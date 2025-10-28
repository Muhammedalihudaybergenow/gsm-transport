import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SMSInterface } from '@libs/common';
import * as serialportgsm from 'serialport-gsm';

const SerialGsm = serialportgsm;

const options = {
  baudRate: 9600,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  xon: false,
  rtscts: false,
  xoff: false,
  xany: false,
  autoDeleteOnReceive: true,
  enableConcatenation: true,
  incomingCallIndication: true,
  incomingSMSIndication: true,
  pin: '',
  customInitCommand: '',
  cnmiCommand: 'AT+CNMI=2,1,0,2,1',
  logger: console,
};

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(private readonly configService: ConfigService) {}

  async sendSms(
    data: SMSInterface,
  ): Promise<{ success: boolean; message: string }> {
    const { payload, phonenumber } = data;
    const normalizedPhonenumber = `${phonenumber}`.trim().slice(-8);
    const fullNumber = `+993${normalizedPhonenumber}`;
    const portPath = this.configService.get<string>('SERIALPORT_GSM_LIST');

    this.logger.log(`🔌 Opening modem on port: ${portPath}`);

    const modem = SerialGsm.Modem();

    const cleanup = () => {
      if (modem.isOpened) {
        modem.close(() => {
          this.logger.log('🔒 Modem connection closed.');
        });
      }
    };

    return new Promise((resolve) => {
      let attempt = 0;
      let sent = false;

      const sendAttempt = () => {
        attempt++;
        this.logger.log(
          `📤 Attempt ${attempt}/3 to send SMS to ${fullNumber}...`,
        );

        modem.sendSMS(fullNumber, payload, false, (response) => {
          if (
            response &&
            response.data &&
            response.data.response === 'Message Successfully Sent'
          ) {
            sent = true;
            this.logger.log(`✅ SMS sent successfully to ${fullNumber}`);
            cleanup();
            return resolve({
              success: true,
              message: `📨 SMS sent successfully to ${fullNumber}`,
            });
          }

          if (attempt < 3) {
            this.logger.warn(`⚠️ Failed attempt ${attempt}. Retrying in 5s...`);
            setTimeout(sendAttempt, 5000);
          } else {
            this.logger.error(`❌ All retry attempts failed for ${fullNumber}`);
            cleanup();
            resolve({
              success: false,
              message: `❌ Failed to send SMS to ${fullNumber} after 3 retries.`,
            });
          }
        });
      };

      modem.open(portPath, options, () => {
        this.logger.log(`✅ Connected to modem ${portPath}`);

        modem.setModemMode(() => {
          this.logger.log(`⚙️ Modem set to PDU mode`);
        }, 'PDU');

        modem.initializeModem(() => {
          this.logger.log(`🔧 Modem initialized`);
          modem.getNetworkSignal((signal) => {
            this.logger.log(`📶 Signal: ${JSON.stringify(signal)}`);
          });

          // slight delay to stabilize before first send
          setTimeout(() => sendAttempt(), 1500);
        });
      });

      modem.on('error', (err: any) => {
        this.logger.error(`❌ Modem error: ${err.message || err}`);
        if (!sent) {
          cleanup();
          resolve({
            success: false,
            message: '❌ Modem error occurred before sending SMS.',
          });
        }
      });

      modem.on('close', () => {
        this.logger.warn('🔌 Modem port closed.');
      });

      // safety timeout
      setTimeout(() => {
        if (!sent && attempt === 0) {
          this.logger.error('⏱️ Timeout while opening modem.');
          cleanup();
          resolve({
            success: false,
            message: '⏱️ Timeout while opening modem connection.',
          });
        }
      }, 10000);
    });
  }
}

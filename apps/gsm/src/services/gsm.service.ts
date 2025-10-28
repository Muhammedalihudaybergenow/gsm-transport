import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SMSInterface } from '@libs/common';
import * as serialportgsm from 'serialport-gsm';

const SerialGsm = serialportgsm;

const MODEM_OPTIONS = {
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

    if (!portPath) {
      this.logger.error('❌ SERIALPORT_GSM_LIST is not configured.');
      return {
        success: false,
        message: 'SMS sending failed: modem port not configured',
      };
    }

    this.logger.log(`🔌 Attempting to open modem on port: ${portPath}`);
    const modem = SerialGsm.Modem();

    const cleanup = () => {
      if (modem.isOpened) {
        modem.close(() => this.logger.log('🔒 Modem connection closed.'));
      }
    };

    return new Promise((resolve) => {
      // Handle errors
      modem.on('error', (err: any) => {
        this.logger.error(`❌ Modem error: ${err.message || err}`);
        cleanup();
        resolve({
          success: false,
          message: 'SMS sending failed by serial device',
        });
      });

      modem.on('close', () => {
        this.logger.warn('⚠️ Modem connection closed unexpectedly.');
      });

      // Open modem
      modem.open(portPath, MODEM_OPTIONS, () => {
        // Small wait for the modem to stabilize after connect
        setTimeout(() => {
          modem.initializeModem(() => {
            modem.setModemMode(() => {}, 'PDU');

            // Send SMS
            modem.sendSMS(fullNumber, payload, false, (response: any) => {
              if (
                response?.status === 'Success' ||
                response?.data?.response?.includes('Success')
              ) {
                this.logger.log(`✅ SMS sent successfully to ${fullNumber}`);
                cleanup();
                return resolve({
                  success: true,
                  message: `📨 SMS sent successfully to ${fullNumber}`,
                });
              } else {
                this.logger.error(`❌ SMS sending failed for ${fullNumber}`);
                cleanup();
                return resolve({
                  success: false,
                  message: 'SMS sending failed by serial device',
                });
              }
            });
          });
        }, 3000); // wait 3 seconds after opening for stability
      });

      // Safety timeout if modem never opens
      setTimeout(() => {
        if (!modem.isOpened) {
          this.logger.error('⏱️ Modem connection failed or timed out.');
          cleanup();
          resolve({
            success: false,
            message: 'SMS sending failed by serial device',
          });
        }
      }, 10000);
    });
  }
}

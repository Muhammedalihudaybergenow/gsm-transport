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
      return {
        success: false,
        message: 'SMS sending failed: modem port not configured',
      };
    }

    const modem = SerialGsm.Modem();
    let modemStable = true; // flag to track unexpected disconnects

    const cleanup = () => {
      if (modem.isOpened) {
        modem.close(() => this.logger.log('🔒 Modem connection closed.'));
      }
    };

    return new Promise((resolve) => {
      modem.on('error', (err: any) => {
        this.logger.error(`❌ Modem error: ${err.message || err}`);
        modemStable = false;
      });

      modem.on('close', () => {
        this.logger.warn('⚠️ Modem connection closed unexpectedly.');
        modemStable = false;
      });

      modem.open(portPath, MODEM_OPTIONS, () => {
        setTimeout(() => {
          modem.initializeModem(() => {
            modem.setModemMode(() => {}, 'PDU');

            modem.sendSMS(fullNumber, payload, false, (response: any) => {
              // wait 2 seconds to make sure modem is stable
              setTimeout(() => {
                cleanup();

                if (!modemStable) {
                  return resolve({
                    success: false,
                    message: 'SMS sending failed by serial device',
                  });
                }

                if (
                  response?.status === 'Success' ||
                  response?.data?.response?.includes('Success')
                ) {
                  return resolve({
                    success: true,
                    message: `📨 SMS sent successfully to ${fullNumber}`,
                  });
                } else {
                  return resolve({
                    success: false,
                    message: 'SMS sending failed by serial device',
                  });
                }
              }, 2000);
            });
          });
        }, 3000); // stabilize modem after opening
      });

      // safety timeout
      setTimeout(() => {
        if (!modem.isOpened) {
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

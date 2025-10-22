import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SMSInterface } from '@libs/common';
import * as serialportgsm from 'serialport-gsm';
export const modem = serialportgsm.Modem();
export const options = {
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
export class MessagesService implements OnModuleInit {
  private readonly logger = new Logger(MessagesService.name);

  private modems: Record<string, serialportgsm.Modem> = {};

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    const ports = this.configService.get<string>('SERIALPORT_GSM_LIST');
    const list = await serialportgsm.list();
    modem.open(
      this.configService.get('SERIALPORT_GSM_LIST'),
      options,
      (data: any) => {
        console.log('Connected to device', data);
      },
    );
    modem.on('open', (data) => {
      modem.setModemMode(() => {
        console.log(`Modem mode`);
      }, 'PDU');
      modem.initializeModem(() => {
        modem.getNetworkSignal((data) => {
          console.log('Signal', data);
        });
      });
      modem.checkModem((data) => {
        console.log(data);
      });
      console.log(data);
    });
    modem.on('error', (err: any) => {
      console.log(err);
    });
    modem.on('close', (res) => {
      console.log(res);
    });
  }

  sendSms(data: SMSInterface) {
    const { payload, phonenumber } = data;
    const normalizedPhonenumber = `${phonenumber}`.trim().slice(-8);
    const fullNumber = `+993${normalizedPhonenumber}`;

    if (!modem) {
      this.logger.error(`❌ Modem not found for `);
      return false;
    }

    try {
      modem.sendSMS(fullNumber, payload, false, (response) => {
        this.logger.log(`✅ SMS response f] → ${fullNumber}:`, response);
      });
      this.logger.log(`📨 SMS sent to ${fullNumber}`);
      return {
        success: true,
        message: `📨 SMS sent to ${fullNumber}`,
      };
    } catch (error) {
      this.logger.error(`SMS sending failed`, error);
      return false;
    }
  }
}

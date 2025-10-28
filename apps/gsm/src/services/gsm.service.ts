import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SMSInterface } from '@libs/common';
import { Modem, SerialPortCommunicator } from 'serialport-gsm';

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
  private reconnectTimeout: NodeJS.Timeout | null = null;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {}

  async sendSms(data: SMSInterface) {
    const { payload, phonenumber } = data;

    try {
      const normalizedPhonenumber = `${phonenumber}`.trim().slice(-8);
      const fullNumber = `+993${normalizedPhonenumber}`;
      const serialPortCommunicator = new SerialPortCommunicator(
        this.configService.get('SERIALPORT_GSM_LIST') || '/dev/ttyUSB0',
      );
      const myModem = new Modem(serialPortCommunicator);
      await myModem.open();
      console.log('.checkModem()', await myModem.checkModem());
      console.log('.getSignalInfo()', await myModem.getSignalInfo());
      await myModem.deleteAllSimMessages();
      await myModem.sendSms(fullNumber, payload, false, (res) => {
        console.log('SMS send response:', res);
      });
      await myModem.close();
    } catch (error) {
      return { success: false, message: 'Failed to send SMS' };
    }
  }
}

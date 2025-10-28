import { Injectable, OnModuleInit } from '@nestjs/common';
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
  private reconnectTimeout: NodeJS.Timeout | null = null;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    const list = await serialportgsm.list();
    console.log('Available serial ports:', list);

    const port = this.configService.get('SERIALPORT_GSM');
    this.connectModem(port);
  }

  private connectModem(port: string) {
    modem.open(port, options, (data: any) => {
      console.log('Connected to device', data);
    });

    modem.on('open', () => {
      console.log('📡 Modem is open');
      modem.setModemMode(() => console.log('Modem mode set to PDU'), 'PDU');
      modem.initializeModem(() => {
        modem.getNetworkSignal((data) => console.log('Signal', data));
        modem.checkModem((data) => console.log('Modem check:', data));
      });
    });

    modem.on('error', (err: any) => {
      console.error('Modem error:', err);
      this.tryReconnect(port);
    });

    modem.on('close', (res) => {
      console.warn('Modem closed:', res);
      this.tryReconnect(port);
    });
  }

  private tryReconnect(port: string) {
    if (this.reconnectTimeout) return; // already attempting reconnect

    console.log('⚡ Attempting to reconnect modem in 3s...');
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      console.log('🔌 Reconnecting modem...');
      this.connectModem(port);
    }, 3000);
  }

  sendSms(data: SMSInterface) {
    const { payload, phonenumber } = data;

    try {
      const normalizedPhonenumber = `${phonenumber}`.trim().slice(-8);
      const fullNumber = `+993${normalizedPhonenumber}`;

      modem.sendSMS(fullNumber, payload, false, (response) => {
        console.log('SMS send callback:', response);
      });

      modem.on('onSendingMessage', (info) => {
        console.log('Sending message event:', info);
      });

      console.log(`SMS send initiated to ${fullNumber}`);
      return {
        status: true,
        message: 'SMS sent successfully',
      };
    } catch (error) {
      console.error('SMS sending error:', error);
      return {
        status: false,
        message: 'Failed to send SMS',
      };
    }
  }
}

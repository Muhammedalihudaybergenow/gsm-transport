import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { SMSInterface } from '@libs/common';
import SerialPortGsm = require('serialport-gsm');

export const options: SerialPortGsm.ModemOptions = {
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

export const modem = new SerialPortGsm.Modem(options);

@Injectable()
export class MessagesService implements OnModuleInit {
  private readonly logger = new Logger(MessagesService.name);

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    const ports = this.configService
      .get<string>('SERIALPORT_GSM_LIST')
      ?.split(',') || ['/dev/ttyUSB0'];

    // Open modem
    modem.open((err?: any) => {
      if (err) this.logger.error('Failed to open modem', err);
      else this.logger.log('Modem connected');
    });

    // Event handlers
    modem.on('open', () => {
      this.logger.log('Modem open');
      modem.setModemMode(() => this.logger.log('Modem set to PDU'), 'PDU');
      modem.initializeModem(() => {
        modem.getNetworkSignal((signal) =>
          this.logger.log(`Signal: ${signal}`),
        );
      });
      modem.checkModem((status) => this.logger.log(`Status: ${status}`));
    });

    modem.on('error', (err: any) => this.logger.error('Modem error', err));
    modem.on('close', () => this.logger.warn('Modem closed'));
    modem.on('onSendingMessage', (data) =>
      this.logger.log('Sending SMS', data),
    );
  }

  sendSms(data: SMSInterface) {
    const { payload, phonenumber } = data;
    const normalizedPhonenumber = `${phonenumber}`.trim().slice(-8);
    const fullNumber = `+993${normalizedPhonenumber}`;

    try {
      modem.sendSMS(fullNumber, payload, false, (response) => {
        this.logger.log(`SMS response for ${fullNumber}:`, response);
      });
      this.logger.log(`SMS sent to ${fullNumber}`);
      return true;
    } catch (error) {
      this.logger.error('SMS sending failed', error);
      return false;
    }
  }
}

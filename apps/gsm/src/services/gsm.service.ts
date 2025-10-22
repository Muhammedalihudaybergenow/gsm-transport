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
    const ports = this.configService
      .get<string>('SERIALPORT_GSM_LIST')
      ?.split(',') || ['/dev/ttyUSB0'];
    console.log(ports);
    const list = await serialportgsm.list();
    console.log(list);
    for (const port of ports) {
      await this.initializeModem(port.trim());
    }
  }

  private initializeModem(port: string): Promise<void> {
    return new Promise((resolve) => {
      const modem = new serialportgsm.Modem();
      modem.open(port, options, (err?: any) => {
        if (err) {
          this.logger.error(`Failed to open modem on ${port}`, err);
          return resolve();
        }

        this.logger.log(`✅ Modem connected on ${port}`);
        this.modems[port] = modem;

        modem.on('open', () => {
          this.logger.log(`📶 Modem [${port}] open`);
          modem.setModemMode(
            () => this.logger.log(`Modem [${port}] set to PDU`),
            'PDU',
          );
          modem.initializeModem(
            (res, err) => {
              modem.getNetworkSignal((signal) =>
                this.logger.log(`Modem [${port}] signal: ${signal}`),
              );
            },
            (err) => {
              this.logger.error(`Modem [${port}] initialization error:`, err);
            },
          );
          modem.checkModem((status) =>
            this.logger.log(`Modem [${port}] status: ${status}`),
          );
        });

        modem.on('error', (err: any) =>
          this.logger.error(`❌ Modem [${port}] error`, err),
        );
        modem.on('close', () => this.logger.warn(`⚠️ Modem [${port}] closed`));
        modem.on('onSendingMessage', (data) =>
          this.logger.log(`📤 Modem [${port}] sending SMS`, data),
        );

        resolve();
      });
    });
  }

  sendSms(data: SMSInterface) {
    const { payload, phonenumber } = data;
    const normalizedPhonenumber = `${phonenumber}`.trim().slice(-8);
    const fullNumber = `+993${normalizedPhonenumber}`;
    console.log(this.modems);
    const availablePorts = Object.keys(this.modems);
    if (availablePorts.length === 0) {
      this.logger.error('❌ No modems connected');
      return false;
    }

    // Choose a modem in round-robin or random fashion
    const randomPort =
      availablePorts[Math.floor(Math.random() * availablePorts.length)];
    const modem = this.modems[randomPort];

    if (!modem) {
      this.logger.error(`❌ Modem not found for port ${randomPort}`);
      return false;
    }

    try {
      modem.sendSMS(fullNumber, payload, false, (response) => {
        this.logger.log(
          `✅ SMS response from [${randomPort}] → ${fullNumber}:`,
          response,
        );
      });
      this.logger.log(`📨 SMS sent to ${fullNumber} via ${randomPort}`);
      return {
        success: true,
        message: `📨 SMS sent to ${fullNumber}`,
      };
    } catch (error) {
      this.logger.error(`SMS sending failed via ${randomPort}`, error);
      return false;
    }
  }
}

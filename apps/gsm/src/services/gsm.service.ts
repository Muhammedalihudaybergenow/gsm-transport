import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
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
export class MessagesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessagesService.name);
  private modem: any;
  private isReady = false;
  private portPath: string;
  private reconnectInterval = 5000; // 5s
  private smsQueue: SMSInterface[] = [];
  private reconnectTimeout?: NodeJS.Timeout;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    this.portPath =
      this.configService.get<string>('SERIALPORT_GSM_LIST') || '/dev/ttyUSB0';
    if (!this.portPath) {
      this.logger.error('❌ SERIALPORT_GSM_LIST is not configured.');
      return;
    }

    this.modem = SerialGsm.Modem();

    // Register events before opening
    this.modem.on('error', (err: any) => {
      this.logger.error(`❌ Modem error: ${err.message || err}`);
      this.handleDisconnect();
    });

    this.modem.on('close', () => {
      this.logger.warn('🔌 Modem port closed.');
      this.handleDisconnect();
    });

    await this.connectModem();
  }

  private connectModem(): Promise<void> {
    return new Promise((resolve) => {
      this.modem.open(this.portPath, MODEM_OPTIONS, (err: any) => {
        if (err) {
          this.logger.error(`❌ Failed to open modem: ${err.message || err}`);
          this.scheduleReconnect();
          return resolve();
        }

        this.logger.log(`✅ Connected to modem ${this.portPath}`);

        this.modem.initializeModem(() => {
          this.modem.setModemMode(() => {
            this.logger.log(`⚙️ Modem set to PDU mode`);
          }, 'PDU');

          this.modem.getNetworkSignal((signal) => {
            this.logger.log(`📶 Signal: ${JSON.stringify(signal)}`);
          });

          this.isReady = true;
          this.logger.log('🔧 Modem initialized and ready to send SMS.');

          // Send any queued messages
          if (this.smsQueue.length > 0) {
            this.logger.log(
              `📨 Sending ${this.smsQueue.length} queued SMS messages`,
            );
            const queue = [...this.smsQueue];
            this.smsQueue = [];
            queue.forEach((sms) => this.sendSms(sms));
          }

          resolve();
        });
      });
    });
  }

  private handleDisconnect() {
    if (this.isReady) {
      this.isReady = false;
      this.logger.warn('⚠️ Modem disconnected. Attempting to reconnect...');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimeout) return; // already scheduled
    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = undefined;
      this.logger.log('🔄 Attempting modem reconnect...');
      await this.connectModem();
    }, this.reconnectInterval);
  }

  async onModuleDestroy() {
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    if (this.modem && this.modem.isOpened) {
      this.modem.close(() => {
        this.logger.log('🔒 Modem connection closed on shutdown.');
      });
    }
  }

  async sendSms(
    data: SMSInterface,
  ): Promise<{ success: boolean; message: string }> {
    const { payload, phonenumber } = data;

    // Queue SMS if modem is not ready
    if (!this.isReady) {
      this.logger.warn('⚠️ Modem not ready, queuing SMS...');
      this.smsQueue.push(data);
      return { success: false, message: 'Modem not ready, SMS queued.' };
    }

    // Normalize phone number
    const normalizedPhonenumber = `${phonenumber}`.trim().slice(-8);
    const fullNumber = `+993${normalizedPhonenumber}`;

    let attempt = 0;
    let sent = false;

    const sendAttempt = (): Promise<{ success: boolean; message: string }> =>
      new Promise((resolve) => {
        attempt++;
        this.logger.log(
          `📤 Attempt ${attempt}/3 to send SMS to ${fullNumber}...`,
        );

        this.modem.sendSMS(fullNumber, payload, false, (response: any) => {
          if (
            response?.status === 'Success' ||
            response?.data?.response?.includes('Success')
          ) {
            sent = true;
            this.logger.log(`✅ SMS sent successfully to ${fullNumber}`);
            return resolve({
              success: true,
              message: `📨 SMS sent successfully to ${fullNumber}`,
            });
          }

          if (attempt < 3) {
            this.logger.warn(`⚠️ Failed attempt ${attempt}. Retrying in 5s...`);
            setTimeout(() => resolve(sendAttempt()), 5000);
          } else {
            this.logger.error(`❌ All retry attempts failed for ${fullNumber}`);
            resolve({
              success: false,
              message: `❌ Failed to send SMS to ${fullNumber} after 3 retries.`,
            });
          }
        });
      });

    return sendAttempt();
  }
}

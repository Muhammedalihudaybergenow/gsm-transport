import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as serialportgsm from 'serialport-gsm';
import { Cron, CronExpression } from '@nestjs/schedule';

interface SMSInterface {
  payload: string;
  phonenumber: string | number;
}

@Injectable()
export class MessagesService implements OnModuleInit, OnModuleDestroy {
  private modem = serialportgsm.Modem();
  private isClosing = false;
  private messageQueue: SMSInterface[] = [];
  private isProcessing = false;

  constructor(private configService: ConfigService) {}

  // ✅ Full modem configuration
  private readonly modemOptions = {
    baudRate: Number(process.env.SERIALPORT_BAUD_RATE) || 9600,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    rtscts: false,
    xon: false,
    xoff: false,
    xany: false,
    autoDeleteOnReceive: true, // Delete messages from SIM after reading
    enableConcatenation: true, // Combine multi-part messages
    incomingCallIndication: true,
    incomingSMSIndication: true,
    pin: '',
    customInitCommand: '',
    cnmiCommand: 'AT+CNMI=2,1,0,2,1', // Notify new SMS
    logger: console,
  };

  async onModuleInit() {
    await this.initializeModem();
  }

  // ✅ Centralized modem initialization
  private async initializeModem() {
    const path = this.configService.get<string>('SERIALPORT_GSM_LIST');
    const baudRate =
      this.configService.get<number>('SERIALPORT_BAUD_RATE') || 9600;

    const modemOptions = { ...this.modemOptions, baudRate };

    Logger.log(`🔌 Opening modem on ${path} with baud rate ${baudRate}`);

    this.modem.open(path, modemOptions, (data) => {
      Logger.log(`📡 Connected to GSM modem at ${path}`);
    });

    this.modem.on('open', () => {
      Logger.log('✅ Modem connection established');

      // Apply modem initialization
      this.modem.initializeModem(
        (msg) => Logger.log('⚙️ Modem initialized:', msg),
        modemOptions,
      );

      // Set PDU mode (standard for SMS operations)
      this.modem.setModemMode(
        () => Logger.log('📶 Modem set to PDU mode'),
        'PDU',
      );

      // Perform health checks
      this.modem.checkModem((data) => Logger.log('🔍 Check modem:', data));
      this.modem.getNetworkSignal((data) => Logger.log('📶 Signal:', data));
    });

    // 🔁 Error and close handling
    this.modem.on('error', (err) => {
      Logger.error('❌ Modem error:', err);
    });

    this.modem.on('close', () => {
      Logger.warn('⚠️ Modem connection closed');
      if (!this.isClosing) this.tryReconnect();
    });

    // 📩 Incoming SMS handler
    this.modem.on('onNewMessage', (msg) => {
      Logger.log('📩 Received message:', msg);

      if (msg.data?.message?.includes('Hormatly')) {
        this.handleBalanceMessage(msg.data.message);
      }
    });
  }

  // ✅ Reconnection logic with reinitialization
  private tryReconnect() {
    setTimeout(() => {
      if (!this.isClosing) {
        Logger.warn('🔄 Trying to reconnect modem...');
        this.initializeModem();
      }
    }, 5000);
  }

  // ✅ Public send method
  public async sendSms({ payload, phonenumber }: SMSInterface) {
    this.enqueueMessage({ payload, phonenumber });
    return { success: true, message: 'Message queued for sending' };
  }

  // ✅ Queue system to prevent message overlap
  private enqueueMessage(message: SMSInterface) {
    this.messageQueue.push(message);
    Logger.log(`Message queued. Queue length: ${this.messageQueue.length}`);
    if (!this.isProcessing) this.processQueue();
  }

  private async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift();
      if (!msg) continue;
      await this._sendSmsInternal(msg);
      await new Promise((r) => setTimeout(r, 3000));
    }

    this.isProcessing = false;
  }

  private async _sendSmsInternal({ payload, phonenumber }: SMSInterface) {
    const normalized = phonenumber.toString().trim();
    const full =
      normalized === '0800' ? normalized : `+993${normalized.slice(-8)}`;
    Logger.log(`📤 Sending SMS to ${full}`);

    return new Promise<void>((resolve, reject) => {
      this.modem.sendSMS(full, payload, false, (data) => {
        if (data?.status === 'success') {
          Logger.log(`✅ Sent to ${full}`);
          resolve();
        } else {
          Logger.error(`❌ Failed to send to ${full}:`, data);
          reject(data);
        }
      });
    });
  }

  // ✅ Auto balance check every midnight
  @Cron(CronExpression.EVERY_MINUTE)
  async checkBalance() {
    Logger.log('⏱ Checking balance...');
    await this.sendSms({ phonenumber: '0800', payload: 'BALANCE' });
  }

  // ✅ Cleanup messages every hour
  @Cron(CronExpression.EVERY_HOUR)
  async cleanupMemory() {
    Logger.log('🧹 Deleting all messages...');
    this.modem.deleteAllSimMessages((result) => {
      Logger.log('✅ Messages deleted:', result);
    });
  }

  // ✅ Graceful shutdown
  async onModuleDestroy() {
    this.isClosing = true;
    this.modem.close(() => Logger.log('🔌 Modem closed'));
  }

  // ✅ Balance check logic for admins
  private async handleBalanceMessage(messageBody: string) {
    const balanceMatch = messageBody.match(/([\d,.]+)\s*manat/);
    const balance = balanceMatch ? balanceMatch[1] : 'Unknown';
    Logger.log(`💰 Current balance: ${balance}`);

    const numericBalance = parseFloat(balance.replace(',', '.'));

    if (!isNaN(numericBalance)) {
      const admins = (
        this.configService.get<string>('OTP_ADMIN_PHONENUMBER') || '63412114'
      ).split('?');
      for (const num of admins) {
        await this.sendSms({
          payload: `⚠️ ORP service alert: please refill balance (${balance} manat).`,
          phonenumber: num,
        });
      }
    }
  }
}

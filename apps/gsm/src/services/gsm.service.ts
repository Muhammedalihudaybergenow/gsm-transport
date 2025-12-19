import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as serialportgsm from 'serialport-gsm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MailService } from './mail.service';

interface SMSInterface {
  payload: string;
  phonenumber: string | number;
  key?: string;
}

@Injectable()
export class MessagesService implements OnModuleInit, OnModuleDestroy {
  private modem = serialportgsm.Modem();
  private isClosing = false;
  private isConnected = false;
  private reconnectInterval?: NodeJS.Timeout;
  private reconnectAttempts = 0;

  private messageQueue: SMSInterface[] = [];
  private isProcessing = false;

  constructor(
    private configService: ConfigService,
    private mailService: MailService,
  ) {}

  private readonly modemOptions = {
    baudRate: Number(process.env.SERIALPORT_BAUD_RATE) || 9600,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    rtscts: false,
    xon: false,
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

  async onModuleInit() {
    await this.initializeModem();
  }

  // ---------------------------
  // Modem Initialization
  // ---------------------------
  private async initializeModem() {
    const path =
      this.configService.get<string>('SERIALPORT_GSM_LIST') || '/dev/ttyUSB0';
    const baudRate =
      this.configService.get<number>('SERIALPORT_BAUD_RATE') || 9600;

    const options = { ...this.modemOptions, baudRate };

    Logger.log(`🔌 Opening modem on ${path} with baud rate ${baudRate}`);

    // Remove old listeners to prevent memory leaks
    this.modem.removeAllListeners();

    this.modem.open(path, options, (data) => {
      Logger.log(`📡 Connected to GSM modem at ${path}`);
    });

    this.modem.on('open', () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;

      if (this.reconnectInterval) {
        clearInterval(this.reconnectInterval);
        this.reconnectInterval = undefined;
      }

      Logger.log('✅ Modem connection established');

      this.modem.initializeModem(
        (msg) => Logger.log('⚙️ Modem initialized:', msg),
        options,
      );

      this.modem.setModemMode(
        () => Logger.log('📶 Modem set to PDU mode'),
        'PDU',
      );

      this.modem.checkModem((data) => Logger.log('🔍 Check modem:', data));
      this.modem.getNetworkSignal((data) => Logger.log('📶 Signal:', data));
    });

    this.modem.on('error', (err) => Logger.error('❌ Modem error:', err));

    this.modem.on('close', () => {
      Logger.warn('⚠️ Modem connection closed');
      this.isConnected = false;

      if (!this.isClosing) {
        this.startReconnectLoop();
      }
    });

    this.modem.on('onNewMessage', (msg) => {
      const messages = Array.isArray(msg) ? msg : [msg];
      for (const message of messages) {
        const sender = message?.sender?.trim();
        const content = message?.message?.trim();
        if (!sender || !content) continue;

        if (sender === '0800') {
          Logger.log('💬 Balance message detected from 0800');
          this.handleBalanceMessage(content);
        } else {
          Logger.log(`📨 Message from ${sender}: ${content}`);
        }
      }
    });
  }

  // ---------------------------
  // Reconnect logic
  // ---------------------------
  private startReconnectLoop() {
    if (this.reconnectInterval) return;

    Logger.warn('🔁 Starting modem reconnect loop...');

    this.reconnectInterval = setInterval(async () => {
      if (this.isConnected || this.isClosing) {
        clearInterval(this.reconnectInterval);
        this.reconnectInterval = undefined;
        return;
      }

      this.reconnectAttempts++;
      Logger.warn(`🔄 Reconnect attempt #${this.reconnectAttempts}`);

      // Send email to admin on 5th attempt
      if (this.reconnectAttempts === 5) {
        Logger.warn('✉️ Sending alert email to admin');
        await this.mailService.sendMail(
          this.configService.get<string>('OTP_ADMIN') ||
            'hudaybergenow117@gmail.com',
        );
      }

      try {
        await this.initializeModem();
      } catch (err) {
        Logger.error('❌ Reconnection attempt failed:', err);
      }
    }, 5000);
  }

  // ---------------------------
  // SMS Sending
  // ---------------------------
  public async sendSms({ payload, phonenumber, key }: SMSInterface) {
    if (key !== this.configService.get('OTP_KEY')) {
      return;
    }
    this.enqueueMessage({ payload, phonenumber });
    return { success: true, message: 'Message queued for sending' };
  }

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

  // ---------------------------
  // Cron Jobs
  // ---------------------------
  @Cron(CronExpression.EVERY_5_HOURS)
  async checkBalance() {
    if (!this.isConnected) {
      Logger.warn('⏱ Skipping balance check — modem not connected');
      return;
    }
    Logger.log('⏱ Checking balance...');
    await this.sendSms({
      phonenumber: '0800',
      payload: 'BALANCE',
      key: this.configService.get('OTP_KEY'),
    });
  }

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupMemory() {
    if (!this.isConnected) {
      Logger.warn('⏱ Skipping cleanup — modem not connected');
      return;
    }
    Logger.log('🧹 Deleting all messages...');
    this.modem.deleteAllSimMessages((result) =>
      Logger.log('✅ Messages deleted:', result),
    );
  }

  // ---------------------------
  // Module Shutdown
  // ---------------------------
  async onModuleDestroy() {
    this.isClosing = true;
    if (this.reconnectInterval) clearInterval(this.reconnectInterval);
    this.modem.close(() => Logger.log('🔌 Modem closed'));
  }

  // ---------------------------
  // Balance Message Handler
  // ---------------------------
  private async handleBalanceMessage(messageBody: string) {
    const balanceMatch = messageBody.match(/([\d,.]+)\s*manat/);
    const balance = balanceMatch ? balanceMatch[1] : 'Unknown';
    Logger.log(`💰 Current balance: ${balance}`);

    const numericBalance = parseFloat(balance.replace(',', '.'));

    if (!isNaN(numericBalance) && numericBalance < 10) {
      const admins = (
        this.configService.get<string>('OTP_ADMIN_PHONENUMBER') || '63412114'
      ).split('?');
      for (const num of admins) {
        await this.sendSms({
          payload: `⚠️ ORP service alert: please refill balance (${balance} manat).`,
          phonenumber: num,
          key: this.configService.get('OTP_KEY'),
        });
      }
    }
  }
}

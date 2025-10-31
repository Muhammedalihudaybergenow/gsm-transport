import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import { Cron, CronExpression } from '@nestjs/schedule';

interface SMSInterface {
  payload: string;
  phonenumber: string | number;
}

@Injectable()
export class MessagesService implements OnModuleInit, OnModuleDestroy {
  private port: SerialPort;
  private parser: ReadlineParser;
  private reconnectInterval = 5000;
  private isClosing = false;

  private messageQueue: SMSInterface[] = [];
  private isProcessing = false;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    await this.initPort();
  }

  private async initPort() {
    const path =
      this.configService.get<string>('SERIALPORT_GSM_LIST') || '/dev/ttyUSB0';
    const baudRate =
      this.configService.get<number>('SERIALPORT_BAUD_RATE') || 115200;

    this.port = new SerialPort({ path, baudRate, autoOpen: false });
    this.parser = this.port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

    this.parser.on('data', (data) => {
      Logger.log('Modem data: ' + data);
      this.handleIncomingMessage(data);
    });

    this.port.on('open', () => Logger.log('Serial port opened for GSM modem'));
    this.port.on('error', (err) => {
      Logger.error('Serial port error: ' + err);
      this.tryReconnect();
    });
    this.port.on('close', () => {
      Logger.warn('Serial port closed');
      if (!this.isClosing) this.tryReconnect();
    });

    await this.openPort();
    await this.initializeModem();
  }

  private async openPort(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.open((err) => {
        if (err) {
          Logger.error('Failed to open serial port: ' + err.message);
          this.tryReconnect();
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  private async initializeModem() {
    try {
      await this.sendCommand('AT', ['OK']);
      await new Promise((r) => setTimeout(r, 2000));
      await this.sendCommand('ATZ', ['OK']);
      await new Promise((r) => setTimeout(r, 2000));
      await this.sendCommand('ATE0', ['OK']); // disable echo
      await new Promise((r) => setTimeout(r, 2000));
      await this.sendCommand('AT+CMGF=1', ['OK']); // text mode
      await new Promise((r) => setTimeout(r, 2000));
      await this.sendCommand('AT+CNMI=2,1,0,0,0', ['OK']); // incoming SMS notification
      await new Promise((r) => setTimeout(r, 2000));
      Logger.log('Modem initialized and ready');
    } catch (err) {
      Logger.error('Modem initialization failed: ' + err);
      throw err;
    }
  }

  private tryReconnect() {
    setTimeout(async () => {
      if (!this.isClosing) {
        try {
          await this.openPort();
          await this.initializeModem();
        } catch {
          this.tryReconnect();
        }
      }
    }, this.reconnectInterval);
  }

  private sendCommand(
    command: string,
    waitFor = ['OK'],
    timeout = 5000,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.port.isOpen) return reject(new Error('Serial port not open'));

      let response = '';
      const listener = (data: string) => {
        response += data + '\n';
        if (waitFor.some((w) => data.includes(w))) {
          this.parser.removeListener('data', listener);
          clearTimeout(timer);
          resolve(response);
        }
        if (data.includes('ERROR')) {
          this.parser.removeListener('data', listener);
          clearTimeout(timer);
          reject(new Error(`Modem error: ${data}`));
        }
      };

      this.parser.on('data', listener);
      this.port.write(command + '\r', (err) => {
        if (err) {
          this.parser.removeListener('data', listener);
          clearTimeout(timer);
          reject(err);
        }
      });

      const timer = setTimeout(() => {
        this.parser.removeListener('data', listener);
        resolve(response || 'Timeout waiting for response');
      }, timeout);
    });
  }

  public async sendSms({ payload, phonenumber }: SMSInterface) {
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

      try {
        await this._sendSmsInternal(msg);
      } catch (err) {
        Logger.error('Failed to send SMS: ' + err.message);
      }

      await new Promise((r) => setTimeout(r, 5000)); // small delay between messages
    }

    this.isProcessing = false;
  }

  private async _sendSmsInternal({ payload, phonenumber }: SMSInterface) {
    const phoneStr = phonenumber.toString().trim();
    let fullNumber: string;

    if (phoneStr === '0800') {
      fullNumber = phoneStr; // short code
    } else {
      if (!/^\d{8}$/.test(phoneStr))
        throw new Error('Phone number must be 8 digits');
      fullNumber = `+993${phoneStr}`;
    }

    await this.sendCommand('AT+CMGF=1', ['OK']); // text mode

    Logger.log(`Sending SMS to ${fullNumber}...`);

    await this.sendCommand(`AT+CMGS="${fullNumber}"`, ['>']);
    const timeout = fullNumber === '0800' ? 20000 : 10000; // longer for short codes
    await this.sendCommand(`${payload}\x1A`, ['OK'], timeout);

    Logger.log(`SMS sent successfully to ${fullNumber}`);
  }

  private async handleIncomingMessage(data: string) {
    const lines = data
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    for (const line of lines) {
      // New SMS stored in memory
      if (line.startsWith('+CMTI:')) {
        const match = line.match(/\+CMTI: "(.+)",(\d+)/);
        if (match) {
          const index = match[2];
          Logger.log(`📩 New SMS stored at index ${index}`);
          await this.sendCommand(`AT+CMGR=${index}`, ['OK']);
        }
      }

      // SMS read from memory
      else if (line.startsWith('+CMGR:')) {
        const header = line;
        const messageBody = lines.slice(1).join(' ');

        const match = header.match(/\+CMGR:\s+"[^"]+","([^"]+)"/);
        const phoneNumber = match ? match[1] : 'Unknown';
        if (phoneNumber === '0800') {
          await this.handleBalanceMessage(messageBody);
        }
        Logger.log(`📩 Incoming message from ${phoneNumber}: ${messageBody}`);
      }

      // Real-time incoming SMS
      else if (line.startsWith('+CMT:')) {
        const header = line;
        const messageBody = lines.slice(1).join(' ');

        const match = header.match(/\+CMT:\s+"([^"]+)"/);
        const phoneNumber = match ? match[1] : 'Unknown';
        Logger.log(
          `📩 Incoming real-time message from ${phoneNumber}: ${messageBody}`,
        );
      }
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async checkBalance() {
    Logger.log('⏱ Checking balance...');
    try {
      await this.sendSms({ phonenumber: '0800', payload: 'BALANCE' });
    } catch (err) {
      Logger.error('Failed to send balance check SMS: ' + err.message);
    }
  }
  @Cron(CronExpression.EVERY_HOUR)
  async cleanupMemory() {
    try {
      Logger.log('🧹 Cleaning all messages from modem memory...');
      await this.sendCommand('AT+CMGD=1,4', ['OK']); // delete all messages
      Logger.log('✅ All messages deleted from memory');
    } catch (err) {
      Logger.error('Failed to clean memory: ' + err.message);
    }
  }
  async onModuleDestroy() {
    this.isClosing = true;
    if (this.port?.isOpen) {
      await new Promise<void>((resolve) => {
        this.port.close((err) => {
          if (err) Logger.error('Error closing port: ' + err);
          else Logger.log('Serial port closed');
          resolve();
        });
      });
    }
  }
  private async handleBalanceMessage(messageBody: string) {
    Logger.warn('message body:', messageBody);
    const balanceMatch = messageBody.match(/([\d,.]+)\s*manat/);
    const balance = balanceMatch ? balanceMatch[1] : 'Unknown';
    Logger.log(`💰 Current balance: ${balance}`);

    const phonenumbers = (
      this.configService.get<string>('OTP_ADMIN_PHONENUMBER') || '63412114'
    ).split('?');

    for (const phonenumber of phonenumbers) {
      await this.sendSms({
        payload: `I am your ORP service. Please refill your current balance. Your current balance: ${balance}`,
        phonenumber: parseInt(phonenumber),
      });
    }
  }
}

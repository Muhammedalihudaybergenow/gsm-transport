import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';

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

  // 👇 SMS queue and processing state
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

    this.parser.on('data', (data) => Logger.log('Modem data:', data));
    this.port.on('open', () => Logger.log('Serial port opened for GSM modem'));
    this.port.on('error', (err) => {
      console.error('Serial port error:', err);
      this.tryReconnect();
    });
    this.port.on('close', () => {
      console.warn('Serial port closed');
      if (!this.isClosing) this.tryReconnect();
    });

    await this.openPort();
    await this.initializeModem();
  }

  private async openPort(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.open((err) => {
        if (err) {
          console.error('Failed to open serial port:', err.message);
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
      await this.sendCommand('AT', ['OK']); // Test communication
      await this.sendCommand('ATZ', ['OK']); // Reset modem
      await this.sendCommand('ATE0', ['OK']); // Disable echo
      await this.sendCommand('AT+CMGF=1', ['OK']); // Text mode
      Logger.log('Modem initialized in text mode');
    } catch (error) {
      console.error('Modem initialization failed:', error);
      throw error;
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
      if (!this.port.isOpen)
        return reject(new Error('Serial port is not open'));

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

  /**
   * Queued SMS sender
   */
  public async sendSms({
    payload,
    phonenumber,
  }: SMSInterface): Promise<{ success: boolean; message: string }> {
    // ✅ Immediate response to client
    this.enqueueMessage({ payload, phonenumber });
    return { success: true, message: 'Message was sent' };
  }

  /**
   * Add message to queue and start processing if idle
   */
  private enqueueMessage(message: SMSInterface) {
    this.messageQueue.push(message);
    Logger.log(
      `Message queued. Queue length: ${this.messageQueue.length}`,
      'MessagesService',
    );
    if (!this.isProcessing) {
      this.processQueue();
    }
  }

  /**
   * Process queue one-by-one with 5s delay
   */
  private async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      if (!message) continue;

      try {
        await this._sendSmsInternal(message);
      } catch (err) {
        Logger.error(`Failed to send queued SMS: ${err.message}`);
      }

      // Wait 5 seconds before next SMS
      await new Promise((res) => setTimeout(res, 5000));
    }

    this.isProcessing = false;
  }

  private async _sendSmsInternal({
    payload,
    phonenumber,
  }: SMSInterface): Promise<void> {
    const phoneStr = phonenumber.toString().trim();
    if (!/^\d{8}$/.test(phoneStr)) {
      throw new Error('Phone number must be 8 digits');
    }

    const fullNumber = `+993${phoneStr}`;
    if (!/^\+993\d{8}$/.test(fullNumber)) {
      throw new Error('Invalid Turkmenistan phone number');
    }
    await this.sendCommand('AT+CMGF=1', ['OK']); // Text mode
    await this.sendCommand(`AT+CMGS="${fullNumber}"`, ['>']);
    await this.sendCommand(`${payload}\x1A`, ['OK'], 10000);

    Logger.log(`SMS sent successfully to ${fullNumber}`);
  }

  async onModuleDestroy() {
    this.isClosing = true;
    if (this.port?.isOpen) {
      await new Promise<void>((resolve) => {
        this.port.close((err) => {
          if (err) Logger.error('Error closing port:', err);
          else Logger.log('Serial port closed');
          resolve();
        });
      });
    }
  }
}

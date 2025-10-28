import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import { SMSInterface } from '@libs/common';

@Injectable()
export class MessagesService implements OnModuleInit, OnModuleDestroy {
  private port: SerialPort;
  private parser: ReadlineParser;
  private reconnectTimeout = 3000; // 3 seconds
  private isClosing = false;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    await this.initPort();
  }

  private async initPort() {
    const path =
      this.configService.get('SERIALPORT_GSM_LIST') || '/dev/ttyUSB0';
    this.port = new SerialPort({
      path,
      baudRate: 9600,
      autoOpen: false,
    });

    this.parser = this.port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

    this.parser.on('data', (data) => {
      console.log('Modem data:', data);
    });

    this.port.on('open', () => {
      console.log('Serial port opened for GSM modem');
    });

    this.port.on('error', (err) => {
      console.error('Serial port error:', err);
      this.tryReconnect();
    });

    this.port.on('close', () => {
      console.warn('Serial port closed');
      if (!this.isClosing) this.tryReconnect();
    });

    this.openPort();
  }

  private openPort() {
    this.port.open((err) => {
      if (err) {
        console.error('Failed to open serial port:', err.message);
        this.tryReconnect();
      }
    });
  }

  private tryReconnect() {
    console.log(
      `Attempting to reconnect in ${this.reconnectTimeout / 1000} seconds...`,
    );
    setTimeout(() => {
      if (!this.isClosing) this.openPort();
    }, this.reconnectTimeout);
  }

  private sendCommand(
    command: string,
    waitFor = ['OK', '>'],
    timeout = 5000,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.port.isOpen) return reject(new Error('Port is not open'));

      let response = '';
      const listener = (data: string) => {
        response += data + '\n';
        for (const w of waitFor) {
          if (data.includes(w)) {
            this.parser.removeListener('data', listener);
            resolve(response);
            return;
          }
        }
      };

      this.parser.on('data', listener);

      this.port.write(command + '\r', (err) => {
        if (err) {
          this.parser.removeListener('data', listener);
          reject(err);
        }
      });

      setTimeout(() => {
        this.parser.removeListener('data', listener);
        resolve(response);
      }, timeout);
    });
  }

  public async sendSms(
    data: SMSInterface,
  ): Promise<{ success: boolean; message: string }> {
    try {
      const { payload, phonenumber } = data;

      // Normalize phone number (for Turkmenistan example)
      const normalizedPhonenumber = `${phonenumber}`.trim().slice(-8);
      const fullNumber = `+993${normalizedPhonenumber}`;

      if (!this.port.isOpen) {
        console.error('Port is not open. Waiting for reconnect...');
        return { success: false, message: 'Port not open. Try again later.' };
      }

      // Send SMS commands sequentially
      await this.sendCommand('AT'); // basic check
      await this.sendCommand('AT+CMGF=1'); // text mode
      await this.sendCommand(`AT+CMGS="${fullNumber}"`, ['>']); // wait for > prompt
      const result = await this.sendCommand(
        `${payload}\x1A`,
        ['OK', '+CMS ERROR'],
        10000,
      ); // send message, wait for OK
      console.log(result);
      if (result.includes('+CMS ERROR')) {
        return {
          success: false,
          message: 'Failed',
        };
      }
      console.log(`SMS sent successfully to ${fullNumber}`);
      return { success: true, message: 'SMS sent successfully' };
    } catch (error) {
      console.error('Error sending SMS:', error);
      return { success: false, message: 'Failed to send SMS' };
    }
  }

  async onModuleDestroy() {
    this.isClosing = true;
    if (this.port.isOpen) {
      this.port.close((err) => {
        if (err) console.error('Error closing port:', err);
        else console.log('Serial port closed');
      });
    }
  }
}

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
  private reconnectInterval = 5000; // Reconnect every 5 seconds
  private isClosing = false;
  private readonly maxRetries = 3; // Retry SMS sending 3 times
  private readonly retryInterval = 5000; // 10 seconds between retries

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
      await this.sendCommand('AT', ['OK']); // Check responsiveness
      await this.sendCommand('ATZ', ['OK']); // Reset to defaults
      await this.sendCommand('ATE0', ['OK']); // Disable echo
      await this.sendCommand('AT+CMGF=0', ['OK']); // PDU mode
      console.log('Modem initialized successfully');
    } catch (error) {
      console.error('Modem initialization failed:', error);
      throw error;
    }
  }

  private tryReconnect() {
    console.log(
      `Attempting to reconnect in ${this.reconnectInterval / 1000} seconds...`,
    );
    setTimeout(async () => {
      if (!this.isClosing) {
        try {
          await this.openPort();
          await this.initializeModem();
        } catch (error) {
          this.tryReconnect(); // Retry after interval
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
      if (!this.port.isOpen) {
        return reject(new Error('Serial port is not open'));
      }

      let response = '';
      const listener = (data: string) => {
        response += data + '\n';
        for (const w of waitFor) {
          if (data.includes(w)) {
            this.parser.removeListener('data', listener);
            clearTimeout(timer);
            return resolve(response);
          }
        }
        if (data.includes('+CME ERROR') || data.includes('+CMS ERROR')) {
          this.parser.removeListener('data', listener);
          clearTimeout(timer);
          return reject(new Error(`Modem error: ${data}`));
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

  private encodeUCS2(text: string): string {
    if (!text) return '';
    const bufLE = Buffer.from(text, 'utf16le');
    const bufBE = Buffer.alloc(bufLE.length);
    for (let i = 0; i < bufLE.length; i += 2) {
      bufBE[i] = bufLE[i + 1];
      bufBE[i + 1] = bufLE[i];
    }
    return bufBE.toString('hex').toUpperCase();
  }

  private encodePhoneNumber(number: string): string {
    const cleaned = number.startsWith('+') ? number.slice(1) : number;
    if (!/^\d+$/.test(cleaned)) {
      throw new Error('Invalid phone number: must be numeric');
    }
    if (cleaned.length % 2 !== 0) {
      number += 'F';
    }
    return (
      number
        .match(/../g)
        ?.map((s) => s[1] + s[0])
        .join('') ?? ''
    );
  }

  private buildPDU(smsc: string, recipient: string, message: string) {
    // SMSC
    const smscNumber = smsc.startsWith('+') ? smsc.slice(1) : smsc;
    const smscEncoded = this.encodePhoneNumber(smscNumber);
    const smscType = '91'; // International format
    const smscAddr = smscType + smscEncoded;
    const smscOctets = smscAddr.length / 2;
    const smscLength = smscOctets.toString(16).padStart(2, '0');

    // Recipient (Destination Address)
    const recipientNumber = recipient.startsWith('+')
      ? recipient.slice(1)
      : recipient;
    const recipientDigits = recipientNumber.length;
    const recipientEncoded = this.encodePhoneNumber(recipient);
    const recipientLength = recipientDigits.toString(16).padStart(2, '0');

    // Message
    const msgUCS2 = this.encodeUCS2(message);
    const msgOctets = msgUCS2.length / 2;
    if (msgOctets > 140) {
      return {
        success: false,
        message: 'Message too long for single-part SMS in UCS2 encoding',
      };
    }
    const msgLength = msgOctets.toString(16).padStart(2, '0');

    // PDU: SMS-SUBMIT, no VP, SRR=1, UCS2
    const pdu = `${smscLength}${smscAddr}1100${recipientLength}91${recipientEncoded}0008${msgLength}${msgUCS2}`;

    // CMGS length: total octets minus SMSC length octet and SMSC address octets
    const totalOctets = pdu.length / 2;
    const pduLength = totalOctets - 1 - smscOctets;

    return { pdu, pduLength };
  }

  private async trySendSms(
    smsc: string,
    fullNumber: string,
    payload: string,
    attempt: number = 1,
  ): Promise<{ success: boolean; message: string }> {
    try {
      if (!this.port.isOpen) {
        return {
          success: false,
          message: 'Port not open. Waiting for reconnect.',
        };
      }

      const { pdu, pduLength } = this.buildPDU(smsc, fullNumber, payload);
      await this.sendCommand(`AT+CMGS=${pduLength}`, ['>']);
      const result = await this.sendCommand(
        `${pdu}\x1A`,
        ['OK', '+CMS ERROR'],
        10000,
      );

      if (result.includes('+CMS ERROR')) {
        return {
          success: false,
          message: `Modem returned error while sending SMS: ${result}`,
        };
      }

      Logger.warn(
        `SMS sent successfully to ${fullNumber} on attempt ${attempt}`,
      );
      return { success: true, message: 'SMS sent successfully' };
    } catch (error) {
      Logger.error(`SMS attempt ${attempt} failed:`, error.message);
      if (attempt < this.maxRetries) {
        Logger.log(`Retrying in ${this.retryInterval / 1000} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, this.retryInterval));
        return this.trySendSms(smsc, fullNumber, payload, attempt + 1);
      }
      return {
        success: false,
        message: `Failed to send SMS after ${this.maxRetries} attempts: ${error.message}`,
      };
    }
  }

  public async sendSms(
    data: SMSInterface,
  ): Promise<{ success: boolean; message: string }> {
    try {
      const { payload, phonenumber } = data;

      // Validate phone number (Turkmenistan +993, 8-digit local part)
      const phoneStr = phonenumber.toString().trim();
      if (!/^\d{8}$/.test(phoneStr)) {
        return { success: false, message: 'Phone number must be 8 digits' };
      }

      // Validate payload
      if (payload.length > 70) {
        return {
          success: false,
          message: 'Message exceeds 70 characters for single-part SMS',
        };
      }

      const fullNumber = `+993${phoneStr}`;

      // Validate full number format
      if (!/^\+993\d{8}$/.test(fullNumber)) {
        return {
          success: false,
          message: 'Invalid Turkmenistan phone number format',
        };
      }

      // Get SMSC
      const smsc =
        this.configService.get<string>('SMSC_NUMBER') || '99365999996';

      // Validate SMSC (assume +993 for Turkmenistan)
      if (!/^\d{11}$/.test(smsc)) {
        return { success: false, message: 'Invalid SMSC number format' };
      }

      return await this.trySendSms(smsc, fullNumber, payload);
    } catch (error) {
      Logger.error('Error preparing SMS:', error.message);
      return {
        success: false,
        message: `Failed to send SMS: ${error.message}`,
      };
    }
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

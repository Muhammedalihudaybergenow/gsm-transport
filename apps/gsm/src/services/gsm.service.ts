import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import { SMSInterface } from '@libs/common';

@Injectable()
export class MessagesService implements OnModuleInit, OnModuleDestroy {
  private port: SerialPort;
  private parser: ReadlineParser;
  private reconnectTimeout = 3000;
  private isClosing = false;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    await this.initPort();
  }

  private async initPort() {
    const path =
      this.configService.get('SERIALPORT_GSM_LIST') || '/dev/ttyUSB0';
    this.port = new SerialPort({ path, baudRate: 9600, autoOpen: false });
    this.parser = this.port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

    this.parser.on('data', (data) => console.log('Modem data:', data));
    this.port.on('open', () => console.log('Serial port opened for GSM modem'));
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

  // Encode text to UCS2 hex
  private encodeUCS2(text: string): string {
    const bufLE = Buffer.from(text, 'utf16le'); // Node supports utf16le
    // Swap bytes for big-endian
    const bufBE = Buffer.alloc(bufLE.length);
    for (let i = 0; i < bufLE.length; i += 2) {
      bufBE[i] = bufLE[i + 1];
      bufBE[i + 1] = bufLE[i];
    }
    return bufBE.toString('hex').toUpperCase();
  }

  // Convert phone number to semi-octets for PDU
  private encodePhoneNumber(number: string) {
    if (number.startsWith('+')) number = number.slice(1);
    if (number.length % 2 !== 0) number += 'F';
    return (
      number
        .match(/../g)
        ?.map((s) => s[1] + s[0])
        .join('') ?? ''
    );
  }

  // Build single-part PDU message
  private buildPDU(smsc: string, recipient: string, message: string) {
    const smscEncoded = this.encodePhoneNumber(smsc);
    const smscLength = (smscEncoded.length / 2).toString(16).padStart(2, '0');

    const recipientEncoded = this.encodePhoneNumber(recipient);
    const recipientLength = recipient.length.toString(16).padStart(2, '0');

    const msgUCS2 = this.encodeUCS2(message);
    const msgLength = (msgUCS2.length / 2).toString(16).padStart(2, '0');

    // PDU format (simplified for single-part Unicode SMS)
    const pdu = `${smscLength}${smscEncoded}1100${recipientLength}91${recipientEncoded}0008${msgLength}${msgUCS2}`;
    const pduLength = pdu.length / 2 - smscLength.length / 2 - 1; // length in octets

    return { pdu, pduLength };
  }

  public async sendSms(
    data: SMSInterface,
  ): Promise<{ success: boolean; message: string }> {
    try {
      const { payload, phonenumber } = data;

      const normalizedPhonenumber = `${phonenumber}`.trim().slice(-8);
      const fullNumber = `+993${normalizedPhonenumber}`;

      if (!this.port.isOpen) {
        console.error('Port is not open. Waiting for reconnect...');
        return { success: false, message: 'Port not open. Try again later.' };
      }

      // Basic check
      await this.sendCommand('AT');

      // Set PDU mode
      await this.sendCommand('AT+CMGF=0');

      // SMSC (from config or default)
      const smsc = this.configService.get('SMSC_NUMBER') || '99365999996';

      // Build PDU
      const { pdu, pduLength } = this.buildPDU(smsc, fullNumber, payload);

      // Send SMS
      await this.sendCommand(`AT+CMGS=${pduLength}`, ['>']);
      const result = await this.sendCommand(
        `${pdu}\x1A`,
        ['OK', '+CMS ERROR'],
        10000,
      );

      console.log(result);
      if (result.includes('+CMS ERROR')) {
        return { success: false, message: 'Failed to send SMS' };
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

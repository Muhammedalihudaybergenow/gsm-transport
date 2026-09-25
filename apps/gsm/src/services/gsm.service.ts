import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SerialPort } from 'serialport';
import { Cron, CronExpression } from '@nestjs/schedule';

interface SMSInterface {
  payload: string;
  phonenumber: string | number;
  key?: string;
}

interface QueuedMessage extends SMSInterface {
  attempts: number;
  nextAttemptAt: number;
}

const CR = '\r';
const LF = '\n';

@Injectable()
export class MessagesService implements OnModuleInit, OnModuleDestroy {
  private port?: SerialPort;
  private rxBuffer = '';
  private isClosing = false;
  private isConnected = false;
  private reconnectInterval?: NodeJS.Timeout;
  private reconnectAttempts = 0;

  private readonly MAX_ATTEMPTS = 3;

  private readonly SEND_INTERVAL_MS = 5000;

  private readonly BASE_BACKOFF_MS = 10_000;
  private readonly MAX_BACKOFF_MS = 60_000;

  private readonly SEND_TIMEOUT_MS = 45_000;

  private messageQueue: QueuedMessage[] = [];
  private isProcessing = false;

  private atLock: Promise<unknown> = Promise.resolve();

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    await this.initializeModem();
  }

  private get portPath(): string {
    return (
      this.configService.get<string>('SERIALPORT_GSM_LIST') || '/dev/ttyUSB2'
    );
  }

  private get baudRate(): number {
    return Number(this.configService.get('SERIALPORT_BAUD_RATE')) || 115200;
  }

  private async initializeModem(): Promise<void> {
    if (this.port?.isOpen) return;

    return new Promise((resolve) => {
      Logger.log(`🔌 Opening modem on ${this.portPath} @ ${this.baudRate}`);

      this.port = new SerialPort({
        path: this.portPath,
        baudRate: this.baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        rtscts: false,
        autoOpen: false,
      });

      this.port.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        this.rxBuffer += text;
        Logger.debug(`⬅️ ${text.replace(/[\r\n]+/g, ' | ').trim()}`);
      });

      this.port.on('error', (err) => {
        Logger.error('❌ Serial error:', err.message);
      });

      this.port.on('close', () => {
        Logger.warn('⚠️ Serial port closed');
        this.isConnected = false;
        if (!this.isClosing) this.startReconnectLoop();
      });

      this.port.open(async (err) => {
        if (err) {
          Logger.error('❌ Failed to open serial port:', err.message);
          this.startReconnectLoop();
          return resolve();
        }

        this.isConnected = true;
        this.reconnectAttempts = 0;
        if (this.reconnectInterval) {
          clearInterval(this.reconnectInterval);
          this.reconnectInterval = undefined;
        }
        Logger.log('✅ Modem connection established');

        try {
          await this.runInitSequence();
          Logger.log('⚙️ Modem initialized and ready');
        } catch (e: any) {
          Logger.error('❌ Init sequence failed:', e.message);
        }
        resolve();
      });
    });
  }

  private async runInitSequence(): Promise<void> {
    // Basic handshake
    await this.sendAT('AT', 3000);
    await this.sendAT('ATE0', 3000); // echo off

    // Huawei-specific: kill ^BOOT / ^MODE unsolicited spam
    try {
      await this.sendAT('AT^CURC=0', 3000);
    } catch {
      Logger.warn('⚠️ AT^CURC=0 not supported, continuing');
    }

    // Verbose errors
    try {
      await this.sendAT('AT+CMEE=2', 3000);
    } catch {
      /* ignore */
    }

    // SMS text mode (this is what works on the E261)
    await this.sendAT('AT+CMGF=1', 3000);
    await this.sendAT('AT+CSCS="GSM"', 3000);

    // Status checks
    const cpin = await this.sendAT('AT+CPIN?', 3000);
    Logger.log('🔐 SIM:', this.extractLine(cpin, /\+CPIN/));
    const creg = await this.sendAT('AT+CREG?', 3000);
    Logger.log('📡 Network:', this.extractLine(creg, /\+CREG/));
    const csq = await this.sendAT('AT+CSQ', 3000);
    Logger.log('📶 Signal:', this.extractLine(csq, /\+CSQ/));
  }

  private startReconnectLoop() {
    if (this.reconnectInterval) return;
    Logger.warn('🔁 Starting modem reconnect loop...');

    this.reconnectInterval = setInterval(async () => {
      if (this.isConnected || this.isClosing) {
        if (this.reconnectInterval) clearInterval(this.reconnectInterval);
        this.reconnectInterval = undefined;
        return;
      }

      this.reconnectAttempts++;
      Logger.warn(`🔄 Reconnect attempt #${this.reconnectAttempts}`);

      if (this.reconnectAttempts === 5) {
        Logger.warn('⚠️ 5 failed reconnect attempts — alert admin');
        // TODO: hook into your email/notification service here
      }

      try {
        await this.initializeModem();
      } catch (err: any) {
        Logger.error('❌ Reconnect attempt failed:', err.message);
      }
    }, 5000);
  }

  private extractLine(raw: string, re: RegExp): string {
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && re.test(trimmed)) return trimmed;
    }
    return raw.trim().split(/\r?\n/).pop()?.trim() ?? '';
  }
  private stripNoise(buf: string): string {
    return buf
      .split(/\r?\n/)
      .filter((l) => !/^\^/.test(l.trim())) // drop ^BOOT, ^MODE, etc.
      .join('\n');
  }

  private sendAT(command: string, timeoutMs = 5000): Promise<string> {
    const run = () =>
      new Promise<string>((resolve, reject) => {
        if (!this.port || !this.port.isOpen) {
          return reject(new Error('Port not open'));
        }

        this.rxBuffer = '';
        let settled = false;

        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.port?.off('data', onData);
          fn();
        };

        const timer = setTimeout(() => {
          finish(() =>
            reject(new Error(`Timeout waiting for response to ${command}`)),
          );
        }, timeoutMs);

        const onData = () => {
          const clean = this.stripNoise(this.rxBuffer);
          if (/(^|\n)(OK|ERROR|\+CM[SE] ERROR:.*)(\r?\n|$)/.test(clean)) {
            finish(() => {
              if (/\+CM[SE] ERROR:/.test(clean)) {
                reject(new Error(clean.trim()));
              } else {
                resolve(this.rxBuffer.trim());
              }
            });
          }
        };

        this.port.on('data', onData);
        Logger.debug(`➡️ ${command}`);
        this.port.write(command + CR, (err) => {
          if (err) finish(() => reject(err));
        });
      });

    // Serialize
    this.atLock = this.atLock.then(run, run);
    return this.atLock as Promise<string>;
  }

  public async sendSms({ payload, phonenumber, key }: SMSInterface) {
    this.enqueueMessage({ payload, phonenumber, key });
    return true;
  }

  private enqueueMessage(message: SMSInterface) {
    this.messageQueue.push({
      ...message,
      attempts: 0,
      nextAttemptAt: Date.now(),
    });
    Logger.log(`📥 Queued. Length: ${this.messageQueue.length}`);
    if (!this.isProcessing) void this.processQueue();
  }

  private async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.messageQueue.length > 0 && !this.isClosing) {
        const msg = this.messageQueue.shift();
        if (!msg) continue;

        // Respect the backoff timer of this message
        const now = Date.now();
        if (msg.nextAttemptAt > now) {
          const wait = msg.nextAttemptAt - now;
          Logger.log(
            `⏳ Waiting ${Math.round(wait / 1000)}s before retrying ${msg.phonenumber}`,
          );
          await new Promise((r) => setTimeout(r, wait));
        }

        // If modem is not connected, put it back and wait for reconnect
        if (!this.isConnected) {
          Logger.warn('⚠️ Modem not connected — pausing queue');
          this.messageQueue.unshift(msg);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        try {
          await this._sendSmsInternal(msg);
          msg.attempts = 0;
          // Polite pause between messages so the modem can breathe
          await new Promise((r) => setTimeout(r, this.SEND_INTERVAL_MS));
        } catch (err: any) {
          msg.attempts++;
          const errMsg = err?.message || String(err);
          Logger.error(
            `❌ Send attempt ${msg.attempts}/${this.MAX_ATTEMPTS} failed for ${msg.phonenumber}: ${errMsg}`,
          );

          if (msg.attempts >= this.MAX_ATTEMPTS) {
            Logger.error(
              `🗑️ Dropping message to ${msg.phonenumber} after ${this.MAX_ATTEMPTS} attempts`,
            );
            // Do NOT requeue
          } else {
            // Exponential backoff for this specific message
            const backoff = Math.min(
              this.MAX_BACKOFF_MS,
              this.BASE_BACKOFF_MS * Math.pow(2, msg.attempts - 1),
            );
            msg.nextAttemptAt = Date.now() + backoff;
            this.messageQueue.unshift(msg);
            Logger.log(
              `🔁 Will retry ${msg.phonenumber} in ${Math.round(backoff / 1000)}s`,
            );
            // Give the modem some breathing room before we touch it again
            await new Promise((r) => setTimeout(r, Math.min(backoff, 15_000)));
          }
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async _sendSmsInternal({
    payload,
    phonenumber,
  }: SMSInterface): Promise<void> {
    const normalized = phonenumber.toString().trim();
    const full =
      normalized === '0800' ? normalized : `+993${normalized.slice(-8)}`;

    Logger.log(`📤 Sending SMS to ${full}`);

    // Step 1: issue AT+CMGS and wait for '>' prompt
    await this.commandWithLock(
      () =>
        new Promise<void>((resolve, reject) => {
          if (!this.port || !this.port.isOpen) {
            return reject(new Error('Port not open'));
          }

          this.rxBuffer = '';
          let settled = false;

          const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            this.port?.off('data', onData);
            fn();
          };

          const timer = setTimeout(() => {
            finish(() =>
              reject(new Error(`Timeout waiting for > prompt for ${full}`)),
            );
          }, 10_000);

          const onData = () => {
            const clean = this.stripNoise(this.rxBuffer);
            if (clean.includes('>')) {
              finish(() => resolve());
            } else if (
              /\+CM[SE] ERROR:/.test(clean) ||
              /\bERROR\b/.test(clean)
            ) {
              finish(() => reject(new Error(clean.trim())));
            }
          };

          this.port.on('data', onData);
          Logger.debug(`➡️ AT+CMGS="${full}"`);
          this.port.write(`AT+CMGS="${full}"${CR}`, (err) => {
            if (err) finish(() => reject(err));
          });
        }),
    );

    // Step 2: send payload + Ctrl+Z, wait for +CMGS / OK
    await this.commandWithLock(
      () =>
        new Promise<void>((resolve, reject) => {
          if (!this.port || !this.port.isOpen) {
            return reject(new Error('Port not open'));
          }

          this.rxBuffer = '';
          let settled = false;

          const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            this.port?.off('data', onData);
            fn();
          };

          const timer = setTimeout(() => {
            finish(() =>
              reject(new Error(`Timeout waiting for +CMGS for ${full}`)),
            );
          }, this.SEND_TIMEOUT_MS);

          const onData = () => {
            const clean = this.stripNoise(this.rxBuffer);

            if (/\+CM[SE] ERROR:/.test(clean)) {
              finish(() => reject(new Error(clean.trim())));
              return;
            }

            if (/\+CMGS:\s*\d+/.test(clean) && /\bOK\b/.test(clean)) {
              finish(() => resolve());
            }
          };

          this.port.on('data', onData);
          this.port.write(
            Buffer.concat([
              Buffer.from(payload, 'utf8'),
              Buffer.from([0x1a]), // Ctrl+Z
            ]),
          );
        }),
    );

    Logger.log(`✅ Sent to ${full}`);
  }

  private commandWithLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.atLock.then(fn, fn);
    this.atLock = next.catch(() => undefined);
    return next;
  }

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
    Logger.log('🧹 Deleting all SIM messages...');
    try {
      // CMGD=1,4 = delete all messages (received + sent + unsent)
      await this.sendAT('AT+CMGD=1,4', 15_000);
      Logger.log('✅ SIM messages deleted');
    } catch (e: any) {
      Logger.error('❌ Cleanup failed:', e.message);
    }
  }

  async onModuleDestroy() {
    this.isClosing = true;
    if (this.reconnectInterval) clearInterval(this.reconnectInterval);

    // Give the queue a moment to finish in-flight message
    const deadline = Date.now() + 5000;
    while (this.isProcessing && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }

    if (this.port?.isOpen) {
      this.port.close(() => Logger.log('🔌 Modem closed'));
    }
  }
}

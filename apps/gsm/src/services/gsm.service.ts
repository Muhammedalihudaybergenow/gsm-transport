import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import * as serialportgsm from 'serialport-gsm';

interface SMSInterface {
  payload: string;
  phonenumber: string | number;
  key?: string;
}

interface QueuedSms {
  id: string;
  payload: string;
  phonenumber: string;
  attempts: number;
  expiresAt: number;
}

class ModemUnresponsiveError extends Error {}

class SmsSubmissionUnknownError extends Error {}

@Injectable()
export class MessagesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessagesService.name);

  private modem?: any;
  private ready = false;
  private initializing = false;
  private closing = false;
  private busy = false;
  private processing = false;

  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private initTimer?: NodeJS.Timeout;
  private bootTimer?: NodeJS.Timeout;
  private abortInflight?: (error: Error) => void;

  private watchdogFailures = 0;
  private lastBootAt = 0;

  private readonly queue: QueuedSms[] = [];

  private readonly cfg: {
    sendTimeoutMs: number;
    sendGapMs: number;
    maxAttempts: number;
    maxQueue: number;
    ttlMs: number;
    initTimeoutMs: number;
    reconnectBaseMs: number;
    watchdogTimeoutMs: number;
    resetOnBoot: boolean;
  };

  constructor(private readonly configService: ConfigService) {
    const numberConfig = (key: string, fallback: number): number => {
      const value = Number(this.configService.get(key));
      return Number.isFinite(value) && value > 0 ? value : fallback;
    };

    this.cfg = {
      sendTimeoutMs: numberConfig('SMS_SEND_TIMEOUT_MS', 45_000),
      sendGapMs: numberConfig('SMS_SEND_GAP_MS', 3_000),
      maxAttempts: numberConfig('SMS_MAX_ATTEMPTS', 3),
      maxQueue: numberConfig('SMS_MAX_QUEUE', 200),
      ttlMs: numberConfig('SMS_TTL_MS', 5 * 60_000),
      initTimeoutMs: numberConfig('SMS_INIT_TIMEOUT_MS', 30_000),
      reconnectBaseMs: numberConfig('SMS_RECONNECT_BASE_MS', 2_000),
      watchdogTimeoutMs: numberConfig('SMS_WATCHDOG_TIMEOUT_MS', 10_000),
      resetOnBoot:
        String(this.configService.get('SMS_RESET_ON_BOOT')).toLowerCase() ===
        'true',
    };
  }

  onModuleInit(): void {
    this.connect();
  }

  onModuleDestroy(): void {
    this.closing = true;
    this.clearTimers();
    this.disposeModem();
  }

  async sendSms({ payload, phonenumber }: SMSInterface): Promise<boolean> {
    const normalizedNumber = this.normalizePhoneNumber(phonenumber);

    if (!normalizedNumber) {
      this.logger.error(`Invalid phone number: ${phonenumber}`);
      return false;
    }

    if (!payload?.trim()) {
      this.logger.error('Cannot send an empty SMS');
      return false;
    }

    if (this.queue.length >= this.cfg.maxQueue) {
      this.logger.error(
        `SMS queue is full (${this.cfg.maxQueue}). Rejecting ${normalizedNumber}`,
      );
      return false;
    }

    const sms: QueuedSms = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      payload: payload.trim(),
      phonenumber: normalizedNumber,
      attempts: 0,
      expiresAt: Date.now() + this.cfg.ttlMs,
    };

    this.queue.push(sms);

    this.logger.log(
      `Message queued. ID: ${sms.id}. Queue length: ${this.queue.length}`,
    );

    void this.processQueue();

    return true;
  }

  private connect(): void {
    if (this.closing || this.reconnectTimer) return;

    this.disposeModem();

    const portPath =
      this.configService.get<string>('SERIALPORT_GSM_LIST') || '/dev/ttyUSB0';

    const baudRate =
      Number(this.configService.get('SERIALPORT_BAUD_RATE')) || 9600;

    this.logger.log(`Opening modem on ${portPath} with baud rate ${baudRate}`);

    const modem = serialportgsm.Modem();

    this.modem = modem;
    this.ready = false;
    this.initializing = true;

    this.initTimer = setTimeout(() => {
      if (modem === this.modem) {
        this.resetModem('initialization timeout');
      }
    }, this.cfg.initTimeoutMs);

    modem.on('open', () => {
      void this.onOpen(modem);
    });

    modem.on('error', (error: unknown) => {
      this.logger.error(`Modem error: ${this.format(error)}`);

      if (modem !== this.modem) return;

      if (!this.ready || this.initializing) {
        this.resetModem('modem error');
      }
    });

    modem.on('close', () => {
      this.logger.warn('Modem connection closed');

      if (modem === this.modem) {
        this.resetModem('serial port closed');
      }
    });

    modem.on('onNewMessage', (message: unknown) => {
      this.handleIncomingMessage(message);
    });

    try {
      modem.open(portPath, this.buildModemOptions(baudRate), () => {
        this.logger.log(`Modem open callback completed: ${portPath}`);
      });
    } catch (error) {
      this.logger.error(`Failed to open modem: ${this.format(error)}`);
      this.resetModem('open exception');
    }
  }

  private buildModemOptions(baudRate: number) {
    return {
      baudRate,
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
  }

  private async onOpen(modem: any): Promise<void> {
    if (modem !== this.modem || this.closing) return;

    this.logger.log('Serial port opened. Initializing modem...');

    this.attachBootListener(modem);

    try {
      await this.executeWithTimeout('initializeModem', 20_000, (callback) =>
        modem.initializeModem(callback),
      );

      if (modem !== this.modem || this.closing) return;

      await this.executeWithTimeout('setModemMode', 10_000, (callback) =>
        modem.setModemMode(callback, 'PDU'),
      );

      if (modem !== this.modem || this.closing) return;

      clearTimeout(this.initTimer);
      this.initTimer = undefined;

      this.initializing = false;
      this.ready = true;
      this.reconnectAttempts = 0;
      this.watchdogFailures = 0;

      this.logger.log('Modem is ready in PDU mode');

      this.readSignalStrength(modem);
      void this.processQueue();
    } catch (error) {
      if (modem !== this.modem || this.closing) return;

      this.initializing = false;

      this.logger.error(`Modem initialization failed: ${this.format(error)}`);

      this.resetModem('initialization failed');
    }
  }

  private attachBootListener(modem: any): void {
    const port = modem?.port;

    if (!port?.on) {
      this.logger.warn('Unable to attach modem boot listener');
      return;
    }

    port.on('data', (chunk: unknown) => {
      if (modem !== this.modem || this.closing) return;

      const data = String(chunk);

      if (!data.includes('^BOOT')) return;

      const now = Date.now();

      if (now - this.lastBootAt < 5_000) return;

      this.lastBootAt = now;

      this.logger.error(`Modem reboot detected: ${JSON.stringify(data)}`);

      this.ready = false;
      this.initializing = false;

      if (this.cfg.resetOnBoot) {
        clearTimeout(this.bootTimer);

        this.bootTimer = setTimeout(() => {
          if (modem === this.modem && !this.closing) {
            this.resetModem('modem reboot detected');
          }
        }, 2_000);
      }
    });
  }

  private readSignalStrength(modem: any): void {
    try {
      modem.getNetworkSignal((result: unknown) => {
        if (modem !== this.modem) return;

        this.logger.log(`Network signal: ${this.format(result)}`);
      });
    } catch (error) {
      this.logger.warn(`Unable to read signal strength: ${this.format(error)}`);
    }
  }

  private resetModem(reason: string): void {
    if (this.closing || this.reconnectTimer) return;

    this.logger.warn(`Resetting modem connection: ${reason}`);

    this.disposeModem();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer) return;

    this.reconnectAttempts++;

    const delay = Math.min(
      30_000,
      this.cfg.reconnectBaseMs * 2 ** Math.min(this.reconnectAttempts - 1, 4),
    );

    this.logger.warn(
      `Reconnect attempt #${this.reconnectAttempts} in ${Math.round(
        delay / 1000,
      )} seconds`,
    );

    if (this.reconnectAttempts === 5) {
      this.logger.error(
        'The modem failed to reconnect five times. Check USB power, cable, modem hardware, and signal.',
      );
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;

      if (!this.closing) {
        this.connect();
      }
    }, delay);
  }

  private disposeModem(): void {
    clearTimeout(this.initTimer);
    clearTimeout(this.bootTimer);

    this.initTimer = undefined;
    this.bootTimer = undefined;

    this.ready = false;
    this.initializing = false;

    const inflightAbort = this.abortInflight;
    this.abortInflight = undefined;

    if (inflightAbort) {
      inflightAbort(
        new SmsSubmissionUnknownError(
          'Modem connection reset while submitting SMS. Delivery status is unknown.',
        ),
      );
    }

    const modem = this.modem;
    this.modem = undefined;

    if (!modem) return;

    try {
      modem.removeAllListeners();
    } catch {}

    try {
      modem.on('error', () => undefined);
    } catch {}

    try {
      modem.close(() => undefined);
    } catch {}
  }

  private clearTimers(): void {
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.initTimer);
    clearTimeout(this.bootTimer);

    this.reconnectTimer = undefined;
    this.initTimer = undefined;
    this.bootTimer = undefined;
  }

  @Interval(30_000)
  async watchdog(): Promise<void> {
    const modem = this.modem;

    if (!modem || !this.ready || this.busy || this.initializing) return;

    try {
      await this.executeWithTimeout(
        'checkModem',
        this.cfg.watchdogTimeoutMs,
        (callback) => modem.checkModem(callback),
      );

      this.watchdogFailures = 0;
    } catch (error) {
      this.watchdogFailures++;

      this.logger.warn(
        `Modem watchdog failure ${this.watchdogFailures}/2: ${this.format(
          error,
        )}`,
      );

      if (this.watchdogFailures >= 2 && modem === this.modem) {
        this.resetModem('watchdog failure');
      }
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.closing) return;

    this.processing = true;

    try {
      while (this.queue.length > 0 && !this.closing) {
        if (!this.ready || !this.modem) {
          await this.sleep(500);
          continue;
        }

        const sms = this.queue[0];

        if (Date.now() > sms.expiresAt) {
          this.queue.shift();

          this.logger.warn(
            `Dropping expired SMS ${sms.id} to ${sms.phonenumber}`,
          );

          continue;
        }

        this.busy = true;

        this.logger.log(
          `Sending SMS ${sms.id} to ${sms.phonenumber}. Attempt ${
            sms.attempts + 1
          }/${this.cfg.maxAttempts}`,
        );

        try {
          await this.sendOnce(sms);

          this.queue.shift();

          this.logger.log(
            `SMS submission confirmed for ${sms.phonenumber}. ID: ${sms.id}`,
          );
        } catch (error) {
          const unknownSubmission = error instanceof SmsSubmissionUnknownError;

          sms.attempts++;

          this.logger.error(
            `SMS ${sms.id} to ${sms.phonenumber} failed: ${this.format(error)}`,
          );

          if (unknownSubmission) {
            this.queue.shift();

            this.logger.error(
              `SMS ${sms.id} removed because delivery status is unknown. It will not be retried automatically to prevent duplicates.`,
            );
          } else if (sms.attempts >= this.cfg.maxAttempts) {
            this.queue.shift();

            this.logger.error(
              `SMS ${sms.id} permanently failed after ${sms.attempts} attempts`,
            );
          }

          if (
            error instanceof ModemUnresponsiveError ||
            error instanceof SmsSubmissionUnknownError
          ) {
            this.resetModem('SMS transmission interrupted');
          }
        } finally {
          this.busy = false;
        }

        await this.sleep(this.cfg.sendGapMs);
      }
    } finally {
      this.processing = false;
    }
  }

  private sendOnce(sms: QueuedSms): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const modem = this.modem;

      if (!modem || !this.ready) {
        reject(new ModemUnresponsiveError('Modem is not ready'));
        return;
      }

      let settled = false;
      let timeout: NodeJS.Timeout | undefined;

      const finish = (error?: Error): void => {
        if (settled) return;

        settled = true;

        if (timeout) {
          clearTimeout(timeout);
        }

        if (this.abortInflight === finish) {
          this.abortInflight = undefined;
        }

        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      timeout = setTimeout(() => {
        finish(
          new ModemUnresponsiveError(
            `No SMS response after ${this.cfg.sendTimeoutMs / 1000} seconds`,
          ),
        );
      }, this.cfg.sendTimeoutMs);

      this.abortInflight = finish;

      try {
        modem.sendSMS(sms.phonenumber, sms.payload, false, (result: any) => {
          if (settled) return;

          const status = String(result?.status || '').toLowerCase();

          this.logger.debug(
            `SMS callback for ${sms.id}: ${this.format(result)}`,
          );

          if (status === 'success') {
            finish();
            return;
          }

          if (status === 'error' || status === 'failed') {
            finish(
              new Error(`Modem rejected SMS ${sms.id}: ${this.format(result)}`),
            );
          }
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(this.format(error)));
      }
    });
  }

  private normalizePhoneNumber(value: string | number): string {
    const raw = String(value)
      .trim()
      .replace(/[^\d+]/g, '');

    if (!raw) return '';

    if (raw === '0800' || raw === '800') {
      return '0800';
    }

    if (raw.startsWith('+993')) {
      return raw;
    }

    if (raw.startsWith('993')) {
      return `+${raw}`;
    }

    const localNumber = raw.replace(/^0+/, '');

    if (localNumber.length === 8) {
      return `+993${localNumber}`;
    }

    if (raw.length >= 8) {
      return `+993${raw.slice(-8)}`;
    }

    return '';
  }

  private handleIncomingMessage(message: unknown): void {
    const messages: any[] = Array.isArray(message) ? message : [message];

    for (const item of messages) {
      const sender = String(item?.sender || '').trim();
      const content = String(item?.message || '').trim();

      if (!sender || !content) continue;

      if (sender === '0800') {
        this.logger.log('Balance message received from 0800');
        void this.handleBalanceMessage(content);
        continue;
      }

      this.logger.log(`Incoming SMS from ${sender}: ${content}`);
    }
  }

  private async handleBalanceMessage(messageBody: string): Promise<void> {
    const balanceMatch = messageBody.match(/([\d\s,.]+)\s*(?:manat|TMT|тмт)/i);

    const balanceText = balanceMatch
      ? balanceMatch[1].replace(/\s/g, '')
      : 'Unknown';

    this.logger.log(`Current balance: ${balanceText}`);

    const numericBalance = Number(
      balanceText.replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.'),
    );

    if (!Number.isFinite(numericBalance) || numericBalance >= 10) {
      return;
    }

    const admins = (
      this.configService.get<string>('OTP_ADMIN_PHONENUMBER') || '63412114'
    )
      .split(/[,;?\s]+/)
      .map((number) => number.trim())
      .filter(Boolean);

    for (const admin of admins) {
      await this.sendSms({
        phonenumber: admin,
        payload: `⚠️ ORP service alert: please refill balance (${balanceText} manat).`,
      });
    }
  }

  @Cron(CronExpression.EVERY_5_HOURS)
  async checkBalance(): Promise<void> {
    if (!this.ready) {
      this.logger.warn('Balance check skipped because modem is not ready');
      return;
    }

    this.logger.log('Checking SIM balance');

    await this.sendSms({
      phonenumber: '0800',
      payload: 'BALANCE',
    });
  }

  @Cron(CronExpression.EVERY_HOUR)
  cleanupMemory(): void {
    const modem = this.modem;

    if (!modem || !this.ready || this.busy) {
      this.logger.warn('SIM message cleanup skipped because modem is busy');
      return;
    }

    try {
      modem.deleteAllSimMessages((result: unknown) => {
        this.logger.log(`SIM messages deleted: ${this.format(result)}`);
      });
    } catch (error) {
      this.logger.error(`Failed to delete SIM messages: ${this.format(error)}`);
    }
  }

  private executeWithTimeout(
    label: string,
    timeoutMs: number,
    callbackFunction: (callback: (result?: any, error?: any) => void) => void,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;

        settled = true;

        reject(
          new ModemUnresponsiveError(`${label} timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);

      const finish = (result?: any, error?: any): void => {
        if (settled) return;

        settled = true;
        clearTimeout(timer);

        if (error) {
          reject(
            error instanceof Error ? error : new Error(this.format(error)),
          );
          return;
        }

        const status = String(result?.status || '').toLowerCase();

        if (status && status !== 'success') {
          reject(new Error(`${label} failed: ${this.format(result)}`));
          return;
        }

        resolve(result);
      };

      try {
        callbackFunction(finish);
      } catch (error) {
        clearTimeout(timer);

        reject(error instanceof Error ? error : new Error(this.format(error)));
      }
    });
  }

  private format(value: unknown): string {
    if (value instanceof Error) {
      return value.message;
    }

    if (typeof value === 'string') {
      return value;
    }

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }
}

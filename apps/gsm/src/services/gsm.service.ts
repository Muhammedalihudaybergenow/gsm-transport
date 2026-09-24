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
  payload: string;
  phonenumber: string;
  attempts: number;
  expiresAt: number;
}

/** The modem stopped answering (hung, rebooted, unplugged): reconnect. */
class ModemUnresponsiveError extends Error {}

@Injectable()
export class MessagesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessagesService.name);

  // serialport-gsm has no reliable typings, so the modem is typed as `any`.
  private modem?: any;
  private ready = false; // port open + initialised + PDU mode set
  private closing = false;
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private initTimer?: NodeJS.Timeout;
  private watchdogFailures = 0;
  private abortInflight?: (err: Error) => void;

  private readonly queue: QueuedSms[] = [];
  private processing = false; // the queue loop is running
  private busy = false; // one SMS is being sent right now

  private readonly cfg: {
    sendTimeoutMs: number; // max wait for the modem to confirm one SMS
    sendGapMs: number; // pause between two SMS
    maxAttempts: number; // tries per SMS before it is dropped
    maxQueue: number;
    ttlMs: number; // SMS older than this are dropped instead of sent
    initTimeoutMs: number; // open + init must finish within this time
    reconnectBaseMs: number; // 1st reconnect delay, doubles up to 30 s
    watchdogTimeoutMs: number; // how long the AT ping may take
    resetOnBootBanner: boolean;
  };

  constructor(private readonly configService: ConfigService) {
    const num = (key: string, fallback: number) =>
      Number(this.configService.get(key)) || fallback;

    this.cfg = {
      sendTimeoutMs: num('SMS_SEND_TIMEOUT_MS', 45_000),
      sendGapMs: num('SMS_SEND_GAP_MS', 3_000),
      maxAttempts: num('SMS_MAX_ATTEMPTS', 3),
      maxQueue: num('SMS_MAX_QUEUE', 200),
      ttlMs: num('SMS_TTL_MS', 5 * 60_000),
      initTimeoutMs: num('SMS_INIT_TIMEOUT_MS', 30_000),
      reconnectBaseMs: num('SMS_RECONNECT_BASE_MS', 2_000),
      watchdogTimeoutMs: num('SMS_WATCHDOG_TIMEOUT_MS', 10_000),
      resetOnBootBanner:
        String(this.configService.get('SMS_RESET_ON_BOOT')) !== 'false',
    };
  }

  // ---------------------------------------------------------------- lifecycle

  onModuleInit() {
    this.connect();
  }

  onModuleDestroy() {
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    this.disposeModem();
  }

  // --------------------------------------------------------------- public API

  /** Queues an SMS. Resolves `true` when queued (not when delivered). */
  async sendSms({ payload, phonenumber }: SMSInterface): Promise<boolean> {
    if (this.queue.length >= this.cfg.maxQueue) {
      this.logger.error(
        `Queue full (${this.cfg.maxQueue}) - rejecting SMS to ${phonenumber}`,
      );
      return false;
    }

    this.queue.push({
      payload,
      phonenumber: phonenumber.toString().trim(),
      attempts: 0,
      expiresAt: Date.now() + this.cfg.ttlMs,
    });
    this.logger.log(`Message queued. Queue length: ${this.queue.length}`);
    void this.processQueue();
    return true;
  }

  // --------------------------------------------------------- modem connection

  private connect() {
    if (this.closing) return;
    this.disposeModem();

    const path =
      this.configService.get<string>('SERIALPORT_GSM_LIST') || '/dev/ttyUSB0';
    const baudRate =
      Number(this.configService.get('SERIALPORT_BAUD_RATE')) || 9600;

    this.logger.log(`🔌 Opening modem on ${path} with baud rate ${baudRate}`);

    // A fresh instance every time: no stale listeners, no half-finished commands
    // left in the library's internal queue from before the modem died.
    const modem = serialportgsm.Modem();
    this.modem = modem;

    // Catch-all: if the port never opens / never initialises, start over.
    this.initTimer = setTimeout(
      () => this.resetModem('open/init timeout'),
      this.cfg.initTimeoutMs,
    );

    modem.on('open', () => void this.onOpen(modem));

    modem.on('error', (err: unknown) => {
      this.logger.error(`❌ Modem error: ${this.fmt(err)}`);
      if (!this.ready && modem === this.modem) {
        this.resetModem('error before ready');
      }
    });

    modem.on('close', () => {
      this.logger.warn('⚠️ Modem connection closed');
      if (modem === this.modem) this.resetModem('port closed');
    });

    modem.on('onNewMessage', (msg: unknown) => this.onIncoming(msg));

    try {
      modem.open(path, this.buildOptions(baudRate), () =>
        this.logger.log(`📡 open() finished for ${path}`),
      );
    } catch (err) {
      this.logger.error(`❌ open() threw: ${this.fmt(err)}`);
      this.resetModem('open failed');
    }
  }

  private buildOptions(baudRate: number) {
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

  private async onOpen(modem: any) {
    if (modem !== this.modem) return; // event from an instance we already dropped

    try {
      this.logger.log('✅ Port open, initialising modem...');

      // Fast path: Huawei modems print "^BOOT:..." when they (re)start. After a
      // restart they have forgotten PDU mode / CNMI, so incoming SMS silently stop
      // arriving. Rebuild the connection straight away instead of waiting for a
      // timeout. Disable with SMS_RESET_ON_BOOT=false.
      if (this.cfg.resetOnBootBanner) {
        modem.port?.on?.('data', (chunk: unknown) => {
          const rebooted = String(chunk).includes('^BOOT');
          if (rebooted && this.ready && modem === this.modem) {
            this.resetModem('modem rebooted (^BOOT)');
          }
        });
      }

      await this.call('initializeModem', 20_000, (cb) =>
        modem.initializeModem(cb),
      );
      await this.call('setModemMode', 10_000, (cb) =>
        modem.setModemMode(cb, 'PDU'),
      );
      if (modem !== this.modem) return;

      clearTimeout(this.initTimer);
      this.ready = true;
      this.reconnectAttempts = 0;
      this.watchdogFailures = 0;
      this.logger.log('📶 Modem ready (PDU mode)');

      modem.getNetworkSignal((r: unknown) =>
        this.logger.log(`📶 Signal: ${this.fmt(r)}`),
      );
      void this.processQueue();
    } catch (err) {
      if (modem === this.modem) {
        this.logger.error(`❌ Modem init failed: ${this.fmt(err)}`);
        this.resetModem('init failed');
      }
    }
  }

  private resetModem(reason: string) {
    if (this.closing || this.reconnectTimer) return; // already recovering
    this.logger.warn(`♻️ Resetting modem connection (${reason})`);
    this.disposeModem();
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.closing || this.reconnectTimer) return;

    this.reconnectAttempts++;
    const delay = Math.min(
      30_000,
      this.cfg.reconnectBaseMs * 2 ** Math.min(this.reconnectAttempts - 1, 4),
    );
    this.logger.warn(
      `🔁 Reconnect attempt #${this.reconnectAttempts} in ${Math.round(delay / 100) / 10}s`,
    );

    if (this.reconnectAttempts === 5) {
      this.logger.warn('⚠️ 5 failed attempts to reconnect modem');
      this.logger.warn('✉️ Sending alert email to admin'); // TODO: actually send it
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private disposeModem() {
    clearTimeout(this.initTimer);
    this.ready = false;

    // Fail an in-flight send right away instead of waiting for its timeout.
    this.abortInflight?.(new ModemUnresponsiveError('modem connection reset'));
    this.abortInflight = undefined;

    const modem = this.modem;
    this.modem = undefined;
    if (!modem) return;

    try {
      modem.removeAllListeners();
    } catch {
      /* ignore */
    }
    try {
      // A dead port can still emit 'error'; with no listener that crashes Node.
      modem.on('error', () => undefined);
    } catch {
      /* ignore */
    }
    try {
      modem.close(() => undefined);
    } catch {
      /* ignore */
    }
  }

  /** Pings the modem while idle; two misses in a row => rebuild the connection. */
  @Interval(30_000)
  async watchdog() {
    const modem = this.modem;
    if (!modem || !this.ready || this.busy) return;

    try {
      await this.call('checkModem', this.cfg.watchdogTimeoutMs, (cb) =>
        modem.checkModem(cb),
      );
      this.watchdogFailures = 0;
    } catch (err) {
      this.watchdogFailures++;
      this.logger.warn(
        `🐕 Modem did not answer AT (${this.watchdogFailures}/2): ${this.fmt(err)}`,
      );
      if (this.watchdogFailures >= 2 && modem === this.modem) {
        this.resetModem('watchdog: modem not responding');
      }
    }
  }

  // ------------------------------------------------------------ send pipeline

  private async processQueue() {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0 && !this.closing) {
        if (!this.ready) {
          // modem is (re)connecting - keep the messages and wait
          await this.sleep(250);
          continue;
        }

        // peek: removed only after success or after the final failed attempt
        const sms = this.queue[0];

        if (Date.now() > sms.expiresAt) {
          this.queue.shift();
          this.logger.warn(
            `⌛ Dropping expired SMS to ${sms.phonenumber} (older than ${this.cfg.ttlMs / 1000}s)`,
          );
          continue;
        }

        this.logger.log(
          `📤 Sending SMS to ${sms.phonenumber} (attempt ${sms.attempts + 1}/${this.cfg.maxAttempts})`,
        );
        this.busy = true;
        try {
          await this.sendOnce(sms);
          this.queue.shift();
          this.logger.log(`✅ Modem confirmed SMS to ${sms.phonenumber}`);
        } catch (err) {
          sms.attempts++;
          this.logger.error(
            `❌ SMS to ${sms.phonenumber} failed: ${this.fmt(err)}`,
          );
          if (sms.attempts >= this.cfg.maxAttempts) {
            this.queue.shift();
            this.logger.error(`🗑 Giving up on SMS to ${sms.phonenumber}`);
          }
          if (err instanceof ModemUnresponsiveError) {
            this.resetModem('modem stopped answering while sending');
          }
        } finally {
          this.busy = false;
        }

        await this.sleep(this.cfg.sendGapMs);
      }
    } finally {
      this.processing = false; // always released: the queue can't get stuck
    }
  }

  private sendOnce(sms: QueuedSms): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const modem = this.modem;
      if (!modem || !this.ready) {
        reject(new ModemUnresponsiveError('modem not ready'));
        return;
      }

      let calls = 0;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.abortInflight = undefined;
        if (err) reject(err);
        else resolve();
      };

      timer = setTimeout(
        () =>
          finish(
            new ModemUnresponsiveError(
              `no answer from modem after ${this.cfg.sendTimeoutMs / 1000}s`,
            ),
          ),
        this.cfg.sendTimeoutMs,
      );
      this.abortInflight = finish;

      try {
        modem.sendSMS(
          this.toDialString(sms.phonenumber),
          sms.payload,
          false,
          (result: any) => {
            calls++;
            if (String(result?.status).toLowerCase() !== 'success') {
              finish(new Error(`modem refused SMS: ${this.fmt(result)}`));
              return;
            }
            // serialport-gsm calls back twice: 1st = queued in the library,
            // 2nd = the modem really sent it.
            if (calls >= 2) finish();
          },
        );
      } catch (err) {
        finish(err instanceof Error ? err : new Error(this.fmt(err)));
      }
    });
  }

  private toDialString(raw: string) {
    return raw === '0800' ? raw : `+993${raw.slice(-8)}`;
  }

  // ----------------------------------------------------------- incoming SMS

  private onIncoming(msg: unknown) {
    const messages: any[] = Array.isArray(msg) ? msg : [msg];
    for (const message of messages) {
      const sender = message?.sender?.trim();
      const content = message?.message?.trim();
      if (!sender || !content) continue;

      if (sender === '0800') {
        this.logger.log('💬 Balance message detected from 0800');
        void this.handleBalanceMessage(content);
      } else {
        this.logger.log(`📨 Message from ${sender}: ${content}`);
      }
    }
  }

  private async handleBalanceMessage(messageBody: string) {
    const balanceMatch = messageBody.match(/([\d,.]+)\s*manat/);
    const balance = balanceMatch ? balanceMatch[1] : 'Unknown';
    this.logger.log(`💰 Current balance: ${balance}`);

    const numericBalance = parseFloat(balance.replace(',', '.'));
    if (!isNaN(numericBalance) && numericBalance < 10) {
      // '?' stays a valid separator (as before); ',' ';' and spaces work too.
      const admins = (
        this.configService.get<string>('OTP_ADMIN_PHONENUMBER') || '63412114'
      )
        .split(/[,;?\s]+/)
        .filter(Boolean);

      for (const num of admins) {
        await this.sendSms({
          payload: `⚠️ ORP service alert: please refill balance (${balance} manat).`,
          phonenumber: num,
        });
      }
    }
  }

  // ------------------------------------------------------------- scheduled

  @Cron(CronExpression.EVERY_5_HOURS)
  async checkBalance() {
    if (!this.ready) {
      this.logger.warn('⏱ Skipping balance check - modem not ready');
      return;
    }
    this.logger.log('⏱ Checking balance...');
    await this.sendSms({ phonenumber: '0800', payload: 'BALANCE' });
  }

  @Cron(CronExpression.EVERY_HOUR)
  cleanupMemory() {
    if (!this.ready || !this.modem) {
      this.logger.warn('⏱ Skipping cleanup - modem not ready');
      return;
    }
    this.logger.log('🧹 Deleting all messages...');
    this.modem.deleteAllSimMessages((result: unknown) =>
      this.logger.log(`✅ Messages deleted: ${this.fmt(result)}`),
    );
  }

  // --------------------------------------------------------------- helpers

  /** Wraps a serialport-gsm callback API in a promise with a timeout. */
  private call(
    label: string,
    timeoutMs: number,
    fn: (cb: (res?: any, err?: any) => void) => void,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new ModemUnresponsiveError(
              `${label} timed out after ${timeoutMs}ms`,
            ),
          ),
        timeoutMs,
      );

      const cb = (res?: any, err?: any) => {
        clearTimeout(timer);
        const status =
          typeof res?.status === 'string'
            ? res.status.toLowerCase()
            : undefined;
        if (err) reject(err instanceof Error ? err : new Error(this.fmt(err)));
        else if (status && status !== 'success')
          reject(new Error(`${label}: ${this.fmt(res)}`));
        else resolve(res);
      };

      try {
        fn(cb);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  private fmt(value: unknown): string {
    if (value instanceof Error) return value.message;
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}

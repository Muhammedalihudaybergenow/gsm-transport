import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SMSInterface } from '@libs/common';
import * as serialportgsm from 'serialport-gsm';

const SerialGsm = serialportgsm;

const options = {
  baudRate: 9600,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  xon: false,
  rtscts: false,
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

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(private readonly configService: ConfigService) {}

  private async wait(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async sendSms(
    data: SMSInterface,
  ): Promise<{ success: boolean; message: string }> {
    const { payload, phonenumber } = data;
    const normalizedPhonenumber = `${phonenumber}`.trim().slice(-8);
    const fullNumber = `+993${normalizedPhonenumber}`;
    const portPath = this.configService.get<string>('SERIALPORT_GSM_LIST');

    this.logger.log(`🔌 Opening modem on port: ${portPath}`);

    const modem = SerialGsm.Modem();

    // helper to close modem safely and synchronously (returns when closed)
    const closeModem = (): Promise<void> =>
      new Promise((res) => {
        try {
          if (modem && (modem as any).isOpened) {
            modem.close(() => {
              this.logger.log('🔒 Modem connection closed.');
              res();
            });
          } else {
            res();
          }
        } catch (e) {
          // still resolve
          res();
        }
      });

    // open + initialize modem once
    const openAndInit = (): Promise<void> =>
      new Promise((resolve, reject) => {
        let openTimer: NodeJS.Timeout | null = null;

        const onError = (err: any) => {
          cleanupListeners();
          reject(err);
        };

        const cleanupListeners = () => {
          modem.removeListener('error', onError);
          if (openTimer) {
            clearTimeout(openTimer);
            openTimer = null;
          }
        };

        modem.open(portPath, options, () => {
          this.logger.log(`✅ Modem connected: ${portPath}`);

          modem.setModemMode(() => {
            this.logger.log(`⚙️ Modem set to PDU mode`);
          }, 'PDU');

          modem.initializeModem(() => {
            this.logger.log(`🔧 Modem initialized`);
            // small delay so modem is fully ready
            setTimeout(() => {
              cleanupListeners();
              resolve();
            }, 500);
          });
        });

        modem.on('error', onError);

        // safety: fail open if it takes too long
        openTimer = setTimeout(() => {
          cleanupListeners();
          reject(new Error('Timeout opening modem'));
        }, 10000);
      });

    // send SMS once (single attempt). Resolve true on success, false on failure.
    // This promise resolves exactly once.
    const sendOnce = (): Promise<boolean> =>
      new Promise((resolve) => {
        let finished = false;
        let attemptTimer: NodeJS.Timeout | null = null;

        // ensure only one callback path resolves
        const onceResolve = (val: boolean) => {
          if (finished) return;
          finished = true;
          if (attemptTimer) {
            clearTimeout(attemptTimer);
            attemptTimer = null;
          }
          // remove any listeners (defensive)
          modem.removeAllListeners('error');
          resolve(val);
        };

        try {
          // Send SMS
          modem.sendSMS(fullNumber, payload, false, (response: any) => {
            this.logger.debug(
              'sendSMS callback response:',
              JSON.stringify(response),
            );
            const respStr = JSON.stringify(response || '');
            const successLikely =
              respStr.includes('Message Successfully Sent') ||
              respStr.includes('OK') ||
              /Message.*Sent/i.test(respStr) ||
              /OK/i.test(respStr) ||
              !!(
                response &&
                (response.messageId || response.id || response.msgId)
              );

            if (successLikely) {
              this.logger.log(
                `✅ SMS send callback indicates success for ${fullNumber}`,
              );
              return onceResolve(true);
            }

            // If callback exists but doesn't look like explicit success, still consider it failure for retry
            this.logger.warn(
              `⚠️ sendSMS callback didn't indicate success: ${respStr}`,
            );
            return onceResolve(false);
          });

          // safety timeout for this attempt
          attemptTimer = setTimeout(() => {
            this.logger.error('⏱️ sendSMS attempt timed out');
            onceResolve(false);
          }, 8000);
        } catch (err) {
          this.logger.error('❌ Exception while sending SMS:', err);
          onceResolve(false);
        }
      });

    try {
      await openAndInit();
    } catch (err) {
      this.logger.error('❌ Failed to open/init modem:', err?.message || err);
      await closeModem();
      return { success: false, message: 'Failed to open/init modem' };
    }

    // retry loop: max 3 attempts, 5s between attempts
    const maxAttempts = 3;
    let attempt = 0;
    let success = false;

    for (; attempt < maxAttempts && !success; attempt++) {
      this.logger.log(
        `📤 Attempt ${attempt + 1}/${maxAttempts} to send SMS to ${fullNumber}...`,
      );
      try {
        const ok = await sendOnce();
        if (ok) {
          success = true;
          break;
        } else {
          this.logger.warn(`⚠️ Attempt ${attempt + 1} failed.`);
          if (attempt + 1 < maxAttempts) {
            this.logger.log(`⏳ Waiting 5s before retry...`);
            await this.wait(5000);
          }
        }
      } catch (err) {
        this.logger.error(`❌ Error during attempt ${attempt + 1}:`, err);
        if (attempt + 1 < maxAttempts) {
          await this.wait(5000);
        }
      }
    }

    // always close modem
    await closeModem();

    if (success) {
      return {
        success: true,
        message: `📨 SMS sent successfully to ${fullNumber}`,
      };
    } else {
      return {
        success: false,
        message: `❌ Failed to send SMS to ${fullNumber} after ${maxAttempts} attempts`,
      };
    }
  }
}

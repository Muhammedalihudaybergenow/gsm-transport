declare module 'serialport-gsm' {
  export interface ModemOptions {
    baudRate?: number;
    dataBits?: 7 | 8;
    stopBits?: 1 | 2;
    parity?: 'none' | 'even' | 'odd';
    xon?: boolean;
    xoff?: boolean;
    xany?: boolean;
    rtscts?: boolean;
    autoDeleteOnReceive?: boolean;
    enableConcatenation?: boolean;
    incomingCallIndication?: boolean;
    incomingSMSIndication?: boolean;
    pin?: string;
    customInitCommand?: string;
    cnmiCommand?: string;
    logger?: any;
  }

  export class Modem {
    constructor(options: ModemOptions);
    open(callback?: (err?: any) => void): void;
    close(callback?: (err?: any) => void): void;
    write(data: string | Buffer, callback?: (err?: any) => void): void;

    on(
      event:
        | 'data'
        | 'error'
        | 'close'
        | 'onSendingMessage'
        | 'onSendingMessageStatus'
        | 'onSMSArrive'
        | 'open',
      listener: (...args: any[]) => void,
    ): this;

    sendSMS(
      to: string,
      message: string,
      statusReport?: boolean,
      callback?: (response: any) => void,
    ): void;

    setModemMode(callback: () => void, mode: 'PDU' | 'TEXT'): void;
    initializeModem(callback: () => void): void;
    getNetworkSignal(callback: (signal: any) => void): void;
    checkModem(callback: (status: any) => void): void;
  }

  export interface SerialPortGsmStatic {
    Modem: typeof Modem;
    list(callback?: (err: any, ports: any[]) => void): void;
  }

  const SerialPortGsm: SerialPortGsmStatic;
  export = SerialPortGsm;
}

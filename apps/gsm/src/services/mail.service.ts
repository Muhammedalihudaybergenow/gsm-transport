/* eslint-disable @typescript-eslint/no-require-imports */
import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({
  path: path.join(process.cwd(), '.env'),
});

@Injectable()
export class MailService {
  private transporter: nodemailer.Transporter;
  private smptMail: string;
  constructor() {
    this.smptMail = process.env.SMTP_MAIL ?? 'contact@oteller.com.tm';
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || `465`),
      auth: {
        user: process.env.SMTP_MAIL,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  async sendMail(to: string) {
    try {
      await this.transporter.sendMail({
        from: this.smptMail,
        to,
        subject: 'otp problem',
        body: 'otp problem',
        sender: 'oteller.com.tm',
      });
      Logger.log(`Email sent to ${to}`);
    } catch (error) {
      Logger.error(`Failed to send email to ${to}:`, error);
      throw new Error('Email sending failed');
    }
  }
}

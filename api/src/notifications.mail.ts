import { Inject, Injectable } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { CONFIG, Config } from './config';

export const NOTIFICATION_MAIL = Symbol('NOTIFICATION_MAIL');
export interface NotificationMail { email: string; messageId: string }
export interface NotificationMailDelivery { send(message: NotificationMail): Promise<void> }
@Injectable()
export class NotificationSmtpMail implements NotificationMailDelivery {
  private readonly transport;
  constructor(@Inject(CONFIG) private readonly config: Config) {
    this.transport = nodemailer.createTransport({
      host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
      requireTLS: config.production && !config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
      connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000, dnsTimeout: 5000,
    });
  }
  async send(message: NotificationMail) {
    await this.transport.sendMail({ from: this.config.smtp.from, to: message.email, messageId: message.messageId,
      subject: 'Новое уведомление — E-Repetitor',
      text: `На платформе произошло новое событие. Подробности — в вашем личном кабинете: ${this.config.webOrigin}/account/\nНастроить уведомления можно в личном кабинете.`,
    });
  }
}

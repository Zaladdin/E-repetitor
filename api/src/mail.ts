import { Inject, Injectable } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { CONFIG, Config } from './config';
import { ApiError } from './common';

export const MAIL = Symbol('MAIL');
export interface AccountMail { email: string; token: string; purpose: 'verify' | 'reset' | 'invite' }
export interface MailDelivery { send(message: AccountMail): Promise<void> }

@Injectable()
export class SmtpMail implements MailDelivery {
  private readonly transport;
  constructor(@Inject(CONFIG) private readonly config: Config) {
    this.transport = nodemailer.createTransport({
      host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
      requireTLS: config.production && !config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
      connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000,
    });
  }
  async send(message: AccountMail) {
    const link = `${this.config.webOrigin}/account/#${message.purpose}=${message.token}`;
    try {
      await this.transport.sendMail({
        from: this.config.smtp.from, to: message.email,
        subject: message.purpose === 'verify' ? 'Подтвердите email — E-Repetitor' : message.purpose === 'invite' ? 'Приглашение ученику — E-Repetitor' : 'Смена пароля — E-Repetitor',
        text: message.purpose === 'verify'
          ? `Подтвердите email в течение 24 часов: ${link}\nЕсли вы не создавали аккаунт, проигнорируйте письмо.`
          : message.purpose === 'invite'
            ? `Преподаватель приглашает вас в E-Repetitor. Откройте ссылку в течение 7 дней, проверьте предмет и подтвердите создание аккаунта: ${link}\nЕсли у вас уже есть аккаунт, войдите в него и передайте преподавателю свой Student ID. Если письмо пришло по ошибке, проигнорируйте его.`
            : `Смените пароль в течение 30 минут: ${link}\nЕсли вы не запрашивали смену пароля, проигнорируйте письмо.`,
      });
    } catch {
      // The pending account remains recoverable via resend; never expose SMTP details or token.
      throw new ApiError(503, 'mail_unavailable', 'Не удалось отправить письмо. Попробуйте повторную отправку позже.');
    }
  }
}

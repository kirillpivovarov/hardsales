import { Injectable, Logger } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import { flag, isProduction, port } from '../config';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly from: string;
  private readonly transport: Transporter | null;

  constructor() {
    const mode = process.env.MAIL_TRANSPORT || 'smtp';
    this.from = process.env.MAIL_FROM || (isProduction() ? '' : 'hwforai <no-reply@hwforai.local>');
    if (!/^(?:[^<>\r\n]+\s*<no-reply@[^\s<>@]+>|no-reply@[^\s<>@]+)$/i.test(this.from)) {
      throw new Error('MAIL_FROM must be a no-reply mailbox');
    }
    if (mode === 'console' && !isProduction()) {
      this.transport = null;
      this.logger.warn('Development email transport writes authentication codes to the terminal');
      return;
    }
    if (mode !== 'smtp' || !process.env.SMTP_HOST) throw new Error('Configure SMTP_HOST for mail delivery');
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (Boolean(user) !== Boolean(pass)) throw new Error('Configure both SMTP_USER and SMTP_PASS');
    const secure = flag('SMTP_SECURE', process.env.SMTP_PORT === '465');
    const requireTLS = flag('SMTP_REQUIRE_TLS', isProduction() && !secure);
    if (isProduction() && !secure && !requireTLS) throw new Error('Production SMTP requires TLS');
    this.transport = createTransport({
      host: process.env.SMTP_HOST,
      disableFileAccess: true,
      disableUrlAccess: true,
      port: port('SMTP_PORT', secure ? 465 : 587),
      secure,
      requireTLS,
      auth: user && pass ? { user, pass } : undefined,
      connectionTimeout: 6_000,
      greetingTimeout: 6_000,
      socketTimeout: 8_000,
    });
  }

  async sendMessage(email: string, subject: string, text: string): Promise<void> {
    if (!this.transport) {
      this.logger.log('Development exchange email queued for local inspection');
      return;
    }
    await this.transport.sendMail({ from: this.from, to: { address: email, name: '' }, subject, text });
  }

  async sendCode(email: string, code: string, expiresMinutes: number, purpose: 'REGISTER' | 'LOGIN'): Promise<void> {
    if (!this.transport) {
      this.logger.log(`Development email to ${email}: ${code}`);
      return;
    }
    await this.transport.sendMail({
      from: this.from,
      to: { address: email, name: '' },
      subject: purpose === 'REGISTER' ? 'Подтверждение регистрации в hwforai' : 'Подтверждение входа в hwforai',
      text: `Ваш код подтверждения: ${code}. Он действует ${expiresMinutes} минут. Введите код на сайте hwforai. Если вы не запрашивали код, проигнорируйте письмо.`,
    });
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MailMessage, MailSendResult } from './mail.types';

/** Endpoint HTTP API của Resend (gửi một email). */
const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

/**
 * Transport gửi mail qua Resend (issue #7 chặng 2.5; quyết định của
 * Lão gia 26/10/2026: email hệ thống gửi qua Resend thay SMTP).
 *
 * Cấu hình qua env:
 * - `RESEND_API_KEY`: khoá API của Resend.
 * - `MAIL_FROM`: địa chỉ gửi, phải thuộc domain đã xác minh DNS.
 *
 * Fail-soft có khai báo khi thiếu cấu hình: không có khoá (hoặc không
 * có địa chỉ gửi) thì `send` KHÔNG ném lỗi và KHÔNG gửi — nó ghi log
 * cảnh báo (chỉ người nhận + tiêu đề, không ghi nội dung/mã bí mật) và
 * trả `skipped` kèm lý do. Nhờ vậy app boot và mọi luồng auth chạy
 * bình thường ở môi trường chưa được cấp khoá (test/review), còn
 * production bật gửi thật chỉ bằng cách đặt hai biến env.
 *
 * Có cấu hình mà Resend trả lỗi (mạng/4xx/5xx) thì `send` NÉM Error:
 * lỗi gửi mail thật không được nuốt lặng — consumer outbox dựa vào đó
 * để thử lại ở nhịp sau.
 */
@Injectable()
export class ResendMailService {
  private readonly logger = new Logger(ResendMailService.name);
  private readonly apiKey: string | null;
  private readonly from: string | null;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.apiKey = config.get<string>('RESEND_API_KEY') ?? null;
    this.from = config.get<string>('MAIL_FROM') ?? null;
    if (!this.apiKey) {
      this.logger.warn(
        'RESEND_API_KEY chưa được đặt: mailer ở chế độ ghi log, mail hệ thống sẽ KHÔNG được gửi.',
      );
    } else if (!this.from) {
      this.logger.warn(
        'MAIL_FROM chưa được đặt: mailer không có địa chỉ gửi, mail hệ thống sẽ KHÔNG được gửi.',
      );
    }
  }

  /** Đã đủ cấu hình để gửi thật hay chưa (nơi gọi dùng để khai báo trạng thái). */
  get configured(): boolean {
    return this.apiKey !== null && this.from !== null;
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    if (!this.apiKey) {
      this.logger.log(
        `[chế độ ghi log] Bỏ qua gửi mail tới ${message.to} — tiêu đề "${message.subject}" (thiếu RESEND_API_KEY).`,
      );
      return { status: 'skipped', reason: 'resend_not_configured' };
    }
    if (!this.from) {
      this.logger.log(
        `[chế độ ghi log] Bỏ qua gửi mail tới ${message.to} — tiêu đề "${message.subject}" (thiếu MAIL_FROM).`,
      );
      return { status: 'skipped', reason: 'mail_from_not_configured' };
    }
    const response = await fetch(RESEND_EMAILS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Resend API trả ${response.status}: ${detail.slice(0, 300)}`);
    }
    const body = (await response.json().catch(() => null)) as { id?: string } | null;
    return { status: 'sent', providerId: body?.id ?? null };
  }
}

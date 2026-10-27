import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Transport gửi mail qua Resend ở phía worker (NB-5, issue #174).
 *
 * Vai trò: đây là bản phía worker của ĐÚNG transport đã chạy ở phía
 * API cho mail xác thực (module `apps/api/src/modules/mail`): cùng
 * endpoint HTTP của Resend, cùng hai biến cấu hình môi trường
 * (`RESEND_API_KEY`, `MAIL_FROM`), cùng ngữ nghĩa fail-soft có khai
 * báo. Hai app là hai project TypeScript riêng nên không import chéo
 * được — mỗi phía giữ bản transport của mình, hợp đồng hành vi phải
 * giữ khớp nhau (bất đẳng thức hành vi giữa hai bản là lỗi).
 *
 * Flow của `send`:
 *  1. Thiếu `RESEND_API_KEY` hoặc thiếu `MAIL_FROM` → KHÔNG gửi,
 *     KHÔNG ném lỗi: ghi log cảnh báo (chỉ người nhận + tiêu đề,
 *     không ghi nội dung) và trả `{ status: 'skipped' }` — môi
 *     trường chưa được cấp khoá là trạng thái vận hành hợp lệ (test,
 *     review), nơi gọi coi như đã xử lý xong và ghi nhận trạng thái
 *     riêng (`skipped-not-configured` ở dispatch log).
 *  2. Đủ cấu hình → POST `https://api.resend.com/emails` với
 *     from/to/subject/text (+html nếu có). Resend trả 2xx → trả
 *     `{ status: 'sent', providerId }` (id của Resend để truy vết).
 *  3. Resend trả lỗi (mạng/4xx/5xx) → NÉM Error: lỗi gửi thật không
 *     được nuốt lặng — job BullMQ dựa vào đó để thử lại (job dispatch
 *     để attempts 3 phía API; lượt quét digest giữ mục ở trạng thái
 *     chờ để lượt sau gửi tiếp).
 *
 * Bất biến an toàn: khoá API chỉ đọc từ cấu hình môi trường, không
 * bao giờ ghi vào log/code; nội dung mail không bao giờ ghi vào log.
 */

/** Một bức mail cần gửi (một người nhận cho mỗi bức). */
export interface WorkerMailMessage {
  /** Địa chỉ email người nhận. */
  to: string;
  subject: string;
  /** Nội dung thuần văn bản — luôn có, là bản tối thiểu mọi client đọc được. */
  text: string;
  /** Nội dung HTML tuỳ chọn; thiếu thì chỉ gửi bản text. */
  html?: string;
}

/**
 * Kết quả gửi của transport:
 * - `sent`: Resend đã nhận yêu cầu (kèm id của Resend để truy vết).
 * - `skipped`: không gửi vì chưa cấu hình (fail-soft đã khai báo).
 * Lỗi thật của Resend không nằm trong kiểu này — `send` ném Error.
 */
export type WorkerMailSendResult =
  | { status: 'sent'; providerId: string | null }
  | { status: 'skipped'; reason: 'resend_not_configured' | 'mail_from_not_configured' };

/** Endpoint HTTP API của Resend (gửi một email). */
const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

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
        'RESEND_API_KEY chưa được đặt: mailer ở chế độ ghi log, mail thông báo sẽ KHÔNG được gửi.',
      );
    } else if (!this.from) {
      this.logger.warn(
        'MAIL_FROM chưa được đặt: mailer không có địa chỉ gửi, mail thông báo sẽ KHÔNG được gửi.',
      );
    }
  }

  /** Đã đủ cấu hình để gửi thật hay chưa (nơi gọi dùng để khai báo trạng thái). */
  get configured(): boolean {
    return this.apiKey !== null && this.from !== null;
  }

  /**
   * Gửi một bức mail theo flow ở đầu file.
   *
   * @param message - Người nhận, tiêu đề và nội dung (bản text là bắt buộc).
   * @returns `sent` kèm id của Resend, hoặc `skipped` kèm lý do chưa cấu hình.
   * @throws Error khi Resend trả lỗi — nơi gọi (job) thử lại theo cơ chế của nó.
   */
  async send(message: WorkerMailMessage): Promise<WorkerMailSendResult> {
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

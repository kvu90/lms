/**
 * Kiểu dùng chung của tầng gửi mail hệ thống (issue #7 chặng 2.5).
 *
 * Tầng này CHỈ biết "một bức mail" (người nhận + tiêu đề + nội dung) và
 * kết quả gửi — mọi luật nghiệp vụ (khi nào gửi, gửi cho ai, nội dung
 * lấy từ đâu) nằm ở nơi gọi: hiện tại là các callback của Better Auth
 * (reset mật khẩu, OTP đăng nhập) qua `AuthMailService`, về sau là bất
 * kỳ tính năng nào cần gửi mail thật qua Resend.
 */
export interface MailMessage {
  /** Địa chỉ email người nhận (một người nhận cho mỗi bức mail). */
  to: string;
  subject: string;
  /** Nội dung thuần văn bản — luôn có, là bản tối thiểu mọi client đọc được. */
  text: string;
  /** Nội dung HTML tuỳ chọn; thiếu thì chỉ gửi bản text. */
  html?: string;
}

/**
 * Kết quả gửi của tầng transport:
 * - `sent`: Resend đã nhận yêu cầu (kèm id của Resend để truy vết).
 * - `skipped`: KHÔNG gửi vì chưa cấu hình — đây là fail-soft ĐÃ KHAI
 *   BÁO của hệ khi thiếu `RESEND_API_KEY`/`MAIL_FROM` (môi trường chưa
 *   được cấp khoá), không phải lỗi: nơi gọi coi như đã xử lý xong.
 * Lỗi tạm thời/thật của Resend (mạng, 5xx, 4xx) KHÔNG nằm trong kiểu
 * này — transport ném Error để nơi gọi (consumer outbox) còn thử lại.
 */
export type MailSendResult =
  | { status: 'sent'; providerId: string | null }
  | { status: 'skipped'; reason: 'resend_not_configured' | 'mail_from_not_configured' };

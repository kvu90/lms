import type { MailMessage } from './mail.types';

/**
 * Payload của một yêu cầu gửi mail auth được ghi vào outbox (bảng
 * `outbox_events`, type `auth_mail_requested` — xem AuthMailService).
 *
 * Payload mang nội dung NHẠY CẢM theo đúng bản chất của nó (liên kết
 * reset chứa token, mã OTP): token/mã đều là bí mật DÙNG MỘT LẦN và
 * sống ngắn (reset 1 giờ, OTP 5 phút) theo cấu hình của Better Auth —
 * cùng mức bảo vệ với chính bảng `verification` của Better Auth, nơi
 * token reset cũng nằm trong DB. Consumer đọc payload, dựng nội dung
 * mail bằng các hàm trong file này rồi mới gọi transport.
 */
export interface PasswordResetMailPayload {
  kind: 'password_reset';
  to: string;
  /** Liên kết đặt lại mật khẩu đầy đủ mà Better Auth sinh (chứa token). */
  url: string;
}

export interface EmailOtpMailPayload {
  kind: 'email_otp';
  to: string;
  /** Mã OTP dạng số mà Better Auth sinh (mặc định 6 chữ số). */
  otp: string;
  /** Loại luồng OTP của Better Auth: sign-in | email-verification | forget-password | change-email. */
  otpType: string;
}

export type AuthMailPayload = PasswordResetMailPayload | EmailOtpMailPayload;

/** Hạn hiệu lực của liên kết reset theo cấu hình Better Auth (mặc định 3600 giây). */
const RESET_LINK_VALIDITY_TEXT = '1 giờ';
/** Hạn hiệu lực của mã OTP — PHẢI khớp `expiresIn: 300` trong email-otp.plugin.ts. */
const OTP_VALIDITY_TEXT = '5 phút';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Dựng nội dung mail (tiêu đề + text + html tối thiểu) từ payload outbox. */
export function renderAuthMail(payload: AuthMailPayload): MailMessage {
  if (payload.kind === 'password_reset') {
    const subject = 'Đặt lại mật khẩu tài khoản LMS';
    const text = [
      'Bạn (hoặc ai đó) vừa yêu cầu đặt lại mật khẩu cho tài khoản LMS gắn với email này.',
      '',
      `Mở liên kết sau để đặt mật khẩu mới (có hiệu lực trong ${RESET_LINK_VALIDITY_TEXT}, chỉ dùng được một lần):`,
      payload.url,
      '',
      'Nếu bạn không yêu cầu, hãy bỏ qua email này — mật khẩu hiện tại vẫn giữ nguyên.',
    ].join('\n');
    const html = [
      '<p>Bạn (hoặc ai đó) vừa yêu cầu đặt lại mật khẩu cho tài khoản LMS gắn với email này.</p>',
      `<p><a href="${escapeHtml(payload.url)}">Đặt mật khẩu mới</a> (liên kết có hiệu lực trong ${RESET_LINK_VALIDITY_TEXT}, chỉ dùng được một lần).</p>`,
      '<p>Nếu bạn không yêu cầu, hãy bỏ qua email này — mật khẩu hiện tại vẫn giữ nguyên.</p>',
    ].join('\n');
    return { to: payload.to, subject, text, html };
  }

  // Luồng OTP đặt lại mật khẩu và luồng OTP đăng nhập dùng hai tiêu đề
  // khác nhau để người nhận nhìn tiêu đề là biết mã này cho việc gì.
  const forPasswordReset = payload.otpType === 'forget-password';
  const subject = forPasswordReset ? 'Mã đặt lại mật khẩu LMS' : 'Mã đăng nhập LMS của bạn';
  const purpose = forPasswordReset
    ? 'Mã để đặt lại mật khẩu tài khoản LMS của bạn là:'
    : 'Mã đăng nhập tài khoản LMS của bạn là:';
  const text = [
    purpose,
    '',
    payload.otp,
    '',
    `Mã có hiệu lực trong ${OTP_VALIDITY_TEXT}. Không chia sẻ mã này cho bất kỳ ai — đội ngũ LMS không bao giờ hỏi mã của bạn.`,
  ].join('\n');
  const html = [
    `<p>${purpose}</p>`,
    `<p style="font-size: 24px; font-weight: bold; letter-spacing: 4px;">${escapeHtml(payload.otp)}</p>`,
    `<p>Mã có hiệu lực trong ${OTP_VALIDITY_TEXT}. Không chia sẻ mã này cho bất kỳ ai — đội ngũ LMS không bao giờ hỏi mã của bạn.</p>`,
  ].join('\n');
  return { to: payload.to, subject, text, html };
}

import { describe, expect, it } from 'vitest';
import { renderAuthMail } from './mail-templates';

/**
 * Mẫu mail auth (issue #7 chặng 2.5): nội dung người dùng nhận được
 * phải mang đúng bí mật của luồng (liên kết reset / mã OTP) và đúng
 * hạn hiệu lực đã cấu hình ở Better Auth — sai một trong hai là luồng
 * nghiệp vụ gãy ở tay người dùng thật.
 */
describe('renderAuthMail', () => {
  it('renders the password reset mail with the single-use link', () => {
    const url = 'http://localhost:3100/api/v1/auth/reset-password/abc123?callbackURL=%2Freset-password';
    const mail = renderAuthMail({ kind: 'password_reset', to: 'a@example.com', url });
    expect(mail.to).toBe('a@example.com');
    expect(mail.subject).toBe('Đặt lại mật khẩu tài khoản LMS');
    expect(mail.text).toContain(url);
    expect(mail.text).toContain('1 giờ');
    expect(mail.html).toContain(`href="${url}"`);
  });

  it('renders the sign-in OTP mail with the code and its 5 minute validity', () => {
    const mail = renderAuthMail({ kind: 'email_otp', to: 'b@example.com', otp: '482916', otpType: 'sign-in' });
    expect(mail.subject).toBe('Mã đăng nhập LMS của bạn');
    expect(mail.text).toContain('482916');
    expect(mail.text).toContain('5 phút');
    expect(mail.html).toContain('482916');
  });

  it('uses a distinct subject for the password-reset OTP so users are not confused', () => {
    const mail = renderAuthMail({ kind: 'email_otp', to: 'b@example.com', otp: '103857', otpType: 'forget-password' });
    expect(mail.subject).toBe('Mã đặt lại mật khẩu LMS');
    expect(mail.text).toContain('103857');
  });
});

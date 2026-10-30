import { describe, expect, it } from 'vitest';
import { renderAuthMail } from './auth-mail.js';

/**
 * Mẫu mail auth (hợp đồng dùng chung của sự kiện `auth_mail_requested`):
 * nội dung người dùng nhận được phải mang đúng bí mật của luồng (liên
 * kết reset / mã OTP) và đúng hạn hiệu lực đã cấu hình ở Better Auth —
 * sai một trong hai là luồng nghiệp vụ gãy ở tay người dùng thật. Spec
 * này vốn nằm cạnh bản cài đặt cũ trong module mail phía API và được
 * chuyển nguyên vẹn (chỉ dịch mô tả) khi bề mặt dùng chung được trích
 * xuất vào package này.
 */
describe('Khối renderAuthMail', () => {
  it('dựng mail đặt lại mật khẩu mang liên kết dùng một lần và hạn 1 giờ', () => {
    const url = 'http://localhost:3100/api/v1/auth/reset-password/abc123?callbackURL=%2Freset-password';
    const mail = renderAuthMail({ kind: 'password_reset', to: 'a@example.com', url });
    expect(mail.to).toBe('a@example.com');
    expect(mail.subject).toBe('Đặt lại mật khẩu tài khoản LMS');
    expect(mail.text).toContain(url);
    expect(mail.text).toContain('1 giờ');
    expect(mail.html).toContain(`href="${url}"`);
  });

  it('dựng mail OTP đăng nhập mang mã và hạn hiệu lực 5 phút', () => {
    const mail = renderAuthMail({ kind: 'email_otp', to: 'b@example.com', otp: '482916', otpType: 'sign-in' });
    expect(mail.subject).toBe('Mã đăng nhập LMS của bạn');
    expect(mail.text).toContain('482916');
    expect(mail.text).toContain('5 phút');
    expect(mail.html).toContain('482916');
  });

  it('dùng tiêu đề riêng cho OTP đặt lại mật khẩu để người nhận không nhầm với OTP đăng nhập', () => {
    const mail = renderAuthMail({ kind: 'email_otp', to: 'b@example.com', otp: '103857', otpType: 'forget-password' });
    expect(mail.subject).toBe('Mã đặt lại mật khẩu LMS');
    expect(mail.text).toContain('103857');
  });
});

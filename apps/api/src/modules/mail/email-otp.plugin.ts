import { emailOTP } from 'better-auth/plugins';

/**
 * Cổng gửi mail mà tầng cấu hình Better Auth phụ thuộc vào (issue #7
 * chặng 2.5). Factory `createBetterAuth` là hàm thuần không biết Nest,
 * nên nó chỉ nhận cổng này qua deps; phía Nest, `AuthMailService` là
 * bản cài đặt (ghi yêu cầu vào outbox). Nhờ vậy instance.ts chỉ cần
 * MỘT import + MỘT dòng đăng ký plugin từ factory trong file này —
 * đúng kỷ luật file cấu hình dùng chung của chương trình GĐ2 (các đội
 * BA khác cũng chỉ cộng thêm ở điểm của họ).
 */
export interface AuthMailPort {
  /** Gửi mail chứa liên kết đặt lại mật khẩu (callback sendResetPassword của Better Auth). */
  sendPasswordResetEmail(input: { userId: string; email: string; url: string }): Promise<void>;
  /** Gửi mail chứa mã OTP (callback sendVerificationOTP của plugin emailOTP). */
  sendEmailOtp(input: {
    email: string;
    otp: string;
    type: 'sign-in' | 'email-verification' | 'forget-password' | 'change-email';
  }): Promise<void>;
}

/**
 * Dựng plugin `emailOTP` của Better Auth với đường gửi mã qua cổng
 * mail của hệ (outbox → Resend, xem AuthMailService/AuthMailConsumer).
 *
 * Các ghim theo chính sách đã chốt của hệ:
 * - `otpLength: 6` + `expiresIn: 300` (5 phút — khớp câu chữ trong
 *   mẫu mail ở mail-templates.ts) + `allowedAttempts: 5`.
 * - `disableSignUp: true` — BẮT BUỘC: mặc định của plugin là cho
 *   email lạ nhận OTP rồi TỰ TẠO tài khoản khi đăng nhập bằng mã, tức
 *   mở đăng ký công khai qua đường OTP trong khi toàn hệ đã ghim
 *   `disableSignUp`. Đặt true thì OTP đăng nhập chỉ phục vụ tài khoản
 *   đã tồn tại.
 * - `storeOTP: 'hashed'` — mã lưu trong bảng verification ở dạng băm
 *   thay vì nguyên văn (mặc định của plugin là 'plain').
 */
export function createEmailOtpPlugin(mail: AuthMailPort) {
  return emailOTP({
    otpLength: 6,
    expiresIn: 300,
    allowedAttempts: 5,
    disableSignUp: true,
    storeOTP: 'hashed',
    sendVerificationOTP: async ({ email, otp, type }) => {
      await mail.sendEmailOtp({ email, otp, type });
    },
  });
}

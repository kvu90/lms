import { Injectable } from '@nestjs/common';
import { OutboxService } from '../../infra/events/outbox.service';
import type { AuthMailPort } from './email-otp.plugin';

/** Type của dòng outbox mang yêu cầu gửi mail auth (consumer: AuthMailConsumer). */
export const AUTH_MAIL_OUTBOX_TYPE = 'auth_mail_requested';
/** Aggregate của các dòng outbox mail auth. */
const AUTH_MAIL_AGGREGATE = 'auth';

/**
 * Bản cài đặt của `AuthMailPort` phía các callback Better Auth: KHÔNG
 * gửi mail trong request — chỉ ghi một dòng outbox (cùng transaction
 * ngắn riêng) rồi trả về ngay, đúng kế hoạch chặng 2.5 (tránh timing
 * attack theo tài liệu Better Auth; khâu gửi thật do AuthMailConsumer
 * quét outbox và gọi transport Resend sau đó). Hệ quả: request đặt
 * lại mật khẩu/OTP không chậm theo tốc độ của Resend và không lộ qua
 * thời gian phản hồi việc email có tồn tại hay không.
 */
@Injectable()
export class AuthMailService implements AuthMailPort {
  constructor(private readonly outbox: OutboxService) {}

  async sendPasswordResetEmail(input: { userId: string; email: string; url: string }): Promise<void> {
    await this.outbox.enqueueStandalone({
      aggregate: AUTH_MAIL_AGGREGATE,
      type: AUTH_MAIL_OUTBOX_TYPE,
      payload: { kind: 'password_reset', to: input.email, url: input.url, userId: input.userId },
    });
  }

  async sendEmailOtp(input: {
    email: string;
    otp: string;
    type: 'sign-in' | 'email-verification' | 'forget-password' | 'change-email';
  }): Promise<void> {
    await this.outbox.enqueueStandalone({
      aggregate: AUTH_MAIL_AGGREGATE,
      type: AUTH_MAIL_OUTBOX_TYPE,
      payload: { kind: 'email_otp', to: input.email, otp: input.otp, otpType: input.type },
    });
  }
}

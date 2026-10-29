import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AuthMailService } from './auth-mail.service';
import { ResendMailService } from './resend-mail.service';

/**
 * Tầng gửi mail hệ thống (issue #7 chặng 2.5):
 * - `ResendMailService`: transport gửi mail thật qua Resend (fail-soft
 *   ghi log khi chưa có `RESEND_API_KEY`/`MAIL_FROM`) cho các đường
 *   gửi mail còn nằm trong tiến trình API.
 * - `AuthMailService`: cổng ghi yêu cầu mail auth (reset mật khẩu,
 *   OTP) vào outbox — nơi các callback của Better Auth gọi tới.
 *
 * Khâu gửi mail auth thật nằm ở phía worker (issue #517): relay
 * outbox duy nhất phát dòng `auth_mail_requested` thành job trên
 * hàng đợi, processor ở worker dựng nội dung bằng template dùng
 * chung ở `@lms/contracts` và gửi qua transport Resend phía worker.
 * Tiến trình API không còn consumer polling cho mail auth.
 *
 * Module không phụ thuộc module auth (đường phụ thuộc chạy ngược lại:
 * BetterAuthModule import MailModule để chích AuthMailService vào
 * factory của Better Auth).
 */
@Module({
  imports: [EventsModule],
  providers: [ResendMailService, AuthMailService],
  exports: [ResendMailService, AuthMailService],
})
export class MailModule {}

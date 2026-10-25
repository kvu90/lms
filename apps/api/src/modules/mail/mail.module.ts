import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AuthMailConsumer } from './auth-mail.consumer';
import { AuthMailService } from './auth-mail.service';
import { ResendMailService } from './resend-mail.service';

/**
 * Tầng gửi mail hệ thống (issue #7 chặng 2.5):
 * - `ResendMailService`: transport gửi mail thật qua Resend (fail-soft
 *   ghi log khi chưa có `RESEND_API_KEY`/`MAIL_FROM`).
 * - `AuthMailService`: cổng ghi yêu cầu mail auth (reset mật khẩu,
 *   OTP) vào outbox — nơi các callback của Better Auth gọi tới.
 * - `AuthMailConsumer`: quét outbox trong tiến trình API và gửi qua
 *   transport.
 *
 * Module không phụ thuộc module auth (đường phụ thuộc chạy ngược lại:
 * BetterAuthModule import MailModule để chích AuthMailService vào
 * factory của Better Auth).
 */
@Module({
  imports: [EventsModule],
  providers: [ResendMailService, AuthMailService, AuthMailConsumer],
  exports: [ResendMailService, AuthMailService],
})
export class MailModule {}

import { Module } from '@nestjs/common';
import { MailModule } from '../../mail/mail.module';
import { UsersModule } from '../../users/users.module';
import { BetterAuthService } from './better-auth.service';
import { CredentialBridgeService } from './credential-bridge.service';

/**
 * Nền Better Auth (issue #7, Giai đoạn 1): instance (sau cờ
 * BETTER_AUTH_ENABLED, mặc định tắt) + cầu nối credential. Handler HTTP
 * được mount ở bootstrap (main.ts) qua `mountBetterAuth`, guard nhận
 * diện cookie nằm ở `common/better-auth-session.guard.ts` và được
 * AppModule đăng ký toàn cục trước JwtAuthGuard.
 */
@Module({
  imports: [UsersModule, MailModule],
  providers: [BetterAuthService, CredentialBridgeService],
  exports: [BetterAuthService, CredentialBridgeService],
})
export class BetterAuthModule {}

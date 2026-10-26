import { forwardRef, Module } from '@nestjs/common';
import { MailModule } from '../../mail/mail.module';
import { UsersModule } from '../../users/users.module';
import { AuthModule } from '../auth.module';
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
  // Hai vòng module tường minh, forwardRef ở cả hai phía như khuôn
  // UsersModule ↔ BetterAuthModule đã có:
  // - UsersModule: module này cần PasswordService của UsersModule,
  //   UsersService cần CredentialBridgeService của module này để đồng
  //   bộ credential (chặng 2.6).
  // - AuthModule: module này cần LoginLockoutService của AuthModule
  //   (điểm 2.4: hooks của instance dùng chung chính sách khoá với hệ
  //   legacy), AuthModule cần BetterAuthService + CredentialBridgeService
  //   của module này cho login-as ở chặng bake (chặng 2.6).
  imports: [forwardRef(() => UsersModule), MailModule, forwardRef(() => AuthModule)],
  providers: [BetterAuthService, CredentialBridgeService],
  exports: [BetterAuthService, CredentialBridgeService],
})
export class BetterAuthModule {}

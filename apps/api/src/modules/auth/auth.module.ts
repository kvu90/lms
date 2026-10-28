import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { CacheInfraModule } from '../../infra/cache/cache-infra.module';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { TenantsModule } from '../tenants/tenants.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { BetterAuthModule } from './better-auth/better-auth.module';
import { AuthService } from './auth.service';
import { LoginLockoutService } from './login-lockout.service';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';
import { SessionService } from './session.service';
import { TotpService } from './totp.service';
import { JwtAuthStrategy, LocalAuthStrategy } from './strategies';

/** Facade của AuthModule: AuthService + SessionService. Phụ thuộc Users + Access theo đồ thị phụ thuộc của report. */
@Module({
  imports: [
    // BetterAuthModule: AuthService cần BetterAuthService +
    // CredentialBridgeService cho login-as ở chặng bake (chặng 2.6);
    // BetterAuthModule cũng import ngược module này (LoginLockoutService
    // cho hooks của instance, điểm 2.4 của BA-1) — vòng module tường
    // minh, forwardRef ở CẢ hai phía như khuôn UsersModule ↔
    // BetterAuthModule; chuỗi provider kết thúc ở PasswordService +
    // LoginLockoutService (không phụ thuộc ngược vào AuthService).
    // UsersModule cũng import ngược module này (UsersService cần
    // AuthRepository để thu hồi family refresh khi đặt mật khẩu)
    // nên cạnh UsersModule ở đây cũng phải là forwardRef; chuỗi
    // provider AuthService → UsersService → AuthRepository kết
    // thúc ở tầng dữ liệu, không phụ thuộc ngược vào AuthService.
    forwardRef(() => UsersModule), AccessModule, TenantsModule, CacheInfraModule, EventsModule, PassportModule, forwardRef(() => BetterAuthModule),
    JwtModule.registerAsync({
      imports: [ConfigModule], inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: config.getOrThrow<string>('JWT_SECRET') }),
    }),
  ],
  controllers: [AuthController, OAuthController],
  providers: [AuthRepository, AuthService, SessionService, TotpService, OAuthService, LoginLockoutService, LocalAuthStrategy, JwtAuthStrategy],
  // AuthRepository được export để UsersService dùng cơ chế thu hồi
  // family refresh mỗi lần đặt mật khẩu qua đường sửa hồ sơ — cạnh
  // này làm UsersModule ↔ AuthModule thành vòng module tường minh,
  // forwardRef ở cả hai phía (xem users.module.ts).
  // TotpService được xuất cho BetterAuthModule: cổng MFA của instance
  // Better Auth tra trạng thái MFA từ `user_totp` qua chính service
  // này (nguồn trạng thái MFA duy nhất của hệ).
  exports: [AuthService, SessionService, LoginLockoutService, AuthRepository, TotpService],
})
/** Module xác thực và phiên. */
export class AuthModule {}

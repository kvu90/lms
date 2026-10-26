import { Module } from '@nestjs/common';
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
import { AuthService } from './auth.service';
import { LoginLockoutService } from './login-lockout.service';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';
import { SessionService } from './session.service';
import { TotpService } from './totp.service';
import { JwtAuthStrategy, LocalAuthStrategy } from './strategies';

/** AuthModule facade: AuthService + SessionService. Depends on Users + Access per the report dependency graph. */
@Module({
  imports: [
    UsersModule, AccessModule, TenantsModule, CacheInfraModule, EventsModule, PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule], inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: config.getOrThrow<string>('JWT_SECRET') }),
    }),
  ],
  controllers: [AuthController, OAuthController],
  providers: [AuthRepository, AuthService, SessionService, TotpService, OAuthService, LoginLockoutService, LocalAuthStrategy, JwtAuthStrategy],
  exports: [AuthService, SessionService, LoginLockoutService],
})
/** Module xác thực và phiên. */
export class AuthModule {}

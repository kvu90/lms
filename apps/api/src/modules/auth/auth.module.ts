import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { CacheInfraModule } from '../../infra/cache/cache-infra.module';
import { AccessModule } from '../access/access.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { JwtAuthStrategy, LocalAuthStrategy } from './strategies';

/** AuthModule facade: AuthService + SessionService. Depends on Users + Access per the report dependency graph. */
@Module({
  imports: [
    UsersModule, AccessModule, CacheInfraModule, PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule], inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: config.getOrThrow<string>('JWT_SECRET') }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthRepository, AuthService, SessionService, LocalAuthStrategy, JwtAuthStrategy],
  exports: [AuthService, SessionService],
})
/** Module xác thực và phiên. */
export class AuthModule {}

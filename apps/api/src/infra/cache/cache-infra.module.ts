import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { ConfigModule, ConfigService } from '@nestjs/config';
import KeyvRedis from '@keyv/redis';
import Keyv from 'keyv';
import { cacheRedisConfigFromUrl } from '../../config/env';
import { SessionCacheService } from './session-cache.service';

/**
 * TTL mặc định (mili giây) của kho cache ứng dụng: nơi dùng truyền
 * TTL tường minh thì giữ TTL của mình; lần `set` quên TTL chịu mức
 * mặc định này thay vì tồn tại vô hạn trong Redis.
 */
const APP_CACHE_DEFAULT_TTL_MS = 300_000;

/**
 * CacheInfraModule — ánh xạ hai chế độ của MUC trong Moodle:
 *  - application: kho Redis dùng chung qua @nestjs/cache-manager + Keyv (namespace `lms:app`)
 *  - session:     kho Redis với namespace riêng (`lms:session`), SessionCacheService
 *
 * Chế độ "request" của MUC không còn provider riêng: nhu cầu ghi nhớ
 * trong phạm vi một request do AsyncLocalStorage của ngữ cảnh tenant
 * đảm nhiệm. Provider cache request-scoped trước đây không có nơi
 * sản xuất nào dùng và đã được gỡ — một provider `Scope.REQUEST` bị
 * inject sẽ lặng lẽ kéo cả cây phụ thuộc của nó (kể cả controller)
 * thành request-scoped, khuôn NestJS khuyến nghị tránh trừ khi thật
 * cần thiết.
 */
@Module({
  imports: [
    CacheModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        stores: [
          new Keyv({
            store: new KeyvRedis(cacheRedisConfigFromUrl(config.getOrThrow<string>('REDIS_URL'))),
            namespace: 'lms:app',
            ttl: APP_CACHE_DEFAULT_TTL_MS,
          }),
        ],
      }),
    }),
  ],
  providers: [SessionCacheService],
  exports: [CacheModule, SessionCacheService],
})
export class CacheInfraModule {}

import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { ConfigModule, ConfigService } from '@nestjs/config';
import KeyvRedis from '@keyv/redis';
import Keyv from 'keyv';
import { cacheRedisConfigFromUrl } from '../../config/env';
import { RequestCacheService } from './request-cache.service';
import { SessionCacheService } from './session-cache.service';

/**
 * CacheInfraModule — ánh xạ ba chế độ của MUC trong Moodle:
 *  - application: kho Redis dùng chung qua @nestjs/cache-manager + Keyv (namespace `lms:app`)
 *  - session:     kho Redis với namespace riêng (`lms:session`), SessionCacheService
 *  - request:     Map trong bộ nhớ theo phạm vi REQUEST, RequestCacheService
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
          }),
        ],
      }),
    }),
  ],
  providers: [SessionCacheService, RequestCacheService],
  exports: [CacheModule, SessionCacheService, RequestCacheService],
})
export class CacheInfraModule {}

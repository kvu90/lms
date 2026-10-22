import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { ConfigModule, ConfigService } from '@nestjs/config';
import KeyvRedis from '@keyv/redis';
import Keyv from 'keyv';
import { RequestCacheService } from './request-cache.service';
import { SessionCacheService } from './session-cache.service';

/**
 * CacheInfraModule — maps Moodle MUC's three modes:
 *  - application: shared Redis store via @nestjs/cache-manager + Keyv (namespace `lms:app`)
 *  - session:     Redis store with its own namespace (`lms:session`), SessionCacheService
 *  - request:     REQUEST-scoped in-memory Map, RequestCacheService
 */
@Module({
  imports: [
    CacheModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        stores: [
          new Keyv({
            store: new KeyvRedis(config.getOrThrow<string>('REDIS_URL')),
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

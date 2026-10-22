import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import KeyvRedis from '@keyv/redis';
import Keyv from 'keyv';
import { cacheRedisConfigFromUrl } from '../../config/env';

/**
 * MUC "session" mode: Redis-backed but in its own namespace (`lms:session`),
 * physically separated from the application cache keys.
 */
@Injectable()
export class SessionCacheService implements OnModuleDestroy {
  private readonly keyv: Keyv;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.keyv = new Keyv({
      store: new KeyvRedis(cacheRedisConfigFromUrl(config.getOrThrow<string>('REDIS_URL'))),
      namespace: 'lms:session',
      ttl: 60 * 60 * 1000,
    });
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.keyv.get<T>(key);
  }

  async set(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    return this.keyv.set(key, value, ttlMs);
  }

  async delete(key: string): Promise<boolean> {
    return this.keyv.delete(key);
  }

  async onModuleDestroy(): Promise<void> {
    await this.keyv.disconnect();
  }
}

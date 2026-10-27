import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import KeyvRedis from '@keyv/redis';
import Keyv from 'keyv';
import { cacheRedisConfigFromUrl } from '../../config/env';

/**
 * Chế độ "session" của MUC: backed bởi Redis nhưng nằm trong namespace riêng (`lms:session`),
 * tách biệt về mặt vật lý khỏi các khoá cache của ứng dụng.
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

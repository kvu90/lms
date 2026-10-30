import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateEnv } from '../../config/env';
import { CacheInfraModule } from './cache-infra.module';
import { SessionCacheService } from './session-cache.service';

describe('CacheInfraModule (2 chế độ MUC, Redis thật)', () => {
  let app: INestApplication;
  let appCache: Cache;
  let sessionCache: SessionCacheService;
  let redis: Redis;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
        CacheInfraModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    appCache = moduleRef.get(CACHE_MANAGER);
    sessionCache = moduleRef.get(SessionCacheService);
    const config = moduleRef.get(ConfigService);
    redis = new Redis(config.getOrThrow<string>('REDIS_URL'));
  });

  afterAll(async () => {
    await app.close();
    redis.disconnect();
  });

  it('cache ứng dụng lưu và đọc giá trị', async () => {
    await appCache.set('infra:app-key', 'app-value');
    await expect(appCache.get('infra:app-key')).resolves.toBe('app-value');
  });

  it('cache phiên tách biệt namespace với cache ứng dụng', async () => {
    await appCache.set('infra:shared-key', 'from-app');
    await sessionCache.set('infra:shared-key', 'from-session');
    await expect(appCache.get('infra:shared-key')).resolves.toBe('from-app');
    await expect(sessionCache.get('infra:shared-key')).resolves.toBe('from-session');
    await sessionCache.delete('infra:shared-key');
    await expect(sessionCache.get('infra:shared-key')).resolves.toBeUndefined();
    await expect(appCache.get('infra:shared-key')).resolves.toBe('from-app');
  });

  it('cache ứng dụng áp TTL mặc định khi set không kèm TTL, và tôn trọng TTL tường minh', async () => {
    // Set không truyền TTL: khoá trong Redis phải mang hạn mặc định
    // của module (300 giây) thay vì tồn tại vô hạn (pttl = -1).
    await appCache.set('infra:default-ttl-key', 'defaulted');
    const [defaultedKey] = await redis.keys('*infra:default-ttl-key*');
    expect(defaultedKey).toBeTruthy();
    const defaultedPttl = await redis.pttl(defaultedKey!);
    expect(defaultedPttl).toBeGreaterThan(0);
    expect(defaultedPttl).toBeLessThanOrEqual(300_000);

    // Set có TTL tường minh ngắn: hạn hiệu lực là TTL đã truyền,
    // không bị TTL mặc định ghi đè.
    await appCache.set('infra:explicit-ttl-key', 'explicit', 5_000);
    const [explicitKey] = await redis.keys('*infra:explicit-ttl-key*');
    expect(explicitKey).toBeTruthy();
    const explicitPttl = await redis.pttl(explicitKey!);
    expect(explicitPttl).toBeGreaterThan(0);
    expect(explicitPttl).toBeLessThanOrEqual(5_000);
  });
});

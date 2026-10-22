import { Controller, Get, Inject, Query } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateEnv } from '../../config/env';
import { CacheInfraModule } from './cache-infra.module';
import { RequestCacheService } from './request-cache.service';
import { SessionCacheService } from './session-cache.service';

@Controller('cache-probe')
class CacheProbeController {
  constructor(
    @Inject(RequestCacheService) private readonly requestCache: RequestCacheService,
  ) {}

  @Get()
  probe(@Query('value') value: string) {
    const seen = this.requestCache.get<string>('probe') ?? null;
    this.requestCache.set('probe', value);
    return { seen, stored: value };
  }
}

describe('CacheInfraModule (3 MUC modes, real Redis)', () => {
  let app: INestApplication;
  let appCache: Cache;
  let sessionCache: SessionCacheService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
        CacheInfraModule,
      ],
      controllers: [CacheProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    appCache = moduleRef.get(CACHE_MANAGER);
    sessionCache = moduleRef.get(SessionCacheService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('application cache stores and reads values', async () => {
    await appCache.set('infra:app-key', 'app-value');
    await expect(appCache.get('infra:app-key')).resolves.toBe('app-value');
  });

  it('session cache is namespace-isolated from the application cache', async () => {
    await appCache.set('infra:shared-key', 'from-app');
    await sessionCache.set('infra:shared-key', 'from-session');
    await expect(appCache.get('infra:shared-key')).resolves.toBe('from-app');
    await expect(sessionCache.get('infra:shared-key')).resolves.toBe('from-session');
    await sessionCache.delete('infra:shared-key');
    await expect(sessionCache.get('infra:shared-key')).resolves.toBeUndefined();
    await expect(appCache.get('infra:shared-key')).resolves.toBe('from-app');
  });

  it('request cache does not leak across requests', async () => {
    const server = app.getHttpServer();
    const first = await request(server).get('/cache-probe?value=one');
    expect(first.body).toEqual({ seen: null, stored: 'one' });
    const second = await request(server).get('/cache-probe?value=two');
    expect(second.body).toEqual({ seen: null, stored: 'two' });
  });
});

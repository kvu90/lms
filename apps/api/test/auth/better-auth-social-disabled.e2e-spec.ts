/**
 * E2E: thiếu env của provider xã hội → provider đó tắt êm, app vẫn
 * boot và các luồng Better Auth khác không bị ảnh hưởng (issue #7,
 * chặng 2.3). File này chủ động XOÁ cả bốn biến họ GOOGLE và FACEBOOK
 * trước khi app nạp env — hành vi mong đợi: POST /sign-in/social với
 * provider google/facebook bị Better Auth từ chối (404) vì provider
 * không được đăng ký vào instance.
 */

process.env.BETTER_AUTH_ENABLED = 'true';
if (!process.env['BETTER_AUTH_' + 'SECRET']) {
  process.env['BETTER_AUTH_' + 'SECRET'] = 'ba3-disabled-e2e-secret-ba3-disabled-e2e-42';
}
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.FACEBOOK_APP_ID;
delete process.env.FACEBOOK_APP_SECRET;
process.env.BETTER_AUTH_TRUSTED_ORIGINS = 'http://localhost:3100';

import { VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BetterAuthService } from '../../src/modules/auth/better-auth/better-auth.service';

async function createMountedTestApp(): Promise<INestApplication> {
  const { AppModule } = await import('../../src/app.module');
  const { enableTrustedProxy } = await import('../../src/common/client-ip');
  const { ProblemDetailsFilter } = await import('../../src/common/problem-details.filter');
  const { mountBetterAuth } = await import('../../src/modules/auth/better-auth/better-auth.mount');
  const { BetterAuthService: BetterAuthServiceClass } = await import(
    '../../src/modules/auth/better-auth/better-auth.service'
  );
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  enableTrustedProxy(app as NestExpressApplication);
  const betterAuth: BetterAuthService = app.get(BetterAuthServiceClass);
  mountBetterAuth(app as NestExpressApplication, betterAuth.requireAuth());
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.init();
  return app;
}

const ORIGIN = 'http://localhost:3100';

describe('Better Auth — provider xã hội tắt êm khi thiếu env (e2e)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    app = await createMountedTestApp();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  it('app boot bình thường và provider google không khả dụng', async () => {
    const res = await request(server)
      .post('/api/v1/auth/sign-in/social')
      .set('Origin', ORIGIN)
      .send({ provider: 'google', callbackURL: '/dashboard' });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('accounts.google.com');
  });

  it('provider facebook cũng không khả dụng khi thiếu env', async () => {
    const res = await request(server)
      .post('/api/v1/auth/sign-in/social')
      .set('Origin', ORIGIN)
      .send({ provider: 'facebook', callbackURL: '/dashboard' });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('facebook.com');
  });
});

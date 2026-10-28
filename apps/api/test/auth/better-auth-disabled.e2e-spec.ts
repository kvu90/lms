import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, http, login } from '../support/identity-access-helpers';

/**
 * Cờ Better Auth TẮT (mặc định — trạng thái của mọi môi trường hiện
 * tại): handler của Better Auth không được mount nên đường
 * `/api/v1/auth/*` của nó là 404 của Nest, và đường auth hiện tại xử lý
 * mọi request nguyên vẹn (issue #7, Giai đoạn 1: rollback = tắt cờ /
 * gỡ mount + guard; trạng thái này phải luôn là trạng thái an toàn).
 */
describe('Better Auth disabled by default (issue #7 phase 1)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('does not mount the Better Auth handler', async () => {
    const res = await http(app).get('/api/v1/auth/get-session');
    expect(res.status).toBe(404);
  });

  it('the existing auth flow is untouched', async () => {
    const session = await login(app, 'admin', 'Admin123!');
    expect(session.accessToken).toBeTruthy();
    const me = await http(app).get('/api/v1/users/me').set('Authorization', `Bearer ${session.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe('admin');
  });
});

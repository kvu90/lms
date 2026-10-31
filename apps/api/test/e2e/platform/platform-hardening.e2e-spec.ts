import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, http, uniqueName } from '../../support/identity-access-helpers';

/**
 * Kiểm chứng lớp bảo vệ ở biên HTTP: header bảo mật trên mọi phản hồi và
 * giới hạn tốc độ hai lớp theo IP (gói chính thức @nestjs/throttler).
 * Toàn bộ suite dùng hạn mức nới rộng trong vitest.config; riêng file
 * này hạ hạn mức route xác thực xuống 3/phút để quan sát hành vi 429
 * thật. Hạn mức phải được đặt bằng vi.hoisted — chạy trước mọi import —
 * vì @nestjs/config chụp lại biến môi trường ngay khi module được nạp.
 */
vi.hoisted(() => {
  process.env.RATE_LIMIT_AUTH_PER_MINUTE = '3';
});

describe('Cứng hoá platform: header bảo mật và giới hạn tốc độ', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('response mang header bảo mật chuẩn, với CSP nghiêm ngặt trên route API có phiên bản', async () => {
    const res = await http(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('route thông tin đăng nhập bị giới hạn theo IP: lần đăng nhập thứ 4 trong một phút trả 429 Problem Details', async () => {
    const statuses: number[] = [];
    let lastBody: { status?: number; code?: string } = {};
    for (let i = 0; i < 4; i += 1) {
      // Mỗi lần một username không tồn tại khác nhau: cô lập hạn mức IP
      // khỏi cơ chế khoá tài khoản (vốn đếm theo từng tài khoản).
      const res = await http(app)
        .post('/api/v1/auth/token')
        .send({ username: uniqueName('ghost'), password: 'WrongPass1!' });
      statuses.push(res.status);
      lastBody = res.body as { status?: number; code?: string };
    }
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses[3]).toBe(429);
    expect(lastBody.status).toBe(429);
    // Các route không phải route xác thực không ăn hạn mức chặt này.
    const health = await http(app).get('/api/v1/health');
    expect(health.status).toBe(200);
  });

  it('route đăng nhập platform cũng chịu hạn mức xác thực chặt: lần đăng nhập thứ 4 trong một phút trả 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      // Mỗi lần một username không tồn tại khác nhau, như ca trên:
      // cô lập hạn mức IP khỏi cơ chế khoá theo tài khoản. Đường
      // đăng nhập platform kiểm chứng mật khẩu quản trị nên phải
      // chịu cùng hạn mức chặt với các route xác thực còn lại.
      const res = await http(app)
        .post('/api/v1/auth/platform/login')
        .send({ username: uniqueName('ghost-platform'), password: 'WrongPass1!' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses[3]).toBe(429);
  });
});

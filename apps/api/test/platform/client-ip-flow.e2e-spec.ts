import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, STRONG_PASSWORD } from '../support/identity-access-helpers';

/**
 * Flow: địa chỉ IP khách thật được ghi lên phiên khi app đứng sau
 * đúng một chặng proxy tin cậy (tiến trình web ở biên — xem
 * src/common/client-ip.ts).
 *
 * Cơ sở hành vi: chặng proxy ở biên nối IP gốc nó quan sát được vào
 * phía phải của `X-Forwarded-For`; Express với `trust proxy = 1`
 * lấy đúng phần tử phải nhất đó làm `req.ip`.
 * Ba kịch bản dưới đây khoá ba hệ quả: qua proxy thì ghi IP do
 * router nối thêm, khách không giả mạo được IP bằng cách tự chèn
 * thêm chặng vào đầu danh sách, và không qua proxy thì ghi địa chỉ
 * socket trực tiếp đã chuẩn hoá (không còn dạng `::ffff:`).
 */
describe('Client IP resolution behind the trusted proxy', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Đăng nhập lấy cặp token, rồi đọc IP đã ghi trên phiên hiện tại qua GET /auth/sessions. */
  async function loginAndReadSessionIp(username: string, forwardedFor?: string): Promise<string | null> {
    let loginReq = http(app).post('/api/v1/auth/token');
    if (forwardedFor !== undefined) loginReq = loginReq.set('X-Forwarded-For', forwardedFor);
    const loginRes = await loginReq.send({ username, password: STRONG_PASSWORD });
    expect(loginRes.status).toBe(201);
    const accessToken = loginRes.body.accessToken as string;

    const list = await http(app).get('/api/v1/auth/sessions').set('Authorization', `Bearer ${accessToken}`);
    expect(list.status).toBe(200);
    const sessions = list.body.sessions as { kind: string; current: boolean; ip: string | null }[];
    const current = sessions.find((s) => s.kind === 'api' && s.current);
    expect(current).toBeDefined();
    return current!.ip;
  }

  it('records the forwarded client IP when the request passes the trusted proxy', async () => {
    const user = await createUserViaApi(app, admin);
    const ip = await loginAndReadSessionIp(user.username, '203.0.113.55');
    expect(ip).toBe('203.0.113.55');
  });

  it('ignores spoofed left-side X-Forwarded-For entries and records the rightmost hop', async () => {
    const user = await createUserViaApi(app, admin);
    // Khách tự chèn 1.1.1.1 và 2.2.2.2; chặng phải nhất 198.51.100.23
    // là chặng "router" nối thêm — chỉ chặng đó mới được ghi.
    const ip = await loginAndReadSessionIp(user.username, '1.1.1.1, 2.2.2.2, 198.51.100.23');
    expect(ip).toBe('198.51.100.23');
  });

  it('records the normalized direct socket address when no X-Forwarded-For is present', async () => {
    const user = await createUserViaApi(app, admin);
    const ip = await loginAndReadSessionIp(user.username);
    expect(ip).toBe('127.0.0.1');
  });
});

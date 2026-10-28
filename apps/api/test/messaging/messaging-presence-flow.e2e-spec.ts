import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// QUAN TRỌNG: file này KHÔNG import tĩnh helpers/AppModule ở đầu —
// hai knob presence phải nằm trong process.env TRƯỚC khi đồ thị
// module (kèm ConfigModule.forRoot, nơi env được validate) được nạp,
// nên helpers được import động trong beforeAll sau khi gán env.

/**
 * Test hồi quy F2 của review Lớp A (issue #33): presence của messaging
 * sống trong Redis với TTL (mặc định 600s). Lỗi cũ: TTL chỉ đặt lúc
 * nối, không có cơ chế gia hạn — user còn nối và còn hoạt động vẫn bị
 * coi là offline khi TTL đầu tiên hết.
 *
 * Hai knob rút TTL xuống 3s và nhịp gia hạn xuống 300ms để test chạy
 * trong vài giây thay vì chờ 600s. Sau khi socket nối (presence đã
 * ghi), test còn rút TTL của khoá xuống 1.2s — tương đương "TTL gốc
 * đã trôi qua": có gia hạn thì khoá được nới lại trước khi hết và
 * còn tồn tại sau mốc đó; không có gia hạn (code cũ, knob bị bỏ qua
 * và không có vòng gia hạn nào) thì khoá biến mất dù socket vẫn nối.
 */

const PRESENCE_KEY_PREFIX = 'lms:messaging:presence:';

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Messaging presence TTL refresh (issue #33, F2)', () => {
  let app: INestApplication;
  let base: string;
  let redis: Redis;
  let user: { id: string; username: string };
  let token: string;

  beforeAll(async () => {
    process.env.MESSAGING_PRESENCE_TTL_SECONDS = '3';
    process.env.MESSAGING_PRESENCE_REFRESH_MS = '300';
    const helpers = await import('../support/identity-access-helpers');
    app = await helpers.createTestApp();
    const server = app.getHttpServer();
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    const admin = await helpers.adminToken(app);
    user = await helpers.createUserViaApi(app, admin);
    token = (await helpers.login(app, user.username, helpers.STRONG_PASSWORD)).accessToken;
  });

  afterAll(async () => {
    redis.disconnect();
    await app.close();
  });

  it('a still-connected user stays present after the initial TTL would have elapsed', async () => {
    const socket: Socket = io(`${base}/messaging`, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket connect timeout')), 8000);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
    });

    // TENANT-1 (#196): khoá presence mang đoạn tenant —
    // `lms:messaging:presence:{tenantId}:{userId}` — nên test tìm
    // khoá của đúng user theo mẫu thay vì dựng khoá cứng như trước.
    const keyPattern = `${PRESENCE_KEY_PREFIX}*:${user.id}`;
    const findKey = async (): Promise<string | null> => (await redis.keys(keyPattern))[0] ?? null;
    // Presence được ghi khi nối (chờ gateway xử lý xong).
    const deadline = Date.now() + 5000;
    let key = await findKey();
    while (key === null && Date.now() < deadline) {
      await sleep(100);
      key = await findKey();
    }
    expect(key).not.toBeNull();
    const presenceKey = key!;

    // Mô phỏng TTL gốc đã trôi qua: rút hạn khoá xuống 1.2s trong lúc
    // socket VẪN nối. Có gia hạn → khoá được nới lại trước khi hết;
    // không có → khoá chết ở 1.2s và user bị coi là offline.
    await redis.pexpire(presenceKey, 1200);
    await sleep(2600);
    expect(await redis.exists(presenceKey)).toBe(1);
    expect(await redis.pttl(presenceKey)).toBeGreaterThan(0);

    // Ngắt nối: presence bị gỡ và vòng gia hạn không hồi sinh nó.
    socket.disconnect();
    await sleep(700);
    expect(await redis.exists(presenceKey)).toBe(0);
  });
});

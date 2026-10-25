import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD,
} from './identity-access-helpers';

/**
 * Chặn lạm dụng đường gửi tin (lát M2, issue #212; chính sách P2 đã
 * chốt ở issue #33):
 *   (1) trần độ dài một tin đọc qua site-config
 *       `core/messagingmaxmessagelength` (mặc định 10.000) — đếm theo
 *       ký tự người dùng thấy (grapheme), vượt trần → 400
 *       `messaging.message_too_long`;
 *   (2) throttle gửi theo từng người dùng bằng Redis — cửa sổ bùng
 *       phát (`messagingsendburstlimit` tin /
 *       `messagingsendburstwindowseconds` giây) + cửa sổ duy trì
 *       (`messagingsendperminutelimit` tin/phút), mọi mức qua
 *       site-config; vượt → 429 `messaging.rate_limited`, hết cửa sổ
 *       thì gửi lại được.
 * Mỗi ca dùng một CẶP người dùng mới (kết bạn + hội thoại 1–1 riêng)
 * nên bộ đếm throttle theo userId không rò giữa các ca; mọi ghi đè
 * site-config đều được xoá trong finally/afterAll để không rò sang
 * spec khác (suite chạy tuần tự theo file nhưng dùng chung DB/Redis).
 */

interface Person { id: string; username: string; token: string }

const OVERRIDDEN_SETTINGS = [
  'messagingmaxmessagelength',
  'messagingsendburstlimit',
  'messagingsendburstwindowseconds',
  'messagingsendperminutelimit',
] as const;

describe('Messaging — trần độ dài + throttle gửi tin (M2, issue #212)', () => {
  let app: INestApplication;
  let admin: string;

  async function person(): Promise<Person> {
    const u = await createUserViaApi(app, admin);
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, username: u.username, token: session.accessToken };
  }

  /** Hai người dùng mới đã là liên hệ của nhau + hội thoại 1–1 của họ. */
  async function pair(): Promise<{ a: Person; b: Person; conversationId: string }> {
    const a = await person();
    const b = await person();
    const req = await http(app).post(`/api/v1/messages/contacts/${b.id}`).set('Authorization', `Bearer ${a.token}`).send({});
    expect(req.status).toBe(201);
    const accept = await http(app).post(`/api/v1/messages/contacts/requests/${a.id}/accept`).set('Authorization', `Bearer ${b.token}`).send({});
    expect(accept.status).toBe(201);
    const created = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${a.token}`)
      .send({ type: 1, memberIds: [b.id] });
    expect(created.status).toBe(201);
    return { a, b, conversationId: created.body.id as string };
  }

  async function send(token: string, conversationId: string, text: string, clientMessageId?: string) {
    return http(app).post(`/api/v1/messages/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send(clientMessageId ? { text, clientMessageId } : { text });
  }

  async function setSetting(name: string, value: number) {
    const res = await http(app).put(`/api/v1/site-config/core/${name}`)
      .set('Authorization', `Bearer ${admin}`).send({ value });
    expect(res.status).toBe(200);
  }

  async function clearSetting(name: string) {
    await http(app).delete(`/api/v1/site-config/core/${name}`).set('Authorization', `Bearer ${admin}`);
  }

  async function clearAllSettings() {
    for (const name of OVERRIDDEN_SETTINGS) await clearSetting(name);
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    await clearAllSettings();
  });

  afterAll(async () => {
    await clearAllSettings();
    await app.close();
  });

  it('1. tin đúng trần mặc định 10.000 ký tự gửi được; vượt 1 ký tự → 400 messaging.message_too_long', async () => {
    const { a, conversationId } = await pair();
    const atCap = await send(a.token, conversationId, 'a'.repeat(10000));
    expect(atCap.status).toBe(201);
    const overCap = await send(a.token, conversationId, 'a'.repeat(10001));
    expect(overCap.status).toBe(400);
    expect(overCap.body.code).toBe('messaging.message_too_long');
  });

  it('2. đếm theo grapheme: 6.000 emoji (24.000 byte) và 10.000 chữ tổ hợp gửi được; 10.001 emoji → 400', async () => {
    const { a, conversationId } = await pair();
    const emoji = await send(a.token, conversationId, '👍'.repeat(6000));
    expect(emoji.status).toBe(201);
    // 'ế' dạng tổ hợp = 2 code point nhưng 1 ký tự người dùng thấy.
    const combining = await send(a.token, conversationId, 'e\u0301'.repeat(10000));
    expect(combining.status).toBe(201);
    const emojiOver = await send(a.token, conversationId, '👍'.repeat(10001));
    expect(emojiOver.status).toBe(400);
    expect(emojiOver.body.code).toBe('messaging.message_too_long');
  });

  it('3. đổi site-config là đổi hành vi trần: đặt 5 thì 6 ký tự bị 400; đặt 0 thì tắt trần', async () => {
    const { a, conversationId } = await pair();
    await setSetting('messagingmaxmessagelength', 5);
    try {
      const over = await send(a.token, conversationId, '123456');
      expect(over.status).toBe(400);
      expect(over.body.code).toBe('messaging.message_too_long');
      const atCap = await send(a.token, conversationId, '12345');
      expect(atCap.status).toBe(201);
    } finally {
      await clearSetting('messagingmaxmessagelength');
    }
    await setSetting('messagingmaxmessagelength', 0);
    try {
      const long = await send(a.token, conversationId, 'a'.repeat(10001));
      expect(long.status).toBe(201);
    } finally {
      await clearSetting('messagingmaxmessagelength');
    }
  });

  it('4. throttle bùng phát: vượt ngưỡng → 429 messaging.rate_limited, hết cửa sổ gửi lại được; lượt bị 429 không đốt thêm quota', async () => {
    await setSetting('messagingsendburstlimit', 3);
    await setSetting('messagingsendburstwindowseconds', 2);
    await setSetting('messagingsendperminutelimit', 0);
    try {
      const { a, b, conversationId } = await pair();
      for (let i = 0; i < 3; i += 1) {
        const ok = await send(a.token, conversationId, `tin bùng phát ${i}`);
        expect(ok.status).toBe(201);
      }
      const limited = await send(a.token, conversationId, 'tin thứ tư trong cửa sổ');
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('messaging.rate_limited');
      // Người còn lại trong cùng hội thoại KHÔNG bị dính throttle của
      // người gửi (bộ đếm theo từng người dùng).
      const other = await send(b.token, conversationId, 'tin của người còn lại');
      expect(other.status).toBe(201);
      // Hết cửa sổ 2 giây → gửi lại được.
      await new Promise((resolve) => { setTimeout(resolve, 2300); });
      const afterWindow = await send(a.token, conversationId, 'tin sau cửa sổ');
      expect(afterWindow.status).toBe(201);
    } finally {
      await clearAllSettings();
    }
  });

  it('5. throttle duy trì theo phút: trần 2 tin/phút thì tin thứ ba → 429', async () => {
    await setSetting('messagingsendburstlimit', 0);
    await setSetting('messagingsendperminutelimit', 2);
    try {
      const { a, conversationId } = await pair();
      for (let i = 0; i < 2; i += 1) {
        const ok = await send(a.token, conversationId, `tin duy trì ${i}`);
        expect(ok.status).toBe(201);
      }
      const limited = await send(a.token, conversationId, 'tin thứ ba trong phút');
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('messaging.rate_limited');
    } finally {
      await clearAllSettings();
    }
  });

  it('6. gửi lại trùng clientMessageId trả tin cũ, không tốn quota throttle', async () => {
    await setSetting('messagingsendburstlimit', 1);
    await setSetting('messagingsendburstwindowseconds', 30);
    await setSetting('messagingsendperminutelimit', 0);
    try {
      const { a, conversationId } = await pair();
      const first = await send(a.token, conversationId, 'tin gửi lạc quan', 'm2-retry-1');
      expect(first.status).toBe(201);
      // Trần burst = 1 đã cạn, nhưng lượt THỬ LẠI cùng khoá phải trả
      // chính tin đã lưu (điểm trả trùng nằm trước cổng throttle).
      const retry = await send(a.token, conversationId, 'tin gửi lạc quan', 'm2-retry-1');
      expect(retry.status).toBe(201);
      expect(retry.body.id).toBe(first.body.id);
      // Tin MỚI khác khoá thì chạm trần thật.
      const fresh = await send(a.token, conversationId, 'tin mới khác', 'm2-retry-2');
      expect(fresh.status).toBe(429);
      expect(fresh.body.code).toBe('messaging.rate_limited');
    } finally {
      await clearAllSettings();
    }
  });
});

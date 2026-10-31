import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD,
} from '../../support/identity-access-helpers';

/**
 * Lát M5 — GHIM / LƯU TRỮ / TẮT TIẾNG theo hội thoại (issue #240).
 * Các ca kiểm chứng đúng luồng nghiệp vụ đã chốt:
 *  - ghim: hội thoại đã ghim lên đầu danh sách của CHÍNH người ghim
 *    và giữ nguyên qua các lần tải lại; thứ tự trong nhóm ghim vẫn
 *    theo hoạt động gần nhất; trạng thái là của từng thành viên —
 *    phía còn lại không đổi;
 *  - lưu trữ: biến mất khỏi danh sách chính của người lưu, chỉ còn ở
 *    mục đã lưu; có tin mới từ phía kia thì TỰ HIỆN LẠI ở danh sách
 *    chính (quyết định đã chốt ở sổ);
 *  - tắt tiếng: tin vẫn tới và vẫn đếm chưa đọc trong danh sách,
 *    nhưng huy hiệu điều hướng không tính hội thoại này. Cổng thông
 *    báo `message_new` theo cờ tắt tiếng (consumer không sinh thông
 *    báo cho thành viên đã tắt tiếng; bỏ tắt tiếng thì thông báo
 *    trở lại) được kiểm chứng ở tầng integration của worker, nơi
 *    consumer thông báo sự kiện đang chạy (issue con #520 của #491);
 *  - cổng: người ngoài đặt trạng thái → 404 như hội thoại không tồn
 *    tại; PATCH từng phần chỉ đổi đúng cờ được gửi.
 */

interface Person { id: string; username: string; token: string }

interface ConversationListEntry {
  id: string;
  unread: number;
  pinnedAt: string | null;
  archivedAt: string | null;
  muted: boolean;
}

let app: INestApplication;
let admin: string;

async function person(): Promise<Person> {
  const created = await createUserViaApi(app, admin);
  const session = await login(app, created.username, STRONG_PASSWORD);
  return { id: created.id, username: created.username, token: session.accessToken };
}

async function befriend(a: Person, b: Person): Promise<void> {
  const req = await http(app).post(`/api/v1/messages/contacts/${b.id}`)
    .set('Authorization', `Bearer ${a.token}`).send({});
  expect(req.status).toBe(201);
  const accept = await http(app).post(`/api/v1/messages/contacts/requests/${a.id}/accept`)
    .set('Authorization', `Bearer ${b.token}`).send({});
  expect(accept.status).toBe(201);
}

async function openConversation(a: Person, b: Person): Promise<string> {
  const res = await http(app).post('/api/v1/messages/conversations')
    .set('Authorization', `Bearer ${a.token}`).send({ type: 1, memberIds: [b.id] });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function send(token: string, conversationId: string, text: string) {
  const res = await http(app).post(`/api/v1/messages/conversations/${conversationId}/messages`)
    .set('Authorization', `Bearer ${token}`).send({ text });
  expect(res.status).toBe(201);
  return res.body;
}

async function listConversations(token: string, archived = false): Promise<ConversationListEntry[]> {
  const res = await http(app).get(`/api/v1/messages/conversations${archived ? '?archived=true' : ''}`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body as ConversationListEntry[];
}

async function setState(token: string, conversationId: string, patch: Record<string, unknown>) {
  return http(app).patch(`/api/v1/messages/conversations/${conversationId}/state`)
    .set('Authorization', `Bearer ${token}`).send(patch);
}

async function unreadConversationCount(token: string): Promise<number> {
  const res = await http(app).get('/api/v1/messages/unread-count')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body.conversations as number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Messaging M5 — ghim / lưu trữ / tắt tiếng theo hội thoại (issue #240)', () => {
  let a: Person; let b: Person; let d: Person; let outsider: Person;
  let convB: string; let convD: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    a = await person();
    b = await person();
    d = await person();
    outsider = await person();
    await befriend(a, b);
    await befriend(a, d);
    convB = await openConversation(a, b);
    convD = await openConversation(a, d);
  });

  afterAll(async () => { await app.close(); });

  it('ghim: hội thoại đã ghim lên đầu và giữ thứ tự qua tải lại; trạng thái chỉ của người ghim', async () => {
    // Hoạt động gần nhất ở convD → danh sách chính của A: convD trước, convB sau.
    await send(b.token, convB, 'tin ở hội thoại B');
    await sleep(30);
    await send(d.token, convD, 'tin ở hội thoại D');
    let list = await listConversations(a.token);
    expect(list.map((c) => c.id)).toEqual([convD, convB]);
    expect(list.every((c) => c.pinnedAt === null && c.muted === false && c.archivedAt === null)).toBe(true);

    // A ghim convB → convB lên đầu dù hoạt động cũ hơn.
    const patched = await setState(a.token, convB, { pinned: true });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ conversationId: convB, pinned: true, archived: false, muted: false });
    expect(typeof patched.body.pinnedAt).toBe('string');

    list = await listConversations(a.token);
    expect(list.map((c) => c.id)).toEqual([convB, convD]);
    // Tải lại lần nữa — thứ tự ghim vẫn giữ (không phải hiệu ứng tạm).
    list = await listConversations(a.token);
    expect(list.map((c) => c.id)).toEqual([convB, convD]);

    // Trạng thái là của TỪNG thành viên: phía B và D không bị chạm.
    const listB = await listConversations(b.token);
    expect(listB.find((c) => c.id === convB)).toMatchObject({ pinnedAt: null, muted: false, archivedAt: null });
    const listD = await listConversations(d.token);
    expect(listD.find((c) => c.id === convD)).toMatchObject({ pinnedAt: null, muted: false, archivedAt: null });

    // Bỏ ghim → thứ tự trở lại theo hoạt động.
    const unpinned = await setState(a.token, convB, { pinned: false });
    expect(unpinned.status).toBe(200);
    expect(unpinned.body).toMatchObject({ pinned: false, pinnedAt: null });
    list = await listConversations(a.token);
    expect(list.map((c) => c.id)).toEqual([convD, convB]);
  });

  it('lưu trữ: ẩn khỏi danh sách chính, còn ở mục đã lưu; tin mới từ phía kia thì tự hiện lại', async () => {
    const archived = await setState(a.token, convD, { archived: true });
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ archived: true });
    expect(typeof archived.body.archivedAt).toBe('string');

    let main = await listConversations(a.token);
    expect(main.map((c) => c.id)).toEqual([convB]);
    const stored = await listConversations(a.token, true);
    expect(stored.map((c) => c.id)).toEqual([convD]);

    // Phía D không hề biết A đã lưu: danh sách chính của D vẫn có convD.
    const listD = await listConversations(d.token);
    expect(listD.map((c) => c.id)).toContain(convD);

    // Tin mới từ D → hội thoại tự hiện lại ở danh sách chính của A.
    await send(d.token, convD, 'tin mới kéo hội thoại đã lưu trở lại');
    main = await listConversations(a.token);
    expect(main.map((c) => c.id)).toContain(convD);
    expect(main.find((c) => c.id === convD)).toMatchObject({ archivedAt: null });
    const storedAfter = await listConversations(a.token, true);
    expect(storedAfter.map((c) => c.id)).not.toContain(convD);

    // Bỏ lưu bằng tay cũng đưa hội thoại về danh sách chính.
    await setState(a.token, convD, { archived: true });
    const unarchived = await setState(a.token, convD, { archived: false });
    expect(unarchived.body).toMatchObject({ archived: false, archivedAt: null });
    main = await listConversations(a.token);
    expect(main.map((c) => c.id)).toContain(convD);
  });

  it('PATCH từng phần chỉ đổi đúng cờ được gửi; người ngoài và hội thoại không tồn tại đều 404', async () => {
    await setState(a.token, convB, { pinned: true });
    const mutedOnly = await setState(a.token, convB, { muted: true });
    expect(mutedOnly.status).toBe(200);
    // Ghim đặt trước đó không bị PATCH tắt tiếng chạm vào.
    expect(mutedOnly.body).toMatchObject({ pinned: true, muted: true, archived: false });
    const entry = (await listConversations(a.token)).find((c) => c.id === convB);
    expect(entry).toMatchObject({ muted: true });
    expect(entry?.pinnedAt).not.toBeNull();
    await setState(a.token, convB, { pinned: false, muted: false });

    // Người ngoài cuộc trò chuyện: 404 như hội thoại không tồn tại.
    const byOutsider = await setState(outsider.token, convB, { pinned: true });
    expect(byOutsider.status).toBe(404);
    expect(byOutsider.body.code).toBe('messaging.conversation_not_found');

    // Hội thoại không tồn tại: cùng 404, cùng mã.
    const missing = await setState(a.token, '01900000-0000-7000-8000-000000000000', { muted: true });
    expect(missing.status).toBe(404);

    // Kiểu sai bị schema từ chối 400 — không âm thầm đổi trạng thái.
    const wrongType = await setState(a.token, convB, { pinned: 'yes' });
    expect(wrongType.status).toBe(400);
    const after = (await listConversations(a.token)).find((c) => c.id === convB);
    expect(after).toMatchObject({ pinnedAt: null, muted: false });
  });

  it('tắt tiếng: huy hiệu và danh sách đều không đếm tin chưa đọc của hội thoại đã tắt tiếng (vũ trụ chuẩn #592)', async () => {
    // Đọc hết hai hội thoại để mốc huy hiệu về 0.
    for (const convId of [convB, convD]) {
      const read = await http(app).post(`/api/v1/messages/conversations/${convId}/read`)
        .set('Authorization', `Bearer ${a.token}`).send({});
      expect(read.status).toBe(201);
    }
    expect(await unreadConversationCount(a.token)).toBe(0);

    // A tắt tiếng convB, B gửi tin mới.
    await setState(a.token, convB, { muted: true });
    await send(b.token, convB, 'tin trong hội thoại đã tắt tiếng');
    await sleep(30);
    await send(d.token, convD, 'tin trong hội thoại bình thường');

    // Huy hiệu chỉ tính hội thoại KHÔNG tắt tiếng (convD).
    expect(await unreadConversationCount(a.token)).toBe(1);

    // Trong danh sách, convB hiện cờ muted nhưng số chưa đọc bằng 0
    // theo vũ trụ chuẩn duy nhất (issue #592) — tin vẫn tới, mốc đã
    // đọc không đổi, chỉ số đếm là 0 cho tới khi bật lại tiếng.
    const list = await listConversations(a.token);
    expect(list.find((c) => c.id === convB)).toMatchObject({ muted: true, unread: 0 });
    expect(list.find((c) => c.id === convD)).toMatchObject({ muted: false, unread: 1 });

    // Bỏ tắt tiếng → huy hiệu tính lại cả convB.
    await setState(a.token, convB, { muted: false });
    expect(await unreadConversationCount(a.token)).toBe(2);
  });

  it('tắt tiếng: tin vẫn tới và đọc được bình thường trong hội thoại đã tắt tiếng', async () => {
    // Phần cổng thông báo của ca này (thành viên đã tắt tiếng không
    // nhận message_new, bỏ tắt tiếng thì thông báo trở lại) đã chuyển
    // cùng consumer sang tầng integration của worker (issue con #520
    // của #491). Ở tầng API chỉ còn khẳng định phần hành vi của chính
    // API: tắt tiếng không chặn đường tin — tin gửi vào hội thoại đã
    // tắt tiếng vẫn được lưu và đọc lại đầy đủ.
    await setState(a.token, convD, { muted: true });
    await send(d.token, convD, 'tin khi đang tắt tiếng 1');
    await send(d.token, convD, 'tin khi đang tắt tiếng 2');

    const detail = await http(app).get(`/api/v1/messages/conversations/${convD}`)
      .set('Authorization', `Bearer ${a.token}`);
    expect(detail.status).toBe(200);
    const texts = (detail.body.messages as { fullMessage: string }[]).map((m) => m.fullMessage);
    expect(texts).toContain('tin khi đang tắt tiếng 1');
    expect(texts).toContain('tin khi đang tắt tiếng 2');

    await setState(a.token, convD, { muted: false });
  });
});

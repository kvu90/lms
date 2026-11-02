import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCentreKysely, type CentreDb } from '../client';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { MessagingRepository, type MessagingStorePort } from './messaging';

/**
 * Spec tích hợp của repository nhắn tin trên Kysely (issue #658).
 *
 * Database trung tâm dựng từ rỗng bằng chính cầu nối migration
 * của package trên cụm PostgreSQL thật của môi trường test. Mọi
 * ca chạy qua repository production ở `messaging.ts` — không mô
 * phỏng handle.
 *
 * Phạm vi khoá ở đây (bề mặt NATIVE của repository):
 * - Conversation + thành viên + cấp seq trong transaction (kèm
 *   rollback trọn vẹn khi hàm giao dịch ném lỗi) và insert bỏ
 *   khoá chính với id uuidv7 do database sinh (phụ lục U).
 * - Vòng đời tin: chèn/đọc theo khoá chống trùng, xoá mềm, thu
 *   hồi, xoá cứng, cờ xoá-phía-mình, tìm ILIKE có thoát ký tự
 *   mẫu, dấu vết kiểm duyệt.
 * - Danh sách hội thoại một truy vấn (lateral): số chưa đọc theo
 *   vũ trụ chuẩn (tắt tiếng → 0), tin cuối, lọc đã lưu trữ, ẩn
 *   hội thoại 1–1 khi có quan hệ chặn.
 * - Hai trang roster bằng SQL thô (khoá + lớp): thứ tự trang,
 *   phân trang con trỏ, loại tài khoản đã xoá/tạm ngưng/chính
 *   người xem/phía chặn.
 * - Cụm notification: đủ 9 method nhận `tenantId` tường minh —
 *   có tenant thì lọc đúng tenant đó, không truyền thì không lọc
 *   (đúng ngữ nghĩa chỗ đọc ALS cũ); danh sách GỘP là ca kết quả
 *   thật của khuôn `sql.join` T-11 (gộp theo loại × nguồn ×
 *   ngày Asia/Ho_Chi_Minh, lọc theo tập loại, unreadOnly qua
 *   HAVING, phân trang keyset qua cursor), danh sách phẳng +
 *   đánh dấu đã đọc theo khoá gộp.
 * - Nhật ký dispatch: doNothing theo `dedupe_key` + đọc lại đúng
 *   dòng đã ghi.
 *
 * Các method UỶ QUYỀN qua cổng {@link MessagingStorePort} (đọc
 * dùng chung: cửa sổ tin, đếm chưa đọc một conversation, gắn
 * trích dẫn, danh sách chặn...) là passthrough một dòng — SQL
 * của chúng sống tại `packages/messaging` và được khoá bởi bộ
 * e2e/spec messaging phía API qua đúng wiring production
 * (factory dựng repository với `createMessagingStore`), nên
 * spec này gắn cổng bằng bản giả ném lỗi: method native nào lỡ
 * gọi cổng sẽ fail rõ ràng thay vì lặng lẽ qua.
 */

const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : undefined);

const TEST_DB = 'lms_db_g658_messaging';

const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Cổng store giả cho spec này: bề mặt native không được phép chạm cổng (xem ghi chú đầu file). */
const unusedStore: MessagingStorePort = new Proxy({} as MessagingStorePort, {
  get: () => () => {
    throw new Error('Spec tích hợp #658 chỉ kiểm bề mặt native — method uỷ quyền qua cổng không thuộc phạm vi này.');
  },
});

let pool: Pool;
let db: CentreDb;
let repo: MessagingRepository;

const userA = randomUUID();
const userB = randomUUID();
const userC = randomUUID();
let tenantId: string;
let otherTenantId: string;

/** Gieo một user tối thiểu cho các ca cần dòng `users` thật (roster). */
async function seedUser(id: string, username: string, firstName: string, lastName: string): Promise<void> {
  await db
    .insertInto('users')
    .values({ id, username, email: `${username}@example.test`, first_name: firstName, last_name: lastName })
    .execute();
}

/** Gieo một notification với mốc tạo tường minh (điều khiển ngày/giờ cho ca gộp + keyset). */
async function seedNotification(v: {
  userIdTo: string;
  tenantId?: string | null;
  eventType: string;
  component?: string;
  contextUrl?: string | null;
  createdAt: Date;
  timeRead?: Date | null;
}): Promise<string> {
  const row = await db
    .insertInto('notifications')
    .values({
      user_id_to: v.userIdTo,
      tenant_id: v.tenantId ?? null,
      event_type: v.eventType,
      component: v.component ?? 'core_message',
      context_url: v.contextUrl ?? null,
      created_at: v.createdAt,
      time_read: v.timeRead ?? null,
      subject: 's',
      full_message: 'f',
      small_message: 'f',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

beforeAll(async () => {
  if (!adminUrl) {
    throw new Error('Thiếu kết nối quản trị cho spec Kysely #658: đặt LMS_DB_TEST_ADMIN_URL hoặc DATABASE_URL.');
  }
  const storeUrl = await buildTestDatabase({ adminUrl, database: TEST_DB, store: 'centre' });
  pool = new Pool({ connectionString: storeUrl });
  db = createCentreKysely(pool);
  repo = new MessagingRepository(db, unusedStore);

  const tenant = await db
    .insertInto('tenants')
    .values({ slug: 'g658-messaging', name: 'Trung tâm spec messaging', kind: 'center', status: 'active' })
    .returning('id')
    .executeTakeFirstOrThrow();
  tenantId = tenant.id;
  const otherTenant = await db
    .insertInto('tenants')
    .values({ slug: 'g658-messaging-other', name: 'Trung tâm spec messaging khác', kind: 'center', status: 'active' })
    .returning('id')
    .executeTakeFirstOrThrow();
  otherTenantId = otherTenant.id;

  await seedUser(userA, 'g658-an', 'An', 'Nguyen');
  await seedUser(userB, 'g658-binh', 'Binh', 'Tran');
  await seedUser(userC, 'g658-chi', 'Chi', 'Le');
}, 180_000);

afterAll(async () => {
  if (db) await db.destroy().catch(() => undefined);
  if (pool) await pool.end().catch(() => undefined);
  if (adminUrl) await dropTestDatabase(adminUrl, TEST_DB);
});

describe('conversation, thành viên và cấp seq', () => {
  it('chèn conversation bỏ khoá chính: id trả về khớp uuidv7 và đọc lại đúng các trường đã ghi', async () => {
    const row = await repo.insertConversation({ type: 2, name: 'Nhóm spec', createdBy: userA, tenantId });
    expect(row.id).toMatch(UUIDV7_RE);
    expect(row.type).toBe(2);
    expect(row.name).toBe('Nhóm spec');
    expect(row.enabled).toBe(true);
    expect(row.lastMessageSeq).toBe(0);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.tenantId).toBe(tenantId);
  });

  it('thêm thành viên hai lần không trùng (onConflict doNothing), isMember và removeMember giữ đúng hợp đồng', async () => {
    const conv = await repo.insertConversation({ type: 2, name: 'Nhóm thành viên' });
    await repo.addMember(conv.id, userA);
    await repo.addMember(conv.id, userA);
    await repo.addMember(conv.id, userB);
    await expect(repo.isMember(conv.id, userA)).resolves.toBe(true);
    await expect(repo.isMember(conv.id, userC)).resolves.toBe(false);
    await repo.removeMember(conv.id, userB);
    await expect(repo.isMember(conv.id, userB)).resolves.toBe(false);
  });

  it('cấp seq tăng đều trong transaction và transaction ném lỗi thì rollback cả seq lẫn tin', async () => {
    const conv = await repo.insertConversation({ type: 2, name: 'Nhóm seq' });
    const first = await repo.transaction(async (tx) => {
      const seq = await repo.allocateNextSeq(conv.id, tx);
      return repo.insertMessage({ conversationId: conv.id, userIdFrom: userA, seq, fullMessage: 'tin một' }, tx);
    });
    expect(first.seq).toBe(1);
    await expect(
      repo.transaction(async (tx) => {
        const seq = await repo.allocateNextSeq(conv.id, tx);
        await repo.insertMessage({ conversationId: conv.id, userIdFrom: userA, seq, fullMessage: 'tin huỷ' }, tx);
        throw new Error('huỷ giao dịch');
      }),
    ).rejects.toThrow('huỷ giao dịch');
    const after = await repo.transaction(async (tx) => repo.allocateNextSeq(conv.id, tx));
    expect(after).toBe(2);
    const byClient = await repo.getMessageByClientId(conv.id, userA, 'khong-co');
    expect(byClient).toBeUndefined();
  });

  it('tra tin theo khoá chống trùng (conversation, người gửi, clientMessageId) trả đúng tin đã lưu', async () => {
    const conv = await repo.insertConversation({ type: 1 });
    await repo.insertMessage({
      conversationId: conv.id, userIdFrom: userA, seq: 1, fullMessage: 'xin chào', clientMessageId: 'client-1',
    });
    const found = await repo.getMessageByClientId(conv.id, userA, 'client-1');
    expect(found?.fullMessage).toBe('xin chào');
    await expect(repo.getMessageByClientId(conv.id, userB, 'client-1')).resolves.toBeUndefined();
  });
});

describe('vòng đời tin nhắn', () => {
  it('xoá mềm giữ nội dung + dấu vết, thu hồi chỉ đặt dấu, xoá cứng gỡ hẳn dòng và dấu vết kiểm duyệt vẫn còn', async () => {
    const conv = await repo.insertConversation({ type: 2 });
    const msg = await repo.insertMessage({ conversationId: conv.id, userIdFrom: userA, seq: 1, fullMessage: 'nội dung gốc' });
    await repo.insertModeratorAction({
      messageId: msg.id, conversationId: conv.id, actorId: userB, authorId: userA, action: 'recall', messageSeq: 1,
    });
    const recalled = await repo.applyRecall(msg.id, userA);
    expect(recalled?.recalledAt).toBeInstanceOf(Date);
    expect(recalled?.fullMessage).toBe('nội dung gốc');
    const softDeleted = await repo.softDeleteMessage(msg.id, userB);
    expect(softDeleted?.deletedAt).toBeInstanceOf(Date);
    expect(softDeleted?.deletedBy).toBe(userB);
    await repo.hardDeleteMessage(msg.id);
    const actions = await repo.listModeratorActionsForMessage(msg.id);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.action).toBe('recall');
  });

  it('cờ xoá-phía-mình đặt hai lần là no-op và đọc lại đúng trạng thái', async () => {
    const conv = await repo.insertConversation({ type: 2 });
    const msg = await repo.insertMessage({ conversationId: conv.id, userIdFrom: userA, seq: 1, fullMessage: 'tin cờ' });
    await repo.markDeletedForUser(msg.id, userB);
    await repo.markDeletedForUser(msg.id, userB);
    await expect(repo.isDeletedForUser(msg.id, userB)).resolves.toBe(true);
    await expect(repo.isDeletedForUser(msg.id, userA)).resolves.toBe(false);
  });

  it('tìm tin bằng ILIKE thoát ký tự mẫu: dấu % trong truy vấn khớp đúng nghĩa chuỗi con', async () => {
    const conv = await repo.insertConversation({ type: 2 });
    await repo.insertMessage({ conversationId: conv.id, userIdFrom: userA, seq: 1, fullMessage: 'giảm 50% hôm nay' });
    await repo.insertMessage({ conversationId: conv.id, userIdFrom: userA, seq: 2, fullMessage: 'giảm 500 đồng' });
    const hits = await repo.searchMessages(conv.id, { query: '50%' });
    expect(hits.map((h) => h.seq)).toEqual([1]);
    const all = await repo.searchMessages(conv.id, { query: 'GIẢM' });
    expect(all.map((h) => h.seq)).toEqual([2, 1]);
  });

  it('tìm tin của người thường loại tin đã xoá mềm và tin chính họ xoá-phía-mình; privileged thấy cả hai', async () => {
    const conv = await repo.insertConversation({ type: 2 });
    const m1 = await repo.insertMessage({ conversationId: conv.id, userIdFrom: userB, seq: 1, fullMessage: 'khoá học hay' });
    const m2 = await repo.insertMessage({ conversationId: conv.id, userIdFrom: userB, seq: 2, fullMessage: 'khoá học dở' });
    await repo.softDeleteMessage(m1.id, userB);
    await repo.markDeletedForUser(m2.id, userA);
    const normal = await repo.searchMessages(conv.id, { query: 'khoá học', viewerId: userA });
    expect(normal).toHaveLength(0);
    const privileged = await repo.searchMessages(conv.id, { query: 'khoá học', privileged: true });
    expect(privileged.map((h) => h.seq)).toEqual([2, 1]);
  });
});

describe('danh sách hội thoại một truy vấn (lateral)', () => {
  it('số chưa đọc theo vũ trụ chuẩn: tắt tiếng trả 0, tin cuối là tin mới nhất còn hiển thị, lọc lưu trữ tách bạch', async () => {
    const conv = await repo.insertConversation({ type: 2, name: 'Nhóm tóm tắt' });
    await repo.addMember(conv.id, userA);
    await repo.addMember(conv.id, userB);
    await repo.insertMessage({ conversationId: conv.id, userIdFrom: userB, seq: 1, fullMessage: 'một' });
    await repo.insertMessage({ conversationId: conv.id, userIdFrom: userB, seq: 2, fullMessage: 'hai' });

    const summaries = await repo.listConversationSummaries(userA);
    const mine = summaries.find((s) => s.conversation.id === conv.id);
    expect(mine?.unreadCount).toBe(2);
    expect(mine?.lastMessage?.fullMessage).toBe('hai');
    expect(mine?.members.sort()).toEqual([userA, userB].sort());

    await repo.updateMemberConversationState(conv.id, userA, { muted: true });
    const mutedSummaries = await repo.listConversationSummaries(userA);
    expect(mutedSummaries.find((s) => s.conversation.id === conv.id)?.unreadCount).toBe(0);

    await repo.updateMemberConversationState(conv.id, userA, { archived: true });
    const active = await repo.listConversationSummaries(userA);
    expect(active.find((s) => s.conversation.id === conv.id)).toBeUndefined();
    const archived = await repo.listConversationSummaries(userA, { archivedOnly: true });
    expect(archived.find((s) => s.conversation.id === conv.id)?.archivedAt).toBeInstanceOf(Date);
  });

  it('hội thoại 1–1 bị ẩn khỏi danh sách của cả hai phía khi có quan hệ chặn ở bất kỳ chiều nào', async () => {
    const conv = await repo.insertConversation({ type: 1 });
    await repo.addMember(conv.id, userA);
    await repo.addMember(conv.id, userC);
    const before = await repo.listConversationSummaries(userA);
    expect(before.some((s) => s.conversation.id === conv.id)).toBe(true);
    await repo.block(userA, userC);
    const after = await repo.listConversationSummaries(userA);
    expect(after.some((s) => s.conversation.id === conv.id)).toBe(false);
    const otherSide = await repo.listConversationSummaries(userC);
    expect(otherSide.some((s) => s.conversation.id === conv.id)).toBe(false);
    await repo.unblock(userA, userC);
    const restored = await repo.listConversationSummaries(userA);
    expect(restored.some((s) => s.conversation.id === conv.id)).toBe(true);
  });

  it('đếm conversation chưa đọc bỏ qua hội thoại đã tắt tiếng và hội thoại 1–1 đang bị chặn ẩn', async () => {
    const conv = await repo.insertConversation({ type: 2, name: 'Nhóm đếm' });
    await repo.addMember(conv.id, userB);
    await repo.addMember(conv.id, userC);
    await repo.insertMessage({ conversationId: conv.id, userIdFrom: userB, seq: 1, fullMessage: 'đếm' });
    const before = await repo.countUnreadConversations(userC);
    expect(before).toBeGreaterThanOrEqual(1);
    await repo.updateMemberConversationState(conv.id, userC, { muted: true });
    const afterMute = await repo.countUnreadConversations(userC);
    expect(afterMute).toBe(before - 1);
  });
});

describe('cụm notification và tham số tenant tường minh', () => {
  const reader = randomUUID();

  beforeAll(async () => {
    // Hai ngày lịch khác nhau theo Asia/Ho_Chi_Minh: 2026-10-01 10:00
    // +07 = 03:00Z; 2026-10-02 10:00 +07 = 03:00Z ngày kế.
    const day1 = new Date('2026-10-01T03:00:00.000Z');
    const day1Later = new Date('2026-10-01T04:00:00.000Z');
    const day2 = new Date('2026-10-02T03:00:00.000Z');
    await seedNotification({ userIdTo: reader, tenantId, eventType: 'message_new', contextUrl: '/conv/1', createdAt: day1 });
    await seedNotification({ userIdTo: reader, tenantId, eventType: 'message_new', contextUrl: '/conv/1', createdAt: day1Later, timeRead: day1Later });
    await seedNotification({ userIdTo: reader, tenantId, eventType: 'message_new', contextUrl: '/conv/1', createdAt: day2 });
    await seedNotification({ userIdTo: reader, tenantId, eventType: 'grade_updated', contextUrl: null, createdAt: day2 });
    await seedNotification({ userIdTo: reader, tenantId: otherTenantId, eventType: 'message_new', contextUrl: '/conv/9', createdAt: day2 });
    await seedNotification({ userIdTo: reader, tenantId: null, eventType: 'message_new', contextUrl: '/conv/0', createdAt: day2 });
  });

  it('đếm chưa đọc: truyền tenant thì chỉ đếm notification của tenant đó, không truyền thì đếm mọi phạm vi', async () => {
    await expect(repo.countUnreadNotifications(reader, tenantId)).resolves.toBe(3);
    await expect(repo.countUnreadNotifications(reader, otherTenantId)).resolves.toBe(1);
    await expect(repo.countUnreadNotifications(reader)).resolves.toBe(5);
  });

  it('danh sách gộp theo (loại × nguồn × ngày): đếm đúng, ngày theo Asia/Ho_Chi_Minh, lọc tenant và lọc theo tập loại', async () => {
    const all = await repo.listNotificationGroups(reader, { limit: 20 });
    const byKey = new Map(all.map((g) => [`${g.eventType}|${g.sourceKey}|${g.day}`, g]));
    expect(byKey.get('message_new|/conv/1|2026-10-01')?.count).toBe(2);
    expect(byKey.get('message_new|/conv/1|2026-10-01')?.unreadCount).toBe(1);
    expect(byKey.get('message_new|/conv/1|2026-10-02')?.count).toBe(1);
    expect(byKey.get('grade_updated||2026-10-02')?.count).toBe(1);
    expect(byKey.get('message_new|/conv/9|2026-10-02')?.count).toBe(1);

    const scoped = await repo.listNotificationGroups(reader, { limit: 20 }, tenantId);
    expect(scoped.some((g) => g.sourceKey === '/conv/9')).toBe(false);
    expect(scoped.some((g) => g.sourceKey === '/conv/0')).toBe(false);

    const onlyMessages = await repo.listNotificationGroups(reader, { eventTypes: ['message_new'], limit: 20 });
    expect(onlyMessages.every((g) => g.eventType === 'message_new')).toBe(true);
    expect(onlyMessages.length).toBeGreaterThanOrEqual(3);
  });

  it('danh sách gộp unreadOnly loại nhóm đã đọc hết qua HAVING và phân trang keyset không trùng không sót', async () => {
    const unread = await repo.listNotificationGroups(reader, { unreadOnly: true, limit: 20 });
    expect(unread.every((g) => g.unreadCount > 0)).toBe(true);

    const page1 = await repo.listNotificationGroups(reader, { limit: 2 });
    expect(page1).toHaveLength(2);
    const lastOfPage1 = page1[page1.length - 1]!;
    const page2 = await repo.listNotificationGroups(reader, {
      limit: 20,
      cursor: { latestAt: lastOfPage1.latestAt, latestId: lastOfPage1.latestId },
    });
    const keys1 = new Set(page1.map((g) => `${g.eventType}|${g.sourceKey}|${g.day}`));
    for (const g of page2) {
      expect(keys1.has(`${g.eventType}|${g.sourceKey}|${g.day}`)).toBe(false);
    }
    const total = await repo.listNotificationGroups(reader, { limit: 50 });
    expect(page1.length + page2.length).toBe(total.length);
  });

  it('danh sách phẳng theo khoá gộp + đánh dấu đã đọc theo khoá gộp chỉ chạm đúng các mục chưa đọc của khoá', async () => {
    const items = await repo.listNotificationItems(reader, {
      eventType: 'message_new', source: '/conv/1', day: '2026-10-01', limit: 10,
    }, tenantId);
    expect(items).toHaveLength(2);
    const marked = await repo.markNotificationGroupRead(reader, {
      eventType: 'message_new', sourceKey: '/conv/1', day: '2026-10-01',
    }, tenantId);
    expect(marked).toBe(1);
    const after = await repo.listNotificationItems(reader, {
      eventType: 'message_new', source: '/conv/1', day: '2026-10-01', unreadOnly: true, limit: 10,
    }, tenantId);
    expect(after).toHaveLength(0);
  });

  it('đánh dấu một/ tất cả đã đọc, xoá một và dọn đã đọc đều tôn trọng phạm vi tenant truyền vào', async () => {
    const mine = await repo.listNotificationItems(reader, { limit: 50 }, otherTenantId);
    expect(mine).toHaveLength(1);
    const target = mine[0]!;
    await expect(repo.markNotificationRead(target.id, reader, tenantId)).resolves.toBe(false);
    await expect(repo.markNotificationRead(target.id, reader, otherTenantId)).resolves.toBe(true);
    await expect(repo.deleteNotification(target.id, reader, tenantId)).resolves.toBe(false);
    await expect(repo.deleteNotification(target.id, reader, otherTenantId)).resolves.toBe(true);

    const markedAll = await repo.markAllNotificationsRead(reader, tenantId);
    expect(markedAll).toBeGreaterThanOrEqual(1);
    await expect(repo.countUnreadNotifications(reader, tenantId)).resolves.toBe(0);
    const deleted = await repo.deleteReadNotifications(reader, tenantId);
    expect(deleted).toBeGreaterThanOrEqual(1);
    const remaining = await repo.listNotificationItems(reader, { limit: 50 }, tenantId);
    expect(remaining).toHaveLength(0);
  });

  it('chèn notification qua repository trả dòng đầy đủ và nhật ký dispatch chống trùng dedupe_key bằng đọc lại', async () => {
    const notification = await repo.insertNotification({
      userIdTo: reader, tenantId, eventType: 'message_new', subject: 'Tiêu đề', fullMessage: 'Nội dung',
    });
    expect(notification.id).toMatch(UUIDV7_RE);
    expect(notification.subject).toBe('Tiêu đề');
    const first = await repo.insertDispatchLog({
      notificationId: notification.id, userId: reader, tenantId, provider: 'core_message', channel: 'popup',
      status: 'delivered', dedupeKey: 'g658-dedupe-1',
    });
    const second = await repo.insertDispatchLog({
      notificationId: notification.id, userId: reader, tenantId, provider: 'core_message', channel: 'popup',
      status: 'delivered', dedupeKey: 'g658-dedupe-1',
    });
    expect(second.id).toBe(first.id);
    const log = await repo.listDispatchLog(reader);
    expect(log.filter((l) => l.dedupeKey === 'g658-dedupe-1')).toHaveLength(1);
  });
});

describe('trang roster bằng SQL thô', () => {
  it('roster khoá: gán vai staff tại context khoá cho cờ staff, ghi danh hiệu lực cho cờ enrolled, trang con trỏ không trùng', async () => {
    const teacher = randomUUID();
    const student = randomUUID();
    await seedUser(teacher, 'g658-teacher', 'Giao', 'Vien');
    await seedUser(student, 'g658-student', 'Hoc', 'Sinh');
    // Khoá thật làm đích FK cho `enrol`/`context` (khoá mẫu để qua
    // check khoá-thuộc-lớp; spec chỉ cần khoá làm đích FK).
    const rosterTenant = await db
      .insertInto('tenants')
      .values({ slug: 'g658-roster', name: 'Tenant roster G11', kind: 'center', status: 'active' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const rosterCategory = await db
      .insertInto('course_categories')
      .values({ tenant_id: rosterTenant.id, name: 'Danh mục roster G11' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const courseRow = await db
      .insertInto('course')
      .values({
        tenant_id: rosterTenant.id, category: rosterCategory.id,
        full_name: 'Khoá roster G11', short_name: 'G11-ROSTER', is_template: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const courseId = courseRow.id;
    const courseCtx = await db
      .insertInto('context')
      .values({ context_level: 50, instance_id: courseId, path: '', depth: 2 })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db.updateTable('context').set({ path: `/${courseCtx.id}` }).where('id', '=', courseCtx.id).execute();
    const role = await db
      .insertInto('role')
      .values({ name: 'Giáo viên spec', short_name: 'g658teacher', description: '', archetype: 'editingteacher' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('role_assignments')
      .values({ role_id: role.id, user_id: teacher, context_id: courseCtx.id })
      .execute();
    const enrol = await db
      .insertInto('enrol')
      .values({ course_id: courseId, enrol: 'manual', status: 0 })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('user_enrolments')
      .values({ enrol_id: enrol.id, user_id: student, status: 0, time_start: new Date('2020-01-01T00:00:00.000Z') })
      .execute();

    const page = await repo.listCourseRosterPage(courseId, userA, null, 10);
    const byId = new Map(page.map((r) => [r.userId, r]));
    expect(byId.get(teacher)?.staff).toBe(true);
    expect(byId.get(teacher)?.enrolled).toBe(false);
    expect(byId.get(student)?.staff).toBe(false);
    expect(byId.get(student)?.enrolled).toBe(true);
    expect(byId.has(userA)).toBe(false);

    const firstPage = await repo.listCourseRosterPage(courseId, userA, null, 1);
    expect(firstPage).toHaveLength(1);
    const head = firstPage[0]!;
    const secondPage = await repo.listCourseRosterPage(courseId, userA, {
      displayName: head.displayName, username: head.username, userId: head.userId,
    }, 10);
    expect(secondPage.some((r) => r.userId === head.userId)).toBe(false);
    expect(firstPage.length + secondPage.length).toBe(page.length);
  });
});

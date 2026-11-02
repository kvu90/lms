import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCentreKysely, type CentreDb } from '../client';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { BadgesRepository } from './badges';
import { BookRepository } from './books';
import { CalendarRepository } from './calendar';
import { FilesRepository } from './files';
import { SocialRepository } from './social';

/**
 * Spec tích hợp của cụm tương tác G7 trên Kysely (issue #647):
 * calendar, social, badges, books, files.
 *
 * Database kho trung tâm được dựng từ rỗng bằng chính cầu nối
 * migration của package (carrier đóng băng) trên cụm PostgreSQL
 * thật của môi trường test (biến `LMS_DB_TEST_ADMIN_URL` ghi đè
 * cụm khi cần, mặc định suy từ `DATABASE_URL` của package). Mọi ca
 * chạy qua các repository production trong `repositories/` —
 * không mô phỏng handle.
 *
 * Các hành vi được khoá ở đây là các điểm rủi ro của lượt chuyển
 * đổi Drizzle → Kysely: id sinh bởi `DEFAULT uuidv7()` qua
 * returning (phụ lục U của phương án chiến dịch); ngữ nghĩa loại
 * `undefined` khi ghi (T-4) — patch chỉ đổi trường được truyền;
 * jsonb ghi qua helper serialize `::jsonb` đọc lại đúng hình dạng
 * kể cả MẢNG cấp cao nhất; các nhánh onConflict kèm đọc lại qua
 * handle gốc của insert-if-absent; phép đếm `count(*)::int` giữ
 * kiểu runtime `number`; thứ tự sắp xếp ở tầng ứng dụng của danh
 * sách sách; và tính nguyên tử của transaction mở qua repository
 * (commit đủ / rollback sạch).
 */
const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : '');

const TEST_DB = 'lms_db_g7_647';

const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Các định danh cố định cho dữ kiện mẫu; mỗi describe dùng dải riêng để các ca không giẫm nhau. */
const USER_A = '01a19887-6b35-7760-8e64-a5960bfd0801';
const USER_B = '01a19887-6b35-7760-8e64-a5960bfd0802';
const CONTEXT_ID = '01a19887-6b35-7760-8e64-a5960bfd0810';

let pool: Pool;
let db: CentreDb;
let calendar: CalendarRepository;
let social: SocialRepository;
let badges: BadgesRepository;
let books: BookRepository;
let files: FilesRepository;

beforeAll(async () => {
  if (!adminUrl) {
    throw new Error('Thiếu kết nối quản trị cho spec tích hợp G7: đặt LMS_DB_TEST_ADMIN_URL hoặc DATABASE_URL.');
  }
  const url = await buildTestDatabase({ adminUrl, database: TEST_DB, store: 'centre' });
  pool = new Pool({ connectionString: url });
  db = createCentreKysely(pool);
  calendar = new CalendarRepository(db);
  social = new SocialRepository(db);
  badges = new BadgesRepository(db);
  books = new BookRepository(db);
  files = new FilesRepository(db);
}, 300_000);

afterAll(async () => {
  await db.destroy().catch(() => undefined);
  await dropTestDatabase(adminUrl, TEST_DB).catch(() => undefined);
});

describe('repository lịch trên Kysely', () => {
  it('insert sự kiện không truyền id nhận id UUIDv7 và đọc lại đúng hình dạng camelCase', async () => {
    const created = await calendar.insertEvent({
      name: 'Họp phụ huynh',
      eventType: 'site',
      userId: USER_A,
      contextId: CONTEXT_ID,
      timeStart: new Date('2026-09-05T02:00:00.000Z'),
      timeDuration: 3600,
    });
    expect(created.id).toMatch(UUIDV7_PATTERN);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.description).toBe('');
    const read = await calendar.getEvent(created.id);
    expect(read).toMatchObject({ name: 'Họp phụ huynh', eventType: 'site', userId: USER_A, timeDuration: 3600 });
    expect(read!.timeStart.getTime()).toBe(new Date('2026-09-05T02:00:00.000Z').getTime());
  });

  it('liệt kê sự kiện trong khoảng và trong cùng chuỗi lặp theo mốc bắt đầu tăng dần', async () => {
    const start = new Date('2026-10-01T00:00:00.000Z');
    const root = await calendar.insertEvent({ name: 'Chuỗi G7', timeStart: new Date('2026-10-03T00:00:00.000Z') });
    await calendar.updateEvent(root.id, { repeatId: root.id });
    await calendar.insertEvent({ name: 'Chuỗi G7', timeStart: new Date('2026-10-02T00:00:00.000Z'), repeatId: root.id });
    await calendar.insertEvent({ name: 'Chuỗi G7', timeStart: new Date('2026-10-04T00:00:00.000Z'), repeatId: root.id });
    await calendar.insertEvent({ name: 'Ngoài khoảng', timeStart: new Date('2026-12-01T00:00:00.000Z') });

    const series = await calendar.listSeries(root.id);
    expect(series.map((e) => e.timeStart.getUTCDate())).toEqual([2, 3, 4]);

    const inRange = await calendar.listEventsInRange(start, new Date('2026-10-31T23:59:59.000Z'));
    expect(inRange.map((e) => e.name)).toEqual(['Chuỗi G7', 'Chuỗi G7', 'Chuỗi G7']);
  });

  it('transaction của repository commit đủ các thao tác và rollback sạch khi callback ném lỗi', async () => {
    const committedId = await calendar.transaction(async (tx) => {
      const root = await calendar.insertEvent({ name: 'Tx commit', timeStart: new Date('2026-11-01T00:00:00.000Z') }, tx);
      await calendar.updateEvent(root.id, { repeatId: root.id }, tx);
      return root.id;
    });
    expect((await calendar.getEvent(committedId))!.repeatId).toBe(committedId);

    let rolledBackId = '';
    await expect(
      calendar.transaction(async (tx) => {
        const row = await calendar.insertEvent({ name: 'Tx rollback', timeStart: new Date('2026-11-02T00:00:00.000Z') }, tx);
        rolledBackId = row.id;
        throw new Error('cố ý huỷ giao dịch');
      }),
    ).rejects.toThrow('cố ý huỷ giao dịch');
    expect(await calendar.getEvent(rolledBackId)).toBeUndefined();
  });

  it('token xuất lịch: thay token đặt lại mốc truy cập về null, thu hồi trả đúng trạng thái có/không', async () => {
    const first = await calendar.upsertExportToken(USER_A, 'hash-one');
    expect(first.tokenHash).toBe('hash-one');
    expect(first.lastAccess).toBeNull();
    await calendar.touchExportToken(first.id);
    expect((await calendar.getExportTokenByUser(USER_A))!.lastAccess).toBeInstanceOf(Date);

    const replaced = await calendar.upsertExportToken(USER_A, 'hash-two');
    expect(replaced.id).toBe(first.id);
    expect(replaced.tokenHash).toBe('hash-two');
    expect(replaced.lastAccess).toBeNull();
    expect((await calendar.getExportTokenByHash('hash-two'))!.userId).toBe(USER_A);
    expect(await calendar.getExportTokenByHash('hash-one')).toBeUndefined();

    expect(await calendar.deleteExportToken(USER_A)).toBe(true);
    expect(await calendar.deleteExportToken(USER_A)).toBe(false);
  });

  it('đăng ký lịch ngoài: chèn, đọc theo user và chạm mốc đồng bộ', async () => {
    const sub = await calendar.insertSubscription({
      name: 'Lịch trường bạn', url: null, icsData: 'BEGIN:VCALENDAR', eventType: 'site', userId: USER_B,
    });
    expect(sub.id).toMatch(UUIDV7_PATTERN);
    expect(sub.lastUpdated).toBeNull();
    await calendar.touchSubscription(sub.id);
    expect((await calendar.getSubscription(sub.id))!.lastUpdated).toBeInstanceOf(Date);
    const forUser = await calendar.listSubscriptionsForUser(USER_B);
    expect(forUser.map((s) => s.id)).toContain(sub.id);
    expect(await calendar.listSubscriptionsForUser(USER_A)).toHaveLength(0);
    expect((await calendar.findBySubscriptionUuid(sub.id, 'khong-co'))).toBeUndefined();
  });
});

describe('repository xã hội trên Kysely', () => {
  it('bộ sưu tập mặc định được tạo đúng một lần dù gọi đảm bảo nhiều lần', async () => {
    const first = await social.ensureDefaultCollection();
    const second = await social.ensureDefaultCollection();
    expect(second).toBe(first);
    const collections = await social.listCollections();
    expect(collections.filter((c) => c.name === 'Default collection')).toHaveLength(1);
  });

  it('gắn thẻ trùng khoá tự nhiên có user trả lại dòng đã có qua đường đọc lại; nhánh không user là dòng độc lập', async () => {
    const collId = await social.ensureDefaultCollection();
    const tag = await social.insertTag({ userId: USER_A, tagCollId: collId, name: 'g7-tag', rawName: 'G7 Tag' });
    expect((await social.findTag(collId, 'g7-tag'))!.id).toBe(tag.id);

    const itemId = '01a19887-6b35-7760-8e64-a5960bfd0820';
    const base = { tagId: tag.id, component: 'core', itemType: 'post', itemId, contextId: CONTEXT_ID };
    // Nhánh có user: chỉ số duy nhất sáu cột bắt được trùng vì
    // ti_user_id có giá trị — insert bỏ qua (doNothing không trả
    // dòng) và repository đọc lại đúng dòng đã có.
    const personal1 = await social.insertInstance({ ...base, tiUserId: USER_A });
    const personal2 = await social.insertInstance({ ...base, tiUserId: USER_A });
    expect(personal2.id).toBe(personal1.id);
    expect(personal1.tiUserId).toBe(USER_A);
    // Nhánh không user: ti_user_id NULL được PostgreSQL coi là
    // phân biệt trong chỉ số duy nhất (chỉ số không khai NULLS NOT
    // DISTINCT) nên lần gắn không user là một dòng độc lập — đúng
    // hành vi của đường Drizzle cũ với cùng câu ON CONFLICT, giữ
    // nguyên ở lượt chuyển đổi này.
    const shared = await social.insertInstance({ ...base });
    expect(shared.id).not.toBe(personal1.id);
    expect(shared.tiUserId).toBeNull();

    const forItem = await social.listInstancesForItem('core', 'post', itemId);
    expect(forItem).toHaveLength(2);
    expect((await social.listInstancesForTag(tag.id)).length).toBeGreaterThanOrEqual(2);
    await social.deleteInstancesForItem('core', 'post', itemId, CONTEXT_ID);
    expect(await social.listInstancesForItem('core', 'post', itemId)).toHaveLength(0);
  });

  it('tương quan thẻ ghi đè trên cùng một dòng theo thẻ', async () => {
    const collId = await social.ensureDefaultCollection();
    const tag = await social.insertTag({ tagCollId: collId, name: 'g7-corr', rawName: 'G7 Corr' });
    await social.upsertCorrelation(tag.id, 'a,b');
    await social.upsertCorrelation(tag.id, 'c');
    expect((await social.getCorrelation(tag.id))!.correlatedTags).toBe('c');
  });

  it('bình luận xoá mềm biến khỏi danh sách còn hiệu lực nhưng dòng vẫn đọc được kèm mốc xoá', async () => {
    const itemId = '01a19887-6b35-7760-8e64-a5960bfd0821';
    const input = { contextId: CONTEXT_ID, component: 'blog', commentArea: 'entry', itemId, userId: USER_A };
    const kept = await social.insertComment({ ...input, content: 'giữ lại' });
    const removed = await social.insertComment({ ...input, content: 'sẽ xoá' });
    await social.softDeleteComment(removed.id);
    const visible = await social.listComments('blog', 'entry', itemId, CONTEXT_ID);
    expect(visible.map((c) => c.id)).toEqual([kept.id]);
    expect((await social.getComment(removed.id))!.timeDeleted).toBeInstanceOf(Date);
  });

  it('đánh giá ghi hai lần cùng khoá tự nhiên chỉ giữ một dòng với điểm mới nhất', async () => {
    const itemId = '01a19887-6b35-7760-8e64-a5960bfd0822';
    const base = { contextId: CONTEXT_ID, component: 'blog', ratingArea: 'entry', itemId, userId: USER_A };
    const first = await social.upsertRating({ ...base, scaleId: 10, rating: 3 });
    const second = await social.upsertRating({ ...base, scaleId: 10, rating: 5 });
    expect(second.id).toBe(first.id);
    const rows = await social.listRatings('blog', 'entry', itemId, CONTEXT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rating).toBe(5);
  });

  it('ghi chú liệt kê mới nhất trước và xoá được theo id', async () => {
    const older = await social.insertNote({ userId: USER_B, createdBy: USER_A, content: 'cũ', publishState: 'site', userModified: USER_A });
    const newer = await social.insertNote({ userId: USER_B, createdBy: USER_A, content: 'mới', publishState: 'site', userModified: USER_A });
    const rows = await social.listNotesAbout(USER_B);
    expect(rows.map((n) => n.id)).toEqual([newer.id, older.id]);
    expect(rows[0]!.created).toBeInstanceOf(Date);
    await social.deleteNote(newer.id);
    expect(await social.getNote(newer.id)).toBeUndefined();
  });
});

describe('repository huy hiệu trên Kysely', () => {
  it('tiêu chí giữ nguyên params jsonb ở cả hai hình dạng object và mảng cấp cao nhất', async () => {
    const badge = await badges.insertBadge({ name: 'Huy hiệu G7 jsonb', type: 1, status: 0, userCreated: USER_A });
    const objectParams = await badges.insertCriteria({
      badgeId: badge.id, criteriaType: 'overall', method: 1, params: { threshold: 3, nested: { ok: true } },
    });
    expect(objectParams.params).toEqual({ threshold: 3, nested: { ok: true } });
    const arrayParams = await badges.insertCriteria({
      badgeId: badge.id, criteriaType: 'manual', method: 1, params: ['a', 'b'],
    });
    expect(arrayParams.params).toEqual(['a', 'b']);
    const listed = await badges.listCriteria(badge.id);
    expect(listed).toHaveLength(2);
    await badges.transaction(async (tx) => {
      await badges.deleteCriteria(badge.id, tx);
      await badges.insertCriteria({ badgeId: badge.id, criteriaType: 'overall', method: 2, params: {} }, tx);
    });
    const after = await badges.listCriteria(badge.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.method).toBe(2);
  });

  it('cấp huy hiệu trùng cặp (huy hiệu, user) trả dòng đã cấp và đếm đúng một lần', async () => {
    const badge = await badges.insertBadge({ name: 'Huy hiệu G7 cấp', type: 1, status: 1, userCreated: USER_A });
    const first = await badges.insertIssued({
      badgeId: badge.id, userId: USER_A, uniqueHash: 'hash-g7-1',
      snapshot: { badge: { name: 'Huy hiệu G7 cấp' } }, evidence: { note: 'đủ điều kiện' }, visible: true,
    });
    expect(first.id).toMatch(UUIDV7_PATTERN);
    expect(first.snapshot).toEqual({ badge: { name: 'Huy hiệu G7 cấp' } });
    const again = await badges.insertIssued({
      badgeId: badge.id, userId: USER_A, uniqueHash: 'hash-g7-2', snapshot: {}, evidence: {}, visible: true,
    });
    expect(again.id).toBe(first.id);
    expect(again.uniqueHash).toBe('hash-g7-1');
    expect(await badges.countIssued(badge.id)).toBe(1);
    expect((await badges.findIssued(badge.id, USER_A))!.id).toBe(first.id);
    expect((await badges.listIssuedForUser(USER_A)).map((r) => r.id)).toContain(first.id);
  });

  it('cập nhật bản ghi cấp phát chỉ đổi trường được truyền trong patch, giữ nguyên phần còn lại', async () => {
    const badge = await badges.insertBadge({ name: 'Huy hiệu G7 patch', type: 1, status: 1, userCreated: USER_A });
    const issued = await badges.insertIssued({
      badgeId: badge.id, userId: USER_B, uniqueHash: 'hash-g7-patch', snapshot: {}, evidence: {}, visible: true,
    });
    const revokedAt = new Date('2026-11-01T00:00:00.000Z');
    await badges.updateIssued(issued.id, { revoked: true, revokedAt });
    const read = await badges.getIssued(issued.id);
    expect(read!.revoked).toBe(true);
    expect(read!.revokedAt!.getTime()).toBe(revokedAt.getTime());
    expect(read!.uniqueHash).toBe('hash-g7-patch');
    expect(read!.visible).toBe(true);
    expect(read!.issuerNotified).toBe(false);
  });

  it('cấp thủ công trùng bộ ba trả dòng đã có theo cặp (huy hiệu, người nhận)', async () => {
    const badge = await badges.insertBadge({ name: 'Huy hiệu G7 thủ công', type: 1, status: 1, userCreated: USER_A });
    const first = await badges.insertManualAward({ badgeId: badge.id, recipientId: USER_B, issuerId: USER_A });
    const again = await badges.insertManualAward({ badgeId: badge.id, recipientId: USER_B, issuerId: USER_A });
    expect(again.id).toBe(first.id);
    expect((await badges.findManualAward(badge.id, USER_B))!.id).toBe(first.id);
    expect(await badges.findManualAward(badge.id, USER_A)).toBeUndefined();
  });

  it('cập nhật huy hiệu đổi đúng trường trong patch và làm mới mốc cập nhật', async () => {
    const badge = await badges.insertBadge({ name: 'Huy hiệu G7 sửa', type: 1, status: 0, userCreated: USER_A });
    await badges.updateBadge(badge.id, { status: 1 });
    const read = await badges.getBadge(badge.id);
    expect(read!.status).toBe(1);
    expect(read!.name).toBe('Huy hiệu G7 sửa');
    expect(read!.updatedAt.getTime()).toBeGreaterThanOrEqual(badge.updatedAt.getTime());
  });
});

describe('repository sách trên Kysely', () => {
  it('danh sách sách sắp xếp ở tầng ứng dụng theo khối lớp, rồi position, rồi thời gian tạo', async () => {
    const grade2 = await books.insertBook({ kind: 'textbook', title: 'Sách G7 khối 2', grade: 2, position: 1 });
    const grade1b = await books.insertBook({ kind: 'textbook', title: 'Sách G7 khối 1 sau', grade: 1, position: 2 });
    const grade1a = await books.insertBook({ kind: 'textbook', title: 'Sách G7 khối 1 trước', grade: 1, position: 1 });
    const listed = await books.listBooks();
    const ids = listed.map((b) => b.id);
    expect(ids.indexOf(grade1a.id)).toBeLessThan(ids.indexOf(grade1b.id));
    expect(ids.indexOf(grade1b.id)).toBeLessThan(ids.indexOf(grade2.id));
    const byKind = await books.listBooks(undefined, 'textbook');
    expect(byKind.map((b) => b.id)).toContain(grade2.id);
    expect(await books.listBooks(undefined, 'khong-co-loai-nay')).toHaveLength(0);
  });

  it('tìm sách theo định danh tự nhiên (môn, khối, tựa) chỉ khớp khi cả ba thành phần đều khớp', async () => {
    const subject = await db
      .insertInto('subjects')
      .values({ name: 'Môn G7', slug: 'mon-g7', context_id: CONTEXT_ID })
      .returning('id')
      .executeTakeFirstOrThrow();
    const book = await books.insertBook({ kind: 'textbook', title: 'Sách G7 theo môn', subjectId: subject.id, grade: 5, position: 1 });
    expect((await books.findBook(subject.id, 5, 'Sách G7 theo môn'))!.id).toBe(book.id);
    expect(await books.findBook(subject.id, 6, 'Sách G7 theo môn')).toBeUndefined();
    expect(await books.findBook(subject.id, 5, 'Tựa khác')).toBeUndefined();
    const bySubject = await books.listBooks(subject.id);
    expect(bySubject.map((b) => b.id)).toEqual([book.id]);
  });

  it('lượt ghi một bản ghi dataset trong transaction: node, ánh xạ và dòng sổ nhất quán, source jsonb đọc lại đúng', async () => {
    const book = await books.insertBook({ kind: 'textbook', title: 'Sách G7 nạp', grade: 3, position: 1 });
    const chapter = await books.insertBookNode({ bookId: book.id, parentId: null, title: 'Chủ đề 1', kind: 'chapter', position: 1 });
    // Đích ánh xạ phải có đúng một phía (check XOR của bảng): dựng
    // một node chương trình tối thiểu qua chuỗi môn → chương trình
    // → node để ánh xạ trỏ vào.
    const subject = await db
      .insertInto('subjects')
      .values({ name: 'Môn G7 ánh xạ', slug: 'mon-g7-anh-xa', context_id: CONTEXT_ID })
      .returning('id')
      .executeTakeFirstOrThrow();
    const curriculum = await db
      .insertInto('curricula')
      .values({ subject_id: subject.id, grade: 3 })
      .returning('id')
      .executeTakeFirstOrThrow();
    const programNode = await db
      .insertInto('curriculum_nodes')
      .values({ curriculum_id: curriculum.id, title: 'Node chương trình G7' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const source = { title: 'Bài 1', programRecords: ['CT-1'] };
    const lesson = await books.transaction(async (tx) => {
      const node = await books.insertBookNode(
        { bookId: book.id, parentId: chapter.id, title: 'Bài 1', kind: 'lesson', volume: 1, lessonNumber: 1, position: 1 },
        tx,
      );
      await books.insertMapping({ bookNodeId: node.id, curriculumNodeId: programNode.id, learningOutcomeId: null, position: 1 }, tx);
      await books.insertBookRecord(
        { datasetKey: 'g7-spec', recordId: 'rec-1', bookId: book.id, nodeId: node.id, contentHash: 'hash-1', source },
        tx,
      );
      return node;
    });
    const nodes = await books.listBookNodes(book.id);
    expect(nodes.map((n) => n.kind)).toEqual(['chapter', 'lesson']);
    const mappings = await books.listMappingsForNode(lesson.id);
    expect(mappings).toHaveLength(1);
    expect(await books.listMappingsForNodes([])).toEqual([]);
    expect((await books.listMappingsForNodes([lesson.id]))).toHaveLength(1);
    const record = await books.getBookRecord('g7-spec', 'rec-1');
    expect(record!.source).toEqual(source);
    expect((await books.listBookRecordsByBook(book.id))).toHaveLength(1);

    await books.updateBookRecord(record!.id, { contentHash: 'hash-2', source: { title: 'Bài 1 (đính chính)' } });
    const corrected = await books.getBookRecord('g7-spec', 'rec-1');
    expect(corrected!.contentHash).toBe('hash-2');
    expect(corrected!.source).toEqual({ title: 'Bài 1 (đính chính)' });

    await books.transaction(async (tx) => {
      await books.deleteMappingsForNode(lesson.id, tx);
    });
    expect(await books.listMappingsForNode(lesson.id)).toHaveLength(0);
  });

  it('truy nguồn sách → câu chỉ trả các câu ghi nguồn từ cuốn sách đó', async () => {
    const book = await books.insertBook({ kind: 'textbook', title: 'Sách G7 truy nguồn', grade: 4, position: 1 });
    // Cột category của question là khoá ngoại tới danh mục câu hỏi
    // (uuid) — dựng một danh mục thật rồi dùng id của nó.
    const category = await db
      .insertInto('question_categories')
      .values({ name: 'Ngân hàng G7', context_id: CONTEXT_ID })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('question')
      .values({ qtype: 'multichoice', category: category.id, created_by: USER_A, source_kind: 'book', source_ref: book.id })
      .execute();
    await db
      .insertInto('question')
      .values({ qtype: 'essay', category: category.id, created_by: USER_A, source_kind: 'manual', source_ref: null })
      .execute();
    const rows = await books.listQuestionsByBookSource(book.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ qtype: 'multichoice', category: category.id, createdBy: USER_A, copyCount: 0 });
  });
});

describe('repository tệp trên Kysely', () => {
  it('refcount đếm theo contentHash trả số nguyên kiểu number và giảm đúng khi xoá bản ghi', async () => {
    const input = {
      contentHash: 'hash-g7-files', contextId: CONTEXT_ID, component: 'question',
      fileArea: 'content', fileName: 'a.png', fileSize: 10, mimeType: 'image/png', userId: USER_A,
    };
    const first = await files.insert({ ...input, itemId: null, filePath: '/' });
    expect(first.id).toMatch(UUIDV7_PATTERN);
    expect(await files.countByHash('hash-g7-files')).toBe(1);
    const second = await files.insert({ ...input });
    const count = await files.countByHash('hash-g7-files');
    expect(count).toBe(2);
    expect(typeof count).toBe('number');
    expect((await files.listByContext(CONTEXT_ID)).map((f) => f.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
    await files.deleteById(second.id);
    expect(await files.countByHash('hash-g7-files')).toBe(1);
    expect(await files.getById(second.id)).toBeUndefined();
  });

  it('hình chiếu chốt xoá tệp: liên kết bài nộp, bài nộp theo id và gói chấm hiện hành', async () => {
    // Giàn dữ kiện tối thiểu cho chuỗi FK: tenant → danh mục →
    // khoá → bài tập → bài nộp; các bảng này thuộc module khác,
    // spec chỉ dựng qua handle để kiểm hình chiếu của repository
    // tệp trên chúng.
    const tenant = await db
      .insertInto('tenants')
      .values({ slug: 'g7-files', name: 'Trung tâm G7 tệp', kind: 'centre' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const category = await db
      .insertInto('course_categories')
      .values({ name: 'Danh mục G7', tenant_id: tenant.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    const course = await db
      .insertInto('course')
      // is_template = true để qua check course_class_required_check
      // (khoá thường bắt buộc thuộc một lớp) mà không phải dựng cả
      // chuỗi lớp học — giàn ở đây chỉ cần một khoá làm đích FK.
      .values({ category: category.id, full_name: 'Khoá G7', short_name: 'G7', tenant_id: tenant.id, is_template: true })
      .returning('id')
      .executeTakeFirstOrThrow();
    const assignment = await db
      .insertInto('assignments')
      .values({ course: course.id, name: 'Bài tập G7' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const submission = await db
      .insertInto('assign_submissions')
      .values({ assignment_id: assignment.id, user_id: USER_A, status: 'submitted', attempt_number: 2 })
      .returning('id')
      .executeTakeFirstOrThrow();
    const file = await files.insert({
      contentHash: 'hash-g7-submission', contextId: CONTEXT_ID, component: 'mod_assign',
      fileArea: 'submission_files', itemId: submission.id, fileName: 'bai-lam.pdf', fileSize: 20, userId: USER_A,
    });
    await db
      .insertInto('assign_submission_files')
      .values({ submission_id: submission.id, file_id: file.id })
      .execute();
    await db
      .insertInto('assign_grades')
      .values({ assignment_id: assignment.id, user_id: USER_A, grader_id: USER_B, attempt_number: 2, status: 'released' })
      .execute();

    const links = await files.listSubmissionLinks(file.id);
    expect(links).toEqual([
      { submissionId: submission.id, assignmentId: assignment.id, userId: USER_A, status: 'submitted', attemptNumber: 2 },
    ]);
    expect(await files.getSubmission(submission.id)).toEqual(links[0]);
    expect(await files.getGradeForSubmission(assignment.id, USER_A)).toEqual({ status: 'released', attemptNumber: 2 });
    expect(await files.getGradeForSubmission(assignment.id, USER_B)).toBeUndefined();
  });
});

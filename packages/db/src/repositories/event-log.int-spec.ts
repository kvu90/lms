/**
 * Spec tích hợp của `EventLogRepository.search` (issue #648) trên
 * database trung tâm dựng từ rỗng bằng carrier đóng băng: chốt hai
 * điểm chuyển đổi của nhóm G8 —
 * - Toán tử JSON `payload ->> 'khoá'` giữ nguyên ngữ nghĩa: lọc
 *   theo các trường chuẩn hoá trong payload (courseId,
 *   relatedUserId, component) cho đúng tập dòng như kỳ vọng.
 * - Khuôn điều kiện động DÙNG CHUNG (mẫu BS-1 của thử nghiệm
 *   T-13): truy vấn dòng và truy vấn đếm dùng cùng một hàm dựng
 *   điều kiện — kiểm chứng bằng tương đương thực tế: `total` luôn
 *   bằng số dòng thật khớp bộ lọc (gom đủ mọi trang), kể cả ca
 *   không có điều kiện nào.
 *
 * Cột `seq` là `bigint` sinh bởi identity: qua Kysely đọc thành
 * chuỗi (khuôn T-7), spec khoá luôn hình dạng này ở biên
 * repository — phía tiêu thụ tự chuyển số tường minh.
 */
import { sql } from 'kysely';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCentreKysely, type CentreDb } from '../client';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { EventLogRepository, type EventLogFilters } from './event-log';

const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : undefined);

const TEST_DB = 'lms_db_g648_eventlog';

const USER_1 = '00000000-0000-4000-8000-0000000000d1';
const USER_2 = '00000000-0000-4000-8000-0000000000d2';

let pool: Pool;
let db: CentreDb;
let repo: EventLogRepository;

/** Gom mọi trang của một bộ lọc để đối chiếu với `total` mà cùng lời gọi trả về. */
async function collectAll(filters: EventLogFilters): Promise<{ ids: string[]; total: number }> {
  const first = await repo.search(filters, 1, 2);
  const ids = first.rows.map((r) => r.id);
  const pages = Math.ceil(first.total / 2);
  for (let page = 2; page <= pages; page += 1) {
    const next = await repo.search(filters, page, 2);
    expect(next.total).toBe(first.total);
    ids.push(...next.rows.map((r) => r.id));
  }
  return { ids, total: first.total };
}

beforeAll(async () => {
  if (!adminUrl) throw new Error('Thiếu kết nối quản trị: đặt LMS_DB_TEST_ADMIN_URL hoặc DATABASE_URL.');
  const url = await buildTestDatabase({ adminUrl, database: TEST_DB, store: 'centre' });
  pool = new Pool({ connectionString: url });
  db = createCentreKysely(pool);
  repo = new EventLogRepository(db);

  const seed: Array<{ eventType: string; userId: string; payload: Record<string, unknown> }> = [
    { eventType: 'course_viewed', userId: USER_1, payload: { courseId: 'course-1', component: 'course' } },
    { eventType: 'quiz_attempt', userId: USER_1, payload: { courseId: 'course-1', component: 'quiz', relatedUserId: USER_2 } },
    { eventType: 'quiz_attempt', userId: USER_2, payload: { courseId: 'course-2', component: 'quiz', relatedUserId: USER_1 } },
    { eventType: 'user_login', userId: USER_2, payload: { component: 'auth' } },
    { eventType: 'course_viewed', userId: USER_2, payload: { courseId: 'course-2', component: 'course' } },
  ];
  for (const row of seed) {
    await db.insertInto('event_log').values({
      event_type: row.eventType,
      user_id: row.userId,
      payload: sql`${JSON.stringify(row.payload)}::jsonb`,
    }).execute();
  }
});

afterAll(async () => {
  await pool.end();
  if (adminUrl) await dropTestDatabase(adminUrl, TEST_DB);
});

describe('EventLogRepository.search trên database thật', () => {
  it('không bộ lọc: total bằng tổng số dòng và gom đủ mọi trang không trùng', async () => {
    const { ids, total } = await collectAll({});
    expect(total).toBe(5);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it('lọc theo payload ->> courseId: chỉ các dòng mang đúng courseId trong payload khớp', async () => {
    const { ids, total } = await collectAll({ courseId: 'course-1' });
    expect(total).toBe(2);
    expect(ids).toHaveLength(2);
    const miss = await collectAll({ courseId: 'course-khong-co' });
    expect(miss.total).toBe(0);
    expect(miss.ids).toHaveLength(0);
  });

  it('lọc kết hợp payload ->> relatedUserId và component: giao đúng một dòng', async () => {
    const { ids, total } = await collectAll({ relatedUserId: USER_2, component: 'quiz' });
    expect(total).toBe(1);
    expect(ids).toHaveLength(1);
  });

  it('lọc theo cột userId và eventType đồng thời: điều kiện cột và điều kiện payload dùng chung cho dòng và đếm', async () => {
    const { total } = await collectAll({ userId: USER_2, eventType: 'quiz_attempt' });
    expect(total).toBe(1);
    const byPayloadAndColumn = await collectAll({ userId: USER_1, courseId: 'course-2' });
    expect(byPayloadAndColumn.total).toBe(0);
  });

  it('seq đọc thành chuỗi (int8) và sắp xếp giảm dần theo seq', async () => {
    const { rows } = await repo.search({}, 1, 5);
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(typeof row.seq).toBe('string');
    const seqs = rows.map((r) => Number(r.seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
  });
});

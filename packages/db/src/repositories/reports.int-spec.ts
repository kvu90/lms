/**
 * Spec tích hợp CHỐT thử nghiệm T-11 (issue #648): khuôn ghép đoạn
 * động `sql.join` của `ReportsRepository.userHasAnyRole` đặt cạnh
 * nguyên văn truy vấn Drizzle cũ của `ReportsService.isInAudience`
 * trên cùng một database trung tâm dựng từ rỗng bằng carrier đóng
 * băng (cụm PostgreSQL thật của môi trường test).
 *
 * Ba ca T-11 phải trả lời, mỗi ca chạy CẢ hai phía và đối chiếu:
 * - 1 đoạn / nhiều đoạn vô hướng: kết quả hai phía bằng nhau và
 *   bằng kỳ vọng; thứ tự tham số đã biên dịch của hai phía giống
 *   hệt nhau (tham số ngoài đứng trước, rồi từng đoạn theo mảng).
 * - Đoạn chứa biểu thức con mang tham số riêng (`lower(${...})`):
 *   tham số của biểu thức con giữ đúng vị trí của đoạn trong thứ
 *   tự tham số toàn cục ở cả hai ORM, kết quả chạy thật bằng nhau.
 * - 0 đoạn: phía Drizzle không có chốt chặn thì biên dịch thành
 *   `IN ()` và PostgreSQL từ chối khi chạy — đây là lý do khuôn
 *   chốt yêu cầu chốt chặn: repository trả `false` ngay, không
 *   phát truy vấn.
 */
import { sql as drizzleSql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql as kyselySql } from 'kysely';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCentreKysely, type CentreDb } from '../client';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { ReportsRepository } from './reports';

const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : undefined);

const TEST_DB = 'lms_db_g648_reports';

const ROLE_TEACHER = '00000000-0000-4000-8000-0000000000a1';
const ROLE_MANAGER = '00000000-0000-4000-8000-0000000000a2';
const ROLE_MEMBER = '00000000-0000-4000-8000-0000000000a3';
const USER_A = '00000000-0000-4000-8000-0000000000b1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';
const USER_C = '00000000-0000-4000-8000-0000000000b3';
const CONTEXT_ID = '00000000-0000-4000-8000-0000000000c1';

let pool: Pool;
let db: CentreDb;
let drizzleDb: NodePgDatabase;
let repo: ReportsRepository;

/**
 * Nguyên văn đường Drizzle cũ của `ReportsService.isInAudience`
 * (trước chuyển đổi): cùng mẫu `sql.join` trên các mảnh vô hướng,
 * KHÔNG có chốt chặn danh sách rỗng ở tầng này (chốt chặn cũ nằm ở
 * service, trước khi gọi).
 */
async function drizzleUserHasAnyRole(userId: string, roleNames: string[]): Promise<boolean> {
  const res = await drizzleDb.execute(drizzleSql`
    select 1 as ok from role_assignments ra join role r on r.id = ra.role_id
    where ra.user_id = ${userId} and r.short_name in (${drizzleSql.join(roleNames.map((n) => drizzleSql`${n}`), drizzleSql`, `)}) limit 1`);
  const rows = Array.isArray(res) ? (res[0]?.rows ?? []) : res.rows;
  return rows.length > 0;
}

beforeAll(async () => {
  if (!adminUrl) throw new Error('Thiếu kết nối quản trị: đặt LMS_DB_TEST_ADMIN_URL hoặc DATABASE_URL.');
  const url = await buildTestDatabase({ adminUrl, database: TEST_DB, store: 'centre' });
  pool = new Pool({ connectionString: url });
  db = createCentreKysely(pool);
  drizzleDb = drizzle({ client: pool });
  repo = new ReportsRepository(db);

  // role_assignments.context_id có khoá ngoại tới bảng context:
  // gieo một context hệ thống tối thiểu trước khi gán vai.
  await db.insertInto('context').values({ id: CONTEXT_ID, context_level: 10, depth: 1, path: '/1' }).execute();
  await db.insertInto('role').values([
    { id: ROLE_TEACHER, short_name: 'teacher' },
    { id: ROLE_MANAGER, short_name: 'manager' },
    { id: ROLE_MEMBER, short_name: 'member' },
  ]).execute();
  await db.insertInto('role_assignments').values([
    { role_id: ROLE_TEACHER, user_id: USER_A, context_id: CONTEXT_ID },
    { role_id: ROLE_MANAGER, user_id: USER_B, context_id: CONTEXT_ID },
    { role_id: ROLE_MEMBER, user_id: USER_B, context_id: CONTEXT_ID },
  ]).execute();
});

afterAll(async () => {
  await pool.end();
  if (adminUrl) await dropTestDatabase(adminUrl, TEST_DB);
});

describe('T-11: userHasAnyRole (Kysely) đặt cạnh nguyên văn Drizzle trên database thật', () => {
  it('một đoạn: kết quả hai phía bằng nhau cho ca khớp và ca không khớp', async () => {
    await expect(repo.userHasAnyRole(USER_A, ['teacher'])).resolves.toBe(true);
    await expect(drizzleUserHasAnyRole(USER_A, ['teacher'])).resolves.toBe(true);
    await expect(repo.userHasAnyRole(USER_A, ['manager'])).resolves.toBe(false);
    await expect(drizzleUserHasAnyRole(USER_A, ['manager'])).resolves.toBe(false);
    await expect(repo.userHasAnyRole(USER_C, ['teacher'])).resolves.toBe(false);
    await expect(drizzleUserHasAnyRole(USER_C, ['teacher'])).resolves.toBe(false);
  });

  it('nhiều đoạn: khớp ở vị trí đoạn thứ hai vẫn tìm thấy, và hai phía luôn cho cùng kết quả', async () => {
    const cases: Array<[string, string[], boolean]> = [
      [USER_B, ['teacher', 'manager'], true],
      [USER_A, ['manager', 'teacher'], true],
      [USER_B, ['admin', 'teacher'], false],
      [USER_C, ['teacher', 'manager', 'member'], false],
    ];
    for (const [userId, names, expected] of cases) {
      await expect(repo.userHasAnyRole(userId, names)).resolves.toBe(expected);
      await expect(drizzleUserHasAnyRole(userId, names)).resolves.toBe(expected);
    }
  });

  it('thứ tự tham số đã biên dịch của hai phía giống hệt nhau: tham số ngoài trước, rồi từng đoạn theo thứ tự mảng', () => {
    const roleNames = ['teacher', 'manager', 'member'];
    const drizzleQuery = new PgDialect().sqlToQuery(drizzleSql`
      select 1 as ok from role_assignments ra join role r on r.id = ra.role_id
      where ra.user_id = ${USER_A} and r.short_name in (${drizzleSql.join(roleNames.map((n) => drizzleSql`${n}`), drizzleSql`, `)}) limit 1`);
    const kyselyQuery = kyselySql`
      select 1 as ok from role_assignments ra join role r on r.id = ra.role_id
      where ra.user_id = ${USER_A} and r.short_name in (${kyselySql.join(roleNames.map((n) => kyselySql`${n}`), kyselySql`, `)}) limit 1`
      .compile(db);
    expect(kyselyQuery.parameters).toEqual([USER_A, 'teacher', 'manager', 'member']);
    expect(drizzleQuery.params).toEqual(kyselyQuery.parameters);
    expect(kyselyQuery.sql).toContain('in ($2, $3, $4)');
    expect(drizzleQuery.sql).toContain('in ($2, $3, $4)');
  });

  it('đoạn chứa biểu thức con có tham số riêng: tham số của biểu thức con giữ vị trí của đoạn ở cả hai phía, kết quả thật bằng nhau', async () => {
    // Phía Kysely: ghép cùng khuôn với đoạn đầu là biểu thức con lower(${'TeAcHeR'}).
    const kyselyFragments = [kyselySql`lower(${'TeAcHeR'})`, kyselySql`${'manager'}`];
    const kyselyQuery = kyselySql<{ ok: number }>`
      select 1 as ok from role_assignments ra join role r on r.id = ra.role_id
      where ra.user_id = ${USER_B} and lower(r.short_name) in (${kyselySql.join(kyselyFragments, kyselySql`, `)}) limit 1`
      .compile(db);
    expect(kyselyQuery.parameters).toEqual([USER_B, 'TeAcHeR', 'manager']);
    const kyselyResult = await kyselySql<{ ok: number }>`
      select 1 as ok from role_assignments ra join role r on r.id = ra.role_id
      where ra.user_id = ${USER_B} and lower(r.short_name) in (${kyselySql.join(kyselyFragments, kyselySql`, `)}) limit 1`
      .execute(db);
    // Phía Drizzle: cùng biểu thức con, cùng vị trí đoạn.
    const drizzleFragments = [drizzleSql`lower(${'TeAcHeR'})`, drizzleSql`${'manager'}`];
    const drizzleQuery = new PgDialect().sqlToQuery(drizzleSql`
      select 1 as ok from role_assignments ra join role r on r.id = ra.role_id
      where ra.user_id = ${USER_B} and lower(r.short_name) in (${drizzleSql.join(drizzleFragments, drizzleSql`, `)}) limit 1`);
    expect(drizzleQuery.params).toEqual(kyselyQuery.parameters);
    const drizzleResult = await drizzleDb.execute(drizzleSql`
      select 1 as ok from role_assignments ra join role r on r.id = ra.role_id
      where ra.user_id = ${USER_B} and lower(r.short_name) in (${drizzleSql.join(drizzleFragments, drizzleSql`, `)}) limit 1`);
    // USER_B giữ vai manager: khớp qua đoạn thứ hai ở cả hai phía.
    expect(kyselyResult.rows.length).toBe(1);
    expect(Array.isArray(drizzleResult) ? (drizzleResult[0]?.rows.length ?? 0) : drizzleResult.rows.length).toBe(1);
  });

  it('0 đoạn: phía Drizzle không chốt chặn biên dịch thành IN () và bị PostgreSQL từ chối; repository trả false ngay', async () => {
    const unguarded = new PgDialect().sqlToQuery(drizzleSql`
      select 1 as ok from role_assignments ra join role r on r.id = ra.role_id
      where ra.user_id = ${USER_A} and r.short_name in (${drizzleSql.join([], drizzleSql`, `)}) limit 1`);
    expect(unguarded.sql).toContain('in ()');
    await expect(drizzleUserHasAnyRole(USER_A, [])).rejects.toThrow();
    await expect(repo.userHasAnyRole(USER_A, [])).resolves.toBe(false);
  });
});

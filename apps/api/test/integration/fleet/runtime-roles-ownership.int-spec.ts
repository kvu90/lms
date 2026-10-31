import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildOwnershipTransferQuery } from '../../../src/runtime-roles';

/**
 * Ca hồi quy của việc CHUYỂN CHỦ SỞ HỮU ĐỐI TƯỢNG sang role
 * migration (issue #603, tiếp nối issue #586): câu truy vấn
 * `buildOwnershipTransferQuery` KHÔNG được liệt kê sequence gắn
 * với cột của bảng, vì PostgreSQL từ chối đổi chủ riêng cho
 * sequence dạng này ở cả hai động từ ALTER TABLE và ALTER SEQUENCE
 * ("cannot change owner of sequence") — chính lỗi này đã làm
 * deploy production của PR #595 lỗi ở bước migrate.
 *
 * Kiểm chứng trên database thật của riêng ca này (tên mang hậu tố
 * 603, dọn sạch ở afterAll): một bảng serial đúng dạng bảng
 * `__drizzle_migrations` của drizzle-kit (schema `drizzle`), một
 * bảng có cột identity, một sequence rời và một bảng thường — tất
 * cả thuộc role quản trị của cụm. Ca khẳng định hai điểm: danh
 * sách câu lệnh do truy vấn sinh ra loại cả hai sequence gắn cột
 * nhưng giữ sequence rời; và chạy toàn bộ danh sách theo đúng thứ
 * tự trả về thì không lỗi, chủ cuối của mọi đối tượng (bảng,
 * sequence gắn cột, sequence rời, index) đều là role migration.
 *
 * Vai quản trị suy ra từ username của `DATABASE_URL` (môi trường
 * test của repo) để ca chạy được trên mọi cụm, không khóa cứng tên
 * `postgres`: ở CI đó là user `postgres`, ở cụm local có thể là
 * superuser khác.
 */
const SCRATCH_DATABASE = 'lms_test_ownership_603';
const MIGRATOR_ROLE = 'lms_migrator_test_603';

const ADMIN_ROLE = decodeURIComponent(new URL(process.env.DATABASE_URL!).username || 'postgres');

/** Dựng URL kết nối tới một database trên cùng cụm với database test của repo. */
function clusterUrl(database: string): string {
  const base = new URL(process.env.DATABASE_URL!);
  base.pathname = `/${database}`;
  return base.toString();
}

/** Bọc một định danh Postgres trong dấu nháy kép cho các câu lệnh quản trị của ca test. */
function quoted(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function withClient<T>(connectionString: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Lấy danh sách câu lệnh chuyển chủ do truy vấn sinh ra trên database trầy. */
async function listTransferStatements(): Promise<string[]> {
  const query = buildOwnershipTransferQuery(ADMIN_ROLE, MIGRATOR_ROLE);
  const rows = await withClient(clusterUrl(SCRATCH_DATABASE), async (client) => {
    const result = await client.query<{ statement: string }>(query);
    return result.rows;
  });
  return rows.map((row) => row.statement);
}

beforeAll(async () => {
  // Dọn tàn dư của lượt chạy trước (nếu có) rồi dựng database trầy
  // với đúng bốn dạng đối tượng của ca hồi quy.
  await withClient(clusterUrl('postgres'), async (client) => {
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${SCRATCH_DATABASE}' AND pid <> pg_backend_pid()`,
    );
    await client.query(`DROP DATABASE IF EXISTS ${quoted(SCRATCH_DATABASE)}`);
    await client.query(`DROP ROLE IF EXISTS ${quoted(MIGRATOR_ROLE)}`);
    await client.query(`CREATE ROLE ${quoted(MIGRATOR_ROLE)}`);
    await client.query(`CREATE DATABASE ${quoted(SCRATCH_DATABASE)} OWNER ${quoted(ADMIN_ROLE)}`);
  });
  await withClient(clusterUrl(SCRATCH_DATABASE), async (client) => {
    await client.query(`CREATE SCHEMA drizzle`);
    await client.query(`CREATE TABLE drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY)`);
    await client.query(`CREATE TABLE public.identity_tbl (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, note TEXT)`);
    await client.query(`CREATE SEQUENCE public.standalone_seq`);
    await client.query(`CREATE TABLE public.plain_tbl (id INTEGER PRIMARY KEY)`);
  });
}, 30000);

afterAll(async () => {
  await withClient(clusterUrl('postgres'), async (client) => {
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${SCRATCH_DATABASE}' AND pid <> pg_backend_pid()`,
    );
    await client.query(`DROP DATABASE IF EXISTS ${quoted(SCRATCH_DATABASE)}`);
    await client.query(`DROP ROLE IF EXISTS ${quoted(MIGRATOR_ROLE)}`);
  });
});

describe('Chuyển chủ sở hữu đối tượng sang role migration không liệt kê sequence gắn cột (issue #603)', () => {
  it('danh sách chuyển chủ loại cả hai sequence gắn cột (serial và identity) nhưng giữ sequence rời', async () => {
    const statements = await listTransferStatements();
    // Sequence gắn cột: tên sinh theo quy tắc <bảng>_<cột>_seq.
    expect(statements.some((s) => s.includes('__drizzle_migrations_id_seq'))).toBe(false);
    expect(statements.some((s) => s.includes('identity_tbl_id_seq'))).toBe(false);
    // Sequence rời vẫn được liệt kê để chuyển trực tiếp.
    expect(statements.some((s) => s.includes('standalone_seq'))).toBe(true);
    // Các bảng vẫn được liệt kê — sequence gắn cột đổi chủ theo bảng.
    expect(statements.some((s) => s.includes('__drizzle_migrations'))).toBe(true);
    expect(statements.some((s) => s.includes('identity_tbl'))).toBe(true);
    expect(statements.some((s) => s.includes('plain_tbl'))).toBe(true);
  });

  it('chạy toàn bộ câu lệnh theo thứ tự trả về không lỗi và mọi đối tượng về chủ migration', async () => {
    const statements = await listTransferStatements();
    await withClient(clusterUrl(SCRATCH_DATABASE), async (client) => {
      for (const statement of statements) {
        await client.query(statement);
      }
    });
    const owners = await withClient(clusterUrl(SCRATCH_DATABASE), async (client) => {
      const result = await client.query<{ relname: string; relkind: string; owner: string }>(
        `SELECT c.relname, c.relkind, r.rolname AS owner FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner WHERE ns.nspname IN ('public', 'drizzle') AND c.relkind IN ('r', 'S', 'i') ORDER BY c.relname`,
      );
      return result.rows;
    });
    // Bốn bảng/sequence/index của ca đều phải về chủ migration.
    expect(owners.length).toBeGreaterThan(0);
    for (const row of owners) {
      expect(row.owner).toBe(MIGRATOR_ROLE);
    }
    const byName = new Map(owners.map((row) => [row.relname, row]));
    expect(byName.get('__drizzle_migrations_id_seq')?.owner).toBe(MIGRATOR_ROLE);
    expect(byName.get('identity_tbl_id_seq')?.owner).toBe(MIGRATOR_ROLE);
    expect(byName.get('standalone_seq')?.owner).toBe(MIGRATOR_ROLE);
  });
});

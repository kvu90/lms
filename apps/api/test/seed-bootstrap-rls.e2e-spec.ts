import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Hồi quy sự cố triển khai TENANT-1 (#196, PR #202): production reset DB
 * theo baseline fail-closed xong app KHÔNG boot được — SeedService chạy
 * `onApplicationBootstrap` ngoài ngữ cảnh tenant nên
 * `TenantsService.ensurePlatformTenant` bị RLS WITH CHECK chặn (42501),
 * web crash-loop, seed không chạy được. Mọi e2e thường không bắt được
 * lớp lỗi này vì kết nối test là superuser (bỏ qua RLS kể cả FORCE) và vì
 * app-under-test boot trong cùng tiến trình test.
 *
 * Spec này tái hiện ĐÚNG điều kiện production: dựng một DB trống riêng,
 * áp đúng baseline hiện hành, tạo một role NOSUPERUSER/NOBYPASSRLS, rồi
 * boot app thật (`dist/main.js`, tiến trình con riêng, DATABASE_URL trỏ
 * role thường vào DB trống) và chờ đăng nhập admin thành công qua HTTP.
 * Trước hotfix: tiến trình con chết 42501 ở bootstrap, spec đỏ. Sau
 * hotfix: boot qua, seed gieo đủ tenant nền tảng + tenant trường mặc
 * định + membership của admin.
 *
 * Yêu cầu: dist của apps/api phải được build trước (CI luôn build trước
 * bước test; chạy local: `pnpm --filter @lms/api build`).
 *
 * Tự vệ chống test rỗng: spec cũng khẳng định role thường NGOÀI ngữ
 * cảnh thấy 0 tenant và INSERT bị 42501 — tức RLS thật sự cắn role này,
 * nên boot qua được chỉ có thể nhờ ngữ cảnh platform của seed.
 */

const ADMIN_URL =
  process.env.LMS_TEST_DATABASE_URL ?? 'postgres://lms:lms@localhost:5432/lms_test_api';
const SCRATCH_DB = 'lms_test_seed_rls';
const APP_ROLE = 'lms_seed_rls_app';
const APP_ROLE_PASSWORD = 'seed-rls-test-only';
const APP_PORT = 3199;
const APP_BASE = `http://127.0.0.1:${APP_PORT}`;

function urlFor(dbName: string, username?: string, password?: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  if (username) url.username = username;
  if (password) url.password = password;
  return url.toString();
}

async function pg(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function tryAdminLogin(): Promise<boolean> {
  try {
    const res = await fetch(`${APP_BASE}/api/v1/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Admin123!' }),
    });
    return res.status === 200 || res.status === 201;
  } catch {
    return false;
  }
}

describe('Seed bootstrap trên DB trống bằng role thường dưới RLS fail-closed (#202)', () => {
  let child: ChildProcess | undefined;
  let childOutput = '';
  let childExitCode: number | null = null;

  beforeAll(async () => {
    // 1) DB trống riêng + baseline hiện hành, dựng bằng kết nối quản trị.
    const admin = await pg(urlFor('postgres'));
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
      await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
    } finally {
      await admin.end();
    }
    const scratchAdmin = await pg(urlFor(SCRATCH_DB));
    try {
      const drizzleDir = join(process.cwd(), 'drizzle');
      const baselines = readdirSync(drizzleDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.endsWith('_baseline'))
        .map((d) => join(drizzleDir, d.name, 'migration.sql'));
      expect(baselines).toHaveLength(1);
      await scratchAdmin.query(readFileSync(baselines[0]!, 'utf8'));
      // Role ứng dụng: thường tuyệt đối — không superuser, không
      // bypassrls, không phải chủ sở hữu bảng. Đây là đúng hình dạng kết
      // nối production đã làm app crash-loop.
      await scratchAdmin.query(
        `CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_ROLE_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await scratchAdmin.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
      await scratchAdmin.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
      await scratchAdmin.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
      await scratchAdmin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${APP_ROLE}`);
    } finally {
      await scratchAdmin.end();
    }

    // 2) Boot app thật bằng role thường trên DB trống (tiến trình con).
    const mainJs = join(process.cwd(), 'dist', 'main.js');
    if (!existsSync(mainJs)) {
      throw new Error(
        'Thiếu apps/api/dist/main.js — build trước khi chạy spec này: pnpm --filter @lms/api build',
      );
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: urlFor(SCRATCH_DB, APP_ROLE, APP_ROLE_PASSWORD),
      PORT: String(APP_PORT),
      NODE_ENV: 'test',
    };
    delete env.PLATFORM_ADMIN_USERNAME;
    child = spawn(process.execPath, [mainJs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (d: Buffer) => { childOutput += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { childOutput += d.toString(); });
    child.on('exit', (code) => { childExitCode = code; });

    // 3) Chờ boot + seed xong qua dấu hiệu ngoài: admin đăng nhập được.
    const deadline = Date.now() + 180_000;
    for (;;) {
      if (childExitCode !== null) {
        throw new Error(
          `App con chết khi boot (exit ${childExitCode}) trên DB trống bằng role thường. ` +
          `Cuối log:\n${childOutput.slice(-3000)}`,
        );
      }
      if (await tryAdminLogin()) break;
      if (Date.now() > deadline) {
        throw new Error(
          `App con không sẵn sàng sau 180s trên DB trống bằng role thường. ` +
          `Cuối log:\n${childOutput.slice(-3000)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }, 300_000);

  afterAll(async () => {
    if (child && childExitCode === null) {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 1500));
      if (childExitCode === null) child.kill('SIGKILL');
    }
    const admin = await pg(urlFor('postgres'));
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('app boot qua được bootstrap và admin khởi tạo đăng nhập được qua HTTP', async () => {
    expect(childExitCode).toBeNull();
    await expect(tryAdminLogin()).resolves.toBe(true);
  });

  it('seed đã gieo tenant nền tảng + tenant trường mặc định + membership của admin (đọc trong ngữ cảnh platform)', async () => {
    const client = await pg(urlFor(SCRATCH_DB, APP_ROLE, APP_ROLE_PASSWORD));
    try {
      await client.query(`SELECT set_config('app.platform', 'on', false)`);
      const tenants = await client.query<{ slug: string }>(
        `SELECT slug FROM tenants WHERE slug IN ('trang-chinh', 'truong-mac-dinh') ORDER BY slug`,
      );
      expect(tenants.rows.map((r) => r.slug)).toEqual(['trang-chinh', 'truong-mac-dinh']);
      const memberships = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM tenant_memberships tm
           JOIN users u ON u.id = tm.user_id
          WHERE u.username = 'admin' AND tm.status = 'active'`,
      );
      expect(Number(memberships.rows[0]!.count)).toBeGreaterThanOrEqual(2);
    } finally {
      await client.end();
    }
  });

  it('role thường ngoài ngữ cảnh vẫn bị RLS chặn (fail-closed còn nguyên — boot qua được là nhờ ngữ cảnh platform của seed)', async () => {
    const client = await pg(urlFor(SCRATCH_DB, APP_ROLE, APP_ROLE_PASSWORD));
    try {
      const seen = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM tenants`,
      );
      expect(Number(seen.rows[0]!.count)).toBe(0);
      await expect(
        client.query(
          `INSERT INTO tenants (slug, name, kind) VALUES ('ngoai-ngu-canh', 'X', 'school')`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.end();
    }
  });
});

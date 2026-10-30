/**
 * Kiểm thử khôi phục định kỳ của đội kho (issue #586) — script CLI
 * chạy bằng `pnpm --filter @lms/api fleet:restore-test [--space <slug>]`:
 *
 * 1. Chọn kho: theo slug được chỉ định, hoặc theo vòng xoay công
 *    bằng (kho đang hoạt động có lượt kiểm thử cũ nhất — xem
 *    `pickRestoreCandidate`) khi lịch định kỳ gọi không kèm slug.
 * 2. Lấy bản sao lưu MỚI NHẤT của kho và kiểm toàn vẹn theo tệp băm
 *    đi kèm TRƯỚC khi làm bất cứ việc gì khác: bản sao bị hỏng/bị
 *    sửa (hoặc thiếu tệp băm) khiến lượt kiểm thử ghi nhận THẤT
 *    BẠI ngay — đây là cách một bản sao lưu hỏng được phát hiện
 *    trong vận hành thường ngày thay vì lúc cần khôi phục thật.
 * 3. Khôi phục vào một DATABASE TẠM bằng kết nối quản trị
 *    (`DATABASE_ADMIN_URL`, dự phòng `MIGRATION_DATABASE_URL`), rồi
 *    kiểm: (a) số bảng khôi phục được bằng đúng số bảng trong mục
 *    lục của tệp dump; (b) kiểm tra khói ở mức dữ kiện — tài khoản
 *    quản trị gieo sẵn của kho (`FLEET_SMOKE_ADMIN_USERNAME`, mặc
 *    định `admin`; tắt bằng `FLEET_SMOKE_CHECK=off`) tồn tại và
 *    chưa bị xoá trong bản khôi phục. Kiểm tra khói ở mức HTTP
 *    (đăng nhập thật qua ứng dụng) là việc của nghiệm thu ứng dụng,
 *    không nằm trong công cụ vận hành này.
 * 4. Ghi kết quả vào registry của kho (trạng thái + thời điểm) và
 *    LUÔN xoá database tạm, kể cả khi khôi phục hay kiểm tra hỏng
 *    giữa chừng — database tạm còn sót là rò rỉ tài nguyên của cụm.
 *
 * Một lượt kiểm thử thất bại là SỰ CỐ vận hành: script thoát mã 1
 * để lịch giám sát bắt được. Lỗi cấu hình của chính công cụ (chưa
 * có URL quản trị, thư mục sao lưu trống cấu hình…) dừng bằng ngoại
 * lệ TRƯỚC khi chọn kho và không ghi nhận thất bại cho bất kỳ kho
 * nào — registry không được phép mang sự cố giả.
 */
import { existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Client } from 'pg';
import { quoteIdentifier } from './control-plane-provision';
import {
  newFleetRunId,
  parseBackupFileName,
  pickRestoreCandidate,
  readVerifiedBackupFile,
  retargetUrl,
  runPgTool,
  type FleetSpace,
} from './fleet-common';
import { FleetRegistryWriter } from './fleet-registry-writer';

/** Tuỳ chọn của một lượt kiểm thử khôi phục; mặc định đọc từ biến môi trường của tiến trình. */
export type FleetRestoreTestOptions = {
  env?: NodeJS.ProcessEnv;
  backupDir?: string;
  /** Chỉ định kho cần kiểm thử; bỏ trống thì chọn theo vòng xoay. */
  spaceSlug?: string;
  log?: (message: string) => void;
};

/** Kết quả một lượt kiểm thử khôi phục. */
export type FleetRestoreTestResult = {
  slug: string;
  status: 'success' | 'failed';
  tempDatabase?: string;
  tableCount?: number;
  totalRows?: number;
  detail?: string;
};

/** Tên tệp sao lưu mới nhất trong thư mục của kho (theo thời điểm sửa); null khi chưa có bản nào. */
function newestBackupFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((name) => parseBackupFileName(name) !== null)
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0] ? join(dir, files[0].name) : null;
}

/**
 * Đếm số bảng THUỘC SCHEMA PUBLIC mà mục lục của tệp dump khai
 * (dòng TOC dạng TABLE của schema public, không tính TABLE DATA và
 * không tính các schema hệ thống như schema `drizzle` chứa bảng
 * nhật ký migration) — cùng phạm vi với số bảng đọc từ `pg_tables`
 * sau khôi phục để hai con số đối chiếu được với nhau.
 */
function countDumpTables(listOutput: Buffer): number {
  return listOutput
    .toString('utf8')
    .split('\n')
    .filter((line) => /^\d+; \d+ \d+ TABLE (?!DATA )public /.test(line.trim())).length;
}

/**
 * Chạy một lượt kiểm thử khôi phục.
 * @throws Error khi công cụ thiếu cấu hình (chưa có URL quản trị,
 * chưa cấu hình thư mục sao lưu, slug chỉ định không có trong sổ,
 * hoặc không còn kho đang hoạt động nào cho vòng xoay).
 */
export async function runFleetRestoreTest(options: FleetRestoreTestOptions = {}): Promise<FleetRestoreTestResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((message: string) => console.log(message));
  const backupDir = options.backupDir ?? env.FLEET_BACKUP_DIR;
  if (!backupDir) throw new Error('FLEET_BACKUP_DIR is required');
  const adminUrl = env.DATABASE_ADMIN_URL ?? env.MIGRATION_DATABASE_URL;
  if (!adminUrl) throw new Error('DATABASE_ADMIN_URL (or MIGRATION_DATABASE_URL) is required to create the temporary restore database');
  const encryptionKey = env.FLEET_BACKUP_ENCRYPTION_KEY || undefined;
  const runId = newFleetRunId(new Date());

  const writer = new FleetRegistryWriter(env);
  try {
    const spaces = await writer.listFleetSpaces();
    let space: FleetSpace | null;
    if (options.spaceSlug) {
      space = spaces.find((candidate) => candidate.slug === options.spaceSlug) ?? null;
      if (!space) throw new Error(`space ${options.spaceSlug} is not in the registry`);
    } else {
      space = pickRestoreCandidate(spaces);
      if (!space) throw new Error('no active space is available for a restore test');
    }

    const fail = async (detail: string, extra?: Partial<FleetRestoreTestResult>): Promise<FleetRestoreTestResult> => {
      await writer.recordRestoreOutcome(space.id, 'failed', new Date());
      log(`[${space.slug}] restore test FAILED: ${detail}`);
      return { slug: space.slug, status: 'failed', detail, ...extra };
    };

    const backupPath = newestBackupFile(join(backupDir, space.slug));
    if (!backupPath) return await fail('no backup file found for this space');
    log(`[${space.slug}] restore test on ${basename(backupPath)}`);

    let plain: Buffer;
    try {
      plain = readVerifiedBackupFile(backupPath, encryptionKey);
    } catch (error) {
      return await fail(error instanceof Error ? error.message : String(error));
    }

    const plainPath = join(backupDir, `.restore-${runId}.dump`);
    const tempDatabase = `lms_restore_test_${space.slug.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}_${runId.replace(/\D/g, '').slice(0, 14)}`;
    writeFileSync(plainPath, plain);
    const admin = new Client({ connectionString: retargetUrl(adminUrl, 'postgres') });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(tempDatabase)}`);
      const tempUrl = retargetUrl(adminUrl, tempDatabase);
      try {
        await runPgTool('pg_restore', tempUrl, ['--no-owner', '--no-privileges', plainPath], env);
      } catch (error) {
        return await fail(error instanceof Error ? error.message : String(error), { tempDatabase });
      }
      const listOutput = await runPgTool('pg_restore', tempUrl, ['--list', plainPath], env);
      const expectedTables = countDumpTables(listOutput);

      const check = new Client({ connectionString: tempUrl });
      await check.connect();
      try {
        const tablesResult = await check.query<{ tablename: string }>(
          `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
        );
        const tables = tablesResult.rows.map((row) => row.tablename);
        let totalRows = 0;
        for (const table of tables) {
          const counted = await check.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM ${quoteIdentifier('public')}.${quoteIdentifier(table)}`,
          );
          totalRows += counted.rows[0]?.n ?? 0;
        }
        if (tables.length !== expectedTables || expectedTables === 0) {
          return await fail(`restored ${tables.length} public table(s), dump catalog declares ${expectedTables}`, {
            tempDatabase,
            tableCount: tables.length,
            totalRows,
          });
        }
        // Kiểm tra khói ở mức dữ kiện trên tài khoản quản trị gieo
        // sẵn của kho: cột điều kiện chỉ gồm các cột thật sự có
        // trong bảng users của bản khôi phục (username luôn có; các
        // cột đánh dấu xoá mềm tuỳ thế hệ schema).
        if (tables.includes('users') && env.FLEET_SMOKE_CHECK !== 'off') {
          const columnsResult = await check.query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users'`,
          );
          const columns = new Set(columnsResult.rows.map((row) => row.column_name));
          const conditions = ['username = $1'];
          if (columns.has('deleted_at')) conditions.push('deleted_at IS NULL');
          if (columns.has('deleted')) conditions.push('deleted = false');
          const smokeUser = env.FLEET_SMOKE_ADMIN_USERNAME || 'admin';
          const smoke = await check.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM ${quoteIdentifier('public')}.${quoteIdentifier('users')} WHERE ${conditions.join(' AND ')}`,
            [smokeUser],
          );
          if ((smoke.rows[0]?.n ?? 0) < 1) {
            return await fail(`seeded admin account ${smokeUser} not found in the restored database`, {
              tempDatabase,
              tableCount: tables.length,
              totalRows,
            });
          }
        }
        await writer.recordRestoreOutcome(space.id, 'success', new Date());
        log(`[${space.slug}] restore test passed: ${tables.length} table(s), ${totalRows} row(s)`);
        return { slug: space.slug, status: 'success', tempDatabase, tableCount: tables.length, totalRows };
      } finally {
        await check.end();
      }
    } finally {
      // Database tạm luôn bị xoá, kể cả khi khôi phục/kiểm tra
      // hỏng: giữ lại là rò rỉ tài nguyên và dữ kiện của cụm.
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(tempDatabase)}`);
      } catch {
        // Xoá không thành thì để lỗi gốc của lượt kiểm thử đứng
        // trước; database tạm mang tên có mốc lượt chạy nên đội
        // vận hành truy được và xoá tay.
      }
      await admin.end();
      if (existsSync(plainPath)) unlinkSync(plainPath);
    }
  } finally {
    await writer.close();
  }
}

if (require.main === module) {
  const spaceIndex = process.argv.indexOf('--space');
  const spaceSlug = spaceIndex >= 0 ? process.argv[spaceIndex + 1] : undefined;
  runFleetRestoreTest({ spaceSlug })
    .then((result) => {
      process.exitCode = result.status === 'success' ? 0 : 1;
    })
    .catch((error: unknown) => {
      console.error('fleet-restore-test failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    });
}

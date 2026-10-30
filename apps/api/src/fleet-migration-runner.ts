/**
 * Runner migration của ĐỘI KHO (issue #586) — script CLI chạy bằng
 * `pnpm --filter @lms/api fleet:migrate` trên máy triển khai (hoặc
 * được lịch vận hành gọi), áp bộ migration hiện hành của repo lên
 * MỌI kho trong sổ đăng ký của control plane theo đợt an toàn:
 *
 * 1. Đọc sổ: danh sách kho + phiên bản theo sổ từ control plane
 *    (`FleetRegistryWriter`); phiên bản đích là tên thư mục
 *    migration cuối cùng của bộ migration nghiệp vụ.
 * 2. Chia đợt (xem `orderSpacesIntoWaves`): kho nền tảng trước, một
 *    trung tâm canary, rồi các đợt theo `FLEET_WAVE_SIZE` (mặc định
 *    2). Một kho hỏng KHÔNG chặn các kho khác trong cùng đợt, nhưng
 *    đợt có kho hỏng thì các đợt SAU không chạy — lỗi ở canary phải
 *    dừng đội kho lại cho người vận hành xem, không lan tiếp.
 * 3. Với mỗi kho: đọc phiên bản THẬT trong database của kho (nhật
 *    ký `drizzle.__drizzle_migrations` là nguồn sự thật). Đã ở
 *    phiên bản đích thì bỏ qua hẳn — không chụp sao lưu, không ghi
 *    lượt chạy; chỉ khi sổ lệch sự thật mới đồng bộ lại sổ (không
 *    bịa lượt chạy). Chưa đạt đích thì: chụp BẢN SAO LƯU CHỐT gắn
 *    mã lượt chạy (điểm khôi phục của riêng kho đó — chụp hỏng thì
 *    kho bị đánh dấu hỏng và KHÔNG áp migration), áp migration bằng
 *    bộ máy Drizzle, đọc lại phiên bản thật để đối chiếu, rồi ghi
 *    kết quả (phiên bản đầu/đích, từng bước, lỗi) vào registry.
 *    Migration hỏng KHÔNG tự khôi phục từ bản chốt: khôi phục là
 *    một hành động vận hành riêng có ghi nhận (xem
 *    `fleet-restore-test.ts` và quy trình vận hành) — tự động khôi
 *    phục có thể xoá mất dữ kiện vừa ghi hợp lệ sau điểm chụp.
 * 4. Chạy lại một lượt chỉ xử lý các kho chưa đạt đích: kho đã đạt
 *    đích bị bỏ qua ở bước 3 nên không sinh lượt chạy trùng.
 *
 * Mức tự động hoá là LỰA CHỌN KỸ THUẬT của đội thi công: runner là
 * CLI do người vận hành/lịch của hệ triển khai gọi tường minh và
 * thoát với mã 1 khi có kho hỏng, không phải tiến trình nền tự chạy
 * — quyết định "áp migration lên đội kho" luôn có một điểm kích
 * hoạt rõ ràng để đối chiếu với cửa sổ bảo trì.
 */
import { basename, join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';
import type { SchemaMigrationStep } from '@lms/db/control-plane';
import {
  dumpDatabaseToFile,
  listMigrationFolders,
  newFleetRunId,
  orderSpacesIntoWaves,
  parsePositiveInt,
  readDatabaseSchemaVersion,
  resolveDumpConnectionUrl,
  resolveSpaceConnectionUrl,
  type FleetSpace,
} from './fleet-common';
import { FleetRegistryWriter } from './fleet-registry-writer';

/** Tuỳ chọn của một lượt chạy runner; mặc định đọc từ biến môi trường của tiến trình. */
export type FleetMigrationOptions = {
  env?: NodeJS.ProcessEnv;
  /** Thư mục chứa các thư mục migration nghiệp vụ; mặc định `FLEET_MIGRATIONS_DIR` hoặc `drizzle/` ở thư mục làm việc. */
  migrationsDir?: string;
  /** Thư mục gốc chứa các bản sao lưu theo kho; mặc định `FLEET_BACKUP_DIR` (bắt buộc có). */
  backupDir?: string;
  /** Kích thước các đợt sau canary; mặc định `FLEET_WAVE_SIZE` hoặc 2. */
  waveSize?: number;
  log?: (message: string) => void;
};

/** Kết quả của một kho trong lượt chạy. */
export type FleetMigrationSpaceOutcome = {
  slug: string;
  outcome: 'migrated' | 'failed' | 'reconciled' | 'skipped';
  detail?: string;
};

/** Tổng kết một lượt chạy runner: phiên bản đích và kết quả từng kho đã chạm tới. */
export type FleetMigrationSummary = {
  runId: string;
  targetVersion: string;
  outcomes: FleetMigrationSpaceOutcome[];
  failedCount: number;
};

/** Cắt ngắn chi tiết lỗi ghi vào nhật ký bước: đủ để chẩn đoán, không phình dòng jsonb. */
function errorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

/** Áp migration cho MỘT kho theo đúng trình tự chốt sao lưu → áp → đối chiếu → ghi registry. */
async function migrateSpace(
  space: FleetSpace,
  context: {
    env: NodeJS.ProcessEnv;
    migrationsDir: string;
    backupDir: string;
    runId: string;
    targetVersion: string;
    writer: FleetRegistryWriter;
    log: (message: string) => void;
  },
): Promise<FleetMigrationSpaceOutcome> {
  const { env, writer, log } = context;
  const url = resolveSpaceConnectionUrl(space, env);
  const probe = new Client({ connectionString: url });
  await probe.connect();
  let fromVersion: string | null;
  try {
    fromVersion = await readDatabaseSchemaVersion(probe);
  } finally {
    await probe.end();
  }

  if (fromVersion === context.targetVersion) {
    if (space.registryVersion !== context.targetVersion) {
      await writer.syncVersion(space.id, context.targetVersion);
      log(`[${space.slug}] already at ${context.targetVersion} in its database; registry reconciled`);
      return { slug: space.slug, outcome: 'reconciled' };
    }
    log(`[${space.slug}] already at ${context.targetVersion}; skipped`);
    return { slug: space.slug, outcome: 'skipped' };
  }

  const steps: SchemaMigrationStep[] = [];
  const fail = async (detail: string): Promise<FleetMigrationSpaceOutcome> => {
    await writer.recordMigrationOutcome(space.id, {
      runId: context.runId,
      fromVersion,
      toVersion: context.targetVersion,
      status: 'failed',
      steps,
    });
    log(`[${space.slug}] FAILED: ${detail}`);
    return { slug: space.slug, outcome: 'failed', detail };
  };

  // Điểm khôi phục riêng của kho: bản chốt gắn mã lượt chạy. Chụp
  // hỏng thì dừng kho này tại đây — không áp migration khi không
  // có điểm quay lui. Bản chốt chụp qua kết nối quản trị của cụm
  // khi được cấu hình (xem `resolveDumpConnectionUrl`): schema
  // nghiệp vụ áp FORCE ROW LEVEL SECURITY cả với chủ sở hữu nên
  // role migration tự nó không xuất được bản sao đầy đủ.
  try {
    const stored = await dumpDatabaseToFile({
      url: resolveDumpConnectionUrl(space, env),
      dir: join(context.backupDir, space.slug),
      kind: 'pre-migration',
      runId: context.runId,
      at: new Date(),
      encryptionKey: env.FLEET_BACKUP_ENCRYPTION_KEY || undefined,
      env,
    });
    steps.push({ name: 'pre-migration-backup', status: 'success', detail: basename(stored.path) });
  } catch (error) {
    const detail = errorDetail(error);
    steps.push({ name: 'pre-migration-backup', status: 'failed', detail });
    return fail(`pre-migration backup failed: ${detail}`);
  }

  const pool = new Pool({ connectionString: url });
  try {
    const db = drizzle({ client: pool });
    await migrate(db, { migrationsFolder: context.migrationsDir });
    steps.push({ name: 'apply-migrations', status: 'success' });
  } catch (error) {
    const detail = errorDetail(error);
    steps.push({ name: 'apply-migrations', status: 'failed', detail });
    return fail(`migration failed: ${detail}`);
  } finally {
    await pool.end();
  }

  // Đối chiếu lại bằng sự thật trong database của kho, không tin
  // mỗi việc bộ máy migration không ném lỗi.
  const verify = new Client({ connectionString: url });
  await verify.connect();
  let reached: string | null;
  try {
    reached = await readDatabaseSchemaVersion(verify);
  } finally {
    await verify.end();
  }
  if (reached !== context.targetVersion) {
    const detail = `expected version ${context.targetVersion} after migration, database reports ${reached ?? 'none'}`;
    steps.push({ name: 'verify-version', status: 'failed', detail });
    return fail(detail);
  }
  steps.push({ name: 'verify-version', status: 'success' });
  await writer.recordMigrationOutcome(space.id, {
    runId: context.runId,
    fromVersion,
    toVersion: context.targetVersion,
    status: 'success',
    steps,
  });
  log(`[${space.slug}] migrated ${fromVersion ?? 'none'} -> ${context.targetVersion}`);
  return { slug: space.slug, outcome: 'migrated' };
}

/**
 * Chạy một lượt migration toàn đội kho.
 * @throws Error khi thiếu cấu hình bắt buộc (registry, thư mục sao
 * lưu, bộ migration rỗng) — lỗi cấu hình của công cụ, chưa kho nào
 * bị chạm tới nên không ghi nhận vào registry.
 */
export async function runFleetMigration(options: FleetMigrationOptions = {}): Promise<FleetMigrationSummary> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((message: string) => console.log(message));
  const backupDir = options.backupDir ?? env.FLEET_BACKUP_DIR;
  if (!backupDir) throw new Error('FLEET_BACKUP_DIR is required (pre-migration backups need a destination)');
  const migrationsDir = options.migrationsDir ?? env.FLEET_MIGRATIONS_DIR ?? join(process.cwd(), 'drizzle');
  const folders = listMigrationFolders(migrationsDir);
  const targetVersion = folders[folders.length - 1];
  if (!targetVersion) throw new Error(`no migration folders found under ${migrationsDir}`);
  const waveSize = options.waveSize ?? parsePositiveInt(env.FLEET_WAVE_SIZE, 2);
  const runId = newFleetRunId(new Date());

  const writer = new FleetRegistryWriter(env);
  try {
    const spaces = await writer.listFleetSpaces();
    const waves = orderSpacesIntoWaves(spaces, waveSize);
    log(`fleet migration run ${runId}: target ${targetVersion}, ${waves.length} wave(s)`);
    const outcomes: FleetMigrationSpaceOutcome[] = [];
    for (const [index, wave] of waves.entries()) {
      let waveFailed = false;
      for (const space of wave) {
        const outcome = await migrateSpace(space, {
          env,
          migrationsDir,
          backupDir,
          runId,
          targetVersion,
          writer,
          log,
        });
        outcomes.push(outcome);
        if (outcome.outcome === 'failed') waveFailed = true;
      }
      if (waveFailed) {
        log(`wave ${index + 1} had failures; later waves are not started`);
        break;
      }
    }
    const failedCount = outcomes.filter((outcome) => outcome.outcome === 'failed').length;
    log(`fleet migration run ${runId} finished: ${outcomes.length} space(s) processed, ${failedCount} failed`);
    return { runId, targetVersion, outcomes, failedCount };
  } finally {
    await writer.close();
  }
}

if (require.main === module) {
  runFleetMigration()
    .then((summary) => {
      process.exitCode = summary.failedCount > 0 ? 1 : 0;
    })
    .catch((error: unknown) => {
      console.error('fleet-migration-runner failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    });
}

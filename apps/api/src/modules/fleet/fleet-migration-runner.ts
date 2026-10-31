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
 * 3. Với mỗi kho: đối chiếu TOÀN TẬP tên migration đã áp trong
 *    database của kho (nhật ký `drizzle.__drizzle_migrations` là
 *    nguồn sự thật) với tập thư mục migration cục bộ. Tập còn
 *    thiếu RỖNG thì kho đã đạt đích: bỏ qua hẳn — không chụp sao
 *    lưu, không ghi lượt chạy; chỉ khi sổ lệch sự thật mới đồng bộ
 *    lại sổ (không bịa lượt chạy). Căn cứ là toàn tập chứ không
 *    phải migration mới nhất: một kho đã có migration mới nhất
 *    nhưng thiếu một migration cũ ở giữa vẫn còn thiếu và phải
 *    được áp đúng phần thiếu đó (bộ máy Drizzle áp theo hiệu tập
 *    tên). Còn thiếu thì: chụp BẢN SAO LƯU CHỐT gắn mã lượt chạy
 *    (điểm khôi phục của riêng kho đó — chụp hỏng thì kho bị đánh
 *    dấu hỏng và KHÔNG áp migration), áp migration bằng bộ máy
 *    Drizzle, đọc lại toàn tập đã áp để đối chiếu, rồi ghi kết
 *    quả (phiên bản đầu/đích, từng bước, lỗi) vào registry.
 *    Migration hỏng KHÔNG tự khôi phục từ bản chốt: khôi phục là
 *    một hành động vận hành riêng có ghi nhận (xem
 *    `fleet-restore-test.ts` và quy trình vận hành) — tự động khôi
 *    phục có thể xoá mất dữ kiện vừa ghi hợp lệ sau điểm chụp.
 * 4. Chạy lại một lượt chỉ xử lý các kho chưa đạt đích: kho đã đạt
 *    đích bị bỏ qua ở bước 3 nên không sinh lượt chạy trùng.
 *
 * Cô lập lỗi nằm ở ranh giới MỘT kho: mọi lỗi phát sinh trong lúc
 * xử lý một kho — mở kết nối, đọc phiên bản ở bước thăm dò, chụp
 * bản chốt, áp migration, và cả kết nối/đọc ở bước đối chiếu sau
 * khi áp — đều quy về kết quả `failed` của chính kho đó và được
 * ghi vào registry, không làm sập cả lượt chạy. Chỉ lỗi cấu hình
 * của chính công cụ (thiếu thư mục sao lưu, registry chưa cấu
 * hình, bộ migration rỗng) mới dừng cả lượt, và dừng TRƯỚC khi
 * bất kỳ kho nào bị chạm tới.
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
  readDatabaseAppliedMigrations,
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

/**
 * Áp migration cho MỘT kho theo đúng trình tự thăm dò → chốt sao
 * lưu → áp → đối chiếu → ghi registry. Toàn bộ phần xử lý của kho
 * nằm trong một khối bắt lỗi duy nhất (xem bất biến cô lập lỗi ở
 * đầu file): lỗi ở BẤT KỲ bước nào của kho này — kể cả suy ra URL,
 * mở kết nối hay đọc phiên bản ở bước thăm dò và bước đối chiếu —
 * đều kết thúc bằng ghi nhận `failed` cho chính kho đó qua `fail`,
 * không thoát ra làm sập lượt chạy.
 */
async function migrateSpace(
  space: FleetSpace,
  context: {
    env: NodeJS.ProcessEnv;
    migrationsDir: string;
    migrationFolders: string[];
    backupDir: string;
    runId: string;
    targetVersion: string;
    writer: FleetRegistryWriter;
    log: (message: string) => void;
  },
): Promise<FleetMigrationSpaceOutcome> {
  const { env, writer, log } = context;
  const steps: SchemaMigrationStep[] = [];
  let fromVersion: string | null = null;
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

  try {
    const url = resolveSpaceConnectionUrl(space, env);

    // Bước thăm dò: đọc TOÀN TẬP migration đã áp trong kho (căn cứ
    // quyết định còn thiếu gì) và phiên bản mới nhất (để ghi
    // fromVersion cho nhật ký lượt chạy).
    const probe = new Client({ connectionString: url });
    let applied: string[];
    try {
      await probe.connect();
      applied = await readDatabaseAppliedMigrations(probe);
      fromVersion = await readDatabaseSchemaVersion(probe);
    } finally {
      await probe.end().catch(() => undefined);
    }
    const missing = context.migrationFolders.filter((folder) => !applied.includes(folder));

    if (missing.length === 0) {
      if (space.registryVersion !== context.targetVersion) {
        await writer.syncVersion(space.id, context.targetVersion);
        log(`[${space.slug}] already at ${context.targetVersion} in its database; registry reconciled`);
        return { slug: space.slug, outcome: 'reconciled' };
      }
      log(`[${space.slug}] already at ${context.targetVersion}; skipped`);
      return { slug: space.slug, outcome: 'skipped' };
    }

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
    // mỗi việc bộ máy migration không ném lỗi: toàn tập đã áp phải
    // phủ đủ bộ cục bộ và phiên bản mới nhất phải là đích.
    const verify = new Client({ connectionString: url });
    let stillMissing: string[];
    let reached: string | null;
    try {
      await verify.connect();
      const appliedAfter = await readDatabaseAppliedMigrations(verify);
      stillMissing = context.migrationFolders.filter((folder) => !appliedAfter.includes(folder));
      reached = await readDatabaseSchemaVersion(verify);
    } finally {
      await verify.end().catch(() => undefined);
    }
    if (stillMissing.length > 0 || reached !== context.targetVersion) {
      const detail =
        stillMissing.length > 0
          ? `migration(s) still missing after apply: ${stillMissing.join(', ')}`
          : `expected version ${context.targetVersion} after migration, database reports ${reached ?? 'none'}`;
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
  } catch (error) {
    return fail(errorDetail(error));
  }
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
          migrationFolders: folders,
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

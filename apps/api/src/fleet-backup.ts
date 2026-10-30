/**
 * Sao lưu logic định kỳ của đội kho (issue #586) — script CLI chạy
 * bằng `pnpm --filter @lms/api fleet:backup`, hai chế độ:
 *
 * CHẾ ĐỘ CHẠY (mặc định): chụp một bản sao lưu logic cho từng kho
 * còn mang dữ kiện (trạng thái đang hoạt động hoặc tạm ngưng — kho
 * đã đóng đã hết vòng đời dữ kiện; kho đang cấp phát chưa chắc có
 * database để chụp) và cho chính database control plane. Mỗi kho
 * ghi kết quả (trạng thái + thời điểm) vào registry của mình ngay
 * sau lượt chụp, nên tỉ lệ sao lưu thành công của từng kho đọc
 * được trực tiếp từ control plane. Một kho chụp hỏng không chặn
 * các kho còn lại. Sau khi chụp, dọn các bản cũ quá hạn lưu trữ
 * (`FLEET_BACKUP_RETENTION_DAYS`, mặc định 30 ngày) nhưng luôn giữ
 * bản mới nhất của mỗi kho.
 *
 * CHẾ ĐỘ KIỂM (`--check`): không chụp gì, chỉ đối chiếu — kho nào
 * chưa có bản sao lưu thành công nào trong cửa sổ
 * `FLEET_BACKUP_MAX_AGE_HOURS` (mặc định 26 giờ, nới hơn chu kỳ
 * ngày một chút để dao động lịch không báo động giả) thì bị liệt
 * kê và tiến trình thoát mã 1. Control plane được kiểm theo cửa sổ
 * chặt hơn (`FLEET_CP_BACKUP_MAX_AGE_HOURS`, mặc định 13 giờ) dựa
 * trên tuổi tệp sao lưu mới nhất của nó, vì registry của control
 * plane nằm trong chính nó nên "lượt gần nhất" phải đọc từ đĩa.
 * Đây là điểm móc cảnh báo của vận hành: lịch giám sát gọi chế độ
 * kiểm và chuyển mã thoát khác 0 thành cảnh báo cho đội vận hành.
 *
 * Mức tự động hoá là LỰA CHỌN KỸ THUẬT của đội thi công: lịch chụp
 * do hệ triển khai/lịch của máy vận hành kích hoạt CLI này (khai
 * `FLEET_BACKUP_DIR` trỏ ra vùng lưu trữ ngoài máy cụm), không
 * phải tiến trình nền trong ứng dụng — ứng dụng nghiệp vụ không
 * mang quyền chạm tới mọi kho chỉ để phục vụ sao lưu. Các bản chụp
 * chạy qua kết nối quản trị của cụm khi được cấu hình
 * (`DATABASE_ADMIN_URL`, xem `resolveDumpConnectionUrl` trong
 * `fleet-common.ts`): schema nghiệp vụ áp FORCE ROW LEVEL SECURITY
 * cả với chủ sở hữu bảng nên chỉ đường quản trị mới cho ra bản sao
 * đầy đủ.
 */
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  dumpDatabaseToFile,
  isBackupOverdue,
  newFleetRunId,
  parseBackupFileName,
  parsePositiveInt,
  resolveDumpConnectionUrl,
} from './fleet-common';
import { FleetRegistryWriter } from './fleet-registry-writer';

/** Slug thư mục của database control plane trong cây sao lưu (không phải một kho trong sổ). */
export const CONTROL_PLANE_BACKUP_SLUG = 'control-plane';

/** Tuỳ chọn của tác vụ sao lưu; mặc định đọc từ biến môi trường của tiến trình. */
export type FleetBackupOptions = {
  env?: NodeJS.ProcessEnv;
  backupDir?: string;
  log?: (message: string) => void;
};

/** Kết quả chụp của một đích (một kho hoặc control plane). */
export type FleetBackupTargetResult = {
  slug: string;
  status: 'success' | 'failed';
  file?: string;
  detail?: string;
};

/** Tổng kết một lượt sao lưu định kỳ. */
export type FleetBackupSummary = { runId: string; results: FleetBackupTargetResult[]; failedCount: number };

/** Một đích bị quá hạn sao lưu trong chế độ kiểm, kèm lý do đọc được. */
export type FleetBackupOverdue = { slug: string; reason: string };

/** Kho còn mang dữ kiện cần sao lưu: đang hoạt động hoặc tạm ngưng. Đã đóng/đang cấp phát thì không. */
function isBackupTarget(status: string): boolean {
  return status === 'active' || status === 'suspended';
}

/**
 * Dọn bản sao lưu quá hạn trong thư mục của MỘT kho: tệp (và tệp
 * băm đi kèm) có thời điểm sửa cũ hơn hạn lưu trữ sẽ bị xoá, trừ
 * bản mới nhất của thư mục — kho luôn còn ít nhất một điểm khôi
 * phục dù lịch chụp có gián đoạn dài hơn hạn lưu trữ.
 */
function pruneSpaceBackupDir(dir: string, retentionDays: number, now: Date): number {
  if (!existsSync(dir)) return 0;
  const files = readdirSync(dir)
    .filter((name) => parseBackupFileName(name) !== null)
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtime }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  let removed = 0;
  for (const [index, file] of files.entries()) {
    if (index === 0) continue;
    if (file.mtime.getTime() >= cutoff) continue;
    unlinkSync(join(dir, file.name));
    const sidecar = join(dir, `${file.name}.sha256`);
    if (existsSync(sidecar)) unlinkSync(sidecar);
    removed += 1;
  }
  return removed;
}

/**
 * Chạy một lượt sao lưu định kỳ cho toàn đội kho + control plane.
 * @throws Error khi thiếu thư mục sao lưu hoặc registry chưa cấu
 * hình — lỗi cấu hình của công cụ, dừng trước khi chụp bất cứ kho nào.
 */
export async function runFleetBackup(options: FleetBackupOptions = {}): Promise<FleetBackupSummary> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((message: string) => console.log(message));
  const backupDir = options.backupDir ?? env.FLEET_BACKUP_DIR;
  if (!backupDir) throw new Error('FLEET_BACKUP_DIR is required');
  const runId = newFleetRunId(new Date());
  const retentionDays = parsePositiveInt(env.FLEET_BACKUP_RETENTION_DAYS, 30);
  const encryptionKey = env.FLEET_BACKUP_ENCRYPTION_KEY || undefined;
  const writer = new FleetRegistryWriter(env);
  const results: FleetBackupTargetResult[] = [];
  try {
    const spaces = await writer.listFleetSpaces();
    for (const space of spaces) {
      if (!isBackupTarget(space.status)) continue;
      const at = new Date();
      try {
        const stored = await dumpDatabaseToFile({
          url: resolveDumpConnectionUrl(space, env),
          dir: join(backupDir, space.slug),
          kind: 'scheduled',
          runId,
          at,
          encryptionKey,
          env,
        });
        await writer.recordBackupOutcome(space.id, 'success', at);
        log(`[${space.slug}] backup written: ${basename(stored.path)}`);
        results.push({ slug: space.slug, status: 'success', file: stored.path });
      } catch (error) {
        const detail = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        await writer.recordBackupOutcome(space.id, 'failed', at);
        log(`[${space.slug}] backup FAILED: ${detail}`);
        results.push({ slug: space.slug, status: 'failed', detail });
      }
    }
  } finally {
    await writer.close();
  }

  // Control plane tự sao lưu theo cùng khuôn tệp nhưng không có
  // dòng registry để ghi (registry nằm trong chính nó): kết quả
  // chỉ ra log và cửa sổ kiểm riêng đọc lại từ đĩa.
  const cpUrl = env.CONTROL_PLANE_DATABASE_URL;
  if (cpUrl) {
    try {
      const stored = await dumpDatabaseToFile({
        url: cpUrl,
        dir: join(backupDir, CONTROL_PLANE_BACKUP_SLUG),
        kind: 'scheduled',
        runId,
        at: new Date(),
        encryptionKey,
        env,
      });
      log(`[${CONTROL_PLANE_BACKUP_SLUG}] backup written: ${basename(stored.path)}`);
      results.push({ slug: CONTROL_PLANE_BACKUP_SLUG, status: 'success', file: stored.path });
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      log(`[${CONTROL_PLANE_BACKUP_SLUG}] backup FAILED: ${detail}`);
      results.push({ slug: CONTROL_PLANE_BACKUP_SLUG, status: 'failed', detail });
    }
  }

  for (const result of results) {
    const removed = pruneSpaceBackupDir(join(backupDir, result.slug), retentionDays, new Date());
    if (removed > 0) log(`[${result.slug}] pruned ${removed} expired backup file(s)`);
  }
  const failedCount = results.filter((result) => result.status === 'failed').length;
  log(`fleet backup run ${runId} finished: ${results.length} target(s), ${failedCount} failed`);
  return { runId, results, failedCount };
}

/**
 * Chế độ kiểm: liệt kê các đích đã quá hạn sao lưu (xem đầu file).
 * Không chụp, không ghi registry — chỉ đọc sổ và đĩa.
 */
export async function checkFleetBackups(
  options: FleetBackupOptions = {},
): Promise<{ overdue: FleetBackupOverdue[]; checked: string[] }> {
  const env = options.env ?? process.env;
  const backupDir = options.backupDir ?? env.FLEET_BACKUP_DIR;
  if (!backupDir) throw new Error('FLEET_BACKUP_DIR is required');
  const now = new Date();
  const spaceMaxAgeHours = parsePositiveInt(env.FLEET_BACKUP_MAX_AGE_HOURS, 26);
  const cpMaxAgeHours = parsePositiveInt(env.FLEET_CP_BACKUP_MAX_AGE_HOURS, 13);
  const writer = new FleetRegistryWriter(env);
  const overdue: FleetBackupOverdue[] = [];
  const checked: string[] = [];
  try {
    const spaces = await writer.listFleetSpaces();
    for (const space of spaces) {
      if (!isBackupTarget(space.status)) continue;
      checked.push(space.slug);
      if (isBackupOverdue(space.lastBackupAt, now, spaceMaxAgeHours)) {
        overdue.push({
          slug: space.slug,
          reason: space.lastBackupAt
            ? `last successful backup at ${space.lastBackupAt.toISOString()} exceeds ${spaceMaxAgeHours}h`
            : 'no successful backup recorded',
        });
      }
    }
  } finally {
    await writer.close();
  }
  checked.push(CONTROL_PLANE_BACKUP_SLUG);
  const cpDir = join(backupDir, CONTROL_PLANE_BACKUP_SLUG);
  const cpFiles = existsSync(cpDir)
    ? readdirSync(cpDir)
        .filter((name) => parseBackupFileName(name) !== null)
        .map((name) => statSync(join(cpDir, name)).mtime)
        .sort((a, b) => b.getTime() - a.getTime())
    : [];
  const newestCp = cpFiles[0];
  if (!newestCp || isBackupOverdue(newestCp, now, cpMaxAgeHours)) {
    overdue.push({
      slug: CONTROL_PLANE_BACKUP_SLUG,
      reason: newestCp
        ? `newest control plane backup at ${newestCp.toISOString()} exceeds ${cpMaxAgeHours}h`
        : 'no control plane backup file found',
    });
  }
  return { overdue, checked };
}

if (require.main === module) {
  const checkOnly = process.argv.includes('--check');
  const work = checkOnly
    ? checkFleetBackups().then(({ overdue, checked }) => {
        for (const item of overdue) console.log(`OVERDUE [${item.slug}] ${item.reason}`);
        console.log(`fleet backup check: ${checked.length} target(s) checked, ${overdue.length} overdue`);
        process.exitCode = overdue.length > 0 ? 1 : 0;
      })
    : runFleetBackup().then((summary) => {
        process.exitCode = summary.failedCount > 0 ? 1 : 0;
      });
  work.catch((error: unknown) => {
    console.error('fleet-backup failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

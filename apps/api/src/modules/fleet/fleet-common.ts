/**
 * Helper dùng chung của các công cụ vận hành ĐỘI KHO (issue #586):
 * runner migration theo đợt (`fleet-migration-runner.ts`), tác vụ
 * sao lưu (`fleet-backup.ts`) và tác vụ kiểm thử khôi phục
 * (`fleet-restore-test.ts`). File này giữ phần THUẦN (sắp đợt, chọn
 * ứng viên, đặt tên tệp sao lưu, mã hoá, băm) tách khỏi phần chạm hệ
 * thống (chạy `pg_dump`/`pg_restore`, đọc phiên bản thật trong
 * database) để kiểm chứng bằng unit test không cần database.
 *
 * Ba bất biến nghiệp vụ vận hành mà file này khoá:
 * - Thứ tự duyệt đội kho là XÁC ĐỊNH: kho nền tảng (platform) chạy
 *   đợt riêng trước, đúng MỘT trung tâm làm canary ở đợt kế, rồi các
 *   trung tâm còn lại theo từng đợt có kích thước cấu hình được —
 *   cùng một sổ đăng ký thì mọi lượt chạy duyệt đúng một thứ tự.
 * - URL kết nối tới một kho suy ra từ sổ đăng ký: cơ sở là URL mà
 *   `secretRef` trỏ tới (biến môi trường mang URL của tầng ứng
 *   dụng), nhưng khi `MIGRATION_DATABASE_URL` được cấu hình thì
 *   THÔNG TIN ĐĂNG NHẬP bị thay bằng của role migration và tên
 *   database bị thay bằng `databaseName` của kho — công cụ vận hành
 *   luôn chạm kho bằng role migration (chủ sở hữu đối tượng), không
 *   bao giờ bằng role runtime chỉ có quyền dữ liệu, kể cả khi URL
 *   gốc trong sổ là URL runtime.
 * - Tệp sao lưu LUÔN được mã hoá AES-256-GCM và luôn đi kèm tệp
 *   băm SHA-256 của chính tệp đã lưu: mã hoá là bắt buộc
 *   (fail-closed) — thiếu khoá mã hoá thì mọi đường chụp sao lưu
 *   từ chối chạy trước khi dump, không tồn tại chế độ lưu bản thô,
 *   và mọi đường lỗi sau khi dump xong đều xoá tệp thô khỏi đĩa.
 *   Kiểm thử khôi phục đối chiếu băm TRƯỚC khi giải mã/khôi phục,
 *   nên một bản sao bị hỏng hay bị sửa đều bị phát hiện ở cổng đó
 *   thay vì âm thầm khôi phục ra dữ kiện sai.
 * - Bản sao lưu logic chạy qua KẾT NỐI QUẢN TRỊ của cụm khi kết nối
 *   đó được cấu hình (xem `resolveDumpConnectionUrl`): schema
 *   nghiệp vụ áp `FORCE ROW LEVEL SECURITY` lên cả chủ sở hữu
 *   bảng, và `pg_dump` chạy bằng chủ sở hữu sẽ bị chặn ở các bảng
 *   có policy — nó thà dừng còn hơn xuất ra một bản sao thiếu dữ
 *   kiện mà không báo. Thiếu kết nối quản trị thì dump dùng kết nối
 *   migration và chính lỗi của `pg_dump` được ghi nhận thành lượt
 *   sao lưu thất bại; tuyệt đối không có đường nào cho ra một bản
 *   sao thiếu mà mang trạng thái thành công.
 */
import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Client } from 'pg';

/** Một kho trong mắt công cụ vận hành: dòng đăng ký + ảnh registry phiên bản của nó. */
export type FleetSpace = {
  id: string;
  slug: string;
  kind: 'platform' | 'center';
  status: string;
  databaseName: string;
  secretRef: string | null;
  /** Phiên bản schema theo sổ đăng ký (có thể lệch sự thật trong database — xem runner). */
  registryVersion: string | null;
  lastBackupAt: Date | null;
  lastRestoreAt: Date | null;
};

/** Loại bản sao lưu: theo lịch định kỳ hoặc bản chốt trước một lượt migration. */
export type BackupKind = 'scheduled' | 'pre-migration';

/**
 * Sắp các kho ĐANG HOẠT ĐỘNG thành các đợt migration theo thứ tự an
 * toàn: đợt 0 là (các) kho nền tảng — không gian thí điểm của nền
 * tảng tự vận hành; đợt 1 là đúng một trung tâm canary (slug nhỏ
 * nhất); các trung tâm còn lại chia theo `waveSize`. Kho không ở
 * trạng thái `active` (đang cấp phát, tạm ngưng, đã đóng) không vào
 * bất kỳ đợt nào: migration không chạm kho chưa sẵn sàng hay đã
 * ngừng vòng đời.
 */
export function orderSpacesIntoWaves(spaces: FleetSpace[], waveSize: number): FleetSpace[][] {
  const bySlug = (a: FleetSpace, b: FleetSpace) => a.slug.localeCompare(b.slug);
  const active = spaces.filter((space) => space.status === 'active');
  const platforms = active.filter((space) => space.kind === 'platform').sort(bySlug);
  const centers = active.filter((space) => space.kind === 'center').sort(bySlug);
  const waves: FleetSpace[][] = [];
  if (platforms.length > 0) waves.push(platforms);
  if (centers.length > 0) {
    waves.push([centers[0]!]);
    const size = Math.max(1, Math.floor(waveSize) || 1);
    for (let i = 1; i < centers.length; i += size) {
      waves.push(centers.slice(i, i + size));
    }
  }
  return waves;
}

/**
 * Chọn kho cho lượt kiểm thử khôi phục tiếp theo theo vòng xoay
 * công bằng: kho đang hoạt động có `lastRestoreAt` CŨ NHẤT được
 * chọn trước (chưa từng kiểm thử = cũ nhất), hoà thì slug nhỏ hơn
 * thắng để kết quả lặp lại được. Không còn kho đang hoạt động nào
 * thì trả về null.
 */
export function pickRestoreCandidate(spaces: FleetSpace[]): FleetSpace | null {
  const candidates = spaces
    .filter((space) => space.status === 'active')
    .sort((a, b) => {
      const at = a.lastRestoreAt?.getTime() ?? 0;
      const bt = b.lastRestoreAt?.getTime() ?? 0;
      if (at !== bt) return at - bt;
      return a.slug.localeCompare(b.slug);
    });
  return candidates[0] ?? null;
}

/**
 * Một kho bị coi là QUÁ HẠN sao lưu khi chưa từng có bản sao lưu
 * thành công nào, hoặc bản gần nhất đã cũ hơn `maxAgeHours` — cổng
 * cảnh báo của tác vụ sao lưu (`fleet-backup --check`): quá một chu
 * kỳ sao lưu mà không có bản mới là sự cố vận hành phải xử lý.
 */
export function isBackupOverdue(lastBackupAt: Date | null, now: Date, maxAgeHours: number): boolean {
  if (!lastBackupAt) return true;
  return now.getTime() - lastBackupAt.getTime() > maxAgeHours * 3_600_000;
}

/** Mã lượt chạy của đội kho: `fleet-<mốc UTC nén>-<4 ký tự hex>` — gắn vào tên tệp sao lưu chốt và nhật ký lượt chạy. */
export function newFleetRunId(at: Date): string {
  return `fleet-${at.toISOString().replace(/\D/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`;
}

/** Mốc thời gian UTC nén cho tên tệp: `20261030T143005` — sắp xếp theo tên tệp trùng thứ tự thời gian. */
export function formatBackupTimestamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
}

/**
 * Tên tệp sao lưu trong thư mục riêng của kho:
 * `<loại>-<mã lượt>-<mốc UTC>.dump` (thêm `.enc` khi đã mã hoá).
 * Tệp băm đi kèm là chính tên này cộng `.sha256`.
 */
export function backupFileName(kind: BackupKind, runId: string, at: Date, encrypted: boolean): string {
  return `${kind}-${runId}-${formatBackupTimestamp(at)}.dump${encrypted ? '.enc' : ''}`;
}

const BACKUP_FILE_PATTERN = /^(scheduled|pre-migration)-([a-z0-9-]+)-(\d{8}T\d{6})\.dump(\.enc)?$/;

/** Đọc lại thành phần của một tên tệp sao lưu; null khi tên không theo khuôn (không phải tệp sao lưu của đội kho). */
export function parseBackupFileName(fileName: string): { kind: BackupKind; runId: string; encrypted: boolean } | null {
  const match = BACKUP_FILE_PATTERN.exec(fileName);
  if (!match) return null;
  return { kind: match[1] as BackupKind, runId: match[2]!, encrypted: match[4] === '.enc' };
}

/** Băm SHA-256 dạng hex của nội dung tệp — ghi vào tệp `.sha256` đi kèm mọi bản sao lưu. */
export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

const ENCRYPTION_MAGIC = Buffer.from('LMSBK1', 'ascii');
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1 } as const;

/**
 * Mã hoá nội dung sao lưu bằng AES-256-GCM với khoá suy ra từ cụm
 * mật khẩu qua scrypt. Khuôn gói: magic `LMSBK1` + salt 16 byte +
 * IV 12 byte + thẻ xác thực 16 byte + bản mã — gói tự chứa mọi thứ
 * cần để giải mã trừ cụm mật khẩu, và thẻ GCM khiến mọi sửa đổi
 * trên bản mã đều làm giải mã thất bại (phát hiện được ở bước kiểm
 * thử khôi phục).
 */
export function encryptBackup(plain: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, SCRYPT_OPTIONS);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([ENCRYPTION_MAGIC, salt, iv, cipher.getAuthTag(), ciphertext]);
}

/**
 * Giải mã một gói sao lưu đã mã hoá.
 * @throws Error khi dữ kiện không mang magic của khuôn gói hoặc thẻ
 * xác thực không khớp (nội dung đã bị sửa/hỏng, hoặc sai cụm mật khẩu).
 */
export function decryptBackup(data: Buffer, passphrase: string): Buffer {
  if (!isEncryptedBackup(data)) throw new Error('backup payload is not in the encrypted fleet format');
  const salt = data.subarray(6, 22);
  const iv = data.subarray(22, 34);
  const tag = data.subarray(34, 50);
  const ciphertext = data.subarray(50);
  const key = scryptSync(passphrase, salt, 32, SCRYPT_OPTIONS);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Nội dung có phải gói sao lưu đã mã hoá của đội kho hay không (đọc magic ở đầu gói). */
export function isEncryptedBackup(data: Buffer): boolean {
  return data.length > ENCRYPTION_MAGIC.length && data.subarray(0, ENCRYPTION_MAGIC.length).equals(ENCRYPTION_MAGIC);
}

/** Đổi đích của một URL kết nối sang database khác trên cùng cụm (giữ nguyên host, cổng và thông tin đăng nhập). */
export function retargetUrl(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

/**
 * Dựng URL kết nối vận hành tới database của một kho từ sổ đăng ký
 * (xem bất biến ở đầu file): nền là URL mà `secretRef` trỏ tới
 * (dạng `env:<TÊN BIẾN>`; thiếu `secretRef` thì dùng `DATABASE_URL`),
 * thông tin đăng nhập bị thay bằng của `MIGRATION_DATABASE_URL` khi
 * biến đó được cấu hình, và đích cuối luôn là `databaseName` của kho.
 * @throws Error khi biến mà `secretRef` trỏ tới không tồn tại — sổ
 * trỏ tới một bí mật không có thật là lỗi cấu hình phải lộ ngay.
 */
export function resolveSpaceConnectionUrl(space: FleetSpace, env: NodeJS.ProcessEnv): string {
  const refName = space.secretRef?.startsWith('env:') ? space.secretRef.slice('env:'.length) : 'DATABASE_URL';
  const base = env[refName];
  if (!base) throw new Error(`secret reference of space ${space.slug} points at unset variable ${refName}`);
  const parsed = new URL(base);
  const migrationUrl = env.MIGRATION_DATABASE_URL;
  if (migrationUrl) {
    const migration = new URL(migrationUrl);
    parsed.username = migration.username;
    parsed.password = migration.password;
  }
  parsed.pathname = `/${encodeURIComponent(space.databaseName)}`;
  return parsed.toString();
}

/**
 * Dựng URL cho việc CHỤP sao lưu logic của một kho: khi kết nối
 * quản trị của cụm (`DATABASE_ADMIN_URL`) được cấu hình thì dump
 * chạy bằng chính kết nối quản trị đó, chỉ đổi đích sang database
 * của kho — đây là đường duy nhất cho ra bản sao ĐẦY ĐỦ trên một
 * schema áp `FORCE ROW LEVEL SECURITY` cả với chủ sở hữu (xem bất
 * biến ở đầu file). Chưa cấu hình kết nối quản trị thì rơi về URL
 * vận hành bằng role migration của kho, và giới hạn của đường đó
 * (dump bị chặn ở bảng có policy) lộ thành lỗi của lượt sao lưu
 * thay vì một bản sao thiếu âm thầm.
 */
export function resolveDumpConnectionUrl(space: FleetSpace, env: NodeJS.ProcessEnv): string {
  const adminUrl = env.DATABASE_ADMIN_URL;
  if (adminUrl) return retargetUrl(adminUrl, space.databaseName);
  return resolveSpaceConnectionUrl(space, env);
}

/**
 * Tách URL kết nối thành tham số dòng lệnh cho các công cụ của
 * PostgreSQL (`pg_dump`, `pg_restore`, `psql`) và mật khẩu đi kèm.
 * Mật khẩu TUYỆT ĐỐI không nằm trong tham số (lộ qua danh sách tiến
 * trình của máy) — caller truyền nó qua biến môi trường
 * `PGPASSWORD` của tiến trình con (xem `runPgTool`).
 */
export function buildPgToolArgs(url: string): { args: string[]; password: string } {
  const parsed = new URL(url);
  return {
    args: [
      '-h',
      parsed.hostname,
      '-p',
      parsed.port || '5432',
      '-U',
      decodeURIComponent(parsed.username),
      '-d',
      decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    ],
    password: decodeURIComponent(parsed.password),
  };
}

/**
 * Chạy một công cụ PostgreSQL (`pg_dump`, `pg_restore`…) với đích
 * lấy từ URL kết nối và mật khẩu qua `PGPASSWORD`. Thư mục chứa
 * công cụ lấy từ `FLEET_PG_BIN_DIR` khi được cấu hình (máy kiểm
 * chứng dùng bộ công cụ riêng), mặc định theo PATH của tiến trình.
 * @returns Nội dung stdout của công cụ (rỗng với các lệnh ghi ra tệp).
 * @throws Error kèm phần đuôi stderr của công cụ khi mã thoát khác 0.
 */
export function runPgTool(
  binary: string,
  url: string,
  extraArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Buffer> {
  const { args, password } = buildPgToolArgs(url);
  const binDir = env.FLEET_PG_BIN_DIR;
  const command = binDir ? join(binDir, binary) : binary;
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args, ...extraArgs],
      { env: { ...env, PGPASSWORD: password }, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const tail = stderr.toString().trim().slice(-2000);
          reject(new Error(`${binary} failed: ${tail || error.message}`));
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

/**
 * Liệt kê các thư mục migration Drizzle (thư mục con chứa
 * `migration.sql`), sắp xếp tăng dần theo tên — cùng thứ tự mà bộ
 * máy migration của Drizzle áp dụng (sắp theo tên thư mục). Tên thư
 * mục CUỐI là phiên bản đích của đội kho.
 */
export function listMigrationFolders(migrationsDir: string): string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        return statSync(join(migrationsDir, name, 'migration.sql')).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * Đọc phiên bản schema THẬT của một database từ nhật ký migration
 * của chính nó (`drizzle.__drizzle_migrations` — dòng áp gần nhất
 * theo thời gian áp, hoà thì theo id). Database chưa từng được áp
 * migration (chưa có bảng nhật ký) được coi là chưa có phiên bản
 * (null) — đây là NGUỒN SỰ THẬT về phiên bản của kho; sổ đăng ký
 * chỉ là ảnh phản chiếu phải khớp với nó.
 */
export async function readDatabaseSchemaVersion(client: Client): Promise<string | null> {
  try {
    const result = await client.query<{ name: string | null }>(
      'SELECT name FROM drizzle.__drizzle_migrations ORDER BY created_at DESC NULLS LAST, id DESC LIMIT 1',
    );
    return result.rows[0]?.name ?? null;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '42P01' || code === '3F000') return null;
    throw error;
  }
}

/**
 * Đọc TOÀN TẬP tên migration đã áp trong một database từ nhật ký
 * của chính nó. Đây là căn cứ để runner quyết định một kho còn
 * thiếu migration nào: chỉ nhìn migration MỚI NHẤT (như
 * `readDatabaseSchemaVersion`) sẽ bỏ sót kho đã có migration mới
 * nhất nhưng THIẾU một migration cũ ở giữa — kho như vậy trông
 * như đã đạt đích mà thật ra chưa từng áp đủ bộ. Database chưa có
 * bảng nhật ký thì tập đã áp là rỗng.
 */
export async function readDatabaseAppliedMigrations(client: Client): Promise<string[]> {
  try {
    const result = await client.query<{ name: string | null }>(
      'SELECT name FROM drizzle.__drizzle_migrations',
    );
    return result.rows.map((row) => row.name).filter((name): name is string => name !== null);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '42P01' || code === '3F000') return [];
    throw error;
  }
}

/** Đọc một số nguyên dương từ chuỗi cấu hình; rỗng/không hợp lệ thì dùng giá trị dự phòng được truyền vào. */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Một bản sao lưu đã lưu xong trên đĩa: đường dẫn tệp chính, có mã hoá hay không, và băm của chính tệp đó. */
export type StoredBackup = { path: string; encrypted: boolean; sha256: string };

/**
 * Chụp một bản sao lưu logic (`pg_dump` định dạng custom) của
 * database tại `url` vào thư mục của kho: ghi tệp `.dump` tạm, mã
 * hoá thành `.dump.enc`, xoá bản thô, rồi ghi tệp băm `.sha256`
 * của CHÍNH tệp cuối cùng đã lưu. Tệp sao lưu nằm NGOÀI máy cụm
 * khi thư mục sao lưu trỏ ra vùng lưu trữ gắn ngoài (cấu hình ở
 * tầng triển khai); helper này chỉ chịu trách nhiệm khuôn tệp và
 * tính toàn vẹn của nó.
 *
 * Mã hoá là BẮT BUỘC (fail-closed): thiếu khoá mã hoá thì hàm ném
 * lỗi TRƯỚC khi dump bất cứ thứ gì — một bản sao lưu ở dạng thô
 * không bao giờ là sản phẩm của đường này. Sau khi dump xong, tệp
 * thô chỉ tồn tại trong khoảnh khắc chuyển đổi: khối `finally`
 * xoá nó ở MỌI đường ra (thành công lẫn mọi lỗi ở bước ghi tệp mã
 * hoá hay tệp băm), và tệp mã hoá dở cũng bị xoá khi bước ghi của
 * nó hỏng, để trên đĩa không còn gì trông giống một bản sao lưu
 * dùng được.
 * @throws Error khi thiếu khoá mã hoá hoặc `pg_dump` thất bại —
 * caller quyết định ghi nhận thất bại này là chặn bước tiếp theo
 * (bản chốt trước migration) hay chỉ là một lượt sao lưu hỏng.
 */
export async function dumpDatabaseToFile(options: {
  url: string;
  dir: string;
  kind: BackupKind;
  runId: string;
  at: Date;
  encryptionKey?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<StoredBackup> {
  const env = options.env ?? process.env;
  if (!options.encryptionKey) {
    throw new Error(
      'FLEET_BACKUP_ENCRYPTION_KEY is required: fleet backups are always encrypted, plaintext backups are not supported',
    );
  }
  mkdirSync(options.dir, { recursive: true });
  const plainPath = join(options.dir, backupFileName(options.kind, options.runId, options.at, false));
  try {
    await runPgTool('pg_dump', options.url, ['-Fc', '-f', plainPath], env);
  } catch (error) {
    // Dump hỏng giữa chừng để lại một tệp dở trên đĩa: xoá ngay để
    // không lượt chọn bản sao lưu nào về sau nhầm nó là một bản
    // hoàn chỉnh (tệp băm chưa từng được ghi cho nó, nhưng dọn tận
    // gốc vẫn hơn dựa vào một cổng kiểm duy nhất).
    if (existsSync(plainPath)) unlinkSync(plainPath);
    throw error;
  }
  const finalPath = join(options.dir, backupFileName(options.kind, options.runId, options.at, true));
  try {
    const encrypted = encryptBackup(readFileSync(plainPath), options.encryptionKey);
    writeFileSync(finalPath, encrypted);
    const digest = sha256Hex(readFileSync(finalPath));
    writeFileSync(`${finalPath}.sha256`, `${digest}\n`);
    return { path: finalPath, encrypted: true, sha256: digest };
  } catch (error) {
    // Bước ghi tệp mã hoá/băm hỏng giữa chừng: xoá cả tệp mã hoá
    // dở — thiếu tệp băm đi kèm thì nó vốn không dùng được, giữ
    // lại chỉ khiến thư mục sao lưu mang một bản trông như hoàn
    // chỉnh.
    if (existsSync(finalPath)) unlinkSync(finalPath);
    throw error;
  } finally {
    // Tệp thô không bao giờ được ở lại trên đĩa sau khi dump đã
    // xong, ở mọi đường ra kể cả đường thành công ở trên.
    if (existsSync(plainPath)) unlinkSync(plainPath);
  }
}

/**
 * Đọc một tệp sao lưu về nội dung dump THÔ sẵn sàng cho `pg_restore`:
 * đối chiếu băm với tệp `.sha256` đi kèm TRƯỚC TIÊN (thiếu tệp băm
 * cũng là hỏng), rồi giải mã khi tệp là gói đã mã hoá.
 * @throws Error khi băm không khớp (bản sao đã hỏng/bị sửa), thiếu
 * tệp băm, hoặc giải mã thất bại — mọi trường hợp đều là "bản sao
 * không dùng được", caller ghi nhận là kiểm thử khôi phục thất bại.
 */
export function readVerifiedBackupFile(path: string, encryptionKey?: string): Buffer {
  const sidecarPath = `${path}.sha256`;
  let expected: string;
  try {
    expected = readFileSync(sidecarPath, 'utf8').trim();
  } catch {
    throw new Error(`backup checksum file is missing for ${basename(path)}`);
  }
  const stored = readFileSync(path);
  if (sha256Hex(stored) !== expected) {
    throw new Error(`backup checksum mismatch for ${basename(path)}`);
  }
  if (path.endsWith('.enc')) {
    if (!encryptionKey) throw new Error('backup is encrypted but no encryption key is configured');
    return decryptBackup(stored, encryptionKey);
  }
  return stored;
}

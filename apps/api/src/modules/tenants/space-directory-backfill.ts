/**
 * Công cụ LẤP THƯ MỤC cho một không gian kho riêng đã di trú
 * (issue #587, tiền điều kiện Phần B, hạng mục 3 — thiết kế
 * B1+C1): các không gian đã chuyển kho TRƯỚC khi thư mục tồn tại
 * chưa có mục nào trong hai bảng thư mục ở control plane, nên:
 * - bộ chọn trung tâm (`listMyTenants`) không thấy trung tâm đó
 *   dù membership thật đang nằm đầy đủ trong kho đích;
 * - mã tham gia của các lớp trong kho đích không phân giải được
 *   vì đường tra cứu vẫn chỉ nhìn kho chung.
 * Lệnh này đọc membership và mã lớp TẠI KHO ĐÍCH của không gian
 * rồi ghi các mục thư mục tương ứng vào control plane — thư mục
 * chỉ mang dữ kiện định tuyến tối thiểu theo đúng thiết kế đã
 * chốt, không sao chép dữ kiện nghiệp vụ nào lên kho chung hay
 * control plane.
 *
 * Bất biến khi chạy:
 * - Khoá theo định danh gốc: mô hình vật chất hoá tài khoản
 *   sang kho riêng giữ nguyên định danh của người dùng, và tài
 *   khoản sinh ra ngay trong kho riêng (ví dụ quản trị đầu tiên
 *   do cấp phát tạo) chỉ có một định danh duy nhất là định danh
 *   tại kho đích — nên cả `globalUserId` lẫn `spaceUserId` của
 *   mỗi mục đều là định danh của membership tại kho đích.
 * - Chạy lại an toàn: mọi ghi đều là upsert theo khoá tự nhiên
 *   của bảng thư mục — chạy lại không sinh mục trùng.
 * - Va chạm mã tham gia (mã đã thuộc về một không gian khác)
 *   được BÁO CÁO trong kết quả, tuyệt đối không ghi đè mục của
 *   không gian khác.
 *
 * Ranh giới tin cậy: chạy ngoài NestJS như các công cụ fleet —
 * quyền chạy script của đội vận hành trên máy triển khai là
 * ranh giới; không gác capability ở tầng này.
 */
import { Pool } from 'pg';
import { createCentreKysely, sql as kyselySql } from '@lms/db';
import { normalizeSpaceSlug } from './centre-provision';
import { FleetRegistryWriter } from '../fleet/fleet-registry-writer';

/** Đầu vào của một lượt lấp thư mục. */
export type SpaceDirectoryBackfillOptions = {
  /** Slug của không gian kho riêng cần lấp thư mục. */
  slug: string;
  /** Môi trường đọc biến kết nối (mặc định `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Hàm ghi tiến trình (mặc định in ra console). */
  log?: (message: string) => void;
};

/** Một va chạm mã tham gia phát hiện khi lấp thư mục mã. */
export type JoinCodeBackfillConflict = {
  /** Mã tham gia bị va chạm. */
  joinCode: string;
  /** Lớp trong kho đích đang giữ mã này. */
  classId: string;
  /** Không gian mà thư mục đang ghi nhận là chủ của mã. */
  ownerSpaceSlug: string;
};

/** Kết quả một lượt lấp thư mục. */
export type SpaceDirectoryBackfillResult = {
  slug: string;
  /** Số mục thư mục thành viên đã ghi/ghi đè. */
  membershipsUpserted: number;
  /** Số mã tham gia mới đăng ký vào thư mục trong lượt này. */
  joinCodesClaimed: number;
  /** Số mã tham gia đã có sẵn mục của chính không gian này. */
  joinCodesAlreadyPresent: number;
  /** Các va chạm mã tham gia (báo cáo, không ghi đè). */
  joinCodeConflicts: JoinCodeBackfillConflict[];
};

/**
 * Lấp thư mục thành viên + thư mục mã tham gia cho một không
 * gian kho riêng từ chính dữ kiện của kho đích.
 *
 * @param options - Slug không gian (+ môi trường/hàm log tuỳ chọn).
 * @returns Báo cáo số mục đã ghi và các va chạm mã (xem
 *   `SpaceDirectoryBackfillResult`).
 * @throws Error khi không gian chưa đăng ký, không phải không
 *   gian kho riêng đang hoạt động, biến môi trường URL kết nối
 *   của không gian/control plane chưa có, hoặc kho đích không
 *   có dòng tenant mang slug này.
 */
export async function runSpaceDirectoryBackfill(
  options: SpaceDirectoryBackfillOptions,
): Promise<SpaceDirectoryBackfillResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((message: string) => console.log(message));
  const slug = normalizeSpaceSlug(options.slug);
  const writer = new FleetRegistryWriter(env);
  try {
    const space = await writer.findSpaceBySlug(slug);
    if (!space) throw new Error(`Space ${slug} is not registered`);
    if (space.storageMode !== 'dedicated') throw new Error(`Space ${slug} is not a dedicated centre space`);
    if (space.status !== 'active') throw new Error(`Space ${slug} is not active (status ${space.status})`);
    const secretRef = space.secretRef;
    if (!secretRef?.startsWith('env:')) throw new Error(`Space ${slug} has no env secret reference to connect with`);
    const secretEnvVar = secretRef.slice('env:'.length);
    const centreUrl = env[secretEnvVar];
    if (!centreUrl) throw new Error(`Connection URL env var ${secretEnvVar} is not set in this environment`);

    // ---- Đọc dữ kiện thật tại kho đích ----
    const centrePool = new Pool({ connectionString: centreUrl, max: 1 });
    const db = createCentreKysely(centrePool);
    let membershipRows: { userId: string; status: string }[] = [];
    let classRows: { id: string; joinCode: string | null }[] = [];
    try {
      // GUC platform ở mức phiên: các bảng nghiệp vụ FORCE RLS,
      // công cụ vận hành đọc toàn không gian như các runner khác.
      await kyselySql`SELECT set_config('app.platform', 'on', false)`.execute(db);
      const tenant = await db.selectFrom('tenants').selectAll()
        .where('slug', '=', slug).limit(1).executeTakeFirst();
      if (!tenant) throw new Error(`Tenant ${slug} does not exist in its own store`);
      membershipRows = await db
        .selectFrom('tenant_memberships')
        .select(['user_id as userId', 'status'])
        .where('tenant_id', '=', tenant.id)
        .execute();
      classRows = await db
        .selectFrom('classes')
        .select(['id', 'join_code as joinCode'])
        .where('tenant_id', '=', tenant.id)
        .where('join_code', 'is not', null)
        .execute();
    } finally {
      await db.destroy().catch(() => undefined);
    }
    log(`[directory-backfill] ${slug}: ${membershipRows.length} membership(s), ${classRows.length} class join code(s) in the space store`);

    // ---- Ghi thư mục ----
    let membershipsUpserted = 0;
    for (const membership of membershipRows) {
      await writer.upsertMembershipDirectoryEntry({
        globalUserId: membership.userId,
        spaceSlug: slug,
        spaceUserId: membership.userId,
        status: membership.status,
      });
      membershipsUpserted += 1;
    }

    let joinCodesClaimed = 0;
    let joinCodesAlreadyPresent = 0;
    const joinCodeConflicts: JoinCodeBackfillConflict[] = [];
    for (const row of classRows) {
      const joinCode = row.joinCode;
      if (!joinCode) continue;
      const existing = await writer.findJoinCodeDirectoryEntry(joinCode);
      if (existing) {
        if (existing.spaceSlug === slug) {
          joinCodesAlreadyPresent += 1;
        } else {
          joinCodeConflicts.push({ joinCode, classId: row.id, ownerSpaceSlug: existing.spaceSlug });
        }
        continue;
      }
      const claim = await writer.claimJoinCodeDirectoryEntry(joinCode, slug);
      if (claim === 'claimed') joinCodesClaimed += 1;
      else if (claim === 'already') joinCodesAlreadyPresent += 1;
      else {
        const owner = await writer.findJoinCodeDirectoryEntry(joinCode);
        joinCodeConflicts.push({ joinCode, classId: row.id, ownerSpaceSlug: owner?.spaceSlug ?? 'unknown' });
      }
    }
    log(
      `[directory-backfill] ${slug}: ${membershipsUpserted} membership directorie(s) upserted, ` +
        `${joinCodesClaimed} join code(s) claimed, ${joinCodesAlreadyPresent} already present, ` +
        `${joinCodeConflicts.length} conflict(s)`,
    );
    return { slug, membershipsUpserted, joinCodesClaimed, joinCodesAlreadyPresent, joinCodeConflicts };
  } finally {
    await writer.close().catch(() => undefined);
  }
}

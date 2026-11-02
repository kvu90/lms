/**
 * Repository NHẬN DIỆN TRUNG TÂM trên Kysely — chuyển đổi Drizzle →
 * Kysely của chiến dịch chuyển tầng dữ liệu (issue #641, nhóm G1).
 *
 * Vai trò: mọi truy cập tới ba bảng `centre_identity`,
 * `centre_invites` và `config` (đường đọc danh sách quản trị của
 * kho) thuộc nghiệp vụ nhận diện và lời mời của trung tâm (issue
 * #583) tập trung ở đây. Repository không chứa luật nghiệp vụ —
 * phân giải trung tâm, cổng trạng thái và dịch lỗi định tuyến nằm
 * ở tầng service phía ứng dụng.
 *
 * Repository này chạy qua handle được định tuyến (`routedKysely`):
 * khi service bọc lời gọi trong ngữ cảnh ALS mang `spaceSlug` của
 * trung tâm đã chuẩn bị, mọi truy vấn ở đây đều chạm kho của chính
 * trung tâm đó — kể cả khi trung tâm đang ở kho riêng. Vì vậy
 * repository KHÔNG tự phân giải slug hay tự chuẩn bị kho: việc đó
 * là trách nhiệm của service trước khi gọi vào đây.
 *
 * Khuôn hình dạng dữ liệu ở biên repository — cùng khuôn pilot kho
 * control plane (xem `control-plane.ts` và playbook trong
 * `AGENTS.md` của package): truy vấn viết trên interface schema
 * sinh bằng codegen (tên bảng/cột snake_case), cột được chọn bằng
 * danh sách tường minh có bí danh camelCase, giá trị `undefined`
 * bị loại tường minh khỏi patch ghi trước khi gọi builder (quy
 * tắc T-4), và mọi giá trị where đều là tham số bắt buộc.
 * Repository không import từ `apps/*`, không đọc ALS/ngữ cảnh ứng
 * dụng, không tự mở pool.
 */
import type { Insertable, Updateable } from 'kysely';
import type { CentreDb, CentreDB } from '../client';

/** Một dòng nhận diện của trung tâm (tên hiển thị, logo, màu thương hiệu). */
export interface CentreIdentityRow {
  id: string;
  tenantId: string;
  displayName: string;
  logoPath: string | null;
  brandColor: string | null;
  updatedAt: Date;
}

/** Một dòng lời mời tham gia trung tâm (token chỉ lưu dạng hàm băm). */
export interface CentreInviteRow {
  id: string;
  tenantId: string;
  userId: string;
  email: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/** Danh sách cột tường minh có bí danh camelCase cho bảng nhận diện trung tâm. */
const CENTRE_IDENTITY_COLUMNS = [
  'id',
  'tenant_id as tenantId',
  'display_name as displayName',
  'logo_path as logoPath',
  'brand_color as brandColor',
  'updated_at as updatedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng lời mời trung tâm. */
const CENTRE_INVITE_COLUMNS = [
  'id',
  'tenant_id as tenantId',
  'user_id as userId',
  'email',
  'token_hash as tokenHash',
  'expires_at as expiresAt',
  'used_at as usedAt',
  'revoked_at as revokedAt',
  'created_at as createdAt',
] as const;

/**
 * Kho đọc/ghi nhận diện và lời mời của trung tâm (issue #583).
 */
export class CentreIdentityRepository {
  constructor(private readonly handle: CentreDb) {}

  /** Nhận diện hiện tại của tenant trong kho đang được định tuyến. */
  async getIdentity(tenantId: string): Promise<CentreIdentityRow | undefined> {
    return this.handle
      .selectFrom('centre_identity')
      .select(CENTRE_IDENTITY_COLUMNS)
      .where('tenant_id', '=', tenantId)
      .limit(1)
      .executeTakeFirst();
  }

  /** Tạo hoặc cập nhật nhận diện của tenant (một dòng duy nhất cho mỗi tenant). */
  async upsertIdentity(
    tenantId: string,
    patch: { displayName?: string; logoPath?: string | null; brandColor?: string | null },
  ): Promise<CentreIdentityRow> {
    const existing = await this.getIdentity(tenantId);
    if (!existing) {
      const values: Insertable<CentreDB['centre_identity']> = {
        tenant_id: tenantId,
        display_name: patch.displayName ?? '',
        logo_path: patch.logoPath ?? null,
        brand_color: patch.brandColor ?? null,
      };
      const rows = await this.handle
        .insertInto('centre_identity')
        .values(values)
        .returning(CENTRE_IDENTITY_COLUMNS)
        .execute();
      return rows[0]!;
    }
    // Patch cập nhật dựng tường minh theo từng trường có mặt: trường
    // vắng mặt (`undefined`) KHÔNG được chạm tới — cùng ngữ nghĩa
    // rải-có-điều-kiện của đường Drizzle trước đây, và là quy tắc
    // T-4 (không để `undefined` lọt vào set).
    const set: Updateable<CentreDB['centre_identity']> = { updated_at: new Date() };
    if (patch.displayName !== undefined) set.display_name = patch.displayName;
    if (patch.logoPath !== undefined) set.logo_path = patch.logoPath;
    if (patch.brandColor !== undefined) set.brand_color = patch.brandColor;
    const rows = await this.handle
      .updateTable('centre_identity')
      .set(set)
      .where('id', '=', existing.id)
      .returning(CENTRE_IDENTITY_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Lời mời theo hàm băm token (token gốc không bao giờ lưu). */
  async findInviteByTokenHash(tokenHash: string): Promise<CentreInviteRow | undefined> {
    return this.handle
      .selectFrom('centre_invites')
      .select(CENTRE_INVITE_COLUMNS)
      .where('token_hash', '=', tokenHash)
      .limit(1)
      .executeTakeFirst();
  }

  /**
   * Đánh dấu lời mời đã dùng — nguyên tử: chỉ thành công khi lời mời
   * vẫn chưa dùng và chưa thu hồi tại thời điểm ghi. Trả về dòng đã
   * đánh dấu, hoặc undefined khi có lượt khác đốt trước (đua).
   */
  async markInviteUsed(id: string): Promise<CentreInviteRow | undefined> {
    const rows = await this.handle
      .updateTable('centre_invites')
      .set({ used_at: new Date() })
      .where('id', '=', id)
      .where('used_at', 'is', null)
      .where('revoked_at', 'is', null)
      .returning(CENTRE_INVITE_COLUMNS)
      .execute();
    return rows[0];
  }

  /** Thu hồi mọi lời mời đang chờ của một tài khoản (phát hành lại). */
  async revokePendingInvites(userId: string): Promise<void> {
    await this.handle
      .updateTable('centre_invites')
      .set({ revoked_at: new Date() })
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .where('revoked_at', 'is', null)
      .execute();
  }

  /**
   * Danh sách quản trị của kho đang được định tuyến, đọc thẳng từ
   * bảng `config` của kho đó. KHÔNG dùng `PermissionEvaluator` ở
   * đây: bộ đánh giá của app được xây với khoá cache gắn theo tên
   * database lúc khởi động (kho chung), nên đọc qua nó cho một kho
   * trung tâm sẽ trả nhầm danh sách cache của kho chung. Đường
   * PATCH nhận diện chỉ quản trị trung tâm mới được gọi, tần suất
   * thấp — đọc thẳng nguồn sự thật là đúng.
   */
  async listSiteAdmins(): Promise<string[]> {
    const row = await this.handle
      .selectFrom('config')
      .select(['value'])
      .where('key', '=', 'siteadmins')
      .limit(1)
      .executeTakeFirst();
    const value = row?.value;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  }
}

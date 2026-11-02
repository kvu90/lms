/**
 * Repository của cụm XÁC THỰC trên Kysely — chuyển đổi Drizzle →
 * Kysely của chiến dịch chuyển tầng dữ liệu (issue #641, nhóm G1).
 *
 * Vai trò: mọi truy cập tới bốn bảng của kho trung tâm thuộc cụm
 * auth (họ refresh token, nhật ký lần thử đăng nhập, liên kết đăng
 * nhập OAuth, bản ghi TOTP) tập trung ở đây. Repository không chứa
 * luật nghiệp vụ — chính sách khoá tài khoản, xoay token, cổng MFA
 * nằm ở tầng service phía ứng dụng; repository chỉ nhận handle
 * Kysely (instance gốc hoặc transaction đang mở) do tầng ứng dụng
 * truyền vào.
 *
 * Khuôn hình dạng dữ liệu ở biên repository — cùng khuôn pilot kho
 * control plane (xem `control-plane.ts` và playbook trong
 * `AGENTS.md` của package):
 * - Bên trong, truy vấn viết trên interface schema sinh bằng
 *   codegen: tên bảng/cột giữ nguyên snake_case của database.
 * - Bên ngoài, repository trả/nhận hình dạng dòng camelCase như
 *   phía tiêu thụ đang dùng: cột được chọn bằng danh sách tường
 *   minh có bí danh (`family_id as familyId`), giá trị ghi được
 *   ánh xạ từng trường từ camelCase sang snake_case ở các hàm
 *   `*InsertValues` trong file này. Phía tiêu thụ vì vậy chỉ đổi
 *   điểm import khi kho chuyển đổi.
 * - Giá trị `undefined` bị LOẠI khỏi values trước khi gọi builder
 *   (quy tắc T-4 của pilot): trường vắng mặt phải để default của
 *   database quyết định. Ngược lại, `undefined` lọt vào mệnh đề
 *   WHERE bị gắn thành NULL lúc thực thi và lặng lẽ trả 0 dòng —
 *   vì vậy mọi giá trị where trong repository đều là tham số bắt
 *   buộc.
 * - Repository không import từ `apps/*`, không đọc ALS/ngữ cảnh
 *   ứng dụng, không tự mở pool: handle do tầng ứng dụng dựng (điểm
 *   lắp ráp là facade định tuyến theo không gian `routedKysely`)
 *   rồi truyền vào; ngữ cảnh trung tâm đi theo chính kết nối của
 *   handle đó.
 */
import type { Insertable } from 'kysely';
import type { CentreDb, CentreDB, CentreTx } from '../client';

/** Handle đọc/ghi mà repository nhận: instance gốc hoặc transaction đang mở. */
export type AuthDb = CentreDb | CentreTx;

/** Một dòng họ refresh token (hình dạng camelCase phía tiêu thụ dùng). */
export interface RefreshFamilyRow {
  id: string;
  familyId: string;
  userId: string;
  /** Tenant hiệu lực của phiên (claim `tid`) — giữ qua refresh, đổi qua switch-tenant. */
  tenantId: string | null;
  ip: string | null;
  userAgent: string | null;
  currentTokenHash: string;
  previousTokenHash: string | null;
  revoked: boolean;
  expiresAt: Date;
  createdAt: Date;
  rotatedAt: Date;
}

/** Một dòng bản ghi TOTP của user (secret đã mã hoá). */
export interface UserTotpRow {
  id: string;
  userId: string;
  secretEncrypted: string;
  confirmed: boolean;
  createdAt: Date;
  confirmedAt: Date | null;
}

/** Một dòng liên kết đăng nhập ngoài (issuer + định danh chủ thể phía provider). */
export interface UserOauthLinkRow {
  id: string;
  userId: string;
  issuer: string;
  issuerUserId: string;
  email: string;
  createdAt: Date;
}

/** Một dòng nhật ký lần thử đăng nhập. */
export interface LoginAttemptRow {
  id: string;
  userId: string | null;
  username: string;
  success: boolean;
  ip: string | null;
  attemptedAt: Date;
}

/** Dữ kiện tạo một họ refresh token mới (các trường có default ở database được phép vắng mặt). */
export interface NewRefreshFamily {
  id?: string;
  familyId: string;
  userId: string;
  tenantId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  currentTokenHash: string;
  previousTokenHash?: string | null;
  revoked?: boolean;
  expiresAt: Date;
  createdAt?: Date;
  rotatedAt?: Date;
}

/** Dữ kiện tạo một liên kết đăng nhập ngoài. */
export interface NewOauthLink {
  id?: string;
  userId: string;
  issuer: string;
  issuerUserId: string;
  email: string;
  createdAt?: Date;
}

/** Dữ kiện ghi một lần thử đăng nhập. */
export interface NewLoginAttempt {
  id?: string;
  userId?: string | null;
  username: string;
  success: boolean;
  ip?: string | null;
  attemptedAt?: Date;
}

/** Danh sách cột tường minh có bí danh camelCase cho bảng họ refresh token (dùng cho cả select lẫn returning). */
const REFRESH_FAMILY_COLUMNS = [
  'id',
  'family_id as familyId',
  'user_id as userId',
  'tenant_id as tenantId',
  'ip',
  'user_agent as userAgent',
  'current_token_hash as currentTokenHash',
  'previous_token_hash as previousTokenHash',
  'revoked',
  'expires_at as expiresAt',
  'created_at as createdAt',
  'rotated_at as rotatedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng TOTP. */
const USER_TOTP_COLUMNS = [
  'id',
  'user_id as userId',
  'secret_encrypted as secretEncrypted',
  'confirmed',
  'created_at as createdAt',
  'confirmed_at as confirmedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng liên kết OAuth. */
const USER_OAUTH_LINK_COLUMNS = [
  'id',
  'user_id as userId',
  'issuer',
  'issuer_user_id as issuerUserId',
  'email',
  'created_at as createdAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng nhật ký lần thử đăng nhập. */
const LOGIN_ATTEMPT_COLUMNS = [
  'id',
  'user_id as userId',
  'username',
  'success',
  'ip',
  'attempted_at as attemptedAt',
] as const;

/**
 * Ánh xạ dữ kiện tạo họ refresh token (camelCase) sang values
 * insert (snake_case), LOẠI mọi trường mang `undefined` — trường
 * vắng mặt để default của database quyết định (quy tắc T-4).
 */
function refreshFamilyInsertValues(values: NewRefreshFamily): Insertable<CentreDB['refresh_token_family']> {
  const row: Insertable<CentreDB['refresh_token_family']> = {
    family_id: values.familyId,
    user_id: values.userId,
    current_token_hash: values.currentTokenHash,
    expires_at: values.expiresAt,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.tenantId !== undefined) row.tenant_id = values.tenantId;
  if (values.ip !== undefined) row.ip = values.ip;
  if (values.userAgent !== undefined) row.user_agent = values.userAgent;
  if (values.previousTokenHash !== undefined) row.previous_token_hash = values.previousTokenHash;
  if (values.revoked !== undefined) row.revoked = values.revoked;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  if (values.rotatedAt !== undefined) row.rotated_at = values.rotatedAt;
  return row;
}

/** Ánh xạ dữ kiện tạo liên kết OAuth (camelCase) sang values insert (snake_case), loại `undefined` như mọi đường ghi khác. */
function oauthLinkInsertValues(values: NewOauthLink): Insertable<CentreDB['user_oauth_links']> {
  const row: Insertable<CentreDB['user_oauth_links']> = {
    user_id: values.userId,
    issuer: values.issuer,
    issuer_user_id: values.issuerUserId,
    email: values.email,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  return row;
}

/** Ánh xạ dữ kiện ghi lần thử đăng nhập (camelCase) sang values insert (snake_case), loại `undefined` như mọi đường ghi khác. */
function loginAttemptInsertValues(values: NewLoginAttempt): Insertable<CentreDB['login_attempts']> {
  const row: Insertable<CentreDB['login_attempts']> = {
    username: values.username,
    success: values.success,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.userId !== undefined) row.user_id = values.userId;
  if (values.ip !== undefined) row.ip = values.ip;
  if (values.attemptedAt !== undefined) row.attempted_at = values.attemptedAt;
  return row;
}

/**
 * Kho dữ liệu phiên xác thực: họ refresh token (token family) và nhật ký lần thử đăng nhập.
 * Mô hình family cho phép phát hiện tái sử dụng refresh token: khi một token đã xoay bị dùng lại, toàn bộ family bị thu hồi.
 */
export class AuthRepository {
  constructor(private readonly handle: AuthDb) {}

  /** Tạo family mới cho một lần đăng nhập, lưu hash của refresh token đầu tiên. */
  async createFamily(v: NewRefreshFamily): Promise<RefreshFamilyRow> {
    const rows = await this.handle
      .insertInto('refresh_token_family')
      .values(refreshFamilyInsertValues(v))
      .returning(REFRESH_FAMILY_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Tìm family theo hash refresh token (hash hiện tại hoặc hash trước đó vừa xoay). */
  async getFamilyByHash(tokenHash: string): Promise<RefreshFamilyRow | undefined> {
    return this.handle
      .selectFrom('refresh_token_family')
      .select(REFRESH_FAMILY_COLUMNS)
      .where((eb) => eb.or([
        eb('current_token_hash', '=', tokenHash),
        eb('previous_token_hash', '=', tokenHash),
      ]))
      .executeTakeFirst();
  }

  /** Tìm family theo `familyId` (claim `sid` của access token). */
  async getFamilyById(familyId: string): Promise<RefreshFamilyRow | undefined> {
    return this.handle
      .selectFrom('refresh_token_family')
      .select(REFRESH_FAMILY_COLUMNS)
      .where('family_id', '=', familyId)
      .executeTakeFirst();
  }

  /** Cập nhật tenant hiệu lực của family (khi refresh phân giải lại tenant). */
  async setFamilyTenant(id: string, tenantId: string): Promise<void> {
    await this.handle
      .updateTable('refresh_token_family')
      .set({ tenant_id: tenantId })
      .where('id', '=', id)
      .execute();
  }

  /** Xoay family sang refresh token mới (ghi hash mới, đánh dấu hash cũ đã dùng). */
  async rotateFamily(id: string, currentTokenHash: string, previousTokenHash: string): Promise<void> {
    await this.handle
      .updateTable('refresh_token_family')
      .set({ current_token_hash: currentTokenHash, previous_token_hash: previousTokenHash, rotated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** Thu hồi toàn bộ family (đăng xuất hoặc phát hiện tái sử dụng). */
  async revokeFamily(id: string): Promise<void> {
    await this.handle
      .updateTable('refresh_token_family')
      .set({ revoked: true })
      .where('id', '=', id)
      .execute();
  }

  /** Thu hồi mọi family của user (đổi mật khẩu, đình chỉ). */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.handle
      .updateTable('refresh_token_family')
      .set({ revoked: true })
      .where('user_id', '=', userId)
      .execute();
  }

  /**
   * Các family đang hiệu lực của user (chưa thu hồi, chưa hết hạn) — nguồn
   * cho danh sách "phiên API" ở trang quản lý phiên của chính user.
   */
  async listActiveFamiliesByUser(userId: string): Promise<RefreshFamilyRow[]> {
    return this.handle
      .selectFrom('refresh_token_family')
      .select(REFRESH_FAMILY_COLUMNS)
      .where('user_id', '=', userId)
      .where('revoked', '=', false)
      .where('expires_at', '>=', new Date())
      .orderBy('created_at', 'desc')
      .execute();
  }

  /**
   * Tìm family theo định danh family công khai (`family_id` — cũng là `sid` trong access token).
   */
  async getFamilyByFamilyId(familyId: string): Promise<RefreshFamilyRow | undefined> {
    return this.handle
      .selectFrom('refresh_token_family')
      .select(REFRESH_FAMILY_COLUMNS)
      .where('family_id', '=', familyId)
      .executeTakeFirst();
  }

  /**
   * Thu hồi mọi family đang hiệu lực của user ngoại trừ một family giữ lại
   * (phiên hiện tại); trả số family đã thu hồi.
   */
  async revokeOthersForUser(userId: string, keepFamilyId?: string): Promise<number> {
    const active = await this.listActiveFamiliesByUser(userId);
    const targets = active.filter((f) => f.familyId !== keepFamilyId);
    for (const family of targets) await this.revokeFamily(family.id);
    return targets.length;
  }

  // --- Liên kết đăng nhập OAuth (auth_oauth2) ------------------------------------

  /**
   * Tạo liên kết đăng nhập ngoài cho user; ràng buộc duy nhất ở DB chặn
   * một tài khoản provider nối hai user hoặc một user hai liên kết/issuer.
   */
  async createOauthLink(v: NewOauthLink): Promise<UserOauthLinkRow> {
    const rows = await this.handle
      .insertInto('user_oauth_links')
      .values(oauthLinkInsertValues(v))
      .returning(USER_OAUTH_LINK_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /**
   * Tìm liên kết theo tài khoản provider (issuer + định danh chủ thể) — bước khớp đầu tiên ở callback OAuth.
   */
  async getOauthLinkBySubject(issuer: string, issuerUserId: string): Promise<UserOauthLinkRow | undefined> {
    return this.handle
      .selectFrom('user_oauth_links')
      .select(USER_OAUTH_LINK_COLUMNS)
      .where('issuer', '=', issuer)
      .where('issuer_user_id', '=', issuerUserId)
      .executeTakeFirst();
  }

  /**
   * Mọi liên kết đăng nhập ngoài của user, cũ nhất trước (trang Linked logins).
   */
  async listOauthLinksByUser(userId: string): Promise<UserOauthLinkRow[]> {
    return this.handle
      .selectFrom('user_oauth_links')
      .select(USER_OAUTH_LINK_COLUMNS)
      .where('user_id', '=', userId)
      .orderBy('created_at', 'asc')
      .execute();
  }

  /**
   * Tìm liên kết theo id (kèm userId ở phía gọi để kiểm tra sở hữu trước khi gỡ).
   */
  async getOauthLinkById(id: string): Promise<UserOauthLinkRow | undefined> {
    return this.handle
      .selectFrom('user_oauth_links')
      .select(USER_OAUTH_LINK_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /**
   * Xoá một liên kết đăng nhập ngoài (gỡ liên kết ở trang Linked logins).
   */
  async deleteOauthLink(id: string): Promise<void> {
    await this.handle.deleteFrom('user_oauth_links').where('id', '=', id).execute();
  }

  // --- MFA TOTP ---------------------------------------------------------------

  /**
   * Bản ghi TOTP của user (secret đã mã hoá), hoặc undefined nếu chưa setup.
   */
  async getTotpByUserId(userId: string): Promise<UserTotpRow | undefined> {
    return this.handle
      .selectFrom('user_totp')
      .select(USER_TOTP_COLUMNS)
      .where('user_id', '=', userId)
      .executeTakeFirst();
  }

  /**
   * Ghi secret TOTP đang chờ xác nhận; setup lại thì thay secret cũ và đưa
   * trạng thái về chưa xác nhận (authenticator cũ ngừng hiệu lực ngay).
   * Lưu ý: khi factor đang bật (đã xác nhận) thì lời gọi chỉ tới được đây
   * sau cổng tái xác thực bằng mã hiện tại ở `TotpService.setup` — tầng
   * lưu trữ này không tự phân biệt các trạng thái setup.
   */
  async upsertPendingTotp(userId: string, secretEncrypted: string): Promise<UserTotpRow> {
    const rows = await this.handle
      .insertInto('user_totp')
      .values({ user_id: userId, secret_encrypted: secretEncrypted, confirmed: false, confirmed_at: null })
      .onConflict((oc) => oc.column('user_id').doUpdateSet({
        secret_encrypted: secretEncrypted,
        confirmed: false,
        confirmed_at: null,
        created_at: new Date(),
      }))
      .returning(USER_TOTP_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /**
   * Đánh dấu TOTP đã xác nhận (MFA bắt đầu chặn đăng nhập từ đây).
   */
  async confirmTotp(userId: string): Promise<void> {
    await this.handle
      .updateTable('user_totp')
      .set({ confirmed: true, confirmed_at: new Date() })
      .where('user_id', '=', userId)
      .execute();
  }

  /**
   * Xoá hẳn bản ghi TOTP của user (user tự tắt bằng mã đúng, hoặc quản trị reset).
   */
  async deleteTotp(userId: string): Promise<void> {
    await this.handle.deleteFrom('user_totp').where('user_id', '=', userId).execute();
  }

  /**
   * Ghi một lần thử đăng nhập (thành công/thất bại, IP) phục vụ khoá tạm thời.
   */
  async recordAttempt(v: NewLoginAttempt): Promise<void> {
    await this.handle.insertInto('login_attempts').values(loginAttemptInsertValues(v)).execute();
  }

  /**
   * Số lần đăng nhập thất bại gần đây của username — đầu vào của chính sách lockout.
   */
  async recentFailedAttempts(userId: string, since: Date): Promise<LoginAttemptRow[]> {
    return this.handle
      .selectFrom('login_attempts')
      .select(LOGIN_ATTEMPT_COLUMNS)
      .where('user_id', '=', userId)
      .where('success', '=', false)
      .where('attempted_at', '>=', since)
      .orderBy('attempted_at', 'desc')
      .execute();
  }

  /**
   * Thời điểm đăng nhập thành công gần nhất.
   */
  async lastSuccessfulAttemptAt(userId: string): Promise<Date | undefined> {
    const row = await this.handle
      .selectFrom('login_attempts')
      .select(LOGIN_ATTEMPT_COLUMNS)
      .where('user_id', '=', userId)
      .where('success', '=', true)
      .orderBy('attempted_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row?.attemptedAt;
  }
}

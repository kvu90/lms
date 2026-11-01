/**
 * Repository của cụm HUY HIỆU trên Kysely — hạng mục nhân rộng G7
 * của chiến dịch chuyển tầng dữ liệu (issue #647), chuyển từ
 * repository Drizzle cũ ở
 * `apps/api/src/modules/badges/badges.repository.ts`.
 *
 * Vai trò: mọi truy cập tới bốn bảng của kho trung tâm thuộc
 * module huy hiệu — `badge` (định nghĩa huy hiệu), `badge_criteria`
 * (bộ tiêu chí), `badge_issued` (bản ghi cấp phát, bằng chứng bất
 * biến kèm bản chụp jsonb) và `badge_manual_award` (lượt trao thủ
 * công) — tập trung ở đây. Luật nghiệp vụ (đánh giá tiêu chí, gác
 * quyền, thông báo trao huy hiệu) nằm ở tầng service phía ứng
 * dụng; repository chỉ nhận handle để service ghép các thao tác
 * ghi vào một transaction khi cần bất biến nguyên tử (đặt lại bộ
 * tiêu chí, cấp huy hiệu + ghi outbox).
 *
 * Khuôn hình dạng dữ liệu ở biên repository — cùng khuôn pilot kho
 * control plane (xem mục "Sổ tay chuyển đổi repository sang Kysely"
 * trong `AGENTS.md` của package): bên trong dùng tên cột
 * snake_case của interface schema codegen; bên ngoài trả/nhận hình
 * dạng camelCase qua danh sách cột tường minh có bí danh và các
 * hàm ánh xạ ghi loại `undefined` từng trường (thử nghiệm T-4);
 * mọi giá trị where là tham số bắt buộc. Ba cột jsonb của cụm
 * (`badge_criteria.params`, `badge_issued.snapshot`,
 * `badge_issued.evidence`) không mang hình dạng `$type` ở phía
 * Drizzle cũ nên kiểu công khai ở biên là `unknown` như trước, và
 * mọi lần ghi đều đi qua helper serialize `::jsonb` duy nhất trong
 * file này (driver `pg` hiểu MẢNG cấp cao nhất là mảng PostgreSQL
 * thay vì JSON — xem sổ tay).
 *
 * Hai điểm giữ nguyên hành vi của đường Drizzle cũ, có chủ đích:
 * - `insertIssued`/`insertManualAward`: khi insert bỏ qua vì
 *   trùng khoá tự nhiên không trả dòng nào, dòng đã có được đọc
 *   lại qua HANDLE GỐC của repository — không qua handle giao dịch
 *   được truyền vào — đúng như code cũ đọc qua `this.db` thay vì
 *   `tx`.
 * - `countIssued` đếm bằng cách đọc các dòng rồi lấy độ dài ở
 *   tầng ứng dụng, không đổi thành truy vấn `count(*)` ở database.
 *
 * Repository không import từ `apps/*`, không đọc ALS/ngữ cảnh ứng
 * dụng, không tự mở pool, không đọc biến môi trường.
 */
import { sql, type Insertable, type InsertObject, type RawBuilder, type Updateable, type UpdateObject } from 'kysely';
import type { CentreDb, CentreTx, CentreDB } from '../client';
import type { JsonValue } from '../types/centre-db';

/** Handle đọc/ghi mà repository nhận: transaction đang mở hoặc chính instance gốc. */
type RepoDb = CentreDb | CentreTx;

/** Một dòng định nghĩa huy hiệu. */
export interface BadgeRow {
  id: string;
  name: string;
  description: string;
  /** 1 = huy hiệu site, 2 = huy hiệu khoá học. */
  type: number;
  courseId: string | null;
  issuerName: string;
  issuerUrl: string;
  issuerContact: string;
  expireDate: Date | null;
  expirePeriod: number | null;
  status: number;
  version: string;
  language: string;
  userCreated: string | null;
  userModified: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Dữ kiện ghi một huy hiệu mới (đã qua kiểm chứng ở tầng service). */
export interface NewBadge {
  id?: string;
  name: string;
  description?: string;
  type?: number;
  courseId?: string | null;
  issuerName?: string;
  issuerUrl?: string;
  issuerContact?: string;
  expireDate?: Date | null;
  expirePeriod?: number | null;
  status?: number;
  version?: string;
  language?: string;
  userCreated?: string | null;
  userModified?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Một dòng tiêu chí trong bộ tiêu chí của một huy hiệu; `params` là cấu hình riêng của loại tiêu chí. */
export interface CriteriaRow {
  id: string;
  badgeId: string;
  criteriaType: string;
  method: number;
  params: unknown;
  description: string;
}

/** Dữ kiện ghi một tiêu chí mới. */
export interface NewCriteria {
  id?: string;
  badgeId: string;
  criteriaType: string;
  method?: number;
  params?: unknown;
  description?: string;
}

/**
 * Một dòng bản ghi cấp phát huy hiệu: bằng chứng bất biến rằng một
 * user đã đạt huy hiệu, kèm bản chụp (`snapshot`) của huy hiệu +
 * tiêu chí tại thời điểm cấp và `evidence` của lần cấp. Thu hồi
 * không xoá dòng, chỉ lật cờ `revoked`.
 */
export interface IssuedRow {
  id: string;
  badgeId: string;
  userId: string;
  uniqueHash: string;
  snapshot: unknown;
  evidence: unknown;
  dateIssued: Date;
  dateExpire: Date | null;
  visible: boolean;
  revoked: boolean;
  revokedAt: Date | null;
  issuerNotified: boolean;
}

/** Dữ kiện ghi một bản ghi cấp phát mới. */
export interface NewIssued {
  id?: string;
  badgeId: string;
  userId: string;
  uniqueHash: string;
  snapshot?: unknown;
  evidence?: unknown;
  dateIssued?: Date;
  dateExpire?: Date | null;
  visible?: boolean;
  revoked?: boolean;
  revokedAt?: Date | null;
  issuerNotified?: boolean;
}

/** Một dòng lượt trao thủ công (bằng chứng một tiêu chí thủ công đã được đáp ứng theo quyết định của người giữ vai trò). */
export interface ManualAwardRow {
  id: string;
  badgeId: string;
  recipientId: string;
  issuerId: string;
  issuerRole: string | null;
  dateMet: Date;
}

/** Dữ kiện ghi một lượt trao thủ công mới. */
export interface NewManualAward {
  id?: string;
  badgeId: string;
  recipientId: string;
  issuerId: string;
  issuerRole?: string | null;
  dateMet?: Date;
}

/** Danh sách cột tường minh có bí danh camelCase cho bảng huy hiệu. */
const BADGE_COLUMNS = [
  'id',
  'name',
  'description',
  'type',
  'course_id as courseId',
  'issuer_name as issuerName',
  'issuer_url as issuerUrl',
  'issuer_contact as issuerContact',
  'expire_date as expireDate',
  'expire_period as expirePeriod',
  'status',
  'version',
  'language',
  'user_created as userCreated',
  'user_modified as userModified',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng tiêu chí. */
const BADGE_CRITERIA_COLUMNS = [
  'id',
  'badge_id as badgeId',
  'criteria_type as criteriaType',
  'method',
  'params',
  'description',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng cấp phát. */
const BADGE_ISSUED_COLUMNS = [
  'id',
  'badge_id as badgeId',
  'user_id as userId',
  'unique_hash as uniqueHash',
  'snapshot',
  'evidence',
  'date_issued as dateIssued',
  'date_expire as dateExpire',
  'visible',
  'revoked',
  'revoked_at as revokedAt',
  'issuer_notified as issuerNotified',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng trao thủ công. */
const BADGE_MANUAL_AWARD_COLUMNS = [
  'id',
  'badge_id as badgeId',
  'recipient_id as recipientId',
  'issuer_id as issuerId',
  'issuer_role as issuerRole',
  'date_met as dateMet',
] as const;

/**
 * Bọc một giá trị jsonb thành biểu thức tham số JSON tường minh —
 * helper serialize duy nhất của file này cho mọi lần ghi jsonb
 * (khuôn của pilot: driver `pg` tự stringify object thường nhưng
 * hiểu MẢNG cấp cao nhất là mảng PostgreSQL, khiến cột jsonb lỗi
 * `invalid input syntax for type json`). Khác pilot ở một điểm:
 * ba cột jsonb của cụm này không mang hình dạng `$type` ở phía
 * Drizzle cũ nên giá trị ở biên là `unknown` — helper ghim kiểu
 * biểu thức về `JsonValue` của codegen để khớp kiểu cột khi biên
 * dịch, thay vì suy kiểu từ giá trị như khuôn generic của pilot.
 */
function jsonbValue(value: unknown): RawBuilder<JsonValue> {
  return sql<JsonValue>`${JSON.stringify(value)}::jsonb`;
}

/** Ánh xạ dữ kiện ghi huy hiệu (camelCase) sang values insert (snake_case), LOẠI mọi trường `undefined` (T-4). */
function badgeInsertValues(values: NewBadge): Insertable<CentreDB['badge']> {
  const row: Insertable<CentreDB['badge']> = { name: values.name };
  if (values.id !== undefined) row.id = values.id;
  if (values.description !== undefined) row.description = values.description;
  if (values.type !== undefined) row.type = values.type;
  if (values.courseId !== undefined) row.course_id = values.courseId;
  if (values.issuerName !== undefined) row.issuer_name = values.issuerName;
  if (values.issuerUrl !== undefined) row.issuer_url = values.issuerUrl;
  if (values.issuerContact !== undefined) row.issuer_contact = values.issuerContact;
  if (values.expireDate !== undefined) row.expire_date = values.expireDate;
  if (values.expirePeriod !== undefined) row.expire_period = values.expirePeriod;
  if (values.status !== undefined) row.status = values.status;
  if (values.version !== undefined) row.version = values.version;
  if (values.language !== undefined) row.language = values.language;
  if (values.userCreated !== undefined) row.user_created = values.userCreated;
  if (values.userModified !== undefined) row.user_modified = values.userModified;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  if (values.updatedAt !== undefined) row.updated_at = values.updatedAt;
  return row;
}

/**
 * Ánh xạ một patch cập nhật huy hiệu (camelCase) sang set update
 * (snake_case), LOẠI mọi trường `undefined` — patch chỉ chứa
 * trường nào thì chỉ trường đó đổi (quy tắc T-4).
 */
function badgeUpdateSet(patch: Partial<BadgeRow>): Updateable<CentreDB['badge']> {
  const set: Updateable<CentreDB['badge']> = {};
  if (patch.id !== undefined) set.id = patch.id;
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.type !== undefined) set.type = patch.type;
  if (patch.courseId !== undefined) set.course_id = patch.courseId;
  if (patch.issuerName !== undefined) set.issuer_name = patch.issuerName;
  if (patch.issuerUrl !== undefined) set.issuer_url = patch.issuerUrl;
  if (patch.issuerContact !== undefined) set.issuer_contact = patch.issuerContact;
  if (patch.expireDate !== undefined) set.expire_date = patch.expireDate;
  if (patch.expirePeriod !== undefined) set.expire_period = patch.expirePeriod;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.version !== undefined) set.version = patch.version;
  if (patch.language !== undefined) set.language = patch.language;
  if (patch.userCreated !== undefined) set.user_created = patch.userCreated;
  if (patch.userModified !== undefined) set.user_modified = patch.userModified;
  if (patch.createdAt !== undefined) set.created_at = patch.createdAt;
  return set;
}

/**
 * Ánh xạ dữ kiện ghi tiêu chí (camelCase) sang values insert
 * (snake_case), LOẠI mọi trường `undefined` (T-4); cột `params`
 * jsonb đi qua helper serialize. Biến tích luỹ khai kiểu
 * `InsertObject` vì values chứa trường biểu thức (theo sổ tay).
 */
function criteriaInsertValues(values: NewCriteria): InsertObject<CentreDB, 'badge_criteria'> {
  const row: InsertObject<CentreDB, 'badge_criteria'> = {
    badge_id: values.badgeId,
    criteria_type: values.criteriaType,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.method !== undefined) row.method = values.method;
  if (values.params !== undefined) row.params = jsonbValue(values.params);
  if (values.description !== undefined) row.description = values.description;
  return row;
}

/**
 * Ánh xạ dữ kiện ghi bản ghi cấp phát (camelCase) sang values
 * insert (snake_case), LOẠI mọi trường `undefined` (T-4); hai cột
 * jsonb `snapshot`/`evidence` đi qua helper serialize. Biến tích
 * luỹ khai kiểu `InsertObject` vì values chứa trường biểu thức.
 */
function issuedInsertValues(values: NewIssued): InsertObject<CentreDB, 'badge_issued'> {
  const row: InsertObject<CentreDB, 'badge_issued'> = {
    badge_id: values.badgeId,
    user_id: values.userId,
    unique_hash: values.uniqueHash,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.snapshot !== undefined) row.snapshot = jsonbValue(values.snapshot);
  if (values.evidence !== undefined) row.evidence = jsonbValue(values.evidence);
  if (values.dateIssued !== undefined) row.date_issued = values.dateIssued;
  if (values.dateExpire !== undefined) row.date_expire = values.dateExpire;
  if (values.visible !== undefined) row.visible = values.visible;
  if (values.revoked !== undefined) row.revoked = values.revoked;
  if (values.revokedAt !== undefined) row.revoked_at = values.revokedAt;
  if (values.issuerNotified !== undefined) row.issuer_notified = values.issuerNotified;
  return row;
}

/**
 * Ánh xạ một patch cập nhật bản ghi cấp phát (camelCase) sang set
 * update (snake_case), LOẠI mọi trường `undefined` (T-4); hai cột
 * jsonb đi qua helper serialize. Bảng này không có cột
 * `updated_at` nên set là đúng patch, không kèm mốc làm mới.
 */
function issuedUpdateSet(patch: Partial<IssuedRow>): UpdateObject<CentreDB, 'badge_issued'> {
  const set: UpdateObject<CentreDB, 'badge_issued'> = {};
  if (patch.id !== undefined) set.id = patch.id;
  if (patch.badgeId !== undefined) set.badge_id = patch.badgeId;
  if (patch.userId !== undefined) set.user_id = patch.userId;
  if (patch.uniqueHash !== undefined) set.unique_hash = patch.uniqueHash;
  if (patch.snapshot !== undefined) set.snapshot = jsonbValue(patch.snapshot);
  if (patch.evidence !== undefined) set.evidence = jsonbValue(patch.evidence);
  if (patch.dateIssued !== undefined) set.date_issued = patch.dateIssued;
  if (patch.dateExpire !== undefined) set.date_expire = patch.dateExpire;
  if (patch.visible !== undefined) set.visible = patch.visible;
  if (patch.revoked !== undefined) set.revoked = patch.revoked;
  if (patch.revokedAt !== undefined) set.revoked_at = patch.revokedAt;
  if (patch.issuerNotified !== undefined) set.issuer_notified = patch.issuerNotified;
  return set;
}

/** Ánh xạ dữ kiện ghi lượt trao thủ công (camelCase) sang values insert (snake_case), LOẠI mọi trường `undefined` (T-4). */
function manualAwardInsertValues(values: NewManualAward): Insertable<CentreDB['badge_manual_award']> {
  const row: Insertable<CentreDB['badge_manual_award']> = {
    badge_id: values.badgeId,
    recipient_id: values.recipientId,
    issuer_id: values.issuerId,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.issuerRole !== undefined) row.issuer_role = values.issuerRole;
  if (values.dateMet !== undefined) row.date_met = values.dateMet;
  return row;
}

/**
 * Repository huy hiệu trên Kysely: huy hiệu, tiêu chí, bản ghi cấp
 * phát và cấp thủ công của kho trung tâm.
 */
export class BadgesRepository {
  constructor(private readonly handle: CentreDb) {}

  /** Instance gốc của repository. */
  private db(): CentreDb {
    return this.handle;
  }

  /** Mở một transaction trên kho trung tâm qua handle của repository. */
  async transaction<T>(fn: (tx: CentreTx) => Promise<T>): Promise<T> {
    return this.db().transaction().execute(fn);
  }

  /** Chèn huy hiệu. */
  async insertBadge(values: NewBadge, db: RepoDb = this.db()): Promise<BadgeRow> {
    const rows = await db.insertInto('badge').values(badgeInsertValues(values)).returning(BADGE_COLUMNS).execute();
    return rows[0]!;
  }

  /** Lấy huy hiệu theo id. */
  async getBadge(id: string, db: RepoDb = this.db()): Promise<BadgeRow | undefined> {
    return db.selectFrom('badge').select(BADGE_COLUMNS).where('id', '=', id).limit(1).executeTakeFirst();
  }

  /** Liệt kê huy hiệu, theo id tăng dần. */
  async listBadges(db: RepoDb = this.db()): Promise<BadgeRow[]> {
    return db.selectFrom('badge').select(BADGE_COLUMNS).orderBy('id', 'asc').execute();
  }

  /** Cập nhật huy hiệu; mốc `updated_at` luôn được làm mới ở đây như đường Drizzle trước đây. */
  async updateBadge(id: string, patch: Partial<BadgeRow>, db: RepoDb = this.db()): Promise<void> {
    await db
      .updateTable('badge')
      .set({ ...badgeUpdateSet(patch), updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** Thêm một tiêu chí vào bộ tiêu chí của huy hiệu. */
  async insertCriteria(values: NewCriteria, db: RepoDb = this.db()): Promise<CriteriaRow> {
    const rows = await db
      .insertInto('badge_criteria')
      .values(criteriaInsertValues(values))
      .returning(BADGE_CRITERIA_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Tiêu chí của huy hiệu, theo id tăng dần. */
  async listCriteria(badgeId: string, db: RepoDb = this.db()): Promise<CriteriaRow[]> {
    return db
      .selectFrom('badge_criteria')
      .select(BADGE_CRITERIA_COLUMNS)
      .where('badge_id', '=', badgeId)
      .orderBy('id', 'asc')
      .execute();
  }

  /** Xoá toàn bộ tiêu chí của huy hiệu (đặt lại bộ tiêu chí). */
  async deleteCriteria(badgeId: string, db: RepoDb = this.db()): Promise<void> {
    await db.deleteFrom('badge_criteria').where('badge_id', '=', badgeId).execute();
  }

  /**
   * Ghi bản ghi cấp phát huy hiệu cho user. Trùng cặp
   * (badge, user) thì insert là no-op và dòng đã cấp được đọc lại
   * qua handle gốc — cấp hai lần cho cùng một user chỉ cho một
   * bản ghi, như hành vi đường Drizzle cũ.
   */
  async insertIssued(values: NewIssued, db: RepoDb = this.db()): Promise<IssuedRow> {
    const rows = await db
      .insertInto('badge_issued')
      .values(issuedInsertValues(values))
      .onConflict((oc) => oc.columns(['badge_id', 'user_id']).doNothing())
      .returning(BADGE_ISSUED_COLUMNS)
      .execute();
    if (rows[0]) return rows[0];
    const existing = await this.db()
      .selectFrom('badge_issued')
      .select(BADGE_ISSUED_COLUMNS)
      .where('badge_id', '=', values.badgeId)
      .where('user_id', '=', values.userId)
      .limit(1)
      .executeTakeFirst();
    return existing!;
  }

  /** Lấy bản ghi cấp phát theo id. */
  async getIssued(id: string, db: RepoDb = this.db()): Promise<IssuedRow | undefined> {
    return db.selectFrom('badge_issued').select(BADGE_ISSUED_COLUMNS).where('id', '=', id).limit(1).executeTakeFirst();
  }

  /** Tìm bản ghi cấp phát của user cho một huy hiệu. */
  async findIssued(badgeId: string, userId: string, db: RepoDb = this.db()): Promise<IssuedRow | undefined> {
    return db
      .selectFrom('badge_issued')
      .select(BADGE_ISSUED_COLUMNS)
      .where('badge_id', '=', badgeId)
      .where('user_id', '=', userId)
      .limit(1)
      .executeTakeFirst();
  }

  /** Bản ghi cấp phát của một huy hiệu, theo id tăng dần. */
  async listIssuedForBadge(badgeId: string, db: RepoDb = this.db()): Promise<IssuedRow[]> {
    return db
      .selectFrom('badge_issued')
      .select(BADGE_ISSUED_COLUMNS)
      .where('badge_id', '=', badgeId)
      .orderBy('id', 'asc')
      .execute();
  }

  /** Huy hiệu đã cấp cho user, theo id tăng dần. */
  async listIssuedForUser(userId: string, db: RepoDb = this.db()): Promise<IssuedRow[]> {
    return db
      .selectFrom('badge_issued')
      .select(BADGE_ISSUED_COLUMNS)
      .where('user_id', '=', userId)
      .orderBy('id', 'asc')
      .execute();
  }

  /** Số lần huy hiệu đã được cấp (đếm ở tầng ứng dụng trên các dòng đọc về, như đường cũ). */
  async countIssued(badgeId: string, db: RepoDb = this.db()): Promise<number> {
    const rows = await db
      .selectFrom('badge_issued')
      .select(BADGE_ISSUED_COLUMNS)
      .where('badge_id', '=', badgeId)
      .execute();
    return rows.length;
  }

  /** Cập nhật bản ghi cấp phát (ví dụ thu hồi: lật cờ `revoked` + mốc thu hồi). */
  async updateIssued(id: string, patch: Partial<IssuedRow>, db: RepoDb = this.db()): Promise<void> {
    await db.updateTable('badge_issued').set(issuedUpdateSet(patch)).where('id', '=', id).execute();
  }

  /**
   * Ghi một lần cấp thủ công. Chỉ số duy nhất của bảng là bộ ba
   * (badge, recipient, issuer) nhưng dòng đã có được đọc lại theo
   * cặp (badge, recipient) — giữ nguyên bất đối xứng này của
   * đường Drizzle cũ.
   */
  async insertManualAward(values: NewManualAward, db: RepoDb = this.db()): Promise<ManualAwardRow> {
    const rows = await db
      .insertInto('badge_manual_award')
      .values(manualAwardInsertValues(values))
      .onConflict((oc) => oc.columns(['badge_id', 'recipient_id', 'issuer_id']).doNothing())
      .returning(BADGE_MANUAL_AWARD_COLUMNS)
      .execute();
    if (rows[0]) return rows[0];
    const existing = await this.db()
      .selectFrom('badge_manual_award')
      .select(BADGE_MANUAL_AWARD_COLUMNS)
      .where('badge_id', '=', values.badgeId)
      .where('recipient_id', '=', values.recipientId)
      .limit(1)
      .executeTakeFirst();
    return existing!;
  }

  /** Tìm bản ghi cấp thủ công theo cặp (huy hiệu, người nhận). */
  async findManualAward(badgeId: string, recipientId: string, db: RepoDb = this.db()): Promise<ManualAwardRow | undefined> {
    return db
      .selectFrom('badge_manual_award')
      .select(BADGE_MANUAL_AWARD_COLUMNS)
      .where('badge_id', '=', badgeId)
      .where('recipient_id', '=', recipientId)
      .limit(1)
      .executeTakeFirst();
  }
}

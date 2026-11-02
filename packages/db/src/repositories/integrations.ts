/**
 * Repository của cụm INTEGRATIONS trên Kysely — chuyển đổi
 * Drizzle → Kysely thuộc nhóm G8 của chiến dịch chuyển tầng dữ
 * liệu (issue #648).
 *
 * Vai trò: mọi truy cập tới hai bảng external_services và
 * external_tokens của kho trung tâm tập trung ở đây, cộng một truy
 * vấn đọc trạng thái tài khoản tối thiểu trên bảng users (bảng của
 * module users — repository này chỉ ĐỌC hai cờ của nó cho đường
 * kiểm tra chủ token, không sở hữu bảng). Repository không chứa
 * luật nghiệp vụ — vòng đời token và kiểm tra tại lúc dùng nằm ở
 * tầng service phía ứng dụng.
 *
 * Khuôn hình dạng dữ liệu ở biên repository (theo khuôn pilot kho
 * control plane): bên trong dùng tên bảng/cột snake_case của
 * schema codegen; bên ngoài nhận/trả hình dạng camelCase qua danh
 * sách cột có bí danh tường minh và các hàm ánh xạ
 * `*InsertValues`/`*UpdateSet` loại `undefined` từng trường (luật
 * T-4). Cột jsonb `functions` khi ghi đi qua `jsonbValue`
 * (serialize tường minh + `::jsonb`) vì giá trị của nó là một MẢNG
 * ở cấp cao nhất — hình dạng bị driver `pg` hiểu nhầm là mảng
 * PostgreSQL nếu gắn tham số trực tiếp.
 */
import { sql, type Insertable, type InsertObject, type RawBuilder, type UpdateObject } from 'kysely';
import type { CentreDb, CentreTx, CentreDB } from '../client';
import type { JsonValue } from '../types/centre-db';

/** Handle đọc/ghi mà repository nhận: transaction đang mở hoặc chính instance gốc. */
export type IntegrationsDb = CentreDb | CentreTx;

/** Một dòng định nghĩa dịch vụ ngoài (web service) của hệ. */
export interface ServiceRow {
  id: string;
  name: string;
  shortName: string;
  enabled: boolean;
  /** Danh sách hàm mà dịch vụ phơi ra (jsonb). */
  functions: unknown;
  createdAt: Date;
}

/** Một dòng token truy cập dịch vụ ngoài đã cấp cho một user. */
export interface TokenRow {
  id: string;
  tokenHash: string;
  userId: string;
  serviceId: string;
  validUntil: Date | null;
  ipRestriction: string | null;
  revoked: boolean;
  lastAccess: Date | null;
  createdAt: Date;
}

/** Trạng thái tài khoản tối thiểu của chủ token, phục vụ lớp kiểm tra tại lúc dùng ở tầng service. */
export interface TokenOwnerState { suspended: boolean; deleted: boolean }

/** Dữ kiện ghi một định nghĩa dịch vụ mới. */
export interface NewService {
  id?: string;
  name: string;
  shortName: string;
  enabled?: boolean;
  functions?: unknown;
  createdAt?: Date;
}

/** Dữ kiện ghi một token mới. */
export interface NewToken {
  id?: string;
  tokenHash: string;
  userId: string;
  serviceId: string;
  validUntil?: Date | null;
  ipRestriction?: string | null;
  revoked?: boolean;
  lastAccess?: Date | null;
  createdAt?: Date;
}

/**
 * Bọc một giá trị jsonb thành biểu thức tham số JSON tường minh
 * (serialize + `::jsonb`) — xem lý do ở phần đầu file.
 *
 * @param value - Giá trị nghiệp vụ sẽ nằm trong cột jsonb (hình
 *   dạng do phía gọi chịu trách nhiệm — các cột jsonb của cụm này
 *   không khai kiểu nghiệp vụ riêng ở schema).
 * @returns Biểu thức Kysely mang chuỗi JSON đã serialize.
 */
function jsonbValue(value: unknown): RawBuilder<JsonValue> {
  return sql<JsonValue>`${JSON.stringify(value)}::jsonb`;
}

/** Danh sách cột tường minh có bí danh camelCase cho bảng external_services. */
const SERVICE_COLUMNS = [
  'id',
  'name',
  'short_name as shortName',
  'enabled',
  'functions',
  'created_at as createdAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng external_tokens. */
const TOKEN_COLUMNS = [
  'id',
  'token_hash as tokenHash',
  'user_id as userId',
  'service_id as serviceId',
  'valid_until as validUntil',
  'ip_restriction as ipRestriction',
  'revoked',
  'last_access as lastAccess',
  'created_at as createdAt',
] as const;

/** Ánh xạ dữ kiện ghi dịch vụ từ camelCase sang snake_case, loại `undefined` từng trường. */
function serviceInsertValues(values: NewService): InsertObject<CentreDB, 'external_services'> {
  const row: InsertObject<CentreDB, 'external_services'> = {
    name: values.name,
    short_name: values.shortName,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.enabled !== undefined) row.enabled = values.enabled;
  if (values.functions !== undefined) row.functions = jsonbValue(values.functions);
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  return row;
}

/** Ánh xạ bản vá dịch vụ từ camelCase sang snake_case, loại `undefined` từng trường. */
function serviceUpdateSet(patch: Partial<NewService>): UpdateObject<CentreDB, 'external_services'> {
  const set: UpdateObject<CentreDB, 'external_services'> = {};
  if (patch.id !== undefined) set.id = patch.id;
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.shortName !== undefined) set.short_name = patch.shortName;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.functions !== undefined) set.functions = jsonbValue(patch.functions);
  if (patch.createdAt !== undefined) set.created_at = patch.createdAt;
  return set;
}

/** Ánh xạ dữ kiện ghi token từ camelCase sang snake_case, loại `undefined` từng trường. */
function tokenInsertValues(values: NewToken): Insertable<CentreDB['external_tokens']> {
  const row: Insertable<CentreDB['external_tokens']> = {
    token_hash: values.tokenHash,
    user_id: values.userId,
    service_id: values.serviceId,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.validUntil !== undefined) row.valid_until = values.validUntil;
  if (values.ipRestriction !== undefined) row.ip_restriction = values.ipRestriction;
  if (values.revoked !== undefined) row.revoked = values.revoked;
  if (values.lastAccess !== undefined) row.last_access = values.lastAccess;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  return row;
}

/** Ánh xạ bản vá token từ camelCase sang snake_case, loại `undefined` từng trường. */
function tokenUpdateSet(patch: Partial<NewToken>): UpdateObject<CentreDB, 'external_tokens'> {
  const set: UpdateObject<CentreDB, 'external_tokens'> = {};
  if (patch.id !== undefined) set.id = patch.id;
  if (patch.tokenHash !== undefined) set.token_hash = patch.tokenHash;
  if (patch.userId !== undefined) set.user_id = patch.userId;
  if (patch.serviceId !== undefined) set.service_id = patch.serviceId;
  if (patch.validUntil !== undefined) set.valid_until = patch.validUntil;
  if (patch.ipRestriction !== undefined) set.ip_restriction = patch.ipRestriction;
  if (patch.revoked !== undefined) set.revoked = patch.revoked;
  if (patch.lastAccess !== undefined) set.last_access = patch.lastAccess;
  if (patch.createdAt !== undefined) set.created_at = patch.createdAt;
  return set;
}

/** Kho dữ liệu external_services / external_tokens. */
export class IntegrationsRepository {
  constructor(private readonly handle: CentreDb) {}

  /** Handle Kysely của kho trung tâm mà repository đang giữ (tầng service dùng cho các truy vấn đọc phụ trợ của module). */
  get dbHandle(): CentreDb {
    return this.handle;
  }

  /** Ghi một định nghĩa dịch vụ mới, trả dòng vừa ghi. */
  async insertService(v: NewService, db: IntegrationsDb = this.handle): Promise<ServiceRow> {
    const rows = await db
      .insertInto('external_services')
      .values(serviceInsertValues(v))
      .returning(SERVICE_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Lấy định nghĩa dịch vụ theo id. */
  async getService(id: string, db: IntegrationsDb = this.handle): Promise<ServiceRow | undefined> {
    return db
      .selectFrom('external_services')
      .select(SERVICE_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** Liệt kê mọi định nghĩa dịch vụ. */
  async listServices(db: IntegrationsDb = this.handle): Promise<ServiceRow[]> {
    return db.selectFrom('external_services').select(SERVICE_COLUMNS).execute();
  }

  /** Cập nhật một định nghĩa dịch vụ theo bản vá từng phần. */
  async updateService(id: string, v: Partial<NewService>, db: IntegrationsDb = this.handle): Promise<void> {
    await db
      .updateTable('external_services')
      .set(serviceUpdateSet(v))
      .where('id', '=', id)
      .execute();
  }

  /** Ghi một token mới, trả dòng vừa ghi. */
  async insertToken(v: NewToken, db: IntegrationsDb = this.handle): Promise<TokenRow> {
    const rows = await db
      .insertInto('external_tokens')
      .values(tokenInsertValues(v))
      .returning(TOKEN_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Lấy token theo giá trị băm (đường tra cứu lúc dùng). */
  async getTokenByHash(tokenHash: string, db: IntegrationsDb = this.handle): Promise<TokenRow | undefined> {
    return db
      .selectFrom('external_tokens')
      .select(TOKEN_COLUMNS)
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();
  }

  /** Lấy token theo id. */
  async getToken(id: string, db: IntegrationsDb = this.handle): Promise<TokenRow | undefined> {
    return db
      .selectFrom('external_tokens')
      .select(TOKEN_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** Liệt kê mọi token. */
  async listTokens(db: IntegrationsDb = this.handle): Promise<TokenRow[]> {
    return db.selectFrom('external_tokens').select(TOKEN_COLUMNS).execute();
  }

  /** Cập nhật một token theo bản vá từng phần. */
  async updateToken(id: string, v: Partial<NewToken>, db: IntegrationsDb = this.handle): Promise<void> {
    await db
      .updateTable('external_tokens')
      .set(tokenUpdateSet(v))
      .where('id', '=', id)
      .execute();
  }

  /**
   * Nạp trạng thái tài khoản của chủ token (chỉ hai cờ `suspended`/`deleted`).
   * Trả `undefined` khi không còn dòng user tương ứng — tầng service coi đó
   * là tài khoản không còn hoạt động.
   */
  async getTokenOwnerState(userId: string, db: IntegrationsDb = this.handle): Promise<TokenOwnerState | undefined> {
    return db
      .selectFrom('users')
      .select(['suspended', 'deleted'])
      .where('id', '=', userId)
      .executeTakeFirst();
  }
}

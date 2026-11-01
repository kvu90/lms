/**
 * Repository của kho CONTROL PLANE trên Kysely — pilot chuyển đổi
 * Drizzle → Kysely của chiến dịch chuyển tầng dữ liệu (issue #640).
 *
 * Vai trò: mọi truy cập tới sáu bảng của database control plane
 * (sổ đăng ký không gian, lịch sử quản trị sổ, registry phiên bản
 * schema, nhật ký migration, thư mục thành viên và thư mục mã tham
 * gia của các không gian kho riêng) tập trung ở đây. Repository
 * không chứa luật nghiệp vụ — gác quyền, ghi lịch sử và giao dịch
 * nằm ở tầng service phía ứng dụng; repository chỉ nhận handle
 * (instance gốc hoặc transaction đang mở) để phía gọi ghép nhiều
 * thao tác vào một transaction khi cần bất biến "sổ + lịch sử cùng
 * thành/bại".
 *
 * Khuôn hình dạng dữ liệu ở biên repository (các nhóm nhân rộng làm
 * theo — xem mục playbook trong `AGENTS.md` của package):
 * - Bên trong repository, truy vấn viết trên interface schema sinh
 *   bằng codegen: tên bảng/cột giữ nguyên snake_case của database,
 *   kiểu dòng nội bộ qua `Selectable`/`Insertable`/`Updateable`.
 * - Bên ngoài, repository trả NHẬN các hình dạng dòng camelCase như
 *   phía tiêu thụ đang dùng: cột được chọn bằng danh sách tường
 *   minh có bí danh (`database_name as databaseName`), giá trị ghi
 *   được ánh xạ từng trường từ camelCase sang snake_case ở các hàm
 *   `*InsertValues`/`*UpdateSet` trong file này. Phía tiêu thụ vì
 *   vậy chỉ đổi điểm import khi một kho chuyển đổi.
 * - Giá trị `undefined` bị LOẠI khỏi values/set trước khi gọi
 *   builder. Thử nghiệm T-4 của pilot đo được: Kysely tự loại
 *   `undefined` khỏi values/set khi biên dịch (khớp hành vi
 *   Drizzle), nhưng repository vẫn loại tường minh để hành vi
 *   không phụ thuộc mặc định của thư viện. Ngược lại, `undefined`
 *   lọt vào mệnh đề WHERE được biên dịch thành một placeholder
 *   mà tham số giữ nguyên giá trị `undefined`; lúc thực thi
 *   driver gắn NULL nên phép so sánh không khớp dòng nào và
 *   lặng lẽ trả 0 dòng — vì vậy mọi giá trị where trong
 *   repository đều là tham số bắt buộc, không bao giờ
 *   `undefined`.
 * - Repository không import từ `apps/*`, không đọc ALS/ngữ cảnh
 *   ứng dụng, không tự mở pool, không đọc biến môi trường: handle
 *   do tầng ứng dụng dựng bằng factory của package rồi truyền vào.
 */
import { sql, type Insertable, type InsertObject, type RawBuilder, type Updateable } from 'kysely';
import type { ControlPlaneDb, ControlPlaneTx, ControlPlaneDB } from '../client';
import type { SchemaMigrationStep, SpaceRegistrySnapshot } from '../control-plane.schema';

/** Handle giao dịch của control plane — kiểu `Transaction<ControlPlaneDB>` của package. */
export type CpTx = ControlPlaneTx;
/** Handle đọc/ghi mà repository nhận: transaction đang mở hoặc chính instance gốc. */
export type CpDb = ControlPlaneDb | ControlPlaneTx;

/** Một dòng của sổ đăng ký không gian (hình dạng camelCase phía tiêu thụ dùng). */
export interface SpaceRegistryRow {
  id: string;
  slug: string;
  name: string;
  /** center | platform (platform chỉ cho Trang chính). */
  kind: string;
  /** provisioning | active | suspended | closed. */
  status: string;
  databaseName: string;
  /** shared | dedicated. */
  storageMode: string;
  connectionRoleRef: string;
  secretRef: string | null;
  schemaVersion: string | null;
  plan: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Một dòng lịch sử quản trị sổ đăng ký (ảnh chụp trước/sau nằm ở hai cột jsonb). */
export interface SpaceRegistryHistoryRow {
  id: string;
  spaceId: string;
  actorId: string;
  /** create | update | status_change. */
  action: string;
  before: SpaceRegistrySnapshot | null;
  after: SpaceRegistrySnapshot;
  createdAt: Date;
}

/** Một dòng registry phiên bản schema của một kho đã đăng ký (khoá chính là spaceId). */
export interface SpaceSchemaRegistryRow {
  spaceId: string;
  currentVersion: string | null;
  lastBackupStatus: string | null;
  lastBackupAt: Date | null;
  lastRestoreStatus: string | null;
  lastRestoreAt: Date | null;
  updatedAt: Date;
}

/** Một dòng nhật ký lượt chạy migration trên kho của một không gian (chỉ thêm, không sửa). */
export interface SpaceSchemaMigrationRunRow {
  id: string;
  spaceId: string;
  runId: string;
  fromVersion: string | null;
  toVersion: string | null;
  /** running | success | failed. */
  status: string;
  steps: SchemaMigrationStep[];
  startedAt: Date;
  finishedAt: Date | null;
}

/** Một dòng thư mục thành viên của không gian kho riêng (cặp tài khoản toàn cục + không gian). */
export interface SpaceMembershipDirectoryRow {
  id: string;
  globalUserId: string;
  spaceSlug: string;
  spaceUserId: string;
  /** active | suspended | ended — khớp trạng thái membership ở kho đích. */
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Một dòng thư mục mã tham gia lớp của không gian kho riêng (mã → slug). */
export interface SpaceJoinCodeDirectoryRow {
  id: string;
  joinCode: string;
  spaceSlug: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Dữ kiện ghi một dòng đăng ký mới (đã qua kiểm chứng ở tầng service/contract). */
export interface NewSpaceRegistration {
  id?: string;
  slug: string;
  name: string;
  kind: string;
  status?: string;
  databaseName: string;
  storageMode: string;
  connectionRoleRef: string;
  secretRef?: string | null;
  schemaVersion?: string | null;
  plan?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Dữ kiện ghi/đè một dòng registry phiên bản schema. */
export interface NewSpaceSchemaRegistry {
  spaceId: string;
  currentVersion?: string | null;
  lastBackupStatus?: string | null;
  lastBackupAt?: Date | null;
  lastRestoreStatus?: string | null;
  lastRestoreAt?: Date | null;
  updatedAt?: Date;
}

/** Dữ kiện ghi một lượt chạy migration. */
export interface NewSchemaMigrationRun {
  id?: string;
  spaceId: string;
  runId: string;
  fromVersion?: string | null;
  toVersion?: string | null;
  status: string;
  steps?: SchemaMigrationStep[];
  startedAt?: Date;
  finishedAt?: Date | null;
}

/**
 * Lỗi ném ra khi repository bị gọi mà chưa có handle (control plane
 * chưa được cấu hình). Package không phụ thuộc tầng ứng dụng nên
 * lỗi mang mã ổn định `control_plane.not_configured` dạng thuần;
 * tầng ứng dụng cấp hàm dựng lỗi riêng qua tham số khởi tạo của
 * repository để giữ đúng hình dạng lỗi HTTP của nó (xem điểm lắp
 * ráp ở module control plane phía ứng dụng).
 */
export class ControlPlaneNotConfiguredError extends Error {
  /** Mã lỗi ổn định mà phía tiêu thụ dùng để nhận diện trạng thái chưa cấu hình. */
  readonly code = 'control_plane.not_configured';

  constructor() {
    super('Control plane database is not configured');
    this.name = 'ControlPlaneNotConfiguredError';
  }
}

/** Tên chỉ số duy nhất riêng phần trên `space_registry.database_name` (chỉ phủ hàng dedicated). */
export const DEDICATED_DATABASE_NAME_UNIQUE_INDEX = 'space_registry_database_name_dedicated_unique';

/**
 * Bọc một giá trị jsonb thành biểu thức tham số JSON tường minh.
 *
 * Vì sao cần (đo tại pilot): `pg` tự `JSON.stringify` các OBJECT
 * thường khi gắn tham số, nhưng một MẢNG ở cấp cao nhất bị driver
 * hiểu là mảng PostgreSQL và gửi theo cú pháp mảng — cột jsonb
 * nhận vào sẽ lỗi `invalid input syntax for type json`. Drizzle
 * tránh được vì nó tự serialize mọi giá trị jsonb thành chuỗi JSON
 * trước khi gắn tham số. Khuôn ở đây: serialize tường minh +
 * ép kiểu `::jsonb` cho MỌI giá trị jsonb khi ghi (object lẫn
 * mảng) để một khuôn duy nhất, không phụ thuộc nhánh xử lý riêng
 * của driver theo hình dạng giá trị.
 *
 * @param value - Giá trị nghiệp vụ sẽ nằm trong cột jsonb.
 * @returns Biểu thức Kysely mang chuỗi JSON đã serialize, giữ
 *   nguyên kiểu `T` ở tầng TypeScript.
 */
function jsonbValue<T>(value: T): RawBuilder<T> {
  return sql<T>`${JSON.stringify(value)}::jsonb`;
}

/**
 * Lỗi có phải va chạm ĐÚNG chỉ số duy nhất riêng phần của tên
 * database dedicated hay không.
 *
 * PostgreSQL báo lỗi vi phạm unique bằng mã 23505. Qua Kysely, lỗi
 * `pg` được ném TRỰC TIẾP (không bọc `cause` như Drizzle) nên mã và
 * tên ràng buộc đọc ngay trên object lỗi; vòng duyệt chuỗi `cause`
 * vẫn giữ để chịu được các lớp bọc lỗi phía trên (service/tầng ứng
 * dụng) nếu có. Mã 23505 một mình chưa đủ: chỉ khi tên ràng buộc là
 * chỉ số dedicated mới là va chạm này — các vi phạm unique khác
 * (ví dụ slug) không được nuốt thành "trùng tên database". Nhánh dự
 * phòng khớp tên chỉ số qua nội dung `message` giữ nguyên từ đường
 * Drizzle: object lỗi của một số đường ném (ví dụ lỗi được dựng lại
 * từ thông điệp) không mang trường `constraint`.
 *
 * @param err - Lỗi bắt được từ thao tác ghi đăng ký.
 * @returns true khi lỗi là va chạm của chỉ số dedicated.
 */
export function isDedicatedDatabaseNameConflict(err: unknown): boolean {
  let e: unknown = err;
  while (e !== null && typeof e === 'object') {
    const candidate = e as { code?: unknown; constraint?: unknown; message?: unknown };
    if (candidate.code === '23505'
      && (candidate.constraint === DEDICATED_DATABASE_NAME_UNIQUE_INDEX
        || (typeof candidate.message === 'string' && candidate.message.includes(DEDICATED_DATABASE_NAME_UNIQUE_INDEX)))) {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** Danh sách cột tường minh có bí danh camelCase cho bảng sổ đăng ký (dùng cho cả select lẫn returning). */
const SPACE_REGISTRY_COLUMNS = [
  'id',
  'slug',
  'name',
  'kind',
  'status',
  'database_name as databaseName',
  'storage_mode as storageMode',
  'connection_role_ref as connectionRoleRef',
  'secret_ref as secretRef',
  'schema_version as schemaVersion',
  'plan',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng lịch sử sổ đăng ký. */
const SPACE_REGISTRY_HISTORY_COLUMNS = [
  'id',
  'space_id as spaceId',
  'actor_id as actorId',
  'action',
  'before',
  'after',
  'created_at as createdAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng registry phiên bản schema. */
const SPACE_SCHEMA_REGISTRY_COLUMNS = [
  'space_id as spaceId',
  'current_version as currentVersion',
  'last_backup_status as lastBackupStatus',
  'last_backup_at as lastBackupAt',
  'last_restore_status as lastRestoreStatus',
  'last_restore_at as lastRestoreAt',
  'updated_at as updatedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng nhật ký migration. */
const SPACE_SCHEMA_MIGRATION_RUN_COLUMNS = [
  'id',
  'space_id as spaceId',
  'run_id as runId',
  'from_version as fromVersion',
  'to_version as toVersion',
  'status',
  'steps',
  'started_at as startedAt',
  'finished_at as finishedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng thư mục thành viên. */
const SPACE_MEMBERSHIP_DIRECTORY_COLUMNS = [
  'id',
  'global_user_id as globalUserId',
  'space_slug as spaceSlug',
  'space_user_id as spaceUserId',
  'status',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng thư mục mã tham gia. */
const SPACE_JOIN_CODE_DIRECTORY_COLUMNS = [
  'id',
  'join_code as joinCode',
  'space_slug as spaceSlug',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/**
 * Ánh xạ dữ kiện ghi dòng đăng ký (camelCase) sang values insert
 * (snake_case), LOẠI mọi trường mang `undefined`: trường vắng mặt
 * phải để default của database quyết định, không được biên dịch
 * thành tham số `null` (quy tắc T-4 trong playbook của package).
 */
function spaceRegistryInsertValues(values: NewSpaceRegistration): Insertable<ControlPlaneDB['space_registry']> {
  const row: Insertable<ControlPlaneDB['space_registry']> = {
    slug: values.slug,
    name: values.name,
    kind: values.kind,
    database_name: values.databaseName,
    storage_mode: values.storageMode,
    connection_role_ref: values.connectionRoleRef,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.status !== undefined) row.status = values.status;
  if (values.secretRef !== undefined) row.secret_ref = values.secretRef;
  if (values.schemaVersion !== undefined) row.schema_version = values.schemaVersion;
  if (values.plan !== undefined) row.plan = values.plan;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  if (values.updatedAt !== undefined) row.updated_at = values.updatedAt;
  return row;
}

/**
 * Ánh xạ một patch cập nhật dòng đăng ký (camelCase) sang set
 * update (snake_case), LOẠI mọi trường `undefined` — patch chỉ chứa
 * trường nào thì chỉ trường đó đổi, đúng ngữ nghĩa bỏ qua
 * `undefined` của đường Drizzle trước đây (quy tắc T-4).
 */
function spaceRegistryUpdateSet(patch: Partial<NewSpaceRegistration>): Updateable<ControlPlaneDB['space_registry']> {
  const set: Updateable<ControlPlaneDB['space_registry']> = {};
  if (patch.id !== undefined) set.id = patch.id;
  if (patch.slug !== undefined) set.slug = patch.slug;
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.databaseName !== undefined) set.database_name = patch.databaseName;
  if (patch.storageMode !== undefined) set.storage_mode = patch.storageMode;
  if (patch.connectionRoleRef !== undefined) set.connection_role_ref = patch.connectionRoleRef;
  if (patch.secretRef !== undefined) set.secret_ref = patch.secretRef;
  if (patch.schemaVersion !== undefined) set.schema_version = patch.schemaVersion;
  if (patch.plan !== undefined) set.plan = patch.plan;
  if (patch.createdAt !== undefined) set.created_at = patch.createdAt;
  return set;
}

/**
 * Repository của control plane trên Kysely: mọi truy cập tới sáu
 * bảng của database control plane tập trung ở đây.
 *
 * Handle gốc được truyền lúc khởi tạo (instance do factory của
 * package dựng trên pool của tầng ứng dụng); `null` khi control
 * plane chưa được cấu hình — mọi thao tác khi đó ném lỗi do hàm
 * dựng lỗi quyết định (mặc định {@link ControlPlaneNotConfiguredError}),
 * riêng `isConfigured()` trả lời `false` để các đường đọc thư mục
 * tự bỏ qua thay vì ném lỗi vào luồng nghiệp vụ.
 */
export class ControlPlaneRepository {
  constructor(
    private readonly handle: ControlPlaneDb | null,
    private readonly notConfiguredError: () => Error = () => new ControlPlaneNotConfiguredError(),
  ) {}

  /** Instance gốc; ném lỗi rõ ràng khi control plane chưa được cấu hình. */
  private db(): ControlPlaneDb {
    if (!this.handle) {
      throw this.notConfiguredError();
    }
    return this.handle;
  }

  /** Mở một transaction trên database control plane. */
  async transaction<T>(fn: (tx: CpTx) => Promise<T>): Promise<T> {
    return this.db().transaction().execute(fn);
  }

  /**
   * Thêm dòng đăng ký nếu slug chưa có; trả về dòng vừa thêm, hoặc
   * undefined khi slug đã tồn tại. Cả hai đường ghi dùng nhánh này:
   * đường gieo dữ kiện (chạy lại không tạo trùng, không ghi đè dữ
   * kiện đã có) và đường tạo qua API — insert-bỏ-qua-khi-trùng ngay
   * trong transaction khiến hai lượt tạo đồng thời cùng slug chỉ
   * một lượt thành công, lượt còn lại được báo xung đột thay vì vấp
   * ràng buộc unique thành lỗi máy chủ.
   */
  async insertSpaceIfAbsent(values: NewSpaceRegistration, db: CpDb = this.db()): Promise<SpaceRegistryRow | undefined> {
    const rows = await db
      .insertInto('space_registry')
      .values(spaceRegistryInsertValues(values))
      .onConflict((oc) => oc.column('slug').doNothing())
      .returning(SPACE_REGISTRY_COLUMNS)
      .execute();
    return rows[0];
  }

  /** Cập nhật một dòng đăng ký theo id và trả về dòng sau cập nhật. */
  async updateSpace(id: string, patch: Partial<NewSpaceRegistration>, db: CpDb = this.db()): Promise<SpaceRegistryRow> {
    const rows = await db
      .updateTable('space_registry')
      .set({ ...spaceRegistryUpdateSet(patch), updated_at: new Date() })
      .where('id', '=', id)
      .returning(SPACE_REGISTRY_COLUMNS)
      .execute();
    return rows[0]!;
  }

  async findSpaceById(id: string, db: CpDb = this.db()): Promise<SpaceRegistryRow | undefined> {
    return db.selectFrom('space_registry').select(SPACE_REGISTRY_COLUMNS).where('id', '=', id).limit(1).executeTakeFirst();
  }

  /**
   * Đọc một dòng đăng ký KÈM KHOÁ DÒNG (`FOR UPDATE`) — chỉ dùng
   * bên trong transaction: thao tác ghi nào đọc dòng này để hợp nhất
   * / chụp ảnh `before` đều phải đọc qua đây, để hai thao tác ghi
   * đồng thời trên cùng một dòng nối tiếp nhau thay vì cùng đọc một
   * ảnh cũ rồi ghi đè lẫn nhau (mất dữ kiện, chuỗi lịch sử đứt).
   */
  async findSpaceByIdForUpdate(id: string, db: CpDb): Promise<SpaceRegistryRow | undefined> {
    return db
      .selectFrom('space_registry')
      .select(SPACE_REGISTRY_COLUMNS)
      .where('id', '=', id)
      .limit(1)
      .forUpdate()
      .executeTakeFirst();
  }

  /** Tra cứu định tuyến theo slug — đường đọc chính của tầng ứng dụng. */
  async findSpaceBySlug(slug: string, db: CpDb = this.db()): Promise<SpaceRegistryRow | undefined> {
    return db.selectFrom('space_registry').select(SPACE_REGISTRY_COLUMNS).where('slug', '=', slug).limit(1).executeTakeFirst();
  }

  /**
   * Tra cứu dòng đăng ký theo tên database đích — đường kiểm tra trùng
   * của cấp phát: một tên database không được hai dòng đăng ký cùng
   * dùng. Lưu ý: tra cứu này phủ CẢ hàng shared (kho chung vốn được
   * nhiều dòng cùng trỏ) vì tầng ứng dụng từ chối mọi databaseName
   * đã có khi cấp phát kho dedicated — một kho dedicated mang tên
   * trùng kho chung sẽ khiến trung tâm đó trỏ thẳng vào kho chung.
   * Chỉ số duy nhất riêng phần trên database chỉ là chốt chặn cho
   * cuộc đua dedicated-vs-dedicated; kiểm tra ở đây là lớp chính.
   */
  async findSpaceByDatabaseName(databaseName: string, db: CpDb = this.db()): Promise<SpaceRegistryRow | undefined> {
    return db
      .selectFrom('space_registry')
      .select(SPACE_REGISTRY_COLUMNS)
      .where('database_name', '=', databaseName)
      .limit(1)
      .executeTakeFirst();
  }

  /**
   * Tra cứu dòng đăng ký KHÁC theo tên database đích — đường kiểm tra
   * trùng của cập nhật: khi kiểm tra một dòng đang cập nhật, dòng đó
   * PHẢI bị loại trừ NGAY TRONG TRUY VẤN (`id <> ...`). Tra cứu
   * `LIMIT 1` không loại trừ có thể trả về chính dòng đang sửa — hai
   * dòng cùng tên là tiền đề thật vì các không gian kho chung cùng
   * trỏ vào một database — khiến điều kiện so sánh ở phía gọi bỏ qua
   * va chạm với dòng còn lại, mà chỉ số duy nhất riêng phần không
   * cứu được vì dòng còn lại vẫn là `shared`. Lọc bằng code sau
   * `LIMIT 1` không sửa được lỗi này vì dòng còn lại có thể đã bị
   * truy vấn bỏ qua.
   */
  async findOtherSpaceByDatabaseName(
    databaseName: string,
    excludeId: string,
    db: CpDb = this.db(),
  ): Promise<SpaceRegistryRow | undefined> {
    return db
      .selectFrom('space_registry')
      .select(SPACE_REGISTRY_COLUMNS)
      .where('database_name', '=', databaseName)
      .where('id', '<>', excludeId)
      .limit(1)
      .executeTakeFirst();
  }

  /**
   * Toàn bộ sổ đăng ký theo thứ tự slug: đầu vào của các công cụ
   * vận hành đội kho — runner migration đọc danh sách kho + phiên
   * bản hiện tại từ đây, tác vụ sao lưu và kiểm thử khôi phục cũng
   * duyệt cùng danh sách này. Thứ tự slug cố định để mọi lượt chạy
   * duyệt các kho theo cùng một thứ tự xác định.
   */
  async listSpaces(db: CpDb = this.db()): Promise<SpaceRegistryRow[]> {
    return db.selectFrom('space_registry').select(SPACE_REGISTRY_COLUMNS).orderBy('slug', 'asc').execute();
  }

  /** Ghi một dòng lịch sử quản trị (gọi trong cùng transaction với thay đổi trên sổ). */
  async insertHistory(
    values: { spaceId: string; actorId: string; action: string; before: SpaceRegistrySnapshot | null; after: SpaceRegistrySnapshot },
    db: CpDb = this.db(),
  ): Promise<SpaceRegistryHistoryRow> {
    const rows = await db
      .insertInto('space_registry_history')
      .values({
        space_id: values.spaceId,
        actor_id: values.actorId,
        action: values.action,
        before: values.before === null ? null : jsonbValue(values.before),
        after: jsonbValue(values.after),
      })
      .returning(SPACE_REGISTRY_HISTORY_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Lịch sử quản trị của một không gian, mới nhất trước. */
  async listHistory(spaceId: string, db: CpDb = this.db()): Promise<SpaceRegistryHistoryRow[]> {
    return db
      .selectFrom('space_registry_history')
      .select(SPACE_REGISTRY_HISTORY_COLUMNS)
      .where('space_id', '=', spaceId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
  }

  /** Trạng thái schema của một kho; undefined khi chưa có dòng registry cho kho đó. */
  async findSchemaRegistry(spaceId: string, db: CpDb = this.db()): Promise<SpaceSchemaRegistryRow | undefined> {
    return db
      .selectFrom('space_schema_registry')
      .select(SPACE_SCHEMA_REGISTRY_COLUMNS)
      .where('space_id', '=', spaceId)
      .limit(1)
      .executeTakeFirst();
  }

  /** Ghi/đè trạng thái schema của một kho (một dòng duy nhất theo khoá chính spaceId). */
  async upsertSchemaRegistry(
    values: NewSpaceSchemaRegistry,
    db: CpDb = this.db(),
  ): Promise<SpaceSchemaRegistryRow> {
    const insert: Insertable<ControlPlaneDB['space_schema_registry']> = { space_id: values.spaceId };
    if (values.currentVersion !== undefined) insert.current_version = values.currentVersion;
    if (values.lastBackupStatus !== undefined) insert.last_backup_status = values.lastBackupStatus;
    if (values.lastBackupAt !== undefined) insert.last_backup_at = values.lastBackupAt;
    if (values.lastRestoreStatus !== undefined) insert.last_restore_status = values.lastRestoreStatus;
    if (values.lastRestoreAt !== undefined) insert.last_restore_at = values.lastRestoreAt;
    if (values.updatedAt !== undefined) insert.updated_at = values.updatedAt;
    // Set của nhánh cập nhật khi trùng khoá: dựng từ chính các
    // trường có mặt trong values (loại `undefined` như mọi đường
    // ghi khác), luôn kèm mốc cập nhật hiện tại — cùng hình dạng
    // set tường minh của đường Drizzle trước đây.
    const updateSet: Updateable<ControlPlaneDB['space_schema_registry']> = { updated_at: new Date() };
    if (values.currentVersion !== undefined) updateSet.current_version = values.currentVersion;
    if (values.lastBackupStatus !== undefined) updateSet.last_backup_status = values.lastBackupStatus;
    if (values.lastBackupAt !== undefined) updateSet.last_backup_at = values.lastBackupAt;
    if (values.lastRestoreStatus !== undefined) updateSet.last_restore_status = values.lastRestoreStatus;
    if (values.lastRestoreAt !== undefined) updateSet.last_restore_at = values.lastRestoreAt;
    const rows = await db
      .insertInto('space_schema_registry')
      .values(insert)
      .onConflict((oc) => oc.column('space_id').doUpdateSet(updateSet))
      .returning(SPACE_SCHEMA_REGISTRY_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Đảm bảo có dòng registry phiên bản schema cho kho (đường gieo dữ kiện; đã có thì giữ nguyên). */
  async ensureSchemaRegistry(spaceId: string, currentVersion: string, db: CpDb = this.db()): Promise<void> {
    await db
      .insertInto('space_schema_registry')
      .values({ space_id: spaceId, current_version: currentVersion })
      .onConflict((oc) => oc.column('space_id').doNothing())
      .execute();
  }

  /** Thêm một lượt chạy migration vào nhật ký (chỉ thêm, không sửa dòng cũ). */
  async insertMigrationRun(values: NewSchemaMigrationRun, db: CpDb = this.db()): Promise<SpaceSchemaMigrationRunRow> {
    const insert: InsertObject<ControlPlaneDB, 'space_schema_migration_runs'> = {
      space_id: values.spaceId,
      run_id: values.runId,
      status: values.status,
    };
    if (values.id !== undefined) insert.id = values.id;
    if (values.fromVersion !== undefined) insert.from_version = values.fromVersion;
    if (values.toVersion !== undefined) insert.to_version = values.toVersion;
    if (values.steps !== undefined) insert.steps = jsonbValue(values.steps);
    if (values.startedAt !== undefined) insert.started_at = values.startedAt;
    if (values.finishedAt !== undefined) insert.finished_at = values.finishedAt;
    const rows = await db
      .insertInto('space_schema_migration_runs')
      .values(insert)
      .returning(SPACE_SCHEMA_MIGRATION_RUN_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Các lượt chạy migration của một kho, cũ nhất trước (đúng thứ tự thời gian của nhật ký). */
  async listMigrationRuns(spaceId: string, db: CpDb = this.db()): Promise<SpaceSchemaMigrationRunRow[]> {
    return db
      .selectFrom('space_schema_migration_runs')
      .select(SPACE_SCHEMA_MIGRATION_RUN_COLUMNS)
      .where('space_id', '=', spaceId)
      .orderBy('started_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
  }

  // --- thư mục định tuyến của không gian kho riêng (issue #587, hạng mục 3) ---

  /**
   * Control plane đã cấu hình hay chưa — các đường đọc thư mục
   * dùng để tự bỏ qua khi hệ chưa có control plane (thế giới
   * trước định tuyến theo kho: mọi không gian ở kho chung, thư
   * mục rỗng theo định nghĩa), thay vì ném `control_plane.not_configured`
   * vào các luồng nghiệp vụ vốn không cần control plane.
   */
  isConfigured(): boolean {
    return this.handle !== null;
  }

  /**
   * Ghi/đè một mục thư mục thành viên cho cặp (tài khoản toàn
   * cục, không gian): khoá duy nhất của cặp khiến mọi điểm ghi
   * (thêm thành viên, tạo người dùng trong kho riêng, cấp phát,
   * lấp thư mục) đều hội tụ về đúng một dòng — chạy lại không
   * nhân đôi. `spaceUserId` và `status` luôn lấy theo giá trị
   * mới nhất bên gọi cung cấp (trạng thái ở kho đích tại thời
   * điểm đồng bộ).
   */
  async upsertMembershipDirectory(
    values: { globalUserId: string; spaceSlug: string; spaceUserId: string; status: string },
    db: CpDb = this.db(),
  ): Promise<SpaceMembershipDirectoryRow> {
    const rows = await db
      .insertInto('space_membership_directory')
      .values({
        global_user_id: values.globalUserId,
        space_slug: values.spaceSlug,
        space_user_id: values.spaceUserId,
        status: values.status,
      })
      .onConflict((oc) =>
        oc.columns(['global_user_id', 'space_slug']).doUpdateSet({
          space_user_id: values.spaceUserId,
          status: values.status,
          updated_at: new Date(),
        }),
      )
      .returning(SPACE_MEMBERSHIP_DIRECTORY_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /**
   * Đồng bộ trạng thái của một mục thư mục thành viên đã có
   * (điểm đổi trạng thái membership): chỉ cập nhật khi mục tồn
   * tại — trạng thái membership đổi ở nơi chưa từng có mục thư
   * mục không tự sinh mục mới ở đây, vì mục mới phải mang cả
   * `spaceUserId` do điểm ghi có đủ dữ kiện quyết định. Trả về
   * số dòng đã cập nhật (0 = không có mục).
   */
  async updateMembershipDirectoryStatus(
    globalUserId: string,
    spaceSlug: string,
    status: string,
    db: CpDb = this.db(),
  ): Promise<number> {
    const updated = await db
      .updateTable('space_membership_directory')
      .set({ status, updated_at: new Date() })
      .where('global_user_id', '=', globalUserId)
      .where('space_slug', '=', spaceSlug)
      .returning(['id'])
      .execute();
    return updated.length;
  }

  /**
   * Mọi mục thư mục thành viên của một người: khớp theo định
   * danh toàn cục (tài khoản ở kho chung tra bộ chọn sau khi
   * trung tâm đã chuyển) HOẶC theo định danh tại kho đích
   * (phiên của chính kho riêng gọi bộ chọn — định danh người
   * gọi lúc đó là `spaceUserId`). Một mục khớp cả hai chiều vẫn
   * chỉ trả một dòng (điều kiện OR trên cùng một dòng).
   */
  async listMembershipDirectoryForUser(userId: string, db: CpDb = this.db()): Promise<SpaceMembershipDirectoryRow[]> {
    return db
      .selectFrom('space_membership_directory')
      .select(SPACE_MEMBERSHIP_DIRECTORY_COLUMNS)
      .where((eb) => eb.or([eb('global_user_id', '=', userId), eb('space_user_id', '=', userId)]))
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
  }

  /** Tra một mã tham gia trong thư mục: trả dòng thư mục hoặc undefined khi mã chưa đăng ký. */
  async findJoinCodeDirectory(joinCode: string, db: CpDb = this.db()): Promise<SpaceJoinCodeDirectoryRow | undefined> {
    return db
      .selectFrom('space_join_code_directory')
      .select(SPACE_JOIN_CODE_DIRECTORY_COLUMNS)
      .where('join_code', '=', joinCode)
      .limit(1)
      .executeTakeFirst();
  }

  /**
   * Đăng ký một mã tham gia cho một không gian, giữ tính duy
   * nhất toàn hệ của mã bằng chính ràng buộc duy nhất của bảng:
   * - `claimed`: mã chưa có — dòng vừa ghi thuộc về không gian này.
   * - `already`: mã đã đăng ký cho CHÍNH không gian này (ghi lại
   *   cùng trạng thái — idempotent).
   * - `conflict`: mã đã thuộc về một không gian khác — bên gọi
   *   phải từ chối thao tác đặt mã, tuyệt đối không ghi đè.
   */
  async claimJoinCodeDirectory(
    joinCode: string,
    spaceSlug: string,
    db: CpDb = this.db(),
  ): Promise<'claimed' | 'already' | 'conflict'> {
    const inserted = await db
      .insertInto('space_join_code_directory')
      .values({ join_code: joinCode, space_slug: spaceSlug })
      .onConflict((oc) => oc.column('join_code').doNothing())
      .returning(SPACE_JOIN_CODE_DIRECTORY_COLUMNS)
      .execute();
    if (inserted[0]) return 'claimed';
    const existing = await this.findJoinCodeDirectory(joinCode, db);
    return existing && existing.spaceSlug === spaceSlug ? 'already' : 'conflict';
  }

  /** Gỡ một mã khỏi thư mục (mã bị đổi hoặc lớp bị xoá); mã không có trong thư mục thì không làm gì. */
  async deleteJoinCodeDirectory(joinCode: string, db: CpDb = this.db()): Promise<void> {
    await db.deleteFrom('space_join_code_directory').where('join_code', '=', joinCode).execute();
  }

  /** Mọi mã đã đăng ký cho một không gian (công cụ lấp thư mục đối chiếu sau khi chạy). */
  async listJoinCodeDirectoryForSpace(spaceSlug: string, db: CpDb = this.db()): Promise<SpaceJoinCodeDirectoryRow[]> {
    return db
      .selectFrom('space_join_code_directory')
      .select(SPACE_JOIN_CODE_DIRECTORY_COLUMNS)
      .where('space_slug', '=', spaceSlug)
      .orderBy('join_code', 'asc')
      .execute();
  }
}

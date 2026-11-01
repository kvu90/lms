/**
 * Repository của cụm LỊCH trên Kysely — hạng mục nhân rộng G7 của
 * chiến dịch chuyển tầng dữ liệu (issue #647), chuyển từ repository
 * Drizzle cũ ở `apps/api/src/modules/calendar/calendar.repository.ts`.
 *
 * Vai trò: mọi truy cập tới ba bảng của kho trung tâm thuộc module
 * lịch — `calendar_events` (sự kiện, kèm chuỗi lặp và exception),
 * `calendar_subscriptions` (đăng ký lịch ngoài) và
 * `calendar_export_tokens` (token xuất lịch công khai, chỉ lưu
 * hash) — tập trung ở đây. Repository không chứa luật nghiệp vụ:
 * gác quyền, mở rộng chuỗi lặp và ghi outbox nằm ở tầng service
 * phía ứng dụng; repository chỉ nhận handle (instance gốc hoặc
 * transaction đang mở) để phía gọi ghép nhiều thao tác vào một
 * transaction khi cần.
 *
 * Khuôn hình dạng dữ liệu ở biên repository — cùng khuôn pilot kho
 * control plane (xem mục "Sổ tay chuyển đổi repository sang Kysely"
 * trong `AGENTS.md` của package):
 * - Bên trong, truy vấn viết trên interface schema sinh bằng
 *   codegen: tên bảng/cột giữ nguyên snake_case của database.
 * - Bên ngoài, repository trả/nhận các hình dạng dòng camelCase như
 *   phía tiêu thụ đang dùng: cột được chọn bằng danh sách tường
 *   minh có bí danh, giá trị ghi được ánh xạ từng trường
 *   camelCase → snake_case ở các hàm ánh xạ trong file này. Kiểu
 *   dòng công khai khai ngay trong file này, không import từ file
 *   schema Drizzle (file schema bị xoá ở hạng mục gỡ Drizzle).
 * - Giá trị `undefined` bị LOẠI khỏi values/set trước khi gọi
 *   builder (thử nghiệm T-4 đã đo ở pilot: `undefined` lọt vào
 *   mệnh đề WHERE biên dịch thành placeholder gắn NULL và lặng lẽ
 *   trả 0 dòng — vì vậy mọi giá trị where ở đây đều là tham số bắt
 *   buộc). Giá trị `null` tường minh (ví dụ `last_access` khi thay
 *   token xuất lịch) KHÔNG bị loại: nó là dữ kiện ghi thật.
 * - Repository không import từ `apps/*`, không đọc ALS/ngữ cảnh
 *   ứng dụng, không tự mở pool, không đọc biến môi trường: handle
 *   do tầng ứng dụng dựng bằng factory của package rồi truyền vào.
 */
import type { Insertable, Updateable } from 'kysely';
import type { CentreDb, CentreTx, CentreDB } from '../client';

/** Handle đọc/ghi mà repository nhận: transaction đang mở hoặc chính instance gốc. */
type RepoDb = CentreDb | CentreTx;

/** Một dòng sự kiện lịch (hình dạng camelCase phía tiêu thụ dùng). */
export interface CalendarEventRow {
  id: string;
  name: string;
  description: string;
  /** Loại sự kiện (site/course/group/user/category...). */
  eventType: string;
  courseId: string | null;
  groupId: string | null;
  categoryId: string | null;
  userId: string | null;
  contextId: string | null;
  /** Sự kiện nhập từ subscription nào; null khi tạo trực tiếp. */
  subscriptionId: string | null;
  /** UUID của sự kiện trong nguồn lịch ngoài (khớp đồng bộ theo subscription). */
  uuid: string | null;
  /** Id của sự kiện gốc của chuỗi lặp; null khi không thuộc chuỗi. */
  repeatId: string | null;
  /** Quy tắc lặp (RRULE) của sự kiện gốc chuỗi; null ở các bản lặp con. */
  rrule: string | null;
  /** true khi dòng này là exception của một bản lặp trong chuỗi. */
  isException: boolean;
  /** Id của bản lặp mà exception này thay thế. */
  exceptionOf: string | null;
  timeStart: Date;
  timeDuration: number;
  visible: boolean;
  location: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Dữ kiện ghi một sự kiện mới (đã qua kiểm chứng ở tầng service). */
export interface NewCalendarEvent {
  id?: string;
  name: string;
  description?: string;
  eventType?: string;
  courseId?: string | null;
  groupId?: string | null;
  categoryId?: string | null;
  userId?: string | null;
  contextId?: string | null;
  subscriptionId?: string | null;
  uuid?: string | null;
  repeatId?: string | null;
  rrule?: string | null;
  isException?: boolean;
  exceptionOf?: string | null;
  timeStart: Date;
  timeDuration?: number;
  visible?: boolean;
  location?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Một dòng đăng ký lịch ngoài (subscription) của một user. */
export interface CalendarSubscriptionRow {
  id: string;
  name: string;
  /** URL nguồn ICS; null khi nội dung được nạp thẳng qua `icsData`. */
  url: string | null;
  icsData: string | null;
  eventType: string;
  courseId: string | null;
  categoryId: string | null;
  userId: string | null;
  pollInterval: number;
  /** Mốc đồng bộ gần nhất; null khi chưa đồng bộ lần nào. */
  lastUpdated: Date | null;
  createdAt: Date;
}

/** Dữ kiện ghi một đăng ký lịch ngoài mới. */
export interface NewCalendarSubscription {
  id?: string;
  name: string;
  url?: string | null;
  icsData?: string | null;
  eventType?: string;
  courseId?: string | null;
  categoryId?: string | null;
  userId?: string | null;
  pollInterval?: number;
  lastUpdated?: Date | null;
  createdAt?: Date;
}

/** Một dòng token xuất lịch công khai — chỉ chứa hash của token thô, mỗi user tối đa một dòng. */
export interface CalendarExportTokenRow {
  id: string;
  userId: string;
  tokenHash: string;
  /** Lần dùng URL xuất công khai gần nhất; null khi chưa dùng hoặc vừa thay token. */
  lastAccess: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Danh sách cột tường minh có bí danh camelCase cho bảng sự kiện (dùng cho cả select lẫn returning). */
const CALENDAR_EVENT_COLUMNS = [
  'id',
  'name',
  'description',
  'event_type as eventType',
  'course_id as courseId',
  'group_id as groupId',
  'category_id as categoryId',
  'user_id as userId',
  'context_id as contextId',
  'subscription_id as subscriptionId',
  'uuid',
  'repeat_id as repeatId',
  'rrule',
  'is_exception as isException',
  'exception_of as exceptionOf',
  'time_start as timeStart',
  'time_duration as timeDuration',
  'visible',
  'location',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng đăng ký lịch ngoài. */
const CALENDAR_SUBSCRIPTION_COLUMNS = [
  'id',
  'name',
  'url',
  'ics_data as icsData',
  'event_type as eventType',
  'course_id as courseId',
  'category_id as categoryId',
  'user_id as userId',
  'poll_interval as pollInterval',
  'last_updated as lastUpdated',
  'created_at as createdAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng token xuất lịch. */
const CALENDAR_EXPORT_TOKEN_COLUMNS = [
  'id',
  'user_id as userId',
  'token_hash as tokenHash',
  'last_access as lastAccess',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/**
 * Ánh xạ dữ kiện ghi sự kiện (camelCase) sang values insert
 * (snake_case), LOẠI mọi trường mang `undefined`: trường vắng mặt
 * phải để default của database quyết định, không được biên dịch
 * thành tham số `null` (quy tắc T-4 trong sổ tay của package).
 */
function calendarEventInsertValues(values: NewCalendarEvent): Insertable<CentreDB['calendar_events']> {
  const row: Insertable<CentreDB['calendar_events']> = {
    name: values.name,
    time_start: values.timeStart,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.description !== undefined) row.description = values.description;
  if (values.eventType !== undefined) row.event_type = values.eventType;
  if (values.courseId !== undefined) row.course_id = values.courseId;
  if (values.groupId !== undefined) row.group_id = values.groupId;
  if (values.categoryId !== undefined) row.category_id = values.categoryId;
  if (values.userId !== undefined) row.user_id = values.userId;
  if (values.contextId !== undefined) row.context_id = values.contextId;
  if (values.subscriptionId !== undefined) row.subscription_id = values.subscriptionId;
  if (values.uuid !== undefined) row.uuid = values.uuid;
  if (values.repeatId !== undefined) row.repeat_id = values.repeatId;
  if (values.rrule !== undefined) row.rrule = values.rrule;
  if (values.isException !== undefined) row.is_exception = values.isException;
  if (values.exceptionOf !== undefined) row.exception_of = values.exceptionOf;
  if (values.timeDuration !== undefined) row.time_duration = values.timeDuration;
  if (values.visible !== undefined) row.visible = values.visible;
  if (values.location !== undefined) row.location = values.location;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  if (values.updatedAt !== undefined) row.updated_at = values.updatedAt;
  return row;
}

/**
 * Ánh xạ một patch cập nhật sự kiện (camelCase) sang set update
 * (snake_case), LOẠI mọi trường `undefined` — patch chỉ chứa
 * trường nào thì chỉ trường đó đổi (quy tắc T-4).
 */
function calendarEventUpdateSet(patch: Partial<CalendarEventRow>): Updateable<CentreDB['calendar_events']> {
  const set: Updateable<CentreDB['calendar_events']> = {};
  if (patch.id !== undefined) set.id = patch.id;
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.eventType !== undefined) set.event_type = patch.eventType;
  if (patch.courseId !== undefined) set.course_id = patch.courseId;
  if (patch.groupId !== undefined) set.group_id = patch.groupId;
  if (patch.categoryId !== undefined) set.category_id = patch.categoryId;
  if (patch.userId !== undefined) set.user_id = patch.userId;
  if (patch.contextId !== undefined) set.context_id = patch.contextId;
  if (patch.subscriptionId !== undefined) set.subscription_id = patch.subscriptionId;
  if (patch.uuid !== undefined) set.uuid = patch.uuid;
  if (patch.repeatId !== undefined) set.repeat_id = patch.repeatId;
  if (patch.rrule !== undefined) set.rrule = patch.rrule;
  if (patch.isException !== undefined) set.is_exception = patch.isException;
  if (patch.exceptionOf !== undefined) set.exception_of = patch.exceptionOf;
  if (patch.timeStart !== undefined) set.time_start = patch.timeStart;
  if (patch.timeDuration !== undefined) set.time_duration = patch.timeDuration;
  if (patch.visible !== undefined) set.visible = patch.visible;
  if (patch.location !== undefined) set.location = patch.location;
  if (patch.createdAt !== undefined) set.created_at = patch.createdAt;
  return set;
}

/**
 * Ánh xạ dữ kiện ghi đăng ký lịch ngoài (camelCase) sang values
 * insert (snake_case), LOẠI mọi trường mang `undefined` (T-4).
 */
function calendarSubscriptionInsertValues(
  values: NewCalendarSubscription,
): Insertable<CentreDB['calendar_subscriptions']> {
  const row: Insertable<CentreDB['calendar_subscriptions']> = { name: values.name };
  if (values.id !== undefined) row.id = values.id;
  if (values.url !== undefined) row.url = values.url;
  if (values.icsData !== undefined) row.ics_data = values.icsData;
  if (values.eventType !== undefined) row.event_type = values.eventType;
  if (values.courseId !== undefined) row.course_id = values.courseId;
  if (values.categoryId !== undefined) row.category_id = values.categoryId;
  if (values.userId !== undefined) row.user_id = values.userId;
  if (values.pollInterval !== undefined) row.poll_interval = values.pollInterval;
  if (values.lastUpdated !== undefined) row.last_updated = values.lastUpdated;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  return row;
}

/**
 * Repository lịch trên Kysely: mọi truy cập tới ba bảng lịch của
 * kho trung tâm tập trung ở đây.
 *
 * Handle gốc được truyền lúc khởi tạo (facade định tuyến theo
 * không gian của tầng ứng dụng); mọi phương thức nhận thêm handle
 * tuỳ chọn làm tham số cuối — tầng service truyền handle giao dịch
 * khi thao tác phải nằm trong cùng transaction với thao tác khác
 * (ví dụ tạo chuỗi sự kiện + ghi outbox trong `CalendarService`).
 */
export class CalendarRepository {
  constructor(private readonly handle: CentreDb) {}

  /** Instance gốc của repository. */
  private db(): CentreDb {
    return this.handle;
  }

  /** Mở một transaction trên kho trung tâm qua handle của repository. */
  async transaction<T>(fn: (tx: CentreTx) => Promise<T>): Promise<T> {
    return this.db().transaction().execute(fn);
  }

  /** Chèn sự kiện. */
  async insertEvent(values: NewCalendarEvent, db: RepoDb = this.db()): Promise<CalendarEventRow> {
    const rows = await db
      .insertInto('calendar_events')
      .values(calendarEventInsertValues(values))
      .returning(CALENDAR_EVENT_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Lấy sự kiện theo id. */
  async getEvent(id: string, db: RepoDb = this.db()): Promise<CalendarEventRow | undefined> {
    return db
      .selectFrom('calendar_events')
      .select(CALENDAR_EVENT_COLUMNS)
      .where('id', '=', id)
      .limit(1)
      .executeTakeFirst();
  }

  /** Cập nhật sự kiện; mốc `updated_at` luôn được làm mới ở đây như đường Drizzle trước đây. */
  async updateEvent(id: string, patch: Partial<CalendarEventRow>, db: RepoDb = this.db()): Promise<void> {
    await db
      .updateTable('calendar_events')
      .set({ ...calendarEventUpdateSet(patch), updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** Xoá sự kiện. */
  async deleteEvent(id: string, db: RepoDb = this.db()): Promise<void> {
    await db.deleteFrom('calendar_events').where('id', '=', id).execute();
  }

  /** Mọi sự kiện (cho quản trị), theo mốc bắt đầu tăng dần. */
  async listAllEvents(db: RepoDb = this.db()): Promise<CalendarEventRow[]> {
    return db.selectFrom('calendar_events').select(CALENDAR_EVENT_COLUMNS).orderBy('time_start', 'asc').execute();
  }

  /** Sự kiện có mốc trong khoảng thời gian (trước khi mở rộng chuỗi lặp). */
  async listEventsInRange(from: Date, to: Date, db: RepoDb = this.db()): Promise<CalendarEventRow[]> {
    return db
      .selectFrom('calendar_events')
      .select(CALENDAR_EVENT_COLUMNS)
      .where('time_start', '>=', from)
      .where('time_start', '<=', to)
      .orderBy('time_start', 'asc')
      .execute();
  }

  /** Các sự kiện thuộc cùng một chuỗi lặp. */
  async listSeries(repeatId: string, db: RepoDb = this.db()): Promise<CalendarEventRow[]> {
    return db
      .selectFrom('calendar_events')
      .select(CALENDAR_EVENT_COLUMNS)
      .where('repeat_id', '=', repeatId)
      .orderBy('time_start', 'asc')
      .execute();
  }

  /** Tìm sự kiện đã nhập theo uuid của subscription (để đồng bộ không trùng). */
  async findBySubscriptionUuid(
    subscriptionId: string,
    uuid: string,
    db: RepoDb = this.db(),
  ): Promise<CalendarEventRow | undefined> {
    return db
      .selectFrom('calendar_events')
      .select(CALENDAR_EVENT_COLUMNS)
      .where('subscription_id', '=', subscriptionId)
      .where('uuid', '=', uuid)
      .limit(1)
      .executeTakeFirst();
  }

  /** Chèn đăng ký lịch ngoài. */
  async insertSubscription(
    values: NewCalendarSubscription,
    db: RepoDb = this.db(),
  ): Promise<CalendarSubscriptionRow> {
    const rows = await db
      .insertInto('calendar_subscriptions')
      .values(calendarSubscriptionInsertValues(values))
      .returning(CALENDAR_SUBSCRIPTION_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Lấy subscription theo id. */
  async getSubscription(id: string, db: RepoDb = this.db()): Promise<CalendarSubscriptionRow | undefined> {
    return db
      .selectFrom('calendar_subscriptions')
      .select(CALENDAR_SUBSCRIPTION_COLUMNS)
      .where('id', '=', id)
      .limit(1)
      .executeTakeFirst();
  }

  /** Mọi subscription, theo id tăng dần. */
  async listSubscriptions(db: RepoDb = this.db()): Promise<CalendarSubscriptionRow[]> {
    return db
      .selectFrom('calendar_subscriptions')
      .select(CALENDAR_SUBSCRIPTION_COLUMNS)
      .orderBy('id', 'asc')
      .execute();
  }

  /** Subscription thuộc về đúng một user (đường đọc qua HTTP). */
  async listSubscriptionsForUser(userId: string, db: RepoDb = this.db()): Promise<CalendarSubscriptionRow[]> {
    return db
      .selectFrom('calendar_subscriptions')
      .select(CALENDAR_SUBSCRIPTION_COLUMNS)
      .where('user_id', '=', userId)
      .orderBy('id', 'asc')
      .execute();
  }

  /** Token xuất lịch đang hiệu lực của một user (chỉ chứa hash), nếu có. */
  async getExportTokenByUser(userId: string, db: RepoDb = this.db()): Promise<CalendarExportTokenRow | undefined> {
    return db
      .selectFrom('calendar_export_tokens')
      .select(CALENDAR_EXPORT_TOKEN_COLUMNS)
      .where('user_id', '=', userId)
      .limit(1)
      .executeTakeFirst();
  }

  /**
   * Tìm token xuất lịch theo hash của token thô — đường tra cứu duy
   * nhất của URL xuất công khai; không bao giờ tra theo token thô.
   */
  async getExportTokenByHash(tokenHash: string, db: RepoDb = this.db()): Promise<CalendarExportTokenRow | undefined> {
    return db
      .selectFrom('calendar_export_tokens')
      .select(CALENDAR_EXPORT_TOKEN_COLUMNS)
      .where('token_hash', '=', tokenHash)
      .limit(1)
      .executeTakeFirst();
  }

  /**
   * Tạo mới hoặc thay thế token xuất lịch của user (một user một
   * token): ghi đè hash cũ khiến URL xuất cũ chết ngay khi đổi
   * token, và đặt lại `last_access` về null tường minh vì token
   * mới chưa từng được dùng.
   */
  async upsertExportToken(userId: string, tokenHash: string, db: RepoDb = this.db()): Promise<CalendarExportTokenRow> {
    const rows = await db
      .insertInto('calendar_export_tokens')
      .values({ user_id: userId, token_hash: tokenHash })
      .onConflict((oc) =>
        oc.column('user_id').doUpdateSet({ token_hash: tokenHash, updated_at: new Date(), last_access: null }),
      )
      .returning(CALENDAR_EXPORT_TOKEN_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /**
   * Thu hồi token xuất lịch của user: xoá hẳn bản ghi hash để URL
   * cũ chết; trả về true khi thật sự có token đã bị thu hồi.
   */
  async deleteExportToken(userId: string, db: RepoDb = this.db()): Promise<boolean> {
    const deleted = await db
      .deleteFrom('calendar_export_tokens')
      .where('user_id', '=', userId)
      .returning(CALENDAR_EXPORT_TOKEN_COLUMNS)
      .execute();
    return deleted.length > 0;
  }

  /** Ghi nhận lần dùng URL xuất công khai gần nhất. */
  async touchExportToken(id: string, db: RepoDb = this.db()): Promise<void> {
    await db
      .updateTable('calendar_export_tokens')
      .set({ last_access: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** Cập nhật mốc đồng bộ gần nhất của subscription. */
  async touchSubscription(id: string, db: RepoDb = this.db()): Promise<void> {
    await db
      .updateTable('calendar_subscriptions')
      .set({ last_updated: new Date() })
      .where('id', '=', id)
      .execute();
  }
}

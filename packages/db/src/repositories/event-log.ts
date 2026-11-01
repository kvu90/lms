/**
 * Repository của cụm EVENT LOG trên Kysely — chuyển đổi Drizzle →
 * Kysely thuộc nhóm G8 của chiến dịch chuyển tầng dữ liệu (issue
 * #648). Repository này chỉ phụ trách đường ĐỌC (truy vấn
 * logstore); đường ghi event_log/outbox ở tầng hạ tầng thuộc hạng
 * mục D1, không nằm ở đây.
 *
 * Ca T-13 của nhóm (khuôn ghép điều kiện động — ca bổ sung BS-1 đã
 * chốt ở phòng thí nghiệm): điều kiện lọc dựng bằng MỘT hàm xây
 * điều kiện dùng chung cho cả truy vấn dòng và truy vấn đếm, gom
 * vào mảng biểu thức rồi nối bằng `eb.and(...)`:
 * - Mảng rỗng (không bộ lọc nào) biên dịch thành `where 1 = 1`,
 *   tức không lọc — khớp hành vi `where(undefined)` của Drizzle.
 * - Cấm port nguyên văn `where(undefined)`: Kysely biên dịch thành
 *   `where $1` với tham số null, lặng lẽ trả 0 dòng/0 tổng.
 * - Các mảnh lọc theo payload dùng toán tử trích text jsonb
 *   `payload ->> 'key' = tham số` giữ nguyên văn trong template
 *   `sql` (Recipes "Raw SQL" của Kysely); giá trị trích ra là text
 *   nên phép so bằng với tham số chuỗi giữ nguyên ngữ nghĩa.
 *
 * Đếm tổng bằng `count(*)::int` trong biểu thức `sql` (cùng khuôn
 * đếm của repository search): ép int4 ngay ở SQL nên giá trị về là
 * số thật, khớp helper `count()` của Drizzle vốn map kết quả đếm
 * (int8) về number ở tầng driver.
 *
 * Hình dạng dòng: `seq` là cột int8 — qua Kysely nó đọc về là
 * CHUỖI (luật int8 của package: driver `pg` trả int8 dạng text);
 * tầng service chuyển lại thành số tại biên hiển thị/API khi cần.
 * Danh sách cột chọn tường minh có bí danh camelCase như khuôn
 * pilot; repository không import từ `apps/*`, không tự mở pool.
 */
import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';
import type { CentreDb, CentreTx, CentreDB } from '../client';

/** Handle đọc/ghi mà repository nhận: transaction đang mở hoặc chính instance gốc. */
export type EventLogDb = CentreDb | CentreTx;

/** Một dòng nhật ký sự kiện miền (seq là int8 đọc về dạng chuỗi — xem đầu file). */
export interface EventLogRow {
  id: string;
  seq: string;
  eventType: string;
  contextId: string | null;
  userId: string | null;
  tenantId: string | null;
  /** Payload sự kiện (jsonb). */
  payload: unknown | null;
  createdAt: Date;
}

/** Bộ lọc truy vấn logstore — mọi trường đều tuỳ chọn, vắng mặt nghĩa là không lọc theo trường đó. */
export interface EventLogFilters {
  userId?: string;
  relatedUserId?: string;
  courseId?: string;
  contextId?: string;
  component?: string;
  eventType?: string;
  from?: Date;
  to?: Date;
}

/** Danh sách cột tường minh có bí danh camelCase cho bảng event_log. */
const EVENT_LOG_COLUMNS = [
  'id',
  'seq',
  'event_type as eventType',
  'context_id as contextId',
  'user_id as userId',
  'tenant_id as tenantId',
  'payload',
  'created_at as createdAt',
] as const;

/**
 * Dựng mảng điều kiện của logstore từ bộ lọc: điều kiện theo cột
 * qua builder, điều kiện theo payload qua mảnh `sql` với toán tử
 * `->>` giữ nguyên văn. Mảng có thể rỗng — phía gọi nối bằng
 * `eb.and(...)` nên rỗng nghĩa là không lọc. Hàm này là điểm xây
 * điều kiện DUY NHẤT của repository: truy vấn dòng và truy vấn đếm
 * dùng chung nó để tập dòng và tổng luôn nhất quán.
 */
function eventLogConditions(
  eb: ExpressionBuilder<CentreDB, 'event_log'>,
  filters: EventLogFilters,
): Expression<SqlBool>[] {
  const conds: Expression<SqlBool>[] = [];
  if (filters.userId) conds.push(eb('user_id', '=', filters.userId));
  if (filters.contextId) conds.push(eb('context_id', '=', filters.contextId));
  if (filters.eventType) conds.push(eb('event_type', '=', filters.eventType));
  if (filters.relatedUserId) conds.push(sql<SqlBool>`payload ->> 'relatedUserId' = ${filters.relatedUserId}`);
  if (filters.courseId) conds.push(sql<SqlBool>`payload ->> 'courseId' = ${filters.courseId}`);
  if (filters.component) conds.push(sql<SqlBool>`payload ->> 'component' = ${filters.component}`);
  if (filters.from) conds.push(eb('created_at', '>=', filters.from));
  if (filters.to) conds.push(eb('created_at', '<=', filters.to));
  return conds;
}

/** Truy vấn bảng `event_log` (logstore): các bộ lọc theo cột dùng index sẵn có (user_id, context_id); bộ lọc theo người bị tác động/khoá/component đọc các trường đã chuẩn hoá trong payload do EventLogWriter ghi. */
export class EventLogRepository {
  constructor(private readonly handle: CentreDb) {}

  /** Tìm một trang nhật ký theo bộ lọc, kèm tổng số dòng khớp cùng bộ lọc đó. */
  async search(filters: EventLogFilters, page: number, pageSize: number, db: EventLogDb = this.handle): Promise<{ rows: EventLogRow[]; total: number }> {
    const rows = await db
      .selectFrom('event_log')
      .select(EVENT_LOG_COLUMNS)
      .where((eb) => eb.and(eventLogConditions(eb, filters)))
      .orderBy('seq', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute();
    const totalRow = await db
      .selectFrom('event_log')
      .select(sql<number>`count(*)::int`.as('total'))
      .where((eb) => eb.and(eventLogConditions(eb, filters)))
      .executeTakeFirst();
    return { rows, total: totalRow?.total ?? 0 };
  }
}

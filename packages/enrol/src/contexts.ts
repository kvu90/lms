import { and, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import { context } from '@lms/db';
import { uuidIdSchema } from '@lms/contracts';
import { SharedDomainError } from './errors';
import type { ContextRow, EnrolDatabase } from './types';

/**
 * Thao tác trên cây context phân quyền ở tầng dữ liệu dùng chung.
 *
 * Cây context (hệ thống → tenant → danh mục/lớp → khoá học → module
 * → block → user) là nền của mọi phép kiểm quyền: gán vai nằm trên
 * context và được kế thừa xuống dưới theo `path` vật chất hoá. Các
 * hàm ở đây là phần THUẦN DỮ LIỆU của quản lý context mà các lõi
 * dùng chung cần (tra context, đảm bảo context hệ thống/tenant, đánh
 * dấu dirty để vô hiệu hoá cache quyền) — trích từ tầng Access của
 * API để cả API lẫn worker cùng thao tác trên một định nghĩa duy
 * nhất. Phần quản trị context còn lại (tạo cây cho nghiệp vụ, di
 * chuyển cây, xoá context) vẫn thuộc bề mặt của API.
 *
 * Bất biến của cây: `path` là danh sách id tổ tiên vật chất hoá, luôn
 * kết thúc bằng id của chính context; mọi thay đổi về gán vai tại
 * một context đều phải bump `version` của context đó và mọi context
 * con cháu (đánh dấu dirty) để các cache đánh giá quyền không dùng
 * kết quả cũ.
 */

/**
 * Cấp của các loại context (giá trị lưu trong cột `context_level`
 * của bảng `context`, bám thang cấp context của Moodle). Giá trị là
 * dữ kiện đã lưu trong cơ sở dữ liệu nên mọi phía thao tác cây
 * context phải dùng đúng các số này.
 */
export const CONTEXT_LEVELS = { SYSTEM: 10, TENANT: 20, USER: 30, COURSECAT: 40, CLASS: 45, COURSE: 50, MODULE: 70, BLOCK: 80 } as const;

/**
 * Lấy context theo id; undefined nếu không tồn tại.
 *
 * @param db - tay cầm Drizzle của host.
 * @param id - id của context.
 */
export async function getContextById(db: EnrolDatabase, id: string): Promise<ContextRow | undefined> {
  const [row] = await db.select().from(context).where(eq(context.id, id));
  return row;
}

/**
 * Lấy context theo cặp (contextLevel, instanceId) — khoá tự nhiên
 * của cây context; undefined nếu chưa được tạo.
 *
 * @param db - tay cầm Drizzle của host.
 * @param contextLevel - cấp context (xem {@link CONTEXT_LEVELS}).
 * @param instanceId - id của đối tượng mà context đại diện; null cho context hệ thống.
 */
export async function getContextByLevelInstance(
  db: EnrolDatabase,
  contextLevel: number,
  instanceId: string | null,
): Promise<ContextRow | undefined> {
  const [row] = await db.select().from(context)
    .where(and(eq(context.contextLevel, contextLevel), instanceId === null ? isNull(context.instanceId) : eq(context.instanceId, instanceId)));
  return row;
}

/**
 * Lấy context theo id; ném lỗi `access.context_not_found` khi vắng.
 * Id không phải UUID thì chắc chắn không tồn tại context nào mang
 * nó (khoá chính là uuid) — trả lỗi không tìm thấy thay vì để cơ sở
 * dữ liệu ném lỗi cú pháp uuid: các guard của host chạy trước pipe
 * validate nên id thô trên URL tới được đây.
 *
 * @param db - tay cầm Drizzle của host.
 * @param id - id của context.
 * @throws SharedDomainError mã `access.context_not_found`.
 */
export async function getContextOrThrow(db: EnrolDatabase, id: string): Promise<ContextRow> {
  const row = uuidIdSchema.safeParse(id).success ? await getContextById(db, id) : undefined;
  if (!row) throw new SharedDomainError('access.context_not_found', `Context ${id} not found`);
  return row;
}

/**
 * Context của một khoá học (cấp 50); ném lỗi `course.context_missing`
 * khi khoá chưa có context — mọi khoá thật đều có context, thiếu là
 * dữ kiện hỏng chứ không phải trường hợp nghiệp vụ.
 *
 * @param db - tay cầm Drizzle của host.
 * @param courseId - id của khoá học.
 * @throws SharedDomainError mã `course.context_missing`.
 */
export async function getCourseContextId(db: EnrolDatabase, courseId: string): Promise<string> {
  const ctx = await getContextByLevelInstance(db, CONTEXT_LEVELS.COURSE, courseId);
  if (!ctx) throw new SharedDomainError('course.context_missing', `No context for course ${courseId}`);
  return ctx.id;
}

/**
 * Chèn context mới; path/depth được tính và cập nhật sau khi có id.
 *
 * @param db - tay cầm Drizzle của host.
 * @param values - dữ kiện chèn của dòng context.
 */
async function insertContext(db: EnrolDatabase, values: typeof context.$inferInsert): Promise<ContextRow> {
  const [row] = await db.insert(context).values(values).returning();
  return row!;
}

/**
 * Cập nhật path vật chất hoá và depth của context sau khi chèn.
 *
 * @param db - tay cầm Drizzle của host.
 * @param id - id của context.
 * @param path - path vật chất hoá mới.
 * @param depth - độ sâu mới trong cây.
 */
async function updateContextPath(db: EnrolDatabase, id: string, path: string, depth: number): Promise<void> {
  await db.update(context).set({ path, depth }).where(eq(context.id, id));
}

/**
 * Tạo context con dưới một context cha, tính path/depth; idempotent
 * theo khoá tự nhiên (level, instance).
 *
 * @param db - tay cầm Drizzle của host.
 * @param contextLevel - cấp context.
 * @param instanceId - id của đối tượng mà context đại diện.
 * @param parentId - id của context cha; bỏ trống thì cha là context hệ thống.
 * @throws SharedDomainError mã `access.parent_context_not_found` khi context cha không tồn tại.
 */
export async function createContext(
  db: EnrolDatabase,
  contextLevel: number,
  instanceId: string,
  parentId?: string,
): Promise<ContextRow> {
  const existing = await getContextByLevelInstance(db, contextLevel, instanceId);
  if (existing) return existing;
  const parent = contextLevel === CONTEXT_LEVELS.SYSTEM
    ? undefined
    : await getContextById(db, parentId ?? (await ensureSystemContext(db)).id);
  if (contextLevel !== CONTEXT_LEVELS.SYSTEM && !parent) {
    throw new SharedDomainError('access.parent_context_not_found', 'Parent context not found');
  }
  const row = await insertContext(db, { contextLevel, instanceId, path: '', depth: 0 });
  const path = parent ? `${parent.path}/${row.id}` : `/${row.id}`;
  const depth = parent ? parent.depth + 1 : 1;
  await updateContextPath(db, row.id, path, depth);
  return { ...row, path, depth };
}

/**
 * Đảm bảo context hệ thống (level 10, instance null) tồn tại; được
 * tạo lười và là gốc của mọi path. Idempotent.
 *
 * @param db - tay cầm Drizzle của host.
 */
export async function ensureSystemContext(db: EnrolDatabase): Promise<ContextRow> {
  const existing = await getContextByLevelInstance(db, CONTEXT_LEVELS.SYSTEM, null);
  if (existing) return existing;
  const row = await insertContext(db, { contextLevel: CONTEXT_LEVELS.SYSTEM, instanceId: null, path: '', depth: 0 });
  const path = `/${row.id}`;
  await updateContextPath(db, row.id, path, 1);
  return { ...row, path, depth: 1 };
}

/**
 * Đảm bảo context TENANT (level 20) của một tenant tồn tại — mỗi
 * tenant đúng MỘT context tenant, instance_id = tenants.id, cha là
 * context hệ thống. Mọi context thuộc tenant neo dưới context này
 * nên cây của tenant tách hẳn khỏi cây của tenant khác; phép đánh
 * giá quyền dùng nó làm neo cổng membership.
 *
 * @param db - tay cầm Drizzle của host.
 * @param tenantId - id của tenant.
 */
export async function ensureTenantContext(db: EnrolDatabase, tenantId: string): Promise<ContextRow> {
  const existing = await getContextByLevelInstance(db, CONTEXT_LEVELS.TENANT, tenantId);
  if (existing) return existing;
  const system = await ensureSystemContext(db);
  return createContext(db, CONTEXT_LEVELS.TENANT, tenantId, system.id);
}

/**
 * Tăng `version` cho một context và mọi context con cháu (theo tiền
 * tố path) — cơ chế đánh dấu dirty đứng sau việc vô hiệu hoá cache
 * của phép đánh giá quyền.
 *
 * @param db - tay cầm Drizzle của host.
 * @param pathPrefix - path của context gốc của cây con cần bump.
 */
export async function bumpContextVersions(db: EnrolDatabase, pathPrefix: string): Promise<void> {
  await db.update(context).set({ version: sql`${context.version} + 1` })
    .where(or(eq(context.path, pathPrefix), like(context.path, `${pathPrefix}/%`)));
}

/**
 * Đánh dấu dirty một context: mọi thay đổi quyền trong context đều
 * vô hiệu hoá kết quả đã cache của nó và của mọi context con cháu.
 * Context không tồn tại thì bỏ qua (không có cache nào cần vô hiệu).
 *
 * @param db - tay cầm Drizzle của host.
 * @param contextId - id của context.
 */
export async function markContextDirty(db: EnrolDatabase, contextId: string): Promise<void> {
  const ctx = await getContextById(db, contextId);
  if (ctx) await bumpContextVersions(db, ctx.path);
}

/**
 * Lấy nhiều context theo danh sách id trong một truy vấn.
 *
 * @param db - tay cầm Drizzle của host.
 * @param ids - danh sách id context.
 */
export async function getContextsByIds(db: EnrolDatabase, ids: string[]): Promise<ContextRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(context).where(inArray(context.id, ids));
}

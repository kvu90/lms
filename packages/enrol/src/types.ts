import type { CentreDb, CentreTx } from '@lms/db';

/**
 * Các kiểu nền của package `@lms/enrol`: tay cầm cơ sở dữ liệu, các
 * cổng (port) mà host phải cấp, và các kiểu dòng dữ liệu dùng chung.
 *
 * Package không phụ thuộc framework: nó chỉ nói chuyện với tầng dữ
 * liệu qua Kysely trên kho trung tâm của `@lms/db` (không bật
 * CamelCasePlugin — tên cột trong truy vấn giữ snake_case như DB,
 * tên trường trong kiểu dòng giữ camelCase như hợp đồng cũ của
 * repository Drizzle để phía tiêu thụ không đổi). Hai thứ thuộc về
 * hạ tầng của từng app nên được host cấp vào qua cổng thay vì package
 * tự giữ: (1) ghi outbox — mỗi app có dịch vụ outbox riêng với ngữ
 * cảnh tenant của app đó; (2) chạy một lượt đọc trong ngữ cảnh
 * platform — mỗi app giữ bản sao `tenantAls` của riêng nó theo tiền
 * lệ hạ tầng của repo, package không được giữ bản sao thứ ba.
 */

/**
 * Tay cầm Kysely mà các lõi trong package thao tác: handle thường
 * của kho trung tâm hoặc handle giao dịch của nó. Mọi hàm nhận
 * handle đều chấp nhận cả hai để phía gọi lồng thao tác vào giao
 * dịch của mình khi cần (luồng ghi danh mở transaction rồi ghi
 * outbox trong cùng transaction đó).
 */
export type EnrolDatabase = CentreDb | CentreTx;

/** Một sự kiện outbox mà lõi dùng chung yêu cầu host ghi. */
export interface SharedOutboxEventInput {
  /** Nhóm tổng hợp của sự kiện (vd `enrol`, `access`, `completion`). */
  aggregate: string;
  /** Loại sự kiện (vd `user_enrolled`). */
  type: string;
  /** Nội dung sự kiện dạng JSON. */
  payload: Record<string, unknown>;
  /** Tenant của ngữ cảnh phát sinh sự kiện; bỏ trống = platform/không gian chung. */
  tenantId?: string | null;
}

/**
 * Bề mặt transaction tối thiểu mà cổng outbox cần: transaction
 * Kysely của nơi gọi. Hợp đồng của cổng — host chỉ được dùng
 * transaction này để CHÈN dòng sự kiện (xem `SharedOutboxPort`),
 * không đọc/ghi thêm gì khác trong transaction nghiệp vụ của lõi.
 */
export type SharedOutboxTx = CentreTx;

/**
 * Cổng ghi outbox do host cấp. Hợp đồng của cổng — host phải giữ
 * đúng khi hiện thực: `enqueue` ghi dòng sự kiện trong transaction
 * được truyền vào, áp tenant hiệu lực của ngữ cảnh host khi nơi gọi
 * không chỉ định tường minh và gương `tenantId` vào payload (các
 * consumer chạy ở ngữ cảnh platform dựa vào đó để biết sự kiện thuộc
 * tenant nào); `enqueueStandalone` ghi trong một transaction ngắn
 * riêng.
 */
export interface SharedOutboxPort {
  /** Ghi sự kiện trong transaction nghiệp vụ đang mở. */
  enqueue(tx: SharedOutboxTx, input: SharedOutboxEventInput): Promise<void>;
  /** Ghi sự kiện trong một transaction ngắn riêng. */
  enqueueStandalone(input: SharedOutboxEventInput): Promise<void>;
}

/**
 * Cổng chạy một lượt thao tác trong ngữ cảnh platform của host (bỏ
 * qua RLS theo tenant của phiên hiện tại). Các phép đọc chính sách
 * xuyên tenant của package (đếm slot, kiểm tách vai, cổng membership)
 * phải chạy qua cổng này: ở ngữ cảnh của một tenant, RLS sẽ che dữ
 * kiện của tenant khác và một kết quả "không thấy" do bị che sẽ làm
 * các chốt chặn lọt đúng ca cần chặn.
 */
export type PlatformScopeRunner = <T>(fn: () => Promise<T>) => Promise<T>;

/** Bộ phụ thuộc mà host cấp cho các lõi dùng chung của package. */
export interface SharedSurfaceDeps {
  /** Tay cầm Kysely của host (kho trung tâm đã định tuyến theo không gian). */
  db: CentreDb;
  /** Cổng ghi outbox của host. */
  outbox: SharedOutboxPort;
  /** Cổng chạy trong ngữ cảnh platform của host. */
  runInPlatformScope: PlatformScopeRunner;
}

// ---------------------------------------------------------------------------
// Kiểu dòng đọc (hợp đồng công khai — khớp `$inferSelect` của schema
// Drizzle cũ để phía tiêu thụ không đổi; khai tường minh tại đây để
// package sống sót qua hạng mục gỡ Drizzle #663 khi file schema bị xoá)
// ---------------------------------------------------------------------------

/** Dòng của bảng `context` (cây context phân quyền). */
export interface ContextRow {
  id: string;
  contextLevel: number;
  instanceId: string | null;
  path: string;
  depth: number;
  locked: boolean;
  version: number;
}

/** Dòng của bảng `role`. */
export interface RoleRow {
  id: string;
  name: string;
  shortName: string;
  description: string;
  sortOrder: number;
  archetype: string | null;
}

/** Dòng của bảng `role_assignments`. */
export interface RoleAssignmentRow {
  id: string;
  roleId: string;
  userId: string;
  contextId: string;
  updatedAt: Date;
  modifierId: string | null;
  component: string;
  itemId: string | null;
}

/** Dòng của bảng `tenant_memberships`. */
export interface TenantMembershipRow {
  id: string;
  tenantId: string;
  userId: string;
  status: string;
  joinedAt: Date;
  endedAt: Date | null;
}

/**
 * Dòng của bảng `enrol` (một phương thức ghi danh của khoá học) và
 * dòng của bảng `user_enrolments` (ghi danh của một người dùng):
 * dùng chung một định nghĩa với repository Kysely của G5 ở
 * `@lms/db` — hai bảng này là cùng một dữ kiện ở cả hai phía.
 */
export type { EnrolRow as EnrolInstanceRow, UserEnrolmentRow } from '@lms/db/repositories/enrol';

// ---------------------------------------------------------------------------
// Danh sách cột đọc (dùng chung cho select và returning — khuôn G5:
// cột khai tường minh kèm bí danh camelCase, không bật CamelCasePlugin)
// ---------------------------------------------------------------------------

/** Cột đọc của bảng `context`. */
export const CONTEXT_COLUMNS = [
  'id',
  'context_level as contextLevel',
  'instance_id as instanceId',
  'path',
  'depth',
  'locked',
  'version',
] as const;

/** Cột đọc của bảng `role`. */
export const ROLE_COLUMNS = [
  'id',
  'name',
  'short_name as shortName',
  'description',
  'sort_order as sortOrder',
  'archetype',
] as const;

/** Cột đọc của bảng `role_assignments`. */
export const ROLE_ASSIGNMENT_COLUMNS = [
  'id',
  'role_id as roleId',
  'user_id as userId',
  'context_id as contextId',
  'updated_at as updatedAt',
  'modifier_id as modifierId',
  'component',
  'item_id as itemId',
] as const;

/** Cột đọc của bảng `tenant_memberships`. */
export const TENANT_MEMBERSHIP_COLUMNS = [
  'id',
  'tenant_id as tenantId',
  'user_id as userId',
  'status',
  'joined_at as joinedAt',
  'ended_at as endedAt',
] as const;

/** Cột đọc của bảng `enrol`. */
export const ENROL_COLUMNS = [
  'id',
  'course_id as courseId',
  'enrol',
  'name',
  'role_id as roleId',
  'status',
  'enrol_period as enrolPeriod',
  'time_start as timeStart',
  'time_end as timeEnd',
  'enrolment_key as enrolmentKey',
  'custom_int1 as customInt1',
  'custom_int2 as customInt2',
  'custom_text1 as customText1',
  'cost',
  'currency',
  'payment_account_id as paymentAccountId',
  'send_welcome_message as sendWelcomeMessage',
  'welcome_message as welcomeMessage',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/** Cột đọc của bảng `user_enrolments`. */
export const USER_ENROLMENT_COLUMNS = [
  'id',
  'enrol_id as enrolId',
  'user_id as userId',
  'status',
  'time_start as timeStart',
  'time_end as timeEnd',
  'modifier_id as modifierId',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { context, enrol, role, roleAssignments, tenantMemberships, userEnrolments } from '@lms/db';

/**
 * Các kiểu nền của package `@lms/enrol`: tay cầm cơ sở dữ liệu, các
 * cổng (port) mà host phải cấp, và các kiểu dòng dữ liệu dùng chung.
 *
 * Package không phụ thuộc framework: nó chỉ nói chuyện với tầng dữ
 * liệu qua Drizzle trên schema dùng chung `@lms/db`. Hai thứ thuộc về
 * hạ tầng của từng app nên được host cấp vào qua cổng thay vì package
 * tự giữ: (1) ghi outbox — mỗi app có dịch vụ outbox riêng với ngữ
 * cảnh tenant của app đó; (2) chạy một lượt đọc trong ngữ cảnh
 * platform — mỗi app giữ bản sao `tenantAls` của riêng nó theo tiền
 * lệ hạ tầng của repo, package không được giữ bản sao thứ ba.
 */

/**
 * Tay cầm Drizzle mà các lõi trong package thao tác. Schema generic
 * để mở (`any`) vì mỗi app khai tay cầm theo relations của riêng app
 * đó; package chỉ dùng các bảng được truyền tường minh vào từng truy
 * vấn nên không cần biết relations của host.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EnrolDatabase = NodePgDatabase<any>;

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
 * Bề mặt transaction tối thiểu mà cổng outbox cần: chỉ phép `insert`
 * của tay cầm Drizzle, để dòng sự kiện được ghi trong CÙNG transaction
 * với thay đổi nghiệp vụ của lõi (transaction rollback thì không tồn
 * tại dòng sự kiện nào).
 */
export interface SharedOutboxTx {
  insert: EnrolDatabase['insert'];
}

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
  /** Tay cầm Drizzle của host. */
  db: EnrolDatabase;
  /** Cổng ghi outbox của host. */
  outbox: SharedOutboxPort;
  /** Cổng chạy trong ngữ cảnh platform của host. */
  runInPlatformScope: PlatformScopeRunner;
}

/** Dòng của bảng `context` (cây context phân quyền). */
export type ContextRow = typeof context.$inferSelect;
/** Dòng của bảng `role`. */
export type RoleRow = typeof role.$inferSelect;
/** Dòng của bảng `role_assignments`. */
export type RoleAssignmentRow = typeof roleAssignments.$inferSelect;
/** Dòng của bảng `tenant_memberships`. */
export type TenantMembershipRow = typeof tenantMemberships.$inferSelect;
/** Dòng của bảng `enrol` (một phương thức ghi danh của khoá học). */
export type EnrolInstanceRow = typeof enrol.$inferSelect;
/** Dòng của bảng `user_enrolments` (ghi danh của một người dùng). */
export type UserEnrolmentRow = typeof userEnrolments.$inferSelect;

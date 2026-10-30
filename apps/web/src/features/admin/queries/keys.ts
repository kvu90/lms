/**
 * Khoá truy vấn của feature admin (query key factory theo khuyến
 * nghị của tài liệu TanStack Query), tách khỏi factory tập trung khi tổ
 * chức lại apps/web theo mô hình features/ (issue #500): mỗi feature giữ
 * khoá của mình ở tầng queries/; khoá dùng chung nhiều feature ở lại
 * src/lib/query-keys.ts. Cấu trúc phân cấp: thực thể → định danh → tham số.
 */
import type { ListAssignmentsParams } from '../api/admin-roles';

export const queryKeys = {
  adminUsersRoot: ['admin', 'users'] as const,
  /** Gốc khoá bảng dòng gán vai — tiền tố làm mới bảng sau gán/gỡ. */
  roleAssignmentsRoot: ['admin', 'role-assignments'] as const,
  /** Gốc khoá ma trận quyền toàn trang — tiền tố làm mới sau ghi từng ô. */
  capabilityMatrixRoot: ['admin', 'capability-matrix'] as const,
  /**
   * Khoá ma trận quyền toàn trang theo ngữ cảnh đang chọn — mỗi ngữ
   * cảnh là một trang cache riêng, đổi ngữ cảnh là gọi lại server với
   * ngữ cảnh tương ứng.
   */
  capabilityMatrix: (contextId: string) => ['admin', 'capability-matrix', contextId] as const,
  /**
   * Khoá trang dòng gán vai theo đúng bộ lọc/tìm/phân trang đang hiển
   * thị — mỗi tổ hợp tham số là một trang cache riêng, đổi lọc/tìm/
   * trang là đổi khoá và gọi lại server với tham số tương ứng.
   */
  roleAssignments: (params: ListAssignmentsParams) =>
    [
      'admin',
      'role-assignments',
      params.roleId ?? '',
      params.contextId ?? '',
      params.search ?? '',
      params.page,
      params.pageSize,
    ] as const,
  adminUserDetail: (userId: string) => ['admin', 'users', 'detail', userId] as const,
  tenantsRoot: ['admin', 'tenants'] as const,
  tenants: ['admin', 'tenants', 'list'] as const,
  currentTenant: ['admin', 'tenants', 'current'] as const,
  tenantMembers: (tenantId: string) => ['admin', 'tenants', tenantId, 'members'] as const,
  tenantUsers: (tenantId: string) => ['admin', 'tenants', tenantId, 'users'] as const,
  siteConfig: ['site-config'] as const,
  siteConfigAudit: ['site-config', 'audit'] as const,
};

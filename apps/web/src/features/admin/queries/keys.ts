/**
 * Khoá truy vấn của feature admin (query key factory theo khuyến
 * nghị của tài liệu TanStack Query), tách khỏi factory tập trung khi tổ
 * chức lại apps/web theo mô hình features/ (issue #500): mỗi feature giữ
 * khoá của mình ở tầng queries/; khoá dùng chung nhiều feature ở lại
 * src/lib/query-keys.ts. Cấu trúc phân cấp: thực thể → định danh → tham số.
 */
import type { ListAssignmentsParams } from '../api/admin-roles';
import type { ListAdminUsersParams } from '../api/admin-users';

export const queryKeys = {
  adminUsersRoot: ['admin', 'users'] as const,
  /**
   * Khoá một trang danh sách người dùng theo đúng bộ tham số hợp đồng
   * đang hiển thị (tìm kiếm, trạng thái, sắp xếp, trang, cỡ trang) —
   * mỗi tổ hợp là một trang cache riêng, đổi tham số là đổi khoá và
   * gọi lại server. Nằm dưới gốc `adminUsersRoot` nên mọi đột biến
   * người dùng (khoá/xoá/tạo/sửa) làm mới được cả danh sách.
   */
  adminUsersList: (params: ListAdminUsersParams) =>
    [
      'admin',
      'users',
      'list',
      params.search ?? '',
      params.status ?? '',
      params.sortBy ?? '',
      params.sortDirection ?? '',
      params.page,
      params.pageSize,
    ] as const,
  /**
   * Khoá tập người dùng đầy đủ của đường lọc theo vai trò (cùng bộ
   * lọc/sắp xếp, không phân trang hiển thị) — cũng nằm dưới gốc
   * `adminUsersRoot` để đột biến người dùng làm mới.
   */
  adminUsersAll: (params: Omit<ListAdminUsersParams, 'page' | 'pageSize'>) =>
    [
      'admin',
      'users',
      'all',
      params.search ?? '',
      params.status ?? '',
      params.sortBy ?? '',
      params.sortDirection ?? '',
    ] as const,
  /**
   * Khoá số đếm của một nhóm trạng thái cho bốn thẻ thống kê đầu
   * trang người dùng; nhóm tổng (`'total'`) là tổng suy từ ba nhóm
   * trạng thái nên vẫn khoá theo tên nhóm để làm mới cùng gốc.
   */
  adminUserStat: (group: string) => ['admin', 'users', 'stat', group] as const,
  /** Gốc khoá bảng dòng gán vai — tiền tố làm mới bảng sau gán/gỡ. */
  roleAssignmentsRoot: ['admin', 'role-assignments'] as const,
  /**
   * Khoá tập người giữ một vai trò tại một ngữ cảnh (đường lọc theo
   * vai trò của trang người dùng) — dưới gốc bảng gán để gán/gỡ vai
   * làm mới cả tập này.
   */
  roleHolders: (roleId: string, contextId: string) =>
    ['admin', 'role-assignments', 'holders', roleId, contextId] as const,
  /**
   * Khoá các dòng gán vai của đúng một người dùng (cột Vai trò của
   * trang người dùng) — dưới gốc bảng gán để gán/gỡ vai làm mới.
   */
  userAssignments: (userId: string) => ['admin', 'role-assignments', 'by-user', userId] as const,
  /**
   * Khoá trang dòng gán vai theo đúng bộ lọc/tìm/phân trang đang hiển
   * thị — mỗi tổ hợp tham số là một trang cache riêng, đổi lọc/tìm/
   * trang là đổi khoá và gọi lại server với tham số tương ứng.
   */
  roleAssignments: (params: ListAssignmentsParams) =>
    [
      'admin',
      'role-assignments',
      params.userId ?? '',
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

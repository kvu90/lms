/**
 * Khoá truy vấn của feature admin (query key factory theo khuyến
 * nghị của tài liệu TanStack Query), tách khỏi factory tập trung khi tổ
 * chức lại apps/web theo mô hình features/ (issue #500): mỗi feature giữ
 * khoá của mình ở tầng queries/; khoá dùng chung nhiều feature ở lại
 * src/lib/query-keys.ts. Cấu trúc phân cấp: thực thể → định danh → tham số.
 */
export const queryKeys = {
  adminUsersRoot: ['admin', 'users'] as const,
  adminUserDetail: (userId: string) => ['admin', 'users', 'detail', userId] as const,
  tenantsRoot: ['admin', 'tenants'] as const,
  tenants: ['admin', 'tenants', 'list'] as const,
  currentTenant: ['admin', 'tenants', 'current'] as const,
  tenantMembers: (tenantId: string) => ['admin', 'tenants', tenantId, 'members'] as const,
  tenantUsers: (tenantId: string) => ['admin', 'tenants', tenantId, 'users'] as const,
  siteConfig: ['site-config'] as const,
  siteConfigAudit: ['site-config', 'audit'] as const,
};

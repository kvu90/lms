import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { tenantMemberships, tenants } from '@lms/db-schema';
import type { relations } from './relations';

type Database = NodePgDatabase<typeof relations>;

/**
 * Tenant mặc định của một user phía worker (TENANT-1, #196) — cùng
 * luật với `TenantsService.resolveDefaultTenant` phía API (TENANT-0):
 * membership active duy nhất → tenant đó; nhiều tenant → tenant
 * trường đầu tiên; không có → tenant platform (Trang chính). (Nhánh
 * site-admin → platform của luật gốc không áp ở đây: helper này chỉ
 * là nguồn tenant CUỐI CÙNG cho notification phát sinh ở worker khi
 * đối tượng nguồn không thuộc tenant nào — huy hiệu cấp platform,
 * sự kiện lịch cá nhân, báo cáo theo lịch.)
 *
 * Bảng users KHÔNG có cột tenant — tư cách thành viên
 * (tenant_memberships) mới là nguồn sự thật.
 */
export async function resolveDefaultTenantId(db: Database, userId: string): Promise<string | null> {
  const rows = await db.select({ tenantId: tenantMemberships.tenantId, kind: tenants.kind })
    .from(tenantMemberships)
    .innerJoin(tenants, eq(tenants.id, tenantMemberships.tenantId))
    .where(and(
      eq(tenantMemberships.userId, userId),
      eq(tenantMemberships.status, 'active'),
      eq(tenants.status, 'active'),
    ));
  const distinct = [...new Map(rows.map((r) => [r.tenantId, r])).values()];
  if (distinct.length === 1) return distinct[0]!.tenantId;
  if (distinct.length > 1) {
    const nonPlatform = distinct.find((r) => r.kind !== 'platform');
    if (nonPlatform) return nonPlatform.tenantId;
  }
  const [zero] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.kind, 'platform'));
  return zero?.id ?? null;
}

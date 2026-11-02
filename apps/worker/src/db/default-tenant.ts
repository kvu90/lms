import type { CentreDb } from '@lms/db';

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
 *
 * Handle là handle Kysely của kho trung tâm do phía gọi truyền vào
 * (issue #659): các processor truyền `routedKysely` của khung định
 * tuyến phía worker — cùng đích kho với handle Drizzle định tuyến
 * trước đây (ngữ cảnh platform thì về kho chung; phiên theo trung
 * tâm đã chuẩn bị phía Kysely thì vào kho của trung tâm đó; xem
 * `db/routing/space-database.service.ts`). Kiểu handle lấy từ
 * `@lms/db` để các cụm worker sau không định nghĩa lại kiểu cục bộ.
 */
export async function resolveDefaultTenantId(db: CentreDb, userId: string): Promise<string | null> {
  const rows = await db
    .selectFrom('tenant_memberships')
    .innerJoin('tenants', 'tenants.id', 'tenant_memberships.tenant_id')
    .select(['tenant_memberships.tenant_id as tenantId', 'tenants.kind as kind'])
    .where('tenant_memberships.user_id', '=', userId)
    .where('tenant_memberships.status', '=', 'active')
    .where('tenants.status', '=', 'active')
    .execute();
  const distinct = [...new Map(rows.map((r) => [r.tenantId, r])).values()];
  if (distinct.length === 1) return distinct[0]!.tenantId;
  if (distinct.length > 1) {
    const nonPlatform = distinct.find((r) => r.kind !== 'platform');
    if (nonPlatform) return nonPlatform.tenantId;
  }
  const [zero] = await db
    .selectFrom('tenants')
    .select('id')
    .where('tenants.kind', '=', 'platform')
    .execute();
  return zero?.id ?? null;
}

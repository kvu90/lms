import { and, eq } from 'drizzle-orm';
import { tenantMemberships } from '@lms/db';
import { ensureTenantContext, markContextDirty } from './contexts';
import type { EnrolDatabase, TenantMembershipRow } from './types';

/**
 * Đảm bảo membership `active` của một người dùng trong một tenant ở
 * tầng dữ liệu (dùng chung cho funnel ghi danh và bề mặt membership
 * của host): ghi danh vào khoá của tenant nào thì thuộc tenant đó —
 * membership active được bảo đảm ngay tại funnel ghi danh để cổng
 * membership của phép đánh giá quyền cho qua các vai ghi danh vừa
 * cấp.
 *
 * Flow: membership đã `active` thì trả nguyên dòng hiện hữu (no-op);
 * membership tồn tại ở trạng thái khác thì kích hoạt lại (status về
 * `active`, xoá mốc kết thúc); chưa có thì chèn mới ở trạng thái
 * `active`. Cả hai đường ghi đều kết thúc bằng việc đảm bảo context
 * tenant tồn tại và đánh dấu dirty context đó (membership là dữ
 * kiện cổng của phép đánh giá quyền trong cây của tenant).
 *
 * Ngữ cảnh RLS: hàm này kế thừa ngữ cảnh của nơi gọi — các bề mặt
 * gọi nó (funnel ghi danh, tạo tenant/user, bootstrap seed) tự bọc
 * ngữ cảnh phù hợp ở tầng của chúng, như hành vi hiện hành.
 *
 * @param db - tay cầm Drizzle của host.
 * @param tenantId - tenant đích.
 * @param userId - người dùng cần thuộc tenant.
 * @returns dòng membership ở trạng thái `active`.
 */
export async function ensureActiveTenantMembership(
  db: EnrolDatabase,
  tenantId: string,
  userId: string,
): Promise<TenantMembershipRow> {
  const [existing] = await db
    .select()
    .from(tenantMemberships)
    .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, userId)));
  if (existing?.status === 'active') return existing;
  let row: TenantMembershipRow;
  if (existing) {
    await db.update(tenantMemberships).set({ status: 'active', endedAt: null }).where(eq(tenantMemberships.id, existing.id));
    row = { ...existing, status: 'active', endedAt: null };
  } else {
    const [inserted] = await db.insert(tenantMemberships).values({ tenantId, userId, status: 'active' }).returning();
    row = inserted!;
  }
  const tenantCtx = await ensureTenantContext(db, tenantId);
  await markContextDirty(db, tenantCtx.id);
  return row;
}

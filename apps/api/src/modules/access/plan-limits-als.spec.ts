import { describe, expect, it } from 'vitest';
import { PlanLimitsCore, type EnrolDatabase } from '@lms/enrol';
import { tenantAls, type TenantAlsStore } from '../tenants/tenant-als';
import { PlanLimitsService } from './plan-limits.service';
import { RoleSeparationService } from './role-separation.service';
import { EnrolService } from '../enrol/enrol.service';
import { AuthService } from '../auth/auth.service';

/**
 * Ca khoá hành vi của lỗ hổng AsyncLocalStorage ở A4 (issue #587)
 * và của các closure giữ `spaceSlug` đã sửa cùng đợt:
 *
 * - Truy vấn Drizzle là thenable lười — việc thực thi chỉ bắt đầu
 *   khi truy vấn được await (điểm `.then`). Lõi `PlanLimitsCore`
 *   phải await truy vấn membership BÊN TRONG callback async của
 *   cổng platform thì lượt đọc mới chạy trong ngữ cảnh platform;
 *   callback trả thẳng thenable ra khỏi cổng thì điểm `.then` chạy
 *   ngoài `tenantAls.run`, lượt đọc rơi về ngữ cảnh của bên gọi và
 *   tầm nhìn RLS sai (che membership ở tenant khác, làm lọt chốt
 *   chặn slot).
 * - Ba wrapper của A4 (`PlanLimitsService`, `RoleSeparationService`,
 *   `EnrolService`) và đường cấp token (`AuthService.
 *   centreClaimForTenant`) đều phải GIỮ `spaceSlug` của ngữ cảnh
 *   hiện tại khi bước vào ngữ cảnh platform — nếu không, lượt đọc
 *   xuyên tenant của chúng rơi về kho chung và không thấy dữ kiện
 *   chỉ sống ở kho riêng. Vì vậy các ca dưới đây KHÔNG dùng cổng
 *   tự viết trong spec: chúng dựng đúng service thật, đặt ALS mang
 *   `spaceSlug`, rồi khẳng định ngữ cảnh mà lõi/cổng thật nhìn thấy
 *   tại thời điểm truy vấn là ngữ cảnh platform KÈM slug đó. Hoàn
 *   nguyên bất kỳ closure thật nào trong bốn chỗ (bỏ slug, hoặc bỏ
 *   cả cổng platform) cũng làm ít nhất một ca dưới đây đỏ — đúng
 *   tính chất hồi quy mà vòng review trước đã chỉ ra là thiếu.
 *
 * Fake database ở đây chỉ ghi lại ngữ cảnh ALS tại đúng thời điểm
 * truy vấn được thực thi, không mô phỏng dữ liệu thật: các lượt đọc
 * đầu tiên trả về rỗng nên lõi dừng ngay sau đó, đủ để khoá ngữ
 * cảnh của chính lượt đọc đó.
 */
function makeLazyQuery(seen: Array<TenantAlsStore | undefined>) {
  return {
    then(resolve: (value: unknown[]) => void) {
      seen.push(tenantAls.getStore());
      resolve([]);
    },
  };
}

function makeFakeDb(seen: Array<TenantAlsStore | undefined>): EnrolDatabase {
  const lazy = makeLazyQuery(seen);
  return {
    select: () => ({ from: () => ({ where: () => lazy }) }),
  } as unknown as EnrolDatabase;
}

/** Ngữ cảnh của bên gọi: request của một trung tâm ở kho riêng. */
const CALLER_STORE: TenantAlsStore = { tenantId: 'tenant-goi', spaceSlug: 'trung-tam-goi' };

describe('Lõi kiểm hạn mức gói — ngữ cảnh đọc membership khi kích hoạt lại tài khoản', () => {
  it('closure thật của PlanLimitsService giữ spaceSlug khi vào ngữ cảnh platform', async () => {
    const seen: Array<TenantAlsStore | undefined> = [];
    const service = new PlanLimitsService(makeFakeDb(seen) as never);
    await tenantAls.run(CALLER_STORE, () => service.assertUserReactivationWithinSlotLimits('user-1'));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.platform).toBe(true);
    expect(seen[0]?.spaceSlug).toBe('trung-tam-goi');
  });

  it('closure thật của RoleSeparationService giữ spaceSlug khi vào ngữ cảnh platform', async () => {
    const seen: Array<TenantAlsStore | undefined> = [];
    const service = new RoleSeparationService(makeFakeDb(seen) as never);
    await tenantAls.run(CALLER_STORE, () => service.hasTeachingCoverageForCourse('user-1', 'course-1'));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.platform).toBe(true);
    expect(seen[0]?.spaceSlug).toBe('trung-tam-goi');
  });

  it('closure thật của EnrolService giữ spaceSlug khi vào ngữ cảnh platform', async () => {
    const seen: Array<TenantAlsStore | undefined> = [];
    const fakeDb = makeFakeDb(seen);
    // Kể từ khi repository enrol chuyển sang Kysely (issue #645),
    // bề mặt vật chất hoá nhận handle Drizzle đã định tuyến qua
    // tham số inject cuối của EnrolService thay vì qua repository.
    const service = new EnrolService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      fakeDb as never,
    );
    // Bề mặt vật chất hoá của EnrolService dựng lõi giới hạn slot
    // bằng đúng closure của service này — gọi lõi đó là đi qua
    // closure thật, không qua cổng tự viết trong spec.
    const surface = (service as unknown as { materialization: { planLimitsCore: PlanLimitsCore } })
      .materialization;
    await tenantAls.run(CALLER_STORE, () => surface.planLimitsCore.assertUserReactivationWithinSlotLimits('user-1'));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.platform).toBe(true);
    expect(seen[0]?.spaceSlug).toBe('trung-tam-goi');
  });

  it('closure thật của centreClaimForTenant giữ spaceSlug khi vào ngữ cảnh platform', async () => {
    const seen: Array<TenantAlsStore | undefined> = [];
    const tenants = {
      getTenant: async () => {
        seen.push(tenantAls.getStore());
        return { slug: 'trung-tam-goi' };
      },
    };
    const spaceDb = {
      resolveTarget: async () => ({ mode: 'dedicated', spaceId: 'space-1' }),
    };
    const auth = new AuthService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      tenants as never,
      {} as never,
      {} as never,
      {} as never,
      spaceDb as never,
    );
    const claim = await tenantAls.run(CALLER_STORE, () =>
      (auth as unknown as { centreClaimForTenant: (tenantId: string) => Promise<string | undefined> }).centreClaimForTenant(
        'tenant-goi',
      ),
    );
    expect(claim).toBe('space-1');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.platform).toBe(true);
    expect(seen[0]?.spaceSlug).toBe('trung-tam-goi');
  });

  it('callback trả thẳng thenable lười ra khỏi cổng platform thì lượt đọc chạy ngoài ngữ cảnh platform (tái hiện cơ chế lỗi A4)', async () => {
    const seen: Array<TenantAlsStore | undefined> = [];
    const lazy = makeLazyQuery(seen);
    // Dạng cũ: cổng trả thẳng thenable, bên gọi await ngoài `run`.
    const returned = tenantAls.run({ platform: true }, () => lazy);
    await tenantAls.run({ tenantId: 'tenant-goi' }, async () => returned);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.platform).toBeUndefined();
    expect(seen[0]?.tenantId).toBe('tenant-goi');
  });
});

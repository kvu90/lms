import { describe, expect, it } from 'vitest';
import { PlanLimitsCore, type EnrolDatabase } from '@lms/enrol';
import { tenantAls, type TenantAlsStore } from '../tenants/tenant-als';

/**
 * Ca khoá hành vi của lỗ hổng AsyncLocalStorage ở A4 (issue #587):
 * truy vấn Drizzle là thenable lười — việc thực thi chỉ bắt đầu khi
 * truy vấn được await (điểm `.then`). Lõi `PlanLimitsCore` phải
 * await truy vấn membership BÊN TRONG callback async của cổng
 * platform thì lượt đọc mới chạy trong ngữ cảnh platform; callback
 * trả thẳng thenable ra khỏi cổng thì điểm `.then` chạy ngoài
 * `tenantAls.run`, lượt đọc rơi về ngữ cảnh của bên gọi và tầm nhìn
 * RLS sai (che membership ở tenant khác, làm lọt chốt chặn slot).
 *
 * Fake database ở đây chỉ ghi lại ngữ cảnh ALS tại đúng thời điểm
 * truy vấn được thực thi, không mô phỏng dữ liệu thật: membership
 * trả về rỗng nên lõi dừng ngay sau lượt đọc đầu tiên, đủ để khoá
 * ngữ cảnh của chính lượt đọc đó.
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

/** Cổng platform đúng khuôn các service đã sửa ở A4: chạy callback trong ngữ cảnh platform tường minh. */
function runInPlatformScope<T>(fn: () => Promise<T>): Promise<T> {
  return tenantAls.run({ platform: true }, fn);
}

describe('Lõi kiểm hạn mức gói — ngữ cảnh đọc membership khi kích hoạt lại tài khoản', () => {
  it('lượt đọc membership chạy trong ngữ cảnh platform, không chạy trong ngữ cảnh của bên gọi', async () => {
    const seen: Array<TenantAlsStore | undefined> = [];
    const core = new PlanLimitsCore(makeFakeDb(seen), runInPlatformScope);
    await tenantAls.run({ tenantId: 'tenant-goi', spaceSlug: 'trung-tam-goi' }, () =>
      core.assertUserReactivationWithinSlotLimits('user-1'),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.platform).toBe(true);
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

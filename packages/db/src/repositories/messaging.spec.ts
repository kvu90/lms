import { describe, expect, it } from 'vitest';
import { createRecordingDb } from '../test-support/recording-db';
import { MessagingRepository, type MessagingStorePort } from './messaging';

/**
 * Ca đơn vị của ba điểm ghép đoạn động `sql.join` (thử nghiệm T-11)
 * tại `MessagingRepository.listNotificationGroups` — tầng BIÊN
 * DỊCH, không cần database: driver ghi lại truy vấn đã biên dịch
 * (SQL + thứ tự tham số) thay cho kết nối thật.
 *
 * Ba điểm ghép cần khoá (đúng ba điểm `sql.join` của bản bộ máy cũ
 * cũ tại repository messaging):
 * - Danh sách `IN` của `eventTypes`: 0 phần tử thì KHÔNG có mảnh
 *   IN nào trong WHERE (tầng gọi gác danh sách rỗng — `IN ()`
 *   không phải SQL hợp lệ); 1 và nhiều phần tử thì các tham số nối
 *   tiếp theo đúng thứ tự mảng, đứng sau tham số của các điều kiện
 *   WHERE đi trước (userId, tenantId).
 * - Mệnh đề WHERE ghép bằng ` and `: mọi đoạn đều mang tham số
 *   bắt buộc, thứ tự tham số toàn cục giữ theo thứ tự đoạn.
 * - Mệnh đề HAVING: không có điều kiện thì KHÔNG phát `having`;
 *   đoạn cursor chứa biểu thức con `array_agg(...)` — biểu thức
 *   con không mang tham số nên vị trí tham số của cursor
 *   (latestAt, latestId) nằm đúng tại vị trí của đoạn trong danh
 *   sách, và tham số `limit` luôn đứng cuối cùng.
 *
 * Kết quả chạy thật trên database (tổng hợp + phân trang keyset)
 * nằm ở spec tích hợp đi kèm `messaging.int-spec.ts`.
 */

/** Cổng store không tham gia vào `listNotificationGroups` — bản giả rỗng là đủ cho tầng biên dịch. */
const storeStub = {} as unknown as MessagingStorePort;

const USER_ID = '01a19887-6b35-7760-8e64-a5960bfd0875';
const TENANT_ID = '01a19887-6b35-7760-8e64-a5960bfd0876';
const CURSOR_ID = '01a19887-6b35-7760-8e64-a5960bfd0877';
const CURSOR_AT = new Date('2026-10-01T03:04:05.000Z');

/** Dựng repository trên handle ghi lại để soi SQL đã biên dịch của `listNotificationGroups`. */
function repoOnRecordingDriver(): { repo: MessagingRepository; driver: ReturnType<typeof createRecordingDb>['driver'] } {
  const { db, driver } = createRecordingDb();
  return { repo: new MessagingRepository(db, storeStub), driver };
}

describe('listNotificationGroups — khuôn sql.join của T-11 ở tầng biên dịch', () => {
  it('không lọc loại, không tenant, không cursor: WHERE chỉ còn user_id_to và không phát HAVING', async () => {
    const { repo, driver } = repoOnRecordingDriver();
    await expect(repo.listNotificationGroups(USER_ID, { limit: 20 })).resolves.toEqual([]);
    expect(driver.queries).toHaveLength(1);
    const compiled = driver.queries[0]!;
    expect(compiled.sql).toContain('user_id_to = $1');
    expect(compiled.sql).not.toContain('event_type in');
    expect(compiled.sql).not.toContain('tenant_id');
    expect(compiled.sql).not.toContain('having');
    expect(compiled.sql).toContain('Asia/Ho_Chi_Minh');
    expect(compiled.parameters).toEqual([USER_ID, 20]);
  });

  it('danh sách eventTypes rỗng tường minh: không ghép mảnh IN nào (tầng gọi gác danh sách rỗng)', async () => {
    const { repo, driver } = repoOnRecordingDriver();
    await repo.listNotificationGroups(USER_ID, { eventTypes: [], limit: 5 });
    const compiled = driver.queries[0]!;
    expect(compiled.sql).not.toContain('event_type in');
    expect(compiled.sql).not.toContain('in ()');
    expect(compiled.parameters).toEqual([USER_ID, 5]);
  });

  it('một eventType kèm tenant: mảnh IN đứng sau tham số user và tenant, dấu tách đúng một tham số', async () => {
    const { repo, driver } = repoOnRecordingDriver();
    await repo.listNotificationGroups(USER_ID, { eventTypes: ['message_new'], limit: 10 }, TENANT_ID);
    const compiled = driver.queries[0]!;
    expect(compiled.sql).toContain('user_id_to = $1 and tenant_id = $2 and event_type in ($3)');
    expect(compiled.parameters).toEqual([USER_ID, TENANT_ID, 'message_new', 10]);
  });

  it('nhiều eventType: các mảnh nối bằng ", " và tham số giữ đúng thứ tự mảng', async () => {
    const { repo, driver } = repoOnRecordingDriver();
    await repo.listNotificationGroups(USER_ID, { eventTypes: ['a_type', 'b_type', 'c_type'], limit: 7 });
    const compiled = driver.queries[0]!;
    expect(compiled.sql).toContain('event_type in ($2, $3, $4)');
    expect(compiled.parameters).toEqual([USER_ID, 'a_type', 'b_type', 'c_type', 7]);
  });

  it('chỉ unreadOnly: HAVING có đúng một đoạn đếm chưa đọc, không ghép thêm đoạn nào', async () => {
    const { repo, driver } = repoOnRecordingDriver();
    await repo.listNotificationGroups(USER_ID, { unreadOnly: true, limit: 3 });
    const compiled = driver.queries[0]!;
    expect(compiled.sql).toContain('having count(*) filter (where time_read is null) > 0');
    expect(compiled.parameters).toEqual([USER_ID, 3]);
  });

  it('unreadOnly kèm cursor: hai đoạn HAVING nối bằng " and ", tham số cursor nằm tại vị trí của đoạn chứa biểu thức con, limit đứng cuối', async () => {
    const { repo, driver } = repoOnRecordingDriver();
    await repo.listNotificationGroups(USER_ID, {
      unreadOnly: true,
      cursor: { latestAt: CURSOR_AT, latestId: CURSOR_ID },
      limit: 9,
    });
    const compiled = driver.queries[0]!;
    expect(compiled.sql).toContain(
      'having count(*) filter (where time_read is null) > 0 and (max(created_at), (array_agg(id order by created_at desc, id desc))[1]) < ($2::timestamptz, $3::uuid)',
    );
    expect(compiled.parameters).toEqual([USER_ID, CURSOR_AT, CURSOR_ID, 9]);
  });

  it('cursor đứng một mình trong HAVING khi không unreadOnly và thứ tự tham số không đổi', async () => {
    const { repo, driver } = repoOnRecordingDriver();
    await repo.listNotificationGroups(USER_ID, {
      cursor: { latestAt: CURSOR_AT, latestId: CURSOR_ID },
      limit: 4,
    }, TENANT_ID);
    const compiled = driver.queries[0]!;
    expect(compiled.sql).toContain(
      'having (max(created_at), (array_agg(id order by created_at desc, id desc))[1]) < ($3::timestamptz, $4::uuid)',
    );
    expect(compiled.sql).not.toContain('filter (where time_read is null) > 0 and');
    expect(compiled.parameters).toEqual([USER_ID, TENANT_ID, CURSOR_AT, CURSOR_ID, 4]);
  });
});

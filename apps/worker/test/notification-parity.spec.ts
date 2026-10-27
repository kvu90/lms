import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MESSAGE_PROVIDERS,
  providerByName,
} from '../../api/src/modules/messaging/notification-providers';
import {
  NotificationDeliveryService,
  WORKER_PROVIDERS,
  type WorkerProviderLaw,
} from '../src/notification-delivery.service';
import {
  notifications, pluginConfig, userPreferences, users,
} from '@lms/db-schema';

/**
 * Parity luật thông báo API ↔ worker (issue #293).
 *
 * Bối cảnh: registry `MESSAGE_PROVIDERS` phía API
 * (apps/api/src/modules/messaging/notification-providers.ts) là nguồn
 * sự thật DUY NHẤT của luật phân phối thông báo. Phía worker là tiến
 * trình riêng, không import code của app API; các đường phát nền của
 * worker phát qua hàm luật chung `NotificationDeliveryService` và giữ
 * một BẢN CHIẾU viết tay tối thiểu của registry trong
 * `WORKER_PROVIDERS` (chỉ các provider mà worker là nơi phát). Trước
 * spec này không có kiểm tra tự động nào đối chiếu hai phía: registry
 * đổi một trường luật mà bản chiếu không cập nhật theo thì hai phía
 * phân kỳ âm thầm. Spec này là lưới gác — nó ĐỌC registry thật và bản
 * chiếu thật, tuyệt đối không chép cứng một bản sao thứ hai của
 * registry vào test (chép snapshot thì spec thành tự đối chiếu chính
 * nó). Tiền lệ cùng khuôn: grade-parity.spec.ts ở thư mục này.
 *
 * Phạm vi parity — các trường luật THUỘC đối chiếu (khớp tường minh
 * với đặc tả trong issue #293):
 * - `name`, `component`, `mandatoryInApp` của mọi provider có trong
 *   bản chiếu worker, đối chiếu với registry phía API.
 * - Bề mặt phát: mọi tên provider được phát qua `deliverInApp(` trong
 *   apps/worker/src phải có mặt trong bản chiếu.
 *
 * NGOÀI parity (kèm lý do, đã ghi tường minh trong issue #293):
 * - `audience`: chỉ gác ở tầng tuỳ chọn phía API (lọc danh sách loại
 *   trong trang cài đặt + chặn PUT ngoài phía người nhận, lỗi 403 mã
 *   `messaging.preference_audience`); luật PHÁT của worker không đọc
 *   trường này ở bất kỳ điểm nào — nơi phát phía worker đã biết đích
 *   danh người nhận. Bản chiếu vì vậy không mang `audience` (ca kiểm
 *   hình dạng bản chiếu bên dưới gác cả điều này: thêm trường lạ vào
 *   bản chiếu là spec đỏ, buộc phải có quyết định parity riêng).
 * - `channels`: worker chỉ phát kênh trong-app; kênh ngoài là cổng
 *   xếp job phía API. `group`/`label`/`description`: thuần trình bày
 *   phía API/web.
 *
 * Luật cứng kiểm ở tầng hành vi (nửa dưới của file): người nhận bị
 * đình chỉ, chính sách admin cấp site (NB-7) và loại bắt buộc (P2)
 * phải cho cùng kết quả như `notify()` phía API — phía API đã có spec
 * riêng cho các ca này (messaging-admin-policy.spec.ts,
 * notifications-admin-policy.e2e-spec.ts); ở đây khẳng định phía
 * worker bằng chính `NotificationDeliveryService` thật với DB giả
 * theo khuôn unit spec phía API. Luật ghi đè tắt tiếng theo khoá
 * (NB-4) của đường huy hiệu được khẳng định ở spec của lát #174-A ở
 * cả hai phía (badges-issue-notify.spec.ts phía API,
 * notification-badge-award.spec.ts phía worker) nên không lặp ở đây.
 */
describe('Notification parity: worker mirror vs API registry (issue #293)', () => {
  it('the worker mirror is a faithful projection of the API registry on every law field in scope', () => {
    const entries = Object.entries(WORKER_PROVIDERS);
    expect(entries.length).toBeGreaterThan(0);
    expect(MESSAGE_PROVIDERS.length).toBeGreaterThan(0);
    for (const [key, law] of entries) {
      // Khoá của bản chiếu phải là chính tên provider.
      expect(law.name).toBe(key);
      // Provider phía worker có mà registry không có = phân kỳ, đỏ.
      const registryEntry = providerByName(key);
      expect(registryEntry, `WORKER_PROVIDERS.${key} must exist in the API registry`).toBeDefined();
      expect(law.component).toBe(registryEntry!.component);
      expect(law.mandatoryInApp).toBe(registryEntry!.mandatoryInApp ?? false);
    }
  });

  it('the mirror carries exactly the three law fields in parity scope — nothing more, nothing less', () => {
    for (const law of Object.values(WORKER_PROVIDERS)) {
      expect(Object.keys(law).sort()).toEqual(['component', 'mandatoryInApp', 'name']);
    }
  });

  it('every provider emitted through deliverInApp in worker sources is registered in the mirror', () => {
    const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));
    const emitted = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const text = readFileSync(full, 'utf-8');
        for (const match of text.matchAll(/deliverInApp\(\s*[^,]+,\s*'([a-z0-9_]+)'/g)) {
          emitted.add(match[1]);
        }
      }
    };
    walk(srcRoot);
    // Có ít nhất các đường phát nền đã biết; tập rỗng nghĩa là phép
    // quét hỏng chứ không phải không còn đường phát nào.
    expect(emitted.size).toBeGreaterThan(0);
    for (const name of emitted) {
      expect(WORKER_PROVIDERS[name], `worker emits '${name}' via deliverInApp but it is missing from WORKER_PROVIDERS`).toBeDefined();
    }
  });
});

/**
 * Nửa hành vi: dựng NotificationDeliveryService với DB giả theo từng
 * bảng (mỗi kịch bản tối đa một dòng có nghĩa cho mỗi bảng — đủ cho
 * các ca luật cứng ở đây, đúng khuôn fake của messaging-course-mute
 * phía API). Tín hiệu badge qua Redis được stub để spec không phụ
 * thuộc Redis: hành vi cần khẳng định là luật phân phối, không phải
 * đường tín hiệu thời gian thực.
 */
function buildDelivery(scenario: {
  user?: { id: string; suspended: boolean; deleted: boolean };
  preferenceValue?: string;
  sitePolicyValue?: string;
}) {
  const insertedNotifications: Record<string, unknown>[] = [];
  const insertedLogs: Record<string, unknown>[] = [];
  const rowsFor = (table: unknown): Record<string, unknown>[] => {
    if (table === users) return scenario.user ? [scenario.user] : [];
    if (table === pluginConfig) return scenario.sitePolicyValue === undefined ? [] : [{ value: scenario.sitePolicyValue }];
    if (table === userPreferences) return scenario.preferenceValue === undefined ? [] : [{ value: scenario.preferenceValue }];
    return [];
  };
  const db = {
    select: () => ({
      from: (table: unknown) => ({ where: async () => rowsFor(table) }),
    }),
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        if (table === notifications) {
          insertedNotifications.push(v);
          return { returning: async () => [{ id: 'notif-parity-1' }] };
        }
        insertedLogs.push(v);
        return { onConflictDoNothing: async () => [] };
      },
    }),
  };
  const config = { getOrThrow: () => 'redis://localhost:6379' };
  const delivery = new NotificationDeliveryService(db as never, config as never);
  (delivery as unknown as { signalUnreadCountChanged: (userId: string) => Promise<void> })
    .signalUnreadCountChanged = vi.fn(async () => undefined);
  return { delivery, insertedNotifications, insertedLogs };
}

const ACTIVE_USER = { id: 'user-parity', suspended: false, deleted: false };
const CALENDAR_INPUT = { subject: 'Nhắc lịch', body: 'Nội dung nhắc', smallMessage: 'Nhắc lịch' };

describe('Notification parity: worker delivery law matches the API hard laws (issue #293)', () => {
  it('a suspended recipient is skipped and nothing is stored — same as notify() on the API side', async () => {
    const { delivery, insertedNotifications, insertedLogs } = buildDelivery({
      user: { id: 'user-parity', suspended: true, deleted: false },
    });
    const result = await delivery.deliverInApp('user-parity', 'calendar_reminder', CALENDAR_INPUT);
    expect(result.status).toBe('skipped-suspended');
    expect(insertedNotifications).toHaveLength(0);
    expect(insertedLogs).toHaveLength(1);
    expect(insertedLogs[0]).toMatchObject({ provider: 'calendar_reminder', channel: 'popup', status: 'skipped-suspended' });
  });

  it('a recipient that no longer exists is skipped the same way', async () => {
    const { delivery, insertedNotifications } = buildDelivery({});
    const result = await delivery.deliverInApp('user-gone', 'calendar_reminder', CALENDAR_INPUT);
    expect(result.status).toBe('skipped-suspended');
    expect(insertedNotifications).toHaveLength(0);
  });

  it('a provider disabled by the site admin policy (NB-7) is skipped before user preference is consulted', async () => {
    const { delivery, insertedNotifications, insertedLogs } = buildDelivery({
      user: ACTIVE_USER, sitePolicyValue: 'false',
    });
    const result = await delivery.deliverInApp('user-parity', 'calendar_reminder', CALENDAR_INPUT);
    expect(result.status).toBe('skipped-admin-disabled');
    expect(insertedNotifications).toHaveLength(0);
    expect(insertedLogs[0]).toMatchObject({ provider: 'calendar_reminder', status: 'skipped-admin-disabled' });
  });

  it('a recipient who turned the provider off in-app is skipped by preference', async () => {
    const { delivery, insertedNotifications, insertedLogs } = buildDelivery({
      user: ACTIVE_USER, preferenceValue: '0',
    });
    const result = await delivery.deliverInApp('user-parity', 'calendar_reminder', CALENDAR_INPUT);
    expect(result.status).toBe('skipped-preference');
    expect(insertedNotifications).toHaveLength(0);
    expect(insertedLogs[0]).toMatchObject({ provider: 'calendar_reminder', status: 'skipped-preference' });
  });

  it('an enabled recipient with no blocking preference receives the notification and a delivered dispatch log', async () => {
    const { delivery, insertedNotifications, insertedLogs } = buildDelivery({ user: ACTIVE_USER });
    const result = await delivery.deliverInApp('user-parity', 'calendar_reminder', CALENDAR_INPUT);
    expect(result.status).toBe('delivered');
    expect(result.notificationId).toBe('notif-parity-1');
    expect(insertedNotifications).toHaveLength(1);
    expect(insertedNotifications[0]).toMatchObject({ eventType: 'calendar_reminder', component: 'core_calendar' });
    expect(insertedLogs[0]).toMatchObject({ provider: 'calendar_reminder', status: 'delivered', dedupeKey: 'popup-notif-parity-1' });
  });

  it('a mandatory provider (P2) forces the in-app channel on even when the stored preference is off — the mirror of the API law', async () => {
    const mandatory: WorkerProviderLaw = { name: 'parity_mandatory_probe', component: 'core_probe', mandatoryInApp: true };
    const optional: WorkerProviderLaw = { name: 'parity_optional_probe', component: 'core_probe', mandatoryInApp: false };
    const { delivery } = buildDelivery({ user: ACTIVE_USER, preferenceValue: '0' });
    // Cùng một giá trị tuỳ chọn đã lưu ('0' ở khoá v2): loại bắt buộc
    // bị ép bật, loại thường tôn trọng tuỳ chọn — đúng luật
    // resolveNotificationPreference phía API.
    expect(await delivery.resolvePopupEnabled('user-parity', mandatory)).toBe(true);
    expect(await delivery.resolvePopupEnabled('user-parity', optional)).toBe(false);
  });
});

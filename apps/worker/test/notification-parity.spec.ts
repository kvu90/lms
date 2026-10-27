import { describe, expect, it, vi } from 'vitest';
import {
  NotificationDeliveryService,
  WORKER_PROVIDERS,
  type WorkerProviderLaw,
} from '../src/notification-delivery.service';
import {
  notifications, pluginConfig, userPreferences, users,
} from '@lms/db-schema';

/**
 * Parity luật thông báo API ↔ worker — nửa HÀNH VI (issue #293).
 *
 * File này khẳng định phía worker cho cùng kết quả ở các luật cứng
 * mà `notify()` phía API áp: người nhận bị đình chỉ/đã xoá thì
 * không nhận gì (`skipped-suspended`); loại bị chính sách admin cấp
 * site tắt (NB-7) thì bị chặn trước tuỳ chọn người dùng
 * (`skipped-admin-disabled`); tuỳ chọn trong-app của người nhận
 * được tôn trọng (`skipped-preference`); loại bắt buộc (P2,
 * `mandatoryInApp`) ép bật kênh trong-app bất kể tuỳ chọn đã lưu.
 * Phía API đã có spec riêng cho các ca này
 * (messaging-admin-policy.spec.ts, notifications-admin-policy.e2e-spec.ts);
 * ở đây chạy `NotificationDeliveryService` THẬT của worker với DB
 * giả theo khuôn unit spec phía API.
 *
 * Nửa ĐỐI CHIẾU TRƯỜNG LUẬT của parity (bản chiếu `WORKER_PROVIDERS`
 * ở file `../src/notification-delivery.service.ts` so với registry
 * phía API) nằm ở phía API —
 * `apps/api/src/modules/messaging/notification-parity.spec.ts` —
 * vì hai app là hai project TypeScript riêng: import chéo app vỡ
 * typecheck (lỗi rootDir), nên phía API đọc bản chiếu worker dạng
 * văn bản nguồn để đối chiếu với registry thật của chính app đó.
 *
 * Luật ghi đè tắt tiếng theo khoá (NB-4) của đường huy hiệu được
 * khẳng định ở spec của lát #174-A ở cả hai phía
 * (badges-issue-notify.spec.ts phía API,
 * notification-badge-award.spec.ts phía worker) nên không lặp ở đây.
 */

describe('Notification parity: worker mirror local sanity (issue #293)', () => {
  it('every mirror entry is keyed by its own provider name', () => {
    const entries = Object.entries(WORKER_PROVIDERS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, law] of entries) {
      expect(law.name).toBe(key);
    }
  });
});

/**
 * Dựng NotificationDeliveryService với DB giả theo từng bảng (mỗi
 * kịch bản tối đa một dòng có nghĩa cho mỗi bảng — đủ cho các ca
 * luật cứng ở đây). Tín hiệu badge qua Redis được stub để spec
 * không phụ thuộc Redis: hành vi cần khẳng định là luật phân phối,
 * không phải đường tín hiệu thời gian thực.
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

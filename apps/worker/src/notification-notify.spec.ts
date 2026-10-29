import { describe, expect, it, vi } from 'vitest';
import { NotificationDeliveryService } from './notification-delivery.service';
import {
  notifications, outboxEvents, pluginConfig, userPreferences, users,
} from '@lms/db';

/**
 * Bề mặt phát thông báo TRỌN của worker — `NotificationDeliveryService.notify`
 * (issue con #518 của #491): bản phía worker của notify() phía API cho
 * các sự kiện mà worker là nơi phát và registry có kênh ngoài (hiện là
 * hai provider digest phụ huynh). Spec này ghim các luật cứng của bề
 * mặt dùng chung mà các consumer chuyển sau (issue #520) sẽ dựa vào:
 *
 * - Nửa popup đi qua chính deliverInApp (đình chỉ/NB-7/tuỳ chọn) —
 *   người nhận bị đình chỉ là điểm dừng sớm: không kênh ngoài, không
 *   sự kiện `notification_created`, như notify() phía API.
 * - Nửa email: tần suất hiệu lực (v2 thắng; chưa đặt → mặc định theo
 *   nhóm 'learning' là 'daily'); 'off' → dispatch log
 *   `skipped-preference` kênh email và không xếp job; khác 'off' →
 *   job 'dispatch' vào hàng đợi dùng chung với jobId = dedupeKey đúng
 *   định dạng phía API (tiền tố tenant) và nội dung là CẶP TỐI THIỂU
 *   HOÁ (luật C-5), không phải nội dung trong-app.
 * - Cuối đường chính luôn ghi sự kiện outbox `notification_created`
 *   (kể cả khi popup bị tuỳ chọn tắt; notificationId null khi popup
 *   không sinh dòng).
 * - Thiếu cặp nội dung ngoài ở môi trường test → ném lỗi
 *   `messaging.external_minimization_required` như phía API.
 *
 * DB giả theo từng bảng như khuôn spec parity (notification-parity.spec.ts);
 * các lần đọc user_preferences được cấp theo hàng đợi vì thứ tự đọc của
 * luật là xác định (popup v2 → cũ loggedin → loggedoff, rồi email v2 →
 * cũ loggedin → loggedoff). Tín hiệu badge qua Redis được stub: hành vi
 * cần khẳng định là luật phân phối, không phải đường tín hiệu.
 */
function buildNotify(scenario: {
  user?: { id: string; suspended: boolean; deleted: boolean };
  preferenceReads?: (string | undefined)[];
  sitePolicyValue?: string;
}) {
  const insertedNotifications: Record<string, unknown>[] = [];
  const insertedLogs: Record<string, unknown>[] = [];
  const insertedOutbox: Record<string, unknown>[] = [];
  const preferenceReads = [...(scenario.preferenceReads ?? [])];
  const rowsFor = (table: unknown): Record<string, unknown>[] => {
    if (table === users) return scenario.user ? [scenario.user] : [];
    if (table === pluginConfig) return scenario.sitePolicyValue === undefined ? [] : [{ value: scenario.sitePolicyValue }];
    if (table === userPreferences) {
      const value = preferenceReads.shift();
      return value === undefined ? [] : [{ value }];
    }
    return [];
  };
  const db = {
    select: () => ({
      from: (table: unknown) => ({ where: async () => rowsFor(table) }),
    }),
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        if (table === notifications) insertedNotifications.push(v);
        else if (table === outboxEvents) insertedOutbox.push(v);
        else insertedLogs.push(v);
        return {
          returning: async () => [{ id: 'notif-notify-1' }],
          onConflictDoNothing: async () => [],
        };
      },
    }),
  };
  const config = { getOrThrow: () => 'redis://localhost:6379' };
  const queue = { add: vi.fn(async () => ({})) };
  const i18n = { t: (key: string) => key };
  const delivery = new NotificationDeliveryService(db as never, config as never, queue as never, i18n as never);
  (delivery as unknown as { signalUnreadCountChanged: (userId: string) => Promise<void> })
    .signalUnreadCountChanged = vi.fn(async () => undefined);
  return { delivery, queue, insertedNotifications, insertedLogs, insertedOutbox };
}

const ACTIVE_USER = { id: 'user-guardian', suspended: false, deleted: false };
const LONG_BODY = `Kết quả mới đã công bố: 1. ${'x'.repeat(240)}`;
const DIGEST_INPUT = {
  subject: 'Tổng hợp tuần về việc học của con An',
  body: LONG_BODY,
  contextUrl: '/guardian/students/student-1',
  externalSubject: 'Thông tin mới về việc học của con',
  externalBody: 'Có thông tin học tập mới đã được công bố cho con bạn.',
  tenantId: 'tenant-1',
};

describe('NotificationDeliveryService.notify — bề mặt phát trọn phía worker (issue #518)', () => {
  it('phát popup và xếp job email với nội dung tối thiểu hoá, jobId mang tiền tố tenant, tần suất mặc định daily khi chưa có tuỳ chọn nào', async () => {
    const { delivery, queue, insertedNotifications, insertedOutbox } = buildNotify({ user: ACTIVE_USER });
    const result = await delivery.notify('user-guardian', 'guardian_digest', DIGEST_INPUT);
    expect(result).toEqual({ notificationId: 'notif-notify-1', channels: { popup: 'delivered', email: 'queued' } });
    expect(insertedNotifications).toHaveLength(1);
    expect(insertedNotifications[0]).toMatchObject({
      eventType: 'guardian_digest', component: 'core_guardian', tenantId: 'tenant-1',
      smallMessage: LONG_BODY.slice(0, 200),
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
    const [jobName, jobData, jobOptions] = queue.add.mock.calls[0]! as unknown as [string, Record<string, unknown>, Record<string, unknown>];
    expect(jobName).toBe('dispatch');
    expect(jobData).toEqual({
      userId: 'user-guardian', provider: 'guardian_digest', channel: 'email', tenantId: 'tenant-1',
      emailFrequency: 'daily',
      subject: 'Thông tin mới về việc học của con', body: 'Có thông tin học tập mới đã được công bố cho con bạn.',
      notificationId: 'notif-notify-1',
      dedupeKey: 'tenant-1-dispatch-guardian_digest-user-guardian-email-notif-notify-1',
    });
    expect(jobOptions).toEqual({ jobId: 'tenant-1-dispatch-guardian_digest-user-guardian-email-notif-notify-1', attempts: 3 });
    expect(insertedOutbox).toHaveLength(1);
    expect(insertedOutbox[0]).toMatchObject({
      aggregate: 'messaging', type: 'notification_created', tenantId: 'tenant-1',
      payload: { userId: 'user-guardian', provider: 'guardian_digest', notificationId: 'notif-notify-1', tenantId: 'tenant-1' },
    });
  });

  it('tần suất email v2 bằng off: không xếp job, ghi dispatch log skipped-preference cho kênh email, popup vẫn giao và sự kiện vẫn ghi', async () => {
    // Lượt đọc tuỳ chọn: popup v2 = 'off' (không phải '0' nên popup vẫn
    // bật theo luật v2 của kênh popup), email v2 = 'off'.
    const { delivery, queue, insertedLogs, insertedOutbox } = buildNotify({
      user: ACTIVE_USER, preferenceReads: ['off', 'off'],
    });
    const result = await delivery.notify('user-guardian', 'guardian_digest', DIGEST_INPUT);
    expect(result.channels).toEqual({ popup: 'delivered', email: 'skipped-preference' });
    expect(queue.add).not.toHaveBeenCalled();
    const emailLog = insertedLogs.find((l) => l.channel === 'email');
    expect(emailLog).toMatchObject({ provider: 'guardian_digest', status: 'skipped-preference', tenantId: 'tenant-1' });
    expect(String(emailLog!.dedupeKey)).toMatch(/^tenant-1-email-off-guardian_digest-user-guardian-/);
    expect(insertedOutbox).toHaveLength(1);
  });

  it('người nhận bị đình chỉ: dừng sớm — không thông báo, không job email, không sự kiện notification_created', async () => {
    const { delivery, queue, insertedNotifications, insertedOutbox } = buildNotify({
      user: { id: 'user-guardian', suspended: true, deleted: false },
    });
    const result = await delivery.notify('user-guardian', 'guardian_digest', DIGEST_INPUT);
    expect(result.skipped).toBe('suspended');
    expect(insertedNotifications).toHaveLength(0);
    expect(queue.add).not.toHaveBeenCalled();
    expect(insertedOutbox).toHaveLength(0);
  });

  it('popup tắt theo tuỳ chọn v2: vẫn xếp job email với notificationId null và dedupeKey mang uuid ở vị trí notificationId', async () => {
    // Lượt đọc tuỳ chọn: popup v2 = '0' (tắt popup); email v2 chưa đặt,
    // dữ liệu cũ loggedin/loggedoff đều chưa đặt → mặc định 'daily'.
    const { delivery, queue, insertedOutbox } = buildNotify({
      user: ACTIVE_USER, preferenceReads: ['0', undefined, undefined, undefined],
    });
    const result = await delivery.notify('user-guardian', 'guardian_digest', DIGEST_INPUT);
    expect(result.notificationId).toBeNull();
    expect(result.channels).toEqual({ popup: 'skipped-preference', email: 'queued' });
    const [, jobData] = queue.add.mock.calls[0]! as unknown as [string, Record<string, unknown>];
    expect(jobData.notificationId).toBeNull();
    expect(String(jobData.dedupeKey)).toMatch(/^tenant-1-dispatch-guardian_digest-user-guardian-email-[0-9a-f-]{36}$/);
    expect(insertedOutbox[0]).toMatchObject({ payload: { notificationId: null } });
  });

  it('thiếu cặp nội dung ngoài tối thiểu hoá ở môi trường test: ném lỗi messaging.external_minimization_required như phía API', async () => {
    const { delivery } = buildNotify({ user: ACTIVE_USER });
    const withoutExternal = {
      subject: DIGEST_INPUT.subject, body: DIGEST_INPUT.body,
      contextUrl: DIGEST_INPUT.contextUrl, tenantId: DIGEST_INPUT.tenantId,
    };
    await expect(delivery.notify('user-guardian', 'guardian_digest', withoutExternal))
      .rejects.toThrow('messaging.external_minimization_required');
  });

  it('provider không có trong sổ phía worker: trả unknown-provider và không ghi gì', async () => {
    const { delivery, queue, insertedNotifications, insertedLogs, insertedOutbox } = buildNotify({ user: ACTIVE_USER });
    const result = await delivery.notify('user-guardian', 'provider_khong_ton_tai', DIGEST_INPUT);
    expect(result).toEqual({ notificationId: null, channels: {}, skipped: 'unknown-provider' });
    expect(insertedNotifications).toHaveLength(0);
    expect(insertedLogs).toHaveLength(0);
    expect(insertedOutbox).toHaveLength(0);
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('NotificationDeliveryService.notify — chín provider sự kiện thông báo (issue #520)', () => {
  it('provider original-ok (grade_updated): job email mang NGUYÊN nội dung gốc khi nơi phát không truyền bản tối thiểu hoá, tần suất mặc định daily của nhóm learning', async () => {
    const { delivery, queue, insertedOutbox } = buildNotify({ user: ACTIVE_USER });
    const result = await delivery.notify('user-guardian', 'grade_updated', {
      subject: 'Điểm mới trong khoá học "Toán"',
      body: 'Bạn có điểm mới cho mục "Bài 1" trong khoá học "Toán".',
      contextUrl: '/courses/course-1/grades',
      tenantId: 'tenant-1',
    });
    expect(result).toEqual({ notificationId: 'notif-notify-1', channels: { popup: 'delivered', email: 'queued' } });
    const [jobName, jobData, jobOptions] = queue.add.mock.calls[0]! as unknown as [string, Record<string, unknown>, Record<string, unknown>];
    expect(jobName).toBe('dispatch');
    // Luật C-5 nhánh original-ok: kênh ngoài mang nguyên nội dung gốc
    // (registry đã xác nhận an toàn — nội dung không chứa điểm số),
    // KHÔNG ném lỗi thiếu cặp tối thiểu hoá như provider minimized.
    expect(jobData).toMatchObject({
      provider: 'grade_updated', channel: 'email', emailFrequency: 'daily',
      subject: 'Điểm mới trong khoá học "Toán"',
      body: 'Bạn có điểm mới cho mục "Bài 1" trong khoá học "Toán".',
    });
    expect(jobOptions).toMatchObject({ attempts: 3 });
    expect(insertedOutbox[0]).toMatchObject({ payload: { provider: 'grade_updated' } });
  });

  it('provider original-ok ngoài nhóm learning (message_new): tần suất email mặc định là immediate như phía API', async () => {
    const { delivery, queue } = buildNotify({ user: ACTIVE_USER });
    await delivery.notify('user-guardian', 'message_new', {
      subject: 'Tin nhắn mới từ An',
      body: 'Bạn có tin nhắn mới đang chờ.',
      contextUrl: '/messages?conversation=conv-1',
      tenantId: 'tenant-1',
    });
    const [, jobData] = queue.add.mock.calls[0]! as unknown as [string, Record<string, unknown>];
    expect(jobData).toMatchObject({ provider: 'message_new', emailFrequency: 'immediate' });
  });

  it('notify truyền courseId của người nhận đã tắt tiếng khoá đó: dừng sớm skipped-course-mute — không thông báo, không job email, không sự kiện', async () => {
    // Lượt đọc tuỳ chọn đầu tiên trong deliverInApp là khoá tắt tiếng
    // theo khoá (NB-4): giá trị 'mute' nghĩa là người nhận đã tắt
    // tiếng khoá đó theo luật ghi đè của phía API. Provider dùng ở
    // ca này là activity_due_soon — loại THƯỜNG, không thuộc diện
    // miễn trừ P3 như grade_updated.
    const { delivery, queue, insertedNotifications, insertedLogs, insertedOutbox } = buildNotify({
      user: ACTIVE_USER, preferenceReads: ['mute'],
    });
    const result = await delivery.notify('user-guardian', 'activity_due_soon', {
      subject: 'Sắp đến hạn nộp: "Bài 1"',
      body: 'Hoạt động "Bài 1" trong khoá học "Toán" sẽ đến hạn vào mai.',
      contextUrl: '/courses/course-1/exams/pin-1',
      courseId: 'course-1',
      tenantId: 'tenant-1',
    });
    expect(result.skipped).toBe('course-mute');
    expect(result.notificationId).toBeNull();
    expect(insertedNotifications).toHaveLength(0);
    expect(queue.add).not.toHaveBeenCalled();
    expect(insertedOutbox).toHaveLength(0);
    expect(insertedLogs.some((l) => l.status === 'skipped-course-mute' && l.provider === 'activity_due_soon')).toBe(true);
  });
});

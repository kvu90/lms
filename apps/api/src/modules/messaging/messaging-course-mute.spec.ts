import { describe, expect, it, vi } from 'vitest';
import { MessagingService, coursePreferenceName } from './messaging.service';

/**
 * Ghi đè theo khoá học (NB-4, issue #174): notify() áp tắt tiếng theo
 * khoá TRƯỚC khi xét kênh — khoá nguồn bị mute thì không sinh thông
 * báo ở kênh nào và ghi dispatch log 'skipped-course-mute'. Chính
 * sách P3 đã chốt: điểm mới (grade_updated) và sắp hết hạn ghi danh
 * (enrol_expiry_warning) của khoá bị mute vẫn tới; hai loại bắt buộc
 * P2 (mandatoryInApp, gồm admin_announcement) cũng không bị chặn —
 * luật toàn cục thắng ghi đè theo khoá.
 */
describe('MessagingService.notify — course mute override (NB-4)', () => {
  const MUTED_COURSE = 'course-muted';
  const OPEN_COURSE = 'course-open';

  function buildService(storedMode: string | null = 'mute') {
    const inserted: Record<string, unknown>[] = [];
    const logs: Record<string, unknown>[] = [];
    const jobs: Record<string, unknown>[] = [];
    const repo = {
      insertNotification: vi.fn(async (v: Record<string, unknown>) => { inserted.push(v); return { id: 'notif-1', ...v }; }),
      insertDispatchLog: vi.fn(async (v: Record<string, unknown>) => { logs.push(v); return {}; }),
      // TENANT-1 (#196): notify() phân giải tenant của người nhận qua
      // repo trước khi áp cổng mute — fake cần có mặt phương thức này
      // (null = người nhận không thuộc tenant nào, như messaging-notify.spec).
      getUserDefaultTenantId: vi.fn(async () => null),
    };
    const users = {
      getByIdOrUndefined: vi.fn(async (id: string) => ({ id, suspended: false, deleted: false })),
      getPreference: vi.fn(async (_userId: string, name: string) =>
        name === coursePreferenceName(MUTED_COURSE) ? storedMode : null),
    };
    const unreadStream = { signalUnreadCountChanged: vi.fn(async () => undefined) };
    const dispatchQueue = { add: vi.fn(async (_name: string, data: Record<string, unknown>) => { jobs.push(data); }) };
    const outbox = { enqueueStandalone: vi.fn(async () => undefined) };
    const siteConfig = { getValue: vi.fn(async () => undefined) };
    // Throttle gửi tin (lát M2, issue #212) là tham số thứ 10 của
    // constructor: spec này chỉ đi đường notify() nên stub consume
    // không làm gì là đủ (giữ nguyên hành vi spec của NB-4).
    const sendThrottle = { consume: vi.fn(async () => undefined) };
    // I18n (tham số thứ 11, luật C-5 của issue #219): spec này không
    // đi đường bản tóm tắt mặc định cho kênh ngoài nên stub rỗng đủ.
    const service = new MessagingService(
      repo as never, users as never, {} as never, {} as never, outbox as never,
      {} as never, unreadStream as never, dispatchQueue as never, siteConfig as never,
      sendThrottle as never, {} as never,
    );
    return { service, inserted, logs, jobs };
  }

  it('a regular notification from a muted course is skipped on every channel and logged as skipped-course-mute', async () => {
    const { service, inserted, logs, jobs } = buildService();
    const result = await service.notify('user-1', 'activity_due_soon', {
      subject: 'Sắp đến hạn', body: 'Bài tập sắp đến hạn nộp',
      contextUrl: `/courses/${MUTED_COURSE}/quizzes/q1`, courseId: MUTED_COURSE,
    });
    expect(result.skipped).toBe('course-mute');
    expect(result.notificationId).toBeNull();
    expect(result.channels).toEqual({});
    // Không sinh hàng thông báo, không xếp hàng job kênh ngoài nào.
    expect(inserted).toHaveLength(0);
    expect(jobs).toHaveLength(0);
    // Truy vết: đúng một dòng dispatch log với trạng thái riêng.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ provider: 'activity_due_soon', channel: 'popup', status: 'skipped-course-mute' });
  });

  it('P3: a new grade from a muted course is still delivered', async () => {
    const { service, inserted } = buildService();
    const result = await service.notify('user-1', 'grade_updated', {
      subject: 'Có điểm mới', body: 'Điểm đã cập nhật', courseId: MUTED_COURSE,
    });
    expect(result.skipped).toBeUndefined();
    expect(result.notificationId).toBe('notif-1');
    expect(inserted).toHaveLength(1);
  });

  it('P3 + P2: an enrolment-expiry warning from a muted course is still delivered', async () => {
    const { service, inserted } = buildService();
    const result = await service.notify('user-1', 'enrol_expiry_warning', {
      subject: 'Sắp hết hạn ghi danh', body: 'Ghi danh sắp hết hạn', courseId: MUTED_COURSE,
    });
    expect(result.skipped).toBeUndefined();
    expect(inserted).toHaveLength(1);
  });

  it('P2: a mandatory provider is never blocked by a course override, even with a courseId attached', async () => {
    const { service, inserted } = buildService();
    const result = await service.notify('user-1', 'admin_announcement', {
      subject: 'Thông báo quản trị', body: 'Nội dung chính thức', courseId: MUTED_COURSE,
      // Luật C-5 (issue #219): admin_announcement thuộc diện tối
      // thiểu hoá kênh ngoài — nơi gọi thật của nó
      // (sendSystemNotification) áp cứng bản tóm tắt mặc định; ca
      // này chỉ kiểm cổng mute nên truyền bản tối thiểu hoá tường
      // minh để lời gọi hợp lệ theo luật mới.
      externalSubject: 'Thông báo quản trị', externalBody: 'Nội dung chính thức',
    });
    expect(result.skipped).toBeUndefined();
    expect(inserted).toHaveLength(1);
  });

  it('a notification from a different (unmuted) course is delivered normally', async () => {
    const { service, inserted } = buildService();
    const result = await service.notify('user-1', 'activity_due_soon', {
      subject: 'Sắp đến hạn', body: 'Bài tập sắp đến hạn nộp', courseId: OPEN_COURSE,
    });
    expect(result.skipped).toBeUndefined();
    expect(inserted).toHaveLength(1);
  });

  it('without a courseId the override does not apply (behaviour unchanged)', async () => {
    const { service, inserted } = buildService();
    const result = await service.notify('user-1', 'activity_due_soon', {
      subject: 'Sắp đến hạn', body: 'Bài tập sắp đến hạn nộp',
    });
    expect(result.skipped).toBeUndefined();
    expect(inserted).toHaveLength(1);
  });

  it("an explicit 'all' override delivers normally", async () => {
    const { service, inserted } = buildService('all');
    const result = await service.notify('user-1', 'activity_due_soon', {
      subject: 'Sắp đến hạn', body: 'Bài tập sắp đến hạn nộp', courseId: MUTED_COURSE,
    });
    expect(result.skipped).toBeUndefined();
    expect(inserted).toHaveLength(1);
  });

  it('other regular course providers are blocked too (course_completed from a muted course)', async () => {
    const { service, inserted, logs } = buildService();
    const result = await service.notify('user-1', 'course_completed', {
      subject: 'Hoàn thành khoá', body: 'Bạn đã hoàn thành khoá', courseId: MUTED_COURSE,
    });
    expect(result.skipped).toBe('course-mute');
    expect(inserted).toHaveLength(0);
    expect(logs[0]).toMatchObject({ status: 'skipped-course-mute' });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { MessagingService } from './messaging.service';

/**
 * Luật tối thiểu hoá nội dung kênh ngoài (issue #49, lát N1 — chuẩn
 * Canvas): khi caller truyền externalSubject/externalBody, job phân
 * phối kênh ngoài (email/push) chỉ mang bản tóm tắt; bản trong app
 * giữ nguyên nội dung đầy đủ. Không truyền thì job mang subject/body
 * gốc (caller cam kết đã an toàn).
 */
describe('MessagingService.notify — external channel minimization', () => {
  function buildService() {
    const inserted: Record<string, unknown>[] = [];
    const jobs: Record<string, unknown>[] = [];
    const repo = {
      insertNotification: vi.fn(async (v: Record<string, unknown>) => { inserted.push(v); return { id: 'notif-1', ...v }; }),
      insertDispatchLog: vi.fn(async () => ({})),
    };
    const users = {
      getByIdOrUndefined: vi.fn(async (id: string) => ({ id, suspended: false, deleted: false })),
      getPreference: vi.fn(async () => null),
    };
    const unreadStream = { signalUnreadCountChanged: vi.fn(async () => undefined) };
    const dispatchQueue = { add: vi.fn(async (_name: string, data: Record<string, unknown>) => { jobs.push(data); }) };
    const outbox = { enqueueStandalone: vi.fn(async () => undefined) };
    // SiteConfigService quay lại constructor (tham số thứ 9) cho cửa
    // sổ THU HỒI của vòng đời tin nhắn theo vai — spec này không đụng
    // đường thu hồi nên chỉ cần stub getValue trả undefined (service
    // tự rơi về mặc định 15 phút).
    const siteConfig = { getValue: vi.fn(async () => undefined) };
    // Throttle gửi tin (lát M2, issue #212) là tham số thứ 10: spec
    // này chỉ đi đường notify() (tin hệ thống) — không qua cổng gửi
    // tin của người dùng nên stub consume không làm gì là đủ.
    const sendThrottle = { consume: vi.fn(async () => undefined) };
    const service = new MessagingService(
      repo as never, users as never, {} as never, {} as never, outbox as never,
      {} as never, unreadStream as never, dispatchQueue as never, siteConfig as never,
      sendThrottle as never,
    );
    return { service, inserted, jobs };
  }

  it('the external dispatch job carries only the minimized subject/body; the in-app row keeps the full content', async () => {
    const { service, inserted, jobs } = buildService();
    const result = await service.notify('user-1', 'grade_updated', {
      subject: 'Full in-app subject', body: 'Full in-app body with detail',
      externalSubject: 'You have a new grade', externalBody: 'Open the app to see it.',
    });
    expect(result.notificationId).toBe('notif-1');
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.subject).toBe('Full in-app subject');
    // grade_updated khai báo kênh popup + email: đúng một job kênh ngoài.
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.channel).toBe('email');
    expect(jobs[0]!.subject).toBe('You have a new grade');
    expect(jobs[0]!.body).toBe('Open the app to see it.');
  });

  it('without minimized variants the job falls back to subject/body (caller vouches they are safe)', async () => {
    const { service, jobs } = buildService();
    await service.notify('user-1', 'enrol_welcome', {
      subject: 'Welcome', body: 'Welcome body',
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.subject).toBe('Welcome');
    expect(jobs[0]!.body).toBe('Welcome body');
  });
});

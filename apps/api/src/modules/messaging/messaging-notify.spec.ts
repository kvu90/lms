import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessagingService } from './messaging.service';
import { MESSAGE_PROVIDERS } from './notification-providers';

/**
 * Luật tối thiểu hoá nội dung kênh ngoài (issue #49, lát N1 — chuẩn
 * Canvas; siết chặt theo quyết định C-5 của issue #219: CẤM fallback
 * nguyên văn tại notify()). Job phân phối kênh ngoài (email/push)
 * chỉ được mang đúng một trong ba thứ:
 *
 *  1. Bản tối thiểu hoá externalSubject/externalBody do phía gọi
 *     truyền — bản trong app giữ nguyên nội dung đầy đủ.
 *  2. Nội dung gốc — CHỈ khi provider khai báo tường minh
 *     'original-ok' kèm lý do trong registry provider.
 *  3. Bản tóm tắt mặc định i18n — khi provider thuộc diện
 *     'minimized' mà phía gọi thiếu bản tối thiểu hoá; riêng ở môi
 *     trường test, trường hợp này NÉM LỖI (ca cấm fail-được: gỡ cơ
 *     chế cấm ở notify() là các ca thuộc diện này phải đỏ).
 *
 * Đường sendSystemNotification áp cứng diện 'minimized' cho mọi
 * provider vì nội dung là văn bản tự do của quản trị viên.
 */
describe('MessagingService.notify — external channel minimization (C-5)', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = ORIGINAL_NODE_ENV; });

  function buildService() {
    const inserted: Record<string, unknown>[] = [];
    const jobs: Record<string, unknown>[] = [];
    const repo = {
      insertNotification: vi.fn(async (v: Record<string, unknown>) => { inserted.push(v); return { id: 'notif-1', ...v }; }),
      insertDispatchLog: vi.fn(async () => ({})),
      getUserDefaultTenantId: vi.fn(async () => null),
    };
    const users = {
      getByIdOrUndefined: vi.fn(async (id: string) => ({ id, suspended: false, deleted: false })),
      getPreference: vi.fn(async () => null),
    };
    // Evaluator (tham số thứ 3): ca đường gửi hệ thống cần
    // isSiteAdmin = true; các ca notify() thường không đọc evaluator.
    const evaluator = { isSiteAdmin: vi.fn(async () => true) };
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
    // I18n (tham số thứ 11): stub chỉ phục vụ hai khoá tóm tắt mặc
    // định của luật C-5, trả đúng câu chữ của catalog 'vi' để các ca
    // khẳng định trên văn bản thật mà người nhận sẽ thấy.
    const i18n = {
      t: vi.fn((key: string, opts?: { args?: Record<string, unknown> }) => {
        if (key === 'platform.externalGenericSubject') return 'Bạn có thông báo mới';
        if (key === 'platform.externalGenericBody') return `Có thông báo mới thuộc loại "${String(opts?.args?.event ?? '')}" dành cho bạn. Đăng nhập LMS để xem chi tiết.`;
        return key;
      }),
    };
    const service = new MessagingService(
      repo as never, users as never, evaluator as never, {} as never, outbox as never,
      {} as never, unreadStream as never, dispatchQueue as never, siteConfig as never,
      sendThrottle as never, i18n as never,
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

  it('C-5 ban: a minimized provider without minimized variants throws in the test environment instead of leaking the original content', async () => {
    process.env.NODE_ENV = 'test';
    const { service, jobs } = buildService();
    // guardian_digest thuộc diện 'minimized': nội dung trong app là
    // dữ kiện học tập của trẻ gửi cho phụ huynh. Thiếu bản tối thiểu
    // hoá thì notify() phải TỪ CHỐI ở môi trường test — đây là ca
    // cấm fail-được theo hướng ngược lại mà đợt rà soát yêu cầu:
    // nếu ai gỡ cơ chế cấm (quay lại fallback nguyên văn) thì ca
    // này đỏ.
    await expect(service.notify('user-1', 'guardian_digest', {
      subject: 'Full in-app subject', body: 'Full in-app body with child data',
    })).rejects.toThrow('messaging.external_minimization_required');
    // Không job kênh ngoài nào được xếp — nội dung gốc không rời app.
    expect(jobs).toHaveLength(0);
  });

  it('C-5 fallback: outside the test environment a minimized provider without variants gets the generic i18n summary, never the original content', async () => {
    process.env.NODE_ENV = 'production';
    const { service, inserted, jobs } = buildService();
    await service.notify('user-1', 'guardian_digest', {
      subject: 'Full in-app subject', body: 'Full in-app body with child data',
    });
    // Bản trong app giữ nguyên văn; job kênh ngoài chỉ mang bản tóm
    // tắt mặc định (nêu loại sự kiện theo nhãn của provider), không
    // chứa bất kỳ phần nào của nội dung gốc.
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.subject).toBe('Full in-app subject');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.subject).toBe('Bạn có thông báo mới');
    expect(jobs[0]!.body).toBe('Có thông báo mới thuộc loại "Tổng hợp cho phụ huynh" dành cho bạn. Đăng nhập LMS để xem chi tiết.');
    expect(jobs[0]!.subject).not.toBe('Full in-app subject');
    expect(jobs[0]!.body).not.toContain('child data');
  });

  it("C-5 exception: a provider declared 'original-ok' in the registry still sends the original subject/body to external channels", async () => {
    const { service, jobs } = buildService();
    // enrol_welcome khai báo 'original-ok' kèm lý do trong registry
    // (văn bản chào mừng do giáo viên soạn cho chính khoá của mình
    // gửi học viên ghi danh) — ngoại lệ nay là khai báo tường minh
    // kiểm toán được, không còn là fallback im lặng.
    await service.notify('user-1', 'enrol_welcome', {
      subject: 'Welcome', body: 'Welcome body',
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.subject).toBe('Welcome');
    expect(jobs[0]!.body).toBe('Welcome body');
  });

  it('C-5 forced path: sendSystemNotification forces the generic summary on external channels even for an original-ok provider', async () => {
    const { service, inserted, jobs } = buildService();
    // Nội dung đường gửi hệ thống là VĂN BẢN TỰ DO của quản trị
    // viên: áp cứng tối thiểu hoá bất kể registry khai báo
    // grade_updated là 'original-ok', và không ném lỗi kể cả ở môi
    // trường test vì thay thế ở đây là hành vi đã thiết kế.
    const result = await service.sendSystemNotification('admin-1', {
      userId: 'user-1', provider: 'grade_updated',
      subject: 'Free admin subject', body: 'Free admin body',
    });
    expect(result.notificationId).toBe('notif-1');
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.subject).toBe('Free admin subject');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.subject).toBe('Bạn có thông báo mới');
    expect(jobs[0]!.body).toBe('Có thông báo mới thuộc loại "Điểm số thay đổi" dành cho bạn. Đăng nhập LMS để xem chi tiết.');
    expect(jobs[0]!.body).not.toContain('Free admin body');
  });

  it('C-5 registry guard: every provider declares an external policy, and every original-ok declaration carries a reason', () => {
    // Ca gác ở tầng khai báo: thêm provider mới mà không phân loại
    // kênh ngoài — hoặc khai báo 'original-ok' mà không kèm lý do —
    // là ca này đỏ, để điểm mù không quay lại qua đường registry.
    expect(MESSAGE_PROVIDERS.length).toBeGreaterThan(0);
    for (const provider of MESSAGE_PROVIDERS) {
      expect(['minimized', 'original-ok'], `provider ${provider.name} must declare externalPolicy`).toContain(provider.externalPolicy);
      if (provider.externalPolicy === 'original-ok') {
        expect(provider.externalPolicyReason?.trim(), `provider ${provider.name} declared 'original-ok' without a reason`).toBeTruthy();
      }
    }
  });

  it('the email job carries the resolved email frequency for the worker send/digest decision (NB-5)', async () => {
    const { service, jobs } = buildService();
    // grade_updated thuộc nhóm learning → tần suất mặc định 'daily'
    // (P1): job phải mang 'daily' để worker gom vào digest theo ngày
    // thay vì gửi ngay.
    await service.notify('user-1', 'grade_updated', { subject: 'S', body: 'B' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.channel).toBe('email');
    expect(jobs[0]!.emailFrequency).toBe('daily');
    // calendar_reminder thuộc nhóm system → mặc định 'immediate'.
    const second = buildService();
    await second.service.notify('user-1', 'calendar_reminder', { subject: 'S', body: 'B' });
    expect(second.jobs).toHaveLength(1);
    expect(second.jobs[0]!.emailFrequency).toBe('immediate');
  });
});

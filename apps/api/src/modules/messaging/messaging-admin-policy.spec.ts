import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { MessagingService } from './messaging.service';
import { notificationPolicySettingName } from './notification-providers';

/**
 * NB-7 (issue #174): chính sách thông báo của ADMIN ở cấp site +
 * phân tầng bề mặt tuỳ chọn theo vai.
 *
 * - notify() kiểm chính sách admin (site-config
 *   `notifications/provider_<tên>_enabled`) TRƯỚC tuỳ chọn người dùng:
 *   loại bị tắt thì không phát ở kênh nào, kể cả khi tuỳ chọn cá nhân
 *   đang bật, và ghi dispatch log 'skipped-admin-disabled'.
 * - Hai loại bắt buộc P2 không bị chính sách admin chặn (tầng luật ép
 *   bật; API site-config cũng từ chối đặt false cho chúng).
 * - Học sinh (không gán vai nhân sự, không phải site admin): PUT tuỳ
 *   chọn theo loại → 403 ở server; GET preferences chỉ trả phần tối
 *   thiểu (rỗng). Giáo viên/nhân sự giữ hành vi v2 ở phía vai của
 *   mình; tầng audience theo vai + context (issue #288) lọc tiếp bên
 *   trong bề mặt đó — các ca audience nằm ở cuối file này.
 */
describe('MessagingService — admin site policy + student minimal preferences (NB-7)', () => {
  function buildService(opts: {
    disabledProviders?: string[];
    staffAssignment?: boolean;
    siteAdmin?: boolean;
    studentContext?: boolean;
    guardianLink?: boolean;
  } = {}) {
    const disabled = new Set(opts.disabledProviders ?? []);
    const inserted: Record<string, unknown>[] = [];
    const logs: Record<string, unknown>[] = [];
    const jobs: Record<string, unknown>[] = [];
    const storedPrefs = new Map<string, string>();
    const repo = {
      getUserDefaultTenantId: vi.fn(async () => null),
      insertNotification: vi.fn(async (v: Record<string, unknown>) => { inserted.push(v); return { id: 'notif-1', ...v }; }),
      insertDispatchLog: vi.fn(async (v: Record<string, unknown>) => { logs.push(v); return {}; }),
      hasStaffRoleAssignment: vi.fn(async () => opts.staffAssignment ?? false),
      // Hai context vai của tầng audience (issue #288): học sinh
      // (ghi danh/gán vai student) và phụ huynh (liên kết giám hộ).
      hasStudentContext: vi.fn(async () => opts.studentContext ?? false),
      hasActiveGuardianLink: vi.fn(async () => opts.guardianLink ?? false),
    };
    const users = {
      getByIdOrUndefined: vi.fn(async (id: string) => ({ id, suspended: false, deleted: false })),
      getPreference: vi.fn(async (_userId: string, name: string) => storedPrefs.get(name) ?? null),
      setPreference: vi.fn(async (_userId: string, name: string, value: string) => { storedPrefs.set(name, value); }),
    };
    const evaluator = { isSiteAdmin: vi.fn(async () => opts.siteAdmin ?? false) };
    const unreadStream = { signalUnreadCountChanged: vi.fn(async () => undefined) };
    const dispatchQueue = { add: vi.fn(async (_name: string, data: Record<string, unknown>) => { jobs.push(data); }) };
    const outbox = { enqueueStandalone: vi.fn(async () => undefined) };
    const siteConfig = {
      getValue: vi.fn(async (component: string, name: string) => {
        if (component !== 'notifications') return undefined;
        const provider = name.replace(/^provider_/, '').replace(/_enabled$/, '');
        return disabled.has(provider) ? false : undefined;
      }),
    };
    const sendThrottle = { consume: vi.fn(async () => undefined) };
    // I18n (tham số thứ 11, luật C-5 của issue #219): spec này không
    // đi đường bản tóm tắt mặc định cho kênh ngoài nên stub rỗng đủ.
    const service = new MessagingService(
      repo as never, users as never, evaluator as never, {} as never, outbox as never,
      {} as never, unreadStream as never, dispatchQueue as never, siteConfig as never,
      sendThrottle as never, {} as never,
    );
    return { service, inserted, logs, jobs, storedPrefs };
  }

  it('a site-disabled type is skipped on every channel with an admin-disabled log, even when the user preference is on', async () => {
    const { service, inserted, logs, jobs, storedPrefs } = buildService({ disabledProviders: ['grade_updated'] });
    // Tuỳ chọn cá nhân đang BẬT tường minh (khoá v2 = '1').
    storedPrefs.set('message_provider_grade_updated_popup_v2', '1');
    const result = await service.notify('user-1', 'grade_updated', { subject: 'Điểm mới', body: 'Nội dung' });
    expect(result.skipped).toBe('admin-disabled');
    expect(result.notificationId).toBeNull();
    expect(result.channels).toEqual({});
    expect(inserted).toHaveLength(0);
    expect(jobs).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ provider: 'grade_updated', channel: 'popup', status: 'skipped-admin-disabled' });
  });

  it('types the admin has not disabled keep flowing normally', async () => {
    const { service, inserted } = buildService({ disabledProviders: ['grade_updated'] });
    const result = await service.notify('user-1', 'enrol_welcome', { subject: 'Chào mừng', body: 'Nội dung' });
    expect(result.skipped).toBeUndefined();
    expect(inserted).toHaveLength(1);
  });

  it('mandatory P2 types are never blocked by the site policy layer', async () => {
    // Kể cả khi kho dữ liệu có giá trị false (không thể xảy ra qua API
    // vì SiteConfigService chặn, nhưng luật ở notify vẫn phải tự đứng).
    const { service, inserted } = buildService({ disabledProviders: ['enrol_expiry_warning', 'admin_announcement'] });
    for (const provider of ['enrol_expiry_warning', 'admin_announcement']) {
      const result = await service.notify('user-1', provider, {
        subject: 'Bắt buộc', body: 'Nội dung',
        // Luật C-5 (issue #219): admin_announcement thuộc diện tối
        // thiểu hoá kênh ngoài nên lời gọi truyền bản tối thiểu hoá
        // tường minh cho hợp lệ (với enrol_expiry_warning —
        // 'original-ok' — cặp trường này vô hại).
        externalSubject: 'Bắt buộc', externalBody: 'Nội dung',
      });
      expect(result.skipped).toBeUndefined();
    }
    expect(inserted).toHaveLength(2);
  });

  it('a pure student gets 403 on per-type PUT and an empty (minimal) GET', async () => {
    const { service } = buildService({ staffAssignment: false, siteAdmin: false });
    await expect(service.getPreferences('student-1')).resolves.toEqual([]);
    const error = await service.setPreference('student-1', { provider: 'grade_updated', popupEnabled: false })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({ code: 'messaging.preference_staff_only' });
    // Payload lạ cũng nhận cùng một 403 (chặn trước kiểm chứng khác).
    const error2 = await service.setPreference('student-1', { provider: 'khong_ton_tai', popupEnabled: false })
      .catch((e: unknown) => e);
    expect(error2).toBeInstanceOf(ForbiddenException);
  });

  it('teaching staff keep the v2 surface for their side (GET rows + PUT works on staff types)', async () => {
    const { service, storedPrefs } = buildService({ staffAssignment: true });
    const rows = await service.getPreferences('teacher-1');
    // Giáo viên thuần: chỉ phía nhân sự + mọi-vai (10 loại) — phần
    // còn lại của ca này nằm ở các ca audience ngay dưới đây.
    expect(rows.map((r) => r.provider).sort()).toEqual([
      'admin_announcement', 'assignment_submitted', 'badge_awarded', 'calendar_reminder',
      'competency_review_requested', 'contact_request', 'conversation_reported',
      'message_new', 'quiz_attempt_finished', 'report_scheduled',
    ]);
    const view = await service.setPreference('teacher-1', { provider: 'assignment_submitted', popupEnabled: false });
    expect(view.popupEnabled).toBe(false);
    expect(storedPrefs.get('message_provider_assignment_submitted_popup_v2')).toBe('0');
  });

  it('audience split (issue #288): a pure teacher neither sees nor can set student-only or guardian types', async () => {
    const { service } = buildService({ staffAssignment: true });
    const names = (await service.getPreferences('teacher-1')).map((r) => r.provider);
    // Loại chỉ học sinh nhận (báo điểm là ca Lão gia bắt tại trận) và
    // loại của phụ huynh đều vắng khỏi bề mặt của giáo viên thuần.
    for (const hidden of ['grade_updated', 'assignment_assigned', 'assignment_returned', 'quiz_available', 'enrol_welcome', 'guardian_digest', 'guardian_overdue_alert']) {
      expect(names).not.toContain(hidden);
    }
    // PUT thẳng qua API cũng bị server chặn 403 — không chỉ giấu UI.
    for (const provider of ['grade_updated', 'guardian_digest']) {
      const error = await service.setPreference('teacher-1', { provider, popupEnabled: false })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({ code: 'messaging.preference_audience' });
    }
  });

  it('audience split (issue #288): a dual-role user (teaches + learns) sees both sides, guardians only with a guardian link', async () => {
    const dual = buildService({ staffAssignment: true, studentContext: true });
    const dualNames = (await dual.service.getPreferences('dual-1')).map((r) => r.provider);
    expect(dualNames).toContain('grade_updated');
    expect(dualNames).toHaveLength(18);
    expect(dualNames).not.toContain('guardian_digest');
    const put = await dual.service.setPreference('dual-1', { provider: 'grade_updated', popupEnabled: false });
    expect(put.popupEnabled).toBe(false);

    const guardian = buildService({ staffAssignment: true, guardianLink: true });
    const guardianNames = (await guardian.service.getPreferences('guardian-1')).map((r) => r.provider);
    expect(guardianNames).toContain('guardian_digest');
    expect(guardianNames).toContain('guardian_overdue_alert');
    expect(guardianNames).toHaveLength(12);
  });

  it('preference rows expose the site policy as siteEnabled so the settings page can lock admin-disabled types (#288)', async () => {
    // Trang Cài đặt thông báo chỉ HIỂN THỊ được "Admin đã tắt ở cấp
    // site" khi dòng tuỳ chọn mang đúng trạng thái chính sách mà
    // notify() tôn trọng — cùng một hàm đọc chính sách, không suy diễn.
    // Fixture hai vai (dạy + học) để cả hai loại phía học sinh đều
    // nằm trong bề mặt — ca này kiểm siteEnabled, không kiểm audience.
    const { service } = buildService({ staffAssignment: true, studentContext: true, disabledProviders: ['grade_updated', 'enrol_expiry_warning'] });
    const rows = await service.getPreferences('teacher-1');
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    expect(byProvider.get('grade_updated')?.siteEnabled).toBe(false);
    expect(byProvider.get('enrol_welcome')?.siteEnabled).toBe(true);
    // Loại bắt buộc P2: admin không tắt được nên siteEnabled luôn true
    // kể cả khi kho dữ liệu có false (luật ép bật ở tầng chính sách).
    expect(byProvider.get('enrol_expiry_warning')?.siteEnabled).toBe(true);
  });

  it('a site admin without course roles still has the full surface', async () => {
    const { service } = buildService({ staffAssignment: false, siteAdmin: true });
    expect(await service.getPreferences('admin-1')).toHaveLength(20);
  });

  it('the policy setting name follows the registered shape', () => {
    expect(notificationPolicySettingName('grade_updated')).toBe('provider_grade_updated_enabled');
  });
});

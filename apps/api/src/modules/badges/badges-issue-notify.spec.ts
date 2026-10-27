import { describe, expect, it, vi } from 'vitest';
import { BadgesService } from './badges.service';
import { MessagingService, coursePreferenceName } from '../messaging/messaging.service';

/**
 * Ghi nhận badge_awarded (lát #174-A, issue #174): thông báo huy hiệu
 * phải tuân luật ghi đè tắt tiếng theo khoá (NB-4) như mọi loại thông
 * báo gắn khoá khác. Call-site `issueBadge` trước lát này không truyền
 * `courseId` vào `notify()` nên huy hiệu thuộc khoá đã bị người nhận
 * tắt tiếng vẫn phát thông báo. Spec này dựng `BadgesService` với
 * `MessagingService` THẬT (fake repo/users theo đúng khuôn
 * `messaging-course-mute.spec.ts`) để khẳng định HÀNH VI quan sát
 * được ở tầng phân phối:
 *
 * - Huy hiệu vẫn được CẤP (assertion ghi xong) kể cả khi thông báo bị
 *   mute chặn — tắt tiếng chỉ tắt thông báo, không tước huy hiệu.
 * - Khoá bị mute → không sinh dòng thông báo, không xếp job kênh
 *   ngoài, dispatch log ghi đúng một dòng `skipped-course-mute`.
 * - Khoá khác không bị ảnh hưởng; huy hiệu cấp site (không gắn khoá)
 *   vẫn phát bình thường dù người nhận đã mute một khoá bất kỳ.
 */
describe('BadgesService.issueBadge — badge_awarded notification honours the per-course mute (NB-4, #174-A)', () => {
  const MUTED_COURSE = 'course-muted';
  const OPEN_COURSE = 'course-open';

  function buildServices() {
    const insertedNotifications: Record<string, unknown>[] = [];
    const dispatchLogs: Record<string, unknown>[] = [];
    const externalJobs: Record<string, unknown>[] = [];
    const messagingRepo = {
      insertNotification: vi.fn(async (v: Record<string, unknown>) => { insertedNotifications.push(v); return { id: 'notif-1', ...v }; }),
      insertDispatchLog: vi.fn(async (v: Record<string, unknown>) => { dispatchLogs.push(v); return {}; }),
      getUserDefaultTenantId: vi.fn(async () => null),
    };
    const users = {
      getByIdOrUndefined: vi.fn(async (id: string) => ({ id, suspended: false, deleted: false })),
      getPreference: vi.fn(async (_userId: string, name: string) =>
        name === coursePreferenceName(MUTED_COURSE) ? 'mute' : null),
    };
    const unreadStream = { signalUnreadCountChanged: vi.fn(async () => undefined) };
    const dispatchQueue = { add: vi.fn(async (_name: string, data: Record<string, unknown>) => { externalJobs.push(data); }) };
    const notifyOutbox = { enqueueStandalone: vi.fn(async () => undefined) };
    const siteConfig = { getValue: vi.fn(async () => undefined) };
    const sendThrottle = { consume: vi.fn(async () => undefined) };
    const messaging = new MessagingService(
      messagingRepo as never, users as never, {} as never, {} as never, notifyOutbox as never,
      {} as never, unreadStream as never, dispatchQueue as never, siteConfig as never,
      sendThrottle as never,
    );

    const issuedRows: Record<string, unknown>[] = [];
    let badgeRow: Record<string, unknown> = {};
    const badgesRepo = {
      getBadge: vi.fn(async () => badgeRow),
      findIssued: vi.fn(async () => undefined),
      listCriteria: vi.fn(async () => [{ id: 'crit-overall', badgeId: 'b', criteriaType: 'overall', method: 1, params: {} }]),
      dbHandle: { transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})) },
      insertIssued: vi.fn(async (v: Record<string, unknown>) => { const row = { id: 'issued-1', ...v }; issuedRows.push(row); return row; }),
      updateIssued: vi.fn(async () => undefined),
    };
    const outbox = { enqueue: vi.fn(async () => undefined) };
    const i18n = { t: vi.fn((key: string) => key) };
    const badges = new BadgesService(
      badgesRepo as never, {} as never, {} as never, {} as never, {} as never, {} as never,
      {} as never, messaging as never, {} as never, {} as never, {} as never,
      outbox as never, i18n as never, {} as never,
    );
    return {
      badges, insertedNotifications, dispatchLogs, externalJobs, issuedRows,
      setBadge(row: Record<string, unknown>) { badgeRow = row; },
    };
  }

  function badgeOf(courseId: string | null) {
    return {
      id: 'badge-1', name: 'Huy hiệu kiểm chứng', description: null,
      type: courseId ? 2 : 1, courseId, issuerName: 'LMS', issuerUrl: null,
      version: null, expireDate: null, expirePeriod: null, status: 1,
    };
  }

  it('a badge of a muted course is still ISSUED, but its notification is skipped on every channel and logged as skipped-course-mute', async () => {
    const ctx = buildServices();
    ctx.setBadge(badgeOf(MUTED_COURSE));
    const issued = await ctx.badges.issueBadge('badge-1', 'user-1');
    // Huy hiệu vẫn cấp: assertion được ghi và trả về cho người gọi.
    expect(issued.id).toBe('issued-1');
    expect(ctx.issuedRows).toHaveLength(1);
    // Nhưng thông báo bị ghi đè theo khoá chặn ở mọi kênh.
    expect(ctx.insertedNotifications).toHaveLength(0);
    expect(ctx.externalJobs).toHaveLength(0);
    expect(ctx.dispatchLogs).toHaveLength(1);
    expect(ctx.dispatchLogs[0]).toMatchObject({ provider: 'badge_awarded', channel: 'popup', status: 'skipped-course-mute' });
  });

  it('a badge of another (unmuted) course is delivered normally — the mute is per-course, not per-user', async () => {
    const ctx = buildServices();
    ctx.setBadge(badgeOf(OPEN_COURSE));
    const issued = await ctx.badges.issueBadge('badge-1', 'user-1');
    expect(issued.id).toBe('issued-1');
    expect(ctx.insertedNotifications).toHaveLength(1);
    expect(ctx.insertedNotifications[0]).toMatchObject({ eventType: 'badge_awarded' });
    expect(ctx.dispatchLogs.some((l) => l.status === 'delivered' && l.channel === 'popup')).toBe(true);
    expect(ctx.dispatchLogs.some((l) => l.status === 'skipped-course-mute')).toBe(false);
  });

  it('a site badge (no course) is delivered even when the recipient muted some course — there is no course to mute', async () => {
    const ctx = buildServices();
    ctx.setBadge(badgeOf(null));
    const issued = await ctx.badges.issueBadge('badge-1', 'user-1');
    expect(issued.id).toBe('issued-1');
    expect(ctx.insertedNotifications).toHaveLength(1);
    expect(ctx.dispatchLogs.some((l) => l.status === 'skipped-course-mute')).toBe(false);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { BadgeAwardProcessor } from '../../../src/processors/badge-award.processor';
import {
  badge, badgeCriteria, badgeIssued, courseCompletions,
  notificationDispatchLog, notifications, userPreferences,
} from '@lms/db';
import {
  bootWorkerModuleAsOrdinaryRole,
  type OrdinaryWorkerModuleHarness,
} from '../../support/ordinary-worker-module';

/**
 * Lát #174-A (issue #174, khép ghi nhận `badge_awarded` phía worker):
 * đường cấp huy hiệu nền trước đây GHI THẲNG vào bảng `notifications`
 * ngoài hàm luật phân phối chung (lớp G10) — không áp chính sách admin
 * (NB-7), không áp tuỳ chọn người dùng, không ghi dispatch log, và
 * không thể áp ghi đè tắt tiếng theo khoá (NB-4). Sau lát này
 * `BadgeAwardProcessor` phát qua `NotificationDeliveryService` như hai
 * đường NB-6. Oracle hành vi = luật `notify()` phía API sau NB-4:
 *
 * - Huy hiệu thuộc khoá bị người nhận tắt tiếng: assertion VẪN được
 *   cấp, nhưng không sinh thông báo; dispatch log có đúng trạng thái
 *   `skipped-course-mute` cho provider `badge_awarded`.
 * - Huy hiệu thuộc khoá khác / huy hiệu cấp site: thông báo tới bình
 *   thường, dispatch log `delivered`.
 * - Chạy lại job: không cấp trùng, không phát trùng (idempotent như
 *   trước — đường phát mới không phá bất biến này).
 *
 * Fixture theo đúng khuôn `engagement-jobs.spec.ts`: user/khoá/lớp tự
 * tạo với hậu tố duy nhất trên tenant `worker-fixture`, khoá dạy thật
 * phải có class_id (CHECK course_class_required_check, CLASS-0).
 *
 * Từ lát 2 của issue #294, spec này boot WorkerModule qua harness
 * role thường (`test/ordinary-worker-module.ts`): module chạy bằng
 * role NOSUPERUSER/NOBYPASSRLS như production, fixture và đọc kiểm
 * chứng đi qua kết nối quản trị của harness — khẳng định nghiệp vụ
 * của spec không đổi.
 */
describe('Worker #174-A: badge auto-award delivers through the shared delivery law (per-course mute NB-4)', () => {
  let context: INestApplicationContext;
  let harness: OrdinaryWorkerModuleHarness;
  let db: any;
  const suffix = Date.now() % 100000;
  const uid = (slot: number) => `019a0000-0000-7000-8000-${String(980000 + suffix * 10 + slot).padStart(12, '0')}`;
  const mutedUser = uid(1);
  const openUser = uid(2);
  let mutedCourseId = '';
  let openCourseId = '';
  let mutedBadgeId = '';
  let openBadgeId = '';
  let siteBadgeId = '';

  // Lớp fixture cho tenant worker-fixture (chủ lớp là user fixture
  // riêng) — mỗi lần gọi dựng một lớp mới, theo khuôn engagement-jobs.
  async function fixtureClassId(): Promise<string> {
    const ownerId = '01980000-0000-7000-8000-00000000c1a5';
    await db.execute(sql`insert into users (id, username, email, suspended, deleted) values (${ownerId}, 'wk-class-owner', 'wk-class-owner@x.io', false, false) on conflict (id) do nothing`);
    const coh = await db.execute(sql`insert into cohort (tenant_id, name, context_id, component, visible) values ((select id from tenants where slug = 'worker-fixture'), 'wk 174a cohort', '01990000-0000-7000-8000-0000000000a1', 'class', false) returning id`);
    const cohId = (coh.rows[0] as { id: string }).id;
    const cls = await db.execute(sql`insert into classes (tenant_id, name, owner_id, cohort_id) values ((select id from tenants where slug = 'worker-fixture'), 'wk 174a class', ${ownerId}, ${cohId}) returning id`);
    return (cls.rows[0] as { id: string }).id;
  }

  async function fixtureCourse(shortName: string): Promise<string> {
    const catRows = await db.execute(sql`insert into course_categories (name, path, tenant_id) values (${`wk-174a-cat-${shortName}`}, '', (select id from tenants where slug = 'worker-fixture')) returning id`);
    const catId = (catRows.rows[0] as { id: string }).id;
    const courseRows = await db.execute(sql`insert into course (category, tenant_id, full_name, short_name, class_id) values (${catId}, (select tenant_id from course_categories where id = ${catId}), ${`Worker 174A course ${shortName}`}, ${shortName}, ${await fixtureClassId()}) returning id`);
    return (courseRows.rows[0] as { id: string }).id;
  }

  async function mkBadge(name: string, type: number, badgeCourseId: string | null, leafCourseId: string): Promise<string> {
    const [row] = await db.insert(badge).values({ name, type, status: 1, issuerName: 'LMS', courseId: badgeCourseId }).returning();
    await db.insert(badgeCriteria).values({ badgeId: row.id, criteriaType: 'overall', method: 1, params: {} });
    await db.insert(badgeCriteria).values({ badgeId: row.id, criteriaType: 'coursecompletion', method: 1, params: { courseId: leafCourseId } });
    return row.id as string;
  }

  async function badgeNotificationsOf(userId: string) {
    const rows = await db.select().from(notifications).where(and(
      eq(notifications.userIdTo, userId), eq(notifications.eventType, 'badge_awarded'),
    ));
    return rows as { subject: string }[];
  }

  async function badgeDispatchOf(userId: string, status: string) {
    return db.select().from(notificationDispatchLog).where(and(
      eq(notificationDispatchLog.userId, userId),
      eq(notificationDispatchLog.provider, 'badge_awarded'),
      eq(notificationDispatchLog.status, status),
    ));
  }

  beforeAll(async () => {
    harness = await bootWorkerModuleAsOrdinaryRole();
    context = harness.context;
    db = harness.adminDb;
    await db.execute(sql`insert into tenants (slug, name, kind, status) values ('worker-fixture', 'Worker fixture tenant', 'school', 'active') on conflict (slug) do nothing`);
    for (const [id, name] of [[mutedUser, 'muted'], [openUser, 'open']] as const) {
      await db.execute(sql`insert into users (id, username, email, suspended, deleted) values (${id}, ${`wk174a-${name}-${suffix}`}, ${`wk174a-${name}-${suffix}@x.io`}, false, false) on conflict (id) do nothing`);
    }
    mutedCourseId = await fixtureCourse(`wk174am${suffix}`);
    openCourseId = await fixtureCourse(`wk174ao${suffix}`);
    // Cả hai user đều hoàn thành cả hai khoá → đủ tiêu chí cho cả ba huy hiệu.
    for (const userId of [mutedUser, openUser]) {
      for (const courseId of [mutedCourseId, openCourseId]) {
        await db.insert(courseCompletions).values({ userId, course: courseId, status: 'complete', timeStarted: new Date(), timeCompleted: new Date() });
      }
    }
    mutedBadgeId = await mkBadge(`WK174A muted-course badge ${suffix}`, 2, mutedCourseId, mutedCourseId);
    openBadgeId = await mkBadge(`WK174A open-course badge ${suffix}`, 2, openCourseId, openCourseId);
    siteBadgeId = await mkBadge(`WK174A site badge ${suffix}`, 1, null, openCourseId);
    // Người nhận thứ nhất tắt tiếng khoá muted (khoá tuỳ chọn NB-4).
    await db.insert(userPreferences).values({ userId: mutedUser, name: `notif.course.${mutedCourseId}`, value: 'mute' });
  });

  afterAll(async () => { await harness.close(); });

  it('badge of the muted course: assertion issued, notification withheld, dispatch log says skipped-course-mute', async () => {
    const processor = context.get(BadgeAwardProcessor);
    const result = await processor.process({ data: { userId: mutedUser, trigger: 'test-174a' } } as never);
    // Cả ba huy hiệu đều đủ tiêu chí và đều được CẤP cho người này
    // (result.issued là id các assertion vừa ghi — khẳng định theo
    // bảng badgeIssued bên dưới mới là đối chiếu theo huy hiệu).
    expect(result.issued).toHaveLength(3);
    const issued = await db.select().from(badgeIssued).where(eq(badgeIssued.userId, mutedUser));
    expect((issued as { badgeId: string }[]).map((r) => r.badgeId)).toEqual(expect.arrayContaining([mutedBadgeId, openBadgeId, siteBadgeId]));

    const subjects = (await badgeNotificationsOf(mutedUser)).map((n) => n.subject);
    // Huy hiệu của khoá bị mute: KHÔNG có thông báo.
    expect(subjects.some((s) => s.includes('muted-course badge'))).toBe(false);
    // Hai huy hiệu còn lại tới bình thường (mute là theo khoá, không theo người).
    expect(subjects.some((s) => s.includes('open-course badge'))).toBe(true);
    expect(subjects.some((s) => s.includes('site badge'))).toBe(true);

    const muteLogs = await badgeDispatchOf(mutedUser, 'skipped-course-mute');
    expect(muteLogs).toHaveLength(1);
    const deliveredLogs = await badgeDispatchOf(mutedUser, 'delivered');
    expect(deliveredLogs).toHaveLength(2);
  });

  it('a recipient who muted nothing receives all three badge notifications', async () => {
    const processor = context.get(BadgeAwardProcessor);
    await processor.process({ data: { userId: openUser, trigger: 'test-174a' } } as never);
    const subjects = (await badgeNotificationsOf(openUser)).map((n) => n.subject);
    expect(subjects.some((s) => s.includes('muted-course badge'))).toBe(true);
    expect(subjects.some((s) => s.includes('open-course badge'))).toBe(true);
    expect(subjects.some((s) => s.includes('site badge'))).toBe(true);
    expect(await badgeDispatchOf(openUser, 'skipped-course-mute')).toHaveLength(0);
  });

  it('rerunning the job issues nothing twice and sends nothing twice', async () => {
    const processor = context.get(BadgeAwardProcessor);
    const before = await badgeNotificationsOf(mutedUser);
    const rerun = await processor.process({ data: { userId: mutedUser, trigger: 'test-174a' } } as never);
    expect(rerun.issued).toHaveLength(0);
    expect(await badgeNotificationsOf(mutedUser)).toHaveLength(before.length);
    expect(await badgeDispatchOf(mutedUser, 'skipped-course-mute')).toHaveLength(1);
  });
});

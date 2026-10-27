import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { notificationDispatchLog, pluginConfig, userPreferences } from '@lms/db-schema';
import {
  bootWorkerModuleAsOrdinaryRole,
  type OrdinaryWorkerModuleHarness,
} from './ordinary-worker-module';
import { NotificationDispatchProcessor } from '../src/processors/notification-dispatch.processor';
import { NotificationDigestProcessor } from '../src/processors/notification-digest.processor';
import type { WorkerMailMessage, WorkerMailSendResult } from '../src/resend-mail.service';

/**
 * Kênh email thật qua Resend + tổng hợp theo ngày (NB-5, issue #174).
 *
 * Spec chạy trên database test thật của worker, dựng hai processor
 * bằng tay với TRANSPORT GIẢ ghi lại mọi bức mail được yêu cầu gửi —
 * hành vi phải quan sát được ở đây là LUẬT PHÂN PHỐI EMAIL, không
 * phải kết nối Resend thật (transport thật có spec hành vi riêng ở
 * tầng fail-soft: môi trường test không cấu hình khoá thì bỏ qua có
 * khai báo — ca đó khẳng định ở engagement-jobs.spec.ts):
 *
 * - Tần suất `immediate` → gửi ngay đúng một mail tới địa chỉ của
 *   người nhận, mang đúng tiêu đề/thân TỐI THIỂU HOÁ mà job mang
 *   theo (P4), dispatch log chốt `sent`.
 * - Tần suất `daily` → KHÔNG gửi; dispatch log chốt `digest-queued`.
 * - Người dùng tắt email theo loại (tuỳ chọn v2 = off) SAU khi job
 *   đã xếp hàng → lúc phát vẫn bị chặn `skipped-preference` (P2:
 *   kênh ngoài là quyền cá nhân tuyệt đối).
 * - Lượt quét digest gom các mục chờ của một người thành ĐÚNG MỘT
 *   email tổng hợp (thân chỉ gồm các tiêu đề sự kiện), chốt các mục
 *   thành `digest-sent`; người nhận đã bị đình chỉ thì các mục chốt
 *   `skipped-suspended` và không có mail nào; chạy lại lượt quét
 *   không gửi trùng; transport chưa cấu hình thì các mục GIỮ trạng
 *   thái chờ (không mất, không ghi nhận giả).
 * - Luật tại lúc tổng hợp (sửa theo phán quyết review vòng 2 của PR
 *   này): digest kiểm LẠI tuỳ chọn và chính sách site tại lúc gửi —
 *   người dùng tắt email theo loại sau khi xếp hàng thì mục chốt
 *   `skipped-preference`; admin tắt loại ở cấp site (NB-7) thì mục
 *   chốt `skipped-admin-disabled`; loại bắt buộc P2 được miễn trừ
 *   NB-7 như mọi đường phát; transport ném lỗi thì mục giữ trạng
 *   thái chờ và lượt quét không sập.
 *
 * Từ lát 2 của issue #294, spec này boot WorkerModule qua harness
 * role thường (`test/ordinary-worker-module.ts`): module chạy bằng
 * role NOSUPERUSER/NOBYPASSRLS như production. Hai processor tự
 * dựng bằng tay ở đây nhận đúng kết nối role thường của harness
 * (`harness.ordinaryDb`) — đó là phần xử lý cần kiểm chứng dưới
 * RLS; fixture và đọc kiểm chứng đi qua kết nối quản trị của
 * harness — khẳng định nghiệp vụ của spec không đổi.
 */

/** Transport giả: 'sent' ghi lại mail; 'skipped' giả lập chưa cấu hình Resend; 'throw' giả lập Resend trả lỗi thật. */
class FakeMail {
  readonly sent: WorkerMailMessage[] = [];
  mode: 'sent' | 'skipped' | 'throw' = 'sent';
  async send(message: WorkerMailMessage): Promise<WorkerMailSendResult> {
    if (this.mode === 'skipped') return { status: 'skipped', reason: 'resend_not_configured' };
    if (this.mode === 'throw') throw new Error('Resend API trả 500 (giả lập)');
    this.sent.push(message);
    return { status: 'sent', providerId: 'fake-resend-id' };
  }
}

/**
 * I18n giả đọc ĐÚNG catalog thật `src/i18n/vi/platform.json`: khoá
 * digest thiếu trong catalog thì spec đỏ tại đây thay vì lặng lẽ qua.
 */
function buildFakeI18n() {
  const catalog = JSON.parse(
    readFileSync(join(__dirname, '../src/i18n/vi/platform.json'), 'utf-8'),
  ) as Record<string, string>;
  return {
    t: (key: string, opts?: { args?: Record<string, unknown> }) => {
      const template = catalog[key.replace('platform.', '')];
      if (template === undefined) throw new Error(`Missing i18n key in vi catalog: ${key}`);
      return template.replace('{count}', String(opts?.args?.count ?? ''));
    },
  };
}

describe('Worker notification email channel + daily digest (NB-5, issue #174)', () => {
  let context: INestApplicationContext;
  let harness: OrdinaryWorkerModuleHarness;
  let db: any;
  const suffix = Date.now() % 100000;
  const userActive = `01920000-0000-7000-8000-${String(120000 + suffix).padStart(12, '0')}`;
  const userPrefOff = `01920000-0000-7000-8000-${String(220000 + suffix).padStart(12, '0')}`;
  const userSuspended = `01920000-0000-7000-8000-${String(320000 + suffix).padStart(12, '0')}`;
  const userDigest = `01920000-0000-7000-8000-${String(420000 + suffix).padStart(12, '0')}`;
  const userDeferred = `01920000-0000-7000-8000-${String(520000 + suffix).padStart(12, '0')}`;
  const userDigestOff = `01920000-0000-7000-8000-${String(620000 + suffix).padStart(12, '0')}`;
  const userPolicy = `01920000-0000-7000-8000-${String(720000 + suffix).padStart(12, '0')}`;
  const userMandatory = `01920000-0000-7000-8000-${String(820000 + suffix).padStart(12, '0')}`;
  const userThrow = `01920000-0000-7000-8000-${String(920000 + suffix).padStart(12, '0')}`;

  const mail = new FakeMail();
  let dispatch: NotificationDispatchProcessor;
  let digest: NotificationDigestProcessor;

  beforeAll(async () => {
    harness = await bootWorkerModuleAsOrdinaryRole();
    context = harness.context;
    db = harness.adminDb;
    const rows: Array<[string, string, boolean]> = [
      [userActive, `nb5-a-${suffix}`, false],
      [userPrefOff, `nb5-p-${suffix}`, false],
      [userSuspended, `nb5-s-${suffix}`, true],
      [userDigest, `nb5-d-${suffix}`, false],
      [userDeferred, `nb5-x-${suffix}`, false],
      [userDigestOff, `nb5-o-${suffix}`, false],
      [userPolicy, `nb5-y-${suffix}`, false],
      [userMandatory, `nb5-m-${suffix}`, false],
      [userThrow, `nb5-t-${suffix}`, false],
    ];
    for (const [id, username, suspended] of rows) {
      await db.execute(sql`insert into users (id, username, email, suspended, deleted) values (${id}, ${username}, ${`${username}@x.io`}, ${suspended}, false) on conflict (id) do nothing`);
    }
    // Người dùng đã tắt email của calendar_reminder ở tuỳ chọn v2.
    await db.insert(userPreferences).values({
      userId: userPrefOff, name: 'message_provider_calendar_reminder_email_v2', value: 'off',
    }).onConflictDoNothing();
    // Người dùng đã tắt email của grade_updated ở tuỳ chọn v2 — ca
    // digest tôn trọng tuỳ chọn tại lúc tổng hợp dùng người này.
    await db.insert(userPreferences).values({
      userId: userDigestOff, name: 'message_provider_grade_updated_email_v2', value: 'off',
    }).onConflictDoNothing();
    // Hai processor tự dựng bằng tay phải chạy bằng kết nối role
    // thường của harness — dùng `db` quản trị ở đây sẽ đưa phần xử
    // lý cần kiểm chứng quay lại superuser và vô hiệu hoá lát #294.
    dispatch = new NotificationDispatchProcessor(harness.ordinaryDb, mail as never);
    digest = new NotificationDigestProcessor(harness.ordinaryDb, mail as never, buildFakeI18n() as never);
  });
  afterAll(async () => { await harness.close(); });

  const emailJob = (userId: string, dedupeKey: string, extra: Record<string, unknown> = {}) => ({
    data: {
      userId, provider: 'calendar_reminder', channel: 'email',
      subject: 'Nhắc lịch: Buổi học thêm', body: 'Bản tóm tắt cho kênh ngoài.',
      dedupeKey, ...extra,
    },
  }) as never;

  async function logRow(dedupeKey: string) {
    const rows = await db.select().from(notificationDispatchLog)
      .where(eq(notificationDispatchLog.dedupeKey, dedupeKey));
    return rows[0];
  }

  it('immediate frequency sends one real email with the minimized content and logs sent', async () => {
    const before = mail.sent.length;
    const result = await dispatch.process(emailJob(userActive, `nb5-imm-${suffix}`, { emailFrequency: 'immediate' }));
    expect(result.status).toBe('sent');
    expect(mail.sent.length).toBe(before + 1);
    const message = mail.sent[mail.sent.length - 1]!;
    expect(message.to).toBe(`nb5-a-${suffix}@x.io`);
    expect(message.subject).toBe('Nhắc lịch: Buổi học thêm');
    expect(message.text).toBe('Bản tóm tắt cho kênh ngoài.');
    expect((await logRow(`nb5-imm-${suffix}`)).status).toBe('sent');
  });

  it('daily frequency does not send — the dispatch is queued for the daily digest', async () => {
    const before = mail.sent.length;
    const result = await dispatch.process(emailJob(userActive, `nb5-daily-${suffix}`, { emailFrequency: 'daily' }));
    expect(result.status).toBe('digest-queued');
    expect(mail.sent.length).toBe(before);
    expect((await logRow(`nb5-daily-${suffix}`)).status).toBe('digest-queued');
  });

  it('a v2 email opt-out set after enqueueing still suppresses the dispatch (P2)', async () => {
    const before = mail.sent.length;
    const result = await dispatch.process(emailJob(userPrefOff, `nb5-off-${suffix}`, { emailFrequency: 'immediate' }));
    expect(result.status).toBe('skipped-preference');
    expect(mail.sent.length).toBe(before);
    expect((await logRow(`nb5-off-${suffix}`)).status).toBe('skipped-preference');
  });

  async function seedQueued(userId: string, key: string, subject: string, provider = 'grade_updated') {
    await db.insert(notificationDispatchLog).values({
      userId, provider, channel: 'email', status: 'digest-queued',
      subject, dedupeKey: key,
    }).onConflictDoNothing();
  }

  it('the digest sweep sends ONE summary email per user, closes items as digest-sent, and never resends', async () => {
    await seedQueued(userDigest, `nb5-dg1-${suffix}`, 'Có điểm mới: Toán 6');
    await seedQueued(userDigest, `nb5-dg2-${suffix}`, 'Có điểm mới: Văn 6');
    await seedQueued(userDigest, `nb5-dg3-${suffix}`, 'Bài tập mới: Hình học');
    await seedQueued(userSuspended, `nb5-dg4-${suffix}`, 'Có điểm mới: Toán 6');

    const before = mail.sent.length;
    const sweep = await digest.process({} as never);
    // Lượt quét này cũng gom luôn mục tần suất 'daily' của userActive
    // từ ca kiểm trước (cùng database) — tổng: 2 người nhận, 4 mục.
    expect(sweep.usersSent).toBe(2);
    expect(sweep.itemsSent).toBe(4);
    expect(sweep.usersSkipped).toBe(1);
    expect((await logRow(`nb5-daily-${suffix}`)).status).toBe('digest-sent');

    // Đúng một email cho người nhận digest, thân chỉ gồm các tiêu đề
    // sự kiện đã tối thiểu hoá (P4) — không kèm thân chi tiết.
    const digestMails = mail.sent.slice(before).filter((m) => m.to === `nb5-d-${suffix}@x.io`);
    expect(digestMails).toHaveLength(1);
    expect(digestMails[0]!.to).toBe(`nb5-d-${suffix}@x.io`);
    expect(digestMails[0]!.subject).toContain('3');
    expect(digestMails[0]!.text).toContain('Có điểm mới: Toán 6');
    expect(digestMails[0]!.text).toContain('Có điểm mới: Văn 6');
    expect(digestMails[0]!.text).toContain('Bài tập mới: Hình học');

    for (const key of [`nb5-dg1-${suffix}`, `nb5-dg2-${suffix}`, `nb5-dg3-${suffix}`]) {
      expect((await logRow(key)).status).toBe('digest-sent');
    }
    // Người nhận bị đình chỉ: mục chốt skipped-suspended, không mail.
    expect((await logRow(`nb5-dg4-${suffix}`)).status).toBe('skipped-suspended');
    expect(mail.sent.some((m) => m.to === `nb5-s-${suffix}@x.io`)).toBe(false);

    // Chạy lại lượt quét: không còn mục chờ của hai người trên (mục
    // của ca 'daily frequency' ở trên thuộc userActive — lượt quét
    // đầu đã gom cả mục đó; khẳng định ở đây là không có mail digest
    // THỨ HAI nào cho userDigest và trạng thái các mục không đổi).
    const second = await digest.process({} as never);
    expect(mail.sent.filter((m) => m.to === `nb5-d-${suffix}@x.io`)).toHaveLength(1);
    expect(second.itemsSent).toBe(0);
    expect((await logRow(`nb5-dg1-${suffix}`)).status).toBe('digest-sent');
  });

  it('an unconfigured transport leaves queued items pending for a later sweep', async () => {
    await seedQueued(userDeferred, `nb5-dg5-${suffix}`, 'Có điểm mới: Anh 6');
    mail.mode = 'skipped';
    try {
      const sweep = await digest.process({} as never);
      expect(sweep.usersDeferred).toBeGreaterThanOrEqual(1);
      expect(sweep.itemsSent).toBe(0);
      expect((await logRow(`nb5-dg5-${suffix}`)).status).toBe('digest-queued');
    } finally {
      mail.mode = 'sent';
    }
  });

  it('the digest respects a per-provider email opt-out set after queueing (send-time law)', async () => {
    // Hai mục của grade_updated đã xếp hàng chờ; người nhận tắt
    // email của grade_updated ở tuỳ chọn v2 → lượt tổng hợp phải
    // chốt các mục skipped-preference và KHÔNG gửi mail nào cho họ.
    await seedQueued(userDigestOff, `nb5-dg6-${suffix}`, 'Có điểm mới: Sinh 6');
    await seedQueued(userDigestOff, `nb5-dg7-${suffix}`, 'Có điểm mới: Sử 6');
    const sweep = await digest.process({} as never);
    expect(sweep.itemsSuppressedPreference).toBeGreaterThanOrEqual(2);
    expect((await logRow(`nb5-dg6-${suffix}`)).status).toBe('skipped-preference');
    expect((await logRow(`nb5-dg7-${suffix}`)).status).toBe('skipped-preference');
    expect(mail.sent.some((m) => m.to === `nb5-o-${suffix}@x.io`)).toBe(false);
  });

  it('the digest respects the site policy (NB-7) at send time, with the P2 mandatory exemption', async () => {
    // Admin tắt grade_updated và cả admin_announcement ở cấp site
    // SAU khi các mục đã xếp hàng: mục grade_updated bị chặn ở lúc
    // tổng hợp; mục admin_announcement là loại bắt buộc P2 — chính
    // sách site không chặn được nó ở bất kỳ đường phát nào.
    await db.insert(pluginConfig).values({ plugin: 'notifications', name: 'provider_grade_updated_enabled', value: 'false' }).onConflictDoNothing();
    await db.insert(pluginConfig).values({ plugin: 'notifications', name: 'provider_admin_announcement_enabled', value: 'false' }).onConflictDoNothing();
    try {
      await seedQueued(userPolicy, `nb5-dg8-${suffix}`, 'Có điểm mới: Toán 7');
      await seedQueued(userMandatory, `nb5-dg9-${suffix}`, 'Thông báo quản trị & an toàn', 'admin_announcement');
      const sweep = await digest.process({} as never);
      expect(sweep.itemsSuppressedAdmin).toBeGreaterThanOrEqual(1);
      expect((await logRow(`nb5-dg8-${suffix}`)).status).toBe('skipped-admin-disabled');
      expect(mail.sent.some((m) => m.to === `nb5-y-${suffix}@x.io`)).toBe(false);
      // P2: vẫn gửi bình thường bất chấp công tắc site.
      expect((await logRow(`nb5-dg9-${suffix}`)).status).toBe('digest-sent');
      const mandatoryMail = mail.sent.filter((m) => m.to === `nb5-m-${suffix}@x.io`);
      expect(mandatoryMail).toHaveLength(1);
      expect(mandatoryMail[0]!.text).toContain('Thông báo quản trị & an toàn');
    } finally {
      await db.delete(pluginConfig).where(and(
        eq(pluginConfig.plugin, 'notifications'),
        inArray(pluginConfig.name, ['provider_grade_updated_enabled', 'provider_admin_announcement_enabled']),
      ));
    }
  });

  it('a transport error leaves the items queued for the next sweep and does not fail the sweep', async () => {
    await seedQueued(userThrow, `nb5-dg10-${suffix}`, 'Nhắc lịch: Lớp học bù', 'calendar_reminder');
    mail.mode = 'throw';
    try {
      const sweep = await digest.process({} as never);
      expect(sweep.usersFailed).toBeGreaterThanOrEqual(1);
      expect((await logRow(`nb5-dg10-${suffix}`)).status).toBe('digest-queued');
      expect(mail.sent.some((m) => m.to === `nb5-t-${suffix}@x.io`)).toBe(false);
    } finally {
      mail.mode = 'sent';
    }
  });
});

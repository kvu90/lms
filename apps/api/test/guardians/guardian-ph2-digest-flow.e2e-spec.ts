import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD } from '../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from '../support/course-enrolment-helpers';
import { createGradeItem, setGrade } from '../support/assessment-helpers';

/**
 * PH-2 (issue #159) — nửa API của digest phụ huynh: consumer quét
 * outbox (sự kiện do worker chốt bền trong guardian_digests — hình
 * dạng sự kiện khớp apps/worker/test/guardian-digest.spec.ts) và:
 *  - tổng hợp CHỈ dữ liệu đã công bố qua cổng PH-0/DASH1 (item chưa
 *    công bố vắng tuyệt đối, kể cả khỏi số đếm), nội dung thông báo
 *    chỉ gồm số lượng mục + link sâu — không điểm số ở bất kỳ kênh
 *    nào, kênh email nhận bản tối thiểu hoá qua port dispatch (log);
 *  - kiểm lại liên kết tại thời điểm gửi (đã thu hồi → skipped_revoked),
 *    digest rỗng → skipped_empty, phát lại sự kiện không gửi trùng;
 *  - đẩy riêng quá hạn ≥7 ngày qua cùng cơ chế, đúng một lần;
 *  - endpoint tuỳ chọn tần suất theo từng con qua cổng liên kết.
 */
describe('PH-2: digest phụ huynh — consumer + tuỳ chọn (issue #159)', () => {
  let app: INestApplication;
  let admin: string;
  let catId: string;
  let pg: Client;
  let redis: Redis;

  interface Notif { id: string; eventType: string; subject: string; fullMessage: string; contextUrl: string | null }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    catId = (await createCategory(app, admin)).id;
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  }, 120000);
  afterAll(async () => { redis.disconnect(); await pg.end(); await app.close(); });

  /** Khoá mới + học sinh ghi danh + giáo viên editingteacher tại context khoá. */
  async function courseWithPeople() {
    const course = await createCourse(app, admin, catId);
    const instance = await createEnrolInstance(app, admin, course.id);
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const contexts = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const courseCtx = (contexts.body as { id: string; contextLevel: number; instanceId: string }[])
      .find((c) => c.contextLevel === 50 && c.instanceId === course.id)!;
    const teacherUser = await createUserViaApi(app, admin);
    await assignRole(app, admin, teacherUser.id, await roleIdByShortname(app, admin, 'editingteacher'), courseCtx.id);
    const teacher = (await login(app, teacherUser.username, STRONG_PASSWORD)).accessToken;
    return { course, student, teacher };
  }

  async function freshGuardian() {
    const user = await createUserViaApi(app, admin);
    const token = (await login(app, user.username, STRONG_PASSWORD)).accessToken;
    return { user, token };
  }

  async function link(teacher: string, guardianId: string, studentId: string): Promise<string> {
    const res = await http(app).post('/api/v1/guardian-links').set('Authorization', `Bearer ${teacher}`)
      .send({ guardianUserId: guardianId, studentUserId: studentId, relationship: 'Cha' });
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  }

  /** Chốt một vết lượt digest như worker làm + phát sự kiện outbox tương ứng. */
  async function queueDigestEvent(input: {
    guardianId: string; studentId: string; kind: 'weekly' | 'daily';
    windowStart: Date; windowEnd: Date;
  }): Promise<string> {
    const dedupeKey = `digest:${input.guardianId}:${input.studentId}:${input.kind}:${input.windowStart.toISOString()}:e2e-${Date.now()}-${Math.random()}`;
    const ins = await pg.query(
      `insert into guardian_digests (guardian_user_id, student_user_id, kind, window_start, window_end, dedupe_key, status)
       values ($1, $2, $3, $4, $5, $6, 'queued') returning id`,
      [input.guardianId, input.studentId, input.kind, input.windowStart, input.windowEnd, dedupeKey],
    );
    const digestId = (ins.rows[0] as { id: string }).id;
    await pg.query(
      `insert into outbox_events (aggregate, type, payload) values ('guardian', 'guardian_digest_due', $1::jsonb)`,
      [JSON.stringify({
        guardianUserId: input.guardianId, studentUserId: input.studentId, digestId,
        kind: input.kind, windowStart: input.windowStart.toISOString(), windowEnd: input.windowEnd.toISOString(),
      })],
    );
    return digestId;
  }

  async function digestRow(id: string) {
    const res = await pg.query(`select * from guardian_digests where id = $1`, [id]);
    return res.rows[0] as { status: string; new_results_count: number; notification_id: string | null };
  }

  /** Chờ vết lượt rời trạng thái queued (consumer đã xử lý). */
  async function waitDigestStatus(id: string, timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await digestRow(id);
      if (row.status !== 'queued') return row;
      if (Date.now() > deadline) throw new Error(`digest ${id} still queued after ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  async function notificationsOf(token: string): Promise<Notif[]> {
    const res = await http(app).get('/api/v1/notifications/items').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return (res.body as { items: Notif[] }).items;
  }

  async function waitForNotification(token: string, eventType: string, timeoutMs = 25000): Promise<Notif> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = (await notificationsOf(token)).find((n) => n.eventType === eventType);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`notification ${eventType} did not arrive within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  it('digest có kết quả mới ĐÃ CÔNG BỐ: gửi đúng 1 thông báo đếm số mục + link sâu, không điểm số ở mọi kênh, audit có vết', async () => {
    const { course, student, teacher } = await courseWithPeople();
    const { user: guardian, token: guardianToken } = await freshGuardian();
    await link(teacher, guardian.id, student.id);

    const item = await createGradeItem(app, admin, course.id, { itemName: 'Điểm miệng PH2 bí mật', gradeMax: 10 });
    await setGrade(app, teacher, item.id, student.id, 7.25);
    const publish = await http(app).post(`/api/v1/grade-items/${item.id}/publish`)
      .set('Authorization', `Bearer ${teacher}`).send({});
    expect([200, 201]).toContain(publish.status);

    const now = Date.now();
    const digestId = await queueDigestEvent({
      guardianId: guardian.id, studentId: student.id, kind: 'weekly',
      windowStart: new Date(now - 7 * 86_400_000), windowEnd: new Date(now + 86_400_000),
    });

    const notif = await waitForNotification(guardianToken, 'guardian_digest');
    expect(notif.subject).toContain('Tổng hợp tuần');
    expect(notif.fullMessage).toContain('Kết quả mới đã công bố: 1');
    expect(notif.contextUrl).toBe(`/guardian/students/${student.id}`);
    // Không điểm số, không tên item trong nội dung thông báo.
    expect(notif.fullMessage).not.toContain('7.25');
    expect(notif.fullMessage).not.toContain('Điểm miệng PH2 bí mật');
    expect(notif.subject).not.toContain('7.25');

    const row = await waitDigestStatus(digestId);
    expect(row.status).toBe('sent');
    expect(row.new_results_count).toBe(1);
    expect(row.notification_id).toBe(notif.id);

    // Audit: sự kiện guardian_digest_sent mang số đếm, không điểm.
    // Service chốt trạng thái digest TRƯỚC rồi mới ghi audit ở một
    // ghi riêng — chờ sự kiện xuất hiện thay vì khẳng định tức thì
    // (đua thời gian đã gặp ở lượt targeted TENANT-1 #196).
    let audit = await pg.query(
      `select payload::text as text from outbox_events where type = 'guardian_digest_sent' and payload->>'digestId' = $1`, [digestId]);
    const auditDeadline = Date.now() + 10_000;
    while (audit.rows.length === 0 && Date.now() < auditDeadline) {
      await new Promise((r) => setTimeout(r, 300));
      audit = await pg.query(
        `select payload::text as text from outbox_events where type = 'guardian_digest_sent' and payload->>'digestId' = $1`, [digestId]);
    }
    expect(audit.rows).toHaveLength(1);
    expect((audit.rows[0] as { text: string }).text).not.toContain('7.25');

    // Kênh email (port log): job dispatch mang bản tối thiểu hoá —
    // hoặc job còn trong Redis (chưa worker nào xử lý), hoặc worker đã
    // ghi dispatch log; cả hai đều chỉ được chứa subject tối thiểu hoá.
    // TENANT-1 (#196): dedupe_key/jobId mang tiền tố tenant của
    // notification (tenant của liên kết giám hộ).
    const notifRow = await pg.query(`select tenant_id from notifications where id = $1`, [notif.id]);
    const notifTenant = (notifRow.rows[0] as { tenant_id: string | null }).tenant_id;
    expect(notifTenant).toBeTruthy();
    const jobId = `${notifTenant}-dispatch-guardian_digest-${guardian.id}-email-${notif.id}`;
    const jobData = await redis.hget(`bull:notification-dispatch:${jobId}`, 'data');
    if (jobData) {
      expect(jobData).toContain('Thông tin mới về việc học của con');
      expect(jobData).not.toContain('7.25');
      expect(jobData).not.toContain('Điểm miệng PH2 bí mật');
    } else {
      const log = await pg.query(
        `select subject from notification_dispatch_log where dedupe_key = $1`, [jobId]);
      expect(log.rows).toHaveLength(1);
      expect((log.rows[0] as { subject: string }).subject).toBe('Thông tin mới về việc học của con');
    }

    // Phát lại cùng sự kiện (consumer ít-nhất-một-lần): không gửi trùng.
    await pg.query(
      `insert into outbox_events (aggregate, type, payload) values ('guardian', 'guardian_digest_due', $1::jsonb)`,
      [JSON.stringify({
        guardianUserId: guardian.id, studentUserId: student.id, digestId, kind: 'weekly',
        windowStart: new Date(now - 7 * 86_400_000).toISOString(), windowEnd: new Date(now + 86_400_000).toISOString(),
      })],
    );
    await new Promise((r) => setTimeout(r, 2500));
    const all = (await notificationsOf(guardianToken)).filter((n) => n.eventType === 'guardian_digest');
    expect(all).toHaveLength(1);

    // Phụ huynh khác không nhận digest của con người khác.
    const { token: otherToken } = await freshGuardian();
    const otherNotifs = await notificationsOf(otherToken);
    expect(otherNotifs.filter((n) => n.eventType === 'guardian_digest')).toHaveLength(0);
  }, 180000);

  it('item CHƯA công bố: không tính vào digest (số kết quả mới = 0), không rò tên/điểm qua bất kỳ bề mặt nào', async () => {
    const { course, student, teacher } = await courseWithPeople();
    const { user: guardian, token: guardianToken } = await freshGuardian();
    await link(teacher, guardian.id, student.id);

    const item = await createGradeItem(app, admin, course.id, { itemName: 'Điểm chưa công bố PH2', gradeMax: 10 });
    await setGrade(app, teacher, item.id, student.id, 3.75);
    // Chính sách công bố thủ công + không publish — cổng công bố PH-0
    // phải loại item này khỏi digest dù cửa sổ chứa đúng thời điểm chấm.
    const policy = await http(app).put(`/api/v1/grade-items/${item.id}/posting-policy`)
      .set('Authorization', `Bearer ${teacher}`).send({ policy: 'manual' });
    expect(policy.status).toBe(200);

    const now = Date.now();
    const digestId = await queueDigestEvent({
      guardianId: guardian.id, studentId: student.id, kind: 'weekly',
      windowStart: new Date(now - 7 * 86_400_000), windowEnd: new Date(now + 86_400_000),
    });
    const row = await waitDigestStatus(digestId);
    // Digest có thể vẫn gửi nhờ thông báo lớp trong cửa sổ (vd chào
    // mừng ghi danh — thuộc khối thông báo theo quy tắc PH-1), nhưng số
    // kết quả mới PHẢI bằng 0 và vết lượt ghi đúng như vậy.
    expect(row.new_results_count).toBe(0);
    const notifs = await notificationsOf(guardianToken);
    const digestNotifs = notifs.filter((n) => n.eventType === 'guardian_digest');
    for (const n of digestNotifs) {
      expect(n.fullMessage).toContain('Kết quả mới đã công bố: 0');
    }
    expect(JSON.stringify(notifs)).not.toContain('Điểm chưa công bố PH2');
    expect(JSON.stringify(notifs)).not.toContain('3.75');
  }, 180000);

  it('cửa sổ không có gì mới: skipped_empty, không sinh thông báo', async () => {
    const { student, teacher } = await courseWithPeople();
    const { user: guardian, token: guardianToken } = await freshGuardian();
    await link(teacher, guardian.id, student.id);

    // Cửa sổ nằm hoàn toàn trong quá khứ (trước cả ghi danh): không
    // kết quả, không thông báo, không quá hạn/sắp đến hạn nào thuộc về.
    const now = Date.now();
    const digestId = await queueDigestEvent({
      guardianId: guardian.id, studentId: student.id, kind: 'weekly',
      windowStart: new Date(now - 14 * 86_400_000), windowEnd: new Date(now - 7 * 86_400_000),
    });
    const row = await waitDigestStatus(digestId);
    expect(row.status).toBe('skipped_empty');
    const notifs = await notificationsOf(guardianToken);
    expect(notifs.filter((n) => n.eventType === 'guardian_digest')).toHaveLength(0);
  }, 180000);

  it('liên kết đã thu hồi tại thời điểm gửi: skipped_revoked, không gửi gì', async () => {
    const { student, teacher } = await courseWithPeople();
    const { user: guardian, token: guardianToken } = await freshGuardian();
    const linkId = await link(teacher, guardian.id, student.id);

    // Thu hồi TRƯỚC khi chốt sự kiện: lượt digest này mô phỏng vết đã
    // chốt lúc liên kết còn hiệu lực (worker quét trước, thu hồi xảy
    // ra sau) — chốt sự kiện trước rồi mới thu hồi sẽ đua với nhịp
    // quét 500ms của consumer (xử lý lúc liên kết còn active và cửa
    // sổ rỗng thì skipped_empty là đúng nghiệp vụ, ca mất tính xác
    // định — chẩn đoán TENANT-1 #196 trên CI của head a2d43be).
    const revoke = await http(app).delete(`/api/v1/guardian-links/${linkId}`).set('Authorization', `Bearer ${teacher}`);
    expect(revoke.status).toBe(200);

    const now = Date.now();
    const digestId = await queueDigestEvent({
      guardianId: guardian.id, studentId: student.id, kind: 'weekly',
      windowStart: new Date(now - 7 * 86_400_000), windowEnd: new Date(now + 86_400_000),
    });

    const row = await waitDigestStatus(digestId);
    expect(row.status).toBe('skipped_revoked');
    const notifs = await notificationsOf(guardianToken);
    expect(notifs.filter((n) => n.eventType === 'guardian_digest')).toHaveLength(0);
  }, 180000);

  it('đẩy riêng quá hạn ≥7 ngày: thông báo guardian_overdue_alert đúng một lần kể cả khi sự kiện phát lại', async () => {
    const { course, student, teacher } = await courseWithPeople();
    const { user: guardian, token: guardianToken } = await freshGuardian();
    await link(teacher, guardian.id, student.id);

    const dedupeKey = `overdue:${guardian.id}:${student.id}:e2e-cm-${Date.now()}`;
    const ins = await pg.query(
      `insert into guardian_digests (guardian_user_id, student_user_id, kind, activity_cm_id, dedupe_key, status)
       values ($1, $2, 'overdue_alert', $3, $4, 'queued') returning id`,
      [guardian.id, student.id, '01900000-0000-7000-8000-0000000000aa', dedupeKey],
    );
    // activity_cm_id phải là uuid hợp lệ nhưng không cần tồn tại cho nửa API.
    const digestId = (ins.rows[0] as { id: string }).id;
    const payload = {
      guardianUserId: guardian.id, studentUserId: student.id, digestId,
      cmId: '01900000-0000-7000-8000-0000000000aa', activityKind: 'quiz',
      courseId: course.id, activityName: 'Kiểm tra chương 1', dueAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    };
    await pg.query(`insert into outbox_events (aggregate, type, payload) values ('guardian', 'guardian_overdue_alert', $1::jsonb)`, [JSON.stringify(payload)]);

    const notif = await waitForNotification(guardianToken, 'guardian_overdue_alert');
    expect(notif.subject).toContain('Kiểm tra chương 1');
    expect(notif.contextUrl).toBe(`/guardian/students/${student.id}`);
    const row = await waitDigestStatus(digestId);
    expect(row.status).toBe('sent');

    // Kênh email (port log): job dispatch của overdue alert PHẢI dùng
    // subject ngoài TỔNG QUÁT riêng — tên hoạt động chỉ được nằm trong
    // tiêu đề in-app, tuyệt đối không ra kênh ngoài (cùng luật tối
    // thiểu hoá như digest). Hoặc job còn trong Redis, hoặc worker đã
    // ghi dispatch log; cả hai đều chỉ được chứa bản tối thiểu hoá.
    // TENANT-1 (#196): dedupe_key/jobId mang tiền tố tenant như digest.
    const notifRow2 = await pg.query(`select tenant_id from notifications where id = $1`, [notif.id]);
    const notifTenant2 = (notifRow2.rows[0] as { tenant_id: string | null }).tenant_id;
    expect(notifTenant2).toBeTruthy();
    const jobId = `${notifTenant2}-dispatch-guardian_overdue_alert-${guardian.id}-email-${notif.id}`;
    const jobData = await redis.hget(`bull:notification-dispatch:${jobId}`, 'data');
    if (jobData) {
      expect(jobData).toContain('Có việc quá hạn 7 ngày chưa nộp');
      expect(jobData).not.toContain('Kiểm tra chương 1');
    } else {
      const log = await pg.query(
        `select subject from notification_dispatch_log where dedupe_key = $1`, [jobId]);
      expect(log.rows).toHaveLength(1);
      expect((log.rows[0] as { subject: string }).subject).toBe('Có việc quá hạn 7 ngày chưa nộp');
    }

    await pg.query(`insert into outbox_events (aggregate, type, payload) values ('guardian', 'guardian_overdue_alert', $1::jsonb)`, [JSON.stringify(payload)]);
    await new Promise((r) => setTimeout(r, 2500));
    const all = (await notificationsOf(guardianToken)).filter((n) => n.eventType === 'guardian_overdue_alert');
    expect(all).toHaveLength(1);
  }, 180000);

  it('tuỳ chọn tần suất theo con: mặc định weekly, đặt daily/off có hiệu lực, cổng liên kết 404 đồng nhất', async () => {
    const { student, teacher } = await courseWithPeople();
    const { user: guardian, token: guardianToken } = await freshGuardian();
    await link(teacher, guardian.id, student.id);
    const url = `/api/v1/guardian/students/${student.id}/digest-preference`;

    const initial = await http(app).get(url).set('Authorization', `Bearer ${guardianToken}`);
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ studentId: student.id, frequency: 'weekly' });

    const toDaily = await http(app).put(url).set('Authorization', `Bearer ${guardianToken}`).send({ frequency: 'daily' });
    expect(toDaily.status).toBe(200);
    expect(toDaily.body).toMatchObject({ frequency: 'daily' });
    const afterDaily = await http(app).get(url).set('Authorization', `Bearer ${guardianToken}`);
    expect(afterDaily.body).toMatchObject({ frequency: 'daily' });

    const toOff = await http(app).put(url).set('Authorization', `Bearer ${guardianToken}`).send({ frequency: 'off' });
    expect(toOff.status).toBe(200);
    expect(toOff.body).toMatchObject({ frequency: 'off' });

    const invalid = await http(app).put(url).set('Authorization', `Bearer ${guardianToken}`).send({ frequency: 'monthly' });
    expect(invalid.status).toBe(400);

    // Không liên kết → 404 đồng nhất cho cả đọc lẫn ghi; học sinh cũng không tự đặt được cho mình.
    const { token: strangerToken } = await freshGuardian();
    const strangerGet = await http(app).get(url).set('Authorization', `Bearer ${strangerToken}`);
    expect(strangerGet.status).toBe(404);
    const strangerPut = await http(app).put(url).set('Authorization', `Bearer ${strangerToken}`).send({ frequency: 'daily' });
    expect(strangerPut.status).toBe(404);
    const ghost = await http(app).get(`/api/v1/guardian/students/01900000-0000-7000-8000-0000000000ff/digest-preference`)
      .set('Authorization', `Bearer ${guardianToken}`);
    expect(ghost.status).toBe(404);
  }, 180000);
});

import { and, asc, eq, inArray, isNotNull, lte, ne, sql as drizzleSql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'kysely';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CentreDb } from '../client';
import {
  assignments as assignmentsTable,
  assignSubmissions,
  courseModules,
  courseModulesCompletion,
  examAttempts,
  examPins,
  examVersions,
} from '../index';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { createTestKysely } from '../test-support/create-test-kysely';
import {
  runInTestPlatformContext,
  runInTestTenantContext,
  TestTenantPool,
} from '../test-support/tenant-context';
import { GuardianViewRepository } from './guardian-view';
import { GuardiansRepository } from './guardians';

/**
 * Spec tích hợp của hai repository giám hộ trên Kysely (issue #649):
 * repository liên kết giám hộ và repository bề mặt phụ huynh chỉ-xem.
 *
 * Database trung tâm được dựng từ rỗng bằng chính cầu nối migration
 * của package trên cụm PostgreSQL thật của môi trường test (biến
 * `LMS_DB_TEST_ADMIN_URL` ghi đè cụm khi cần, mặc định suy từ
 * `DATABASE_URL` của package). Mọi ca chạy qua repository production
 * — không mô phỏng handle — trong ngữ cảnh tenant qua pool gắn GUC
 * như đường production.
 *
 * Ngoài hành vi của từng phương thức, spec này là bằng chứng nghiệm
 * thu "phạm vi dữ kiện chỉ-đọc giữ nguyên trước/sau" của bề mặt phụ
 * huynh: hai truy vấn khó nhất (quiz có hạn nộp và đếm tiến độ theo
 * khoá) được chạy SONG SONG bằng hai bản thực thi — bản Drizzle cũ
 * (sao nguyên văn từ repository phía ứng dụng trước chuyển đổi, giữ
 * lại trong file này chỉ để đối chiếu) và bản Kysely mới — trên
 * CÙNG một bộ dữ kiện mẫu, và kết quả phải khớp nhau từng dòng.
 * Dữ kiện mẫu được dựng có chủ đích để bắt đúng điểm nóng của nhóm:
 * - Một attempt xem trước (preview = true) cạnh một attempt thật:
 *   điều kiện preview nằm trong ON của left join nên quiz chỉ có
 *   đúng một dòng với trạng thái của attempt thật.
 * - Một module có dòng hoàn thành ở trạng thái 0: điều kiện
 *   completion_state <> 0 nằm trong ON của left join nên module vẫn
 *   tính vào tổng số, chỉ không tính vào số đã hoàn thành; dòng hoàn
 *   thành của HỌC SINH KHÁC trên cùng module không được rò vào đếm.
 */
const TEST_DATABASE = 'lms_db_g649_guardians';
const TEST_ROLE = 'lms_db_g649_guardians';
const TEST_ROLE_PASSWORD = 'lms_db_g649_guardians_pw';

const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : undefined);

const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const QUIZ_DUE_AT = new Date('2026-11-05T10:00:00.000Z');
const ASSIGN_DUE_AT = new Date('2026-11-04T10:00:00.000Z');
const UNTIL = new Date('2026-11-06T00:00:00.000Z');

let tenantPool: TestTenantPool;
let db: CentreDb;
let drizzleDb: NodePgDatabase;
let linksRepo: GuardiansRepository;
let viewRepo: GuardianViewRepository;

let tenantId = '';
let guardianId = '';
let studentId = '';
let otherStudentId = '';
let courseId = '';
let cmQuizId = '';
let cmAssignId = '';

/** Bản thực thi Drizzle cũ của quizDueRows (sao nguyên văn để đối chiếu trước/sau). */
async function oldQuizDueRows(courseIds: string[], studentUserId: string, until: Date) {
  if (!courseIds.length) return [];
  return drizzleDb
    .select({
      cmId: courseModules.id,
      courseId: courseModules.course,
      name: drizzleSql<string>`coalesce(${examPins.name}, ${examVersions.name})`,
      dueAt: examPins.timeClose,
      attemptState: examAttempts.state,
    })
    .from(courseModules)
    .innerJoin(examPins, eq(examPins.id, courseModules.instanceId))
    .innerJoin(examVersions, eq(examVersions.id, examPins.examVersionId))
    .leftJoin(examAttempts, and(
      eq(examAttempts.pinId, examPins.id),
      eq(examAttempts.userId, studentUserId),
      eq(examAttempts.preview, false),
    ))
    .where(and(
      inArray(courseModules.course, courseIds),
      eq(courseModules.component, 'mod_quiz'),
      eq(courseModules.visible, true),
      eq(courseModules.deletionInProgress, false),
      isNotNull(examPins.timeClose),
      lte(examPins.timeClose, until),
    ))
    .orderBy(asc(examPins.timeClose));
}

/** Bản thực thi Drizzle cũ của courseProgressRows (sao nguyên văn để đối chiếu trước/sau). */
async function oldCourseProgressRows(courseIds: string[], studentUserId: string) {
  if (!courseIds.length) return [];
  return drizzleDb
    .select({
      courseId: courseModules.course,
      total: drizzleSql<number>`count(*)::int`,
      completed: drizzleSql<number>`count(${courseModulesCompletion.id})::int`,
    })
    .from(courseModules)
    .leftJoin(courseModulesCompletion, and(
      eq(courseModulesCompletion.courseModuleId, courseModules.id),
      eq(courseModulesCompletion.userId, studentUserId),
      ne(courseModulesCompletion.completionState, 0),
    ))
    .where(and(
      inArray(courseModules.course, courseIds),
      eq(courseModules.visible, true),
      eq(courseModules.deletionInProgress, false),
      ne(courseModules.completion, 0),
    ))
    .groupBy(courseModules.course);
}

/** Bản thực thi Drizzle cũ của assignmentDueRows (sao nguyên văn để đối chiếu trước/sau). */
async function oldAssignmentDueRows(courseIds: string[], studentUserId: string, until: Date) {
  if (!courseIds.length) return [];
  return drizzleDb
    .select({
      cmId: courseModules.id,
      courseId: courseModules.course,
      name: assignmentsTable.name,
      dueAt: assignmentsTable.dueDate,
      submissionStatus: assignSubmissions.status,
    })
    .from(courseModules)
    .innerJoin(assignmentsTable, eq(assignmentsTable.id, courseModules.instanceId))
    .leftJoin(assignSubmissions, and(
      eq(assignSubmissions.assignmentId, assignmentsTable.id),
      eq(assignSubmissions.userId, studentUserId),
    ))
    .where(and(
      inArray(courseModules.course, courseIds),
      eq(courseModules.component, 'mod_assign'),
      eq(courseModules.visible, true),
      eq(courseModules.deletionInProgress, false),
      isNotNull(assignmentsTable.dueDate),
      lte(assignmentsTable.dueDate, until),
    ))
    .orderBy(asc(assignmentsTable.dueDate));
}

/** Chèn một course module mẫu và trả id. */
async function insertCm(values: {
  component: string;
  instanceId?: string | null;
  completion: number;
  visible?: boolean;
  sectionId: string;
}): Promise<string> {
  const row = await db
    .insertInto('course_modules')
    .values({
      component: values.component,
      course: courseId,
      section: values.sectionId,
      instance_id: values.instanceId ?? null,
      completion: values.completion,
      visible: values.visible ?? true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

beforeAll(async () => {
  if (!adminUrl) {
    throw new Error(
      'Thiếu kết nối quản trị cho spec tích hợp G9: đặt LMS_DB_TEST_ADMIN_URL hoặc DATABASE_URL.',
    );
  }
  const adminStoreUrl = await buildTestDatabase({
    adminUrl,
    database: TEST_DATABASE,
    store: 'centre',
  });

  const admin = new Client({ connectionString: adminStoreUrl });
  await admin.connect();
  try {
    await admin.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${TEST_ROLE}') THEN
           CREATE ROLE "${TEST_ROLE}" LOGIN NOSUPERUSER PASSWORD '${TEST_ROLE_PASSWORD}';
         END IF;
       END $$;`,
    );
    await admin.query(`ALTER ROLE "${TEST_ROLE}" WITH LOGIN NOSUPERUSER PASSWORD '${TEST_ROLE_PASSWORD}'`);
    await admin.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "${TEST_ROLE}"`);
    await admin.query(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "${TEST_ROLE}"`);
  } finally {
    await admin.end();
  }

  const roleUrl = new URL(adminStoreUrl);
  roleUrl.username = TEST_ROLE;
  roleUrl.password = TEST_ROLE_PASSWORD;

  tenantPool = new TestTenantPool({ connectionString: roleUrl.toString() });
  db = createTestKysely(tenantPool).centre;
  drizzleDb = drizzle({ client: tenantPool });
  linksRepo = new GuardiansRepository(db);
  viewRepo = new GuardianViewRepository(db);

  tenantId = await runInTestPlatformContext(async () => {
    const row = await db
      .insertInto('tenants')
      .values({ slug: 'g649-alpha', name: 'Trung tâm G9', kind: 'centre' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  });

  await runInTestTenantContext(tenantId, async () => {
    const mkUser = async (username: string): Promise<string> => {
      const row = await db
        .insertInto('users')
        .values({ email: `${username}@example.test`, username })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    };
    guardianId = await mkUser('g649-guardian');
    studentId = await mkUser('g649-student');
    otherStudentId = await mkUser('g649-student-other');

    const category = await db
      .insertInto('course_categories')
      .values({ name: 'Danh mục G9', tenant_id: tenantId })
      .returning('id')
      .executeTakeFirstOrThrow();
    const course = await db
      .insertInto('course')
      .values({
        category: category.id,
        full_name: 'Khoá học G9',
        short_name: 'G9',
        tenant_id: tenantId,
        is_template: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    courseId = course.id;
    const section = await db
      .insertInto('course_sections')
      .values({ course: courseId })
      .returning('id')
      .executeTakeFirstOrThrow();

    // Chuỗi đề thi: ngân hàng → đề → phiên bản → pin (pin không đặt
    // tên riêng để kiểm chứng coalesce lấy tên của phiên bản đề).
    const bank = await db
      .insertInto('question_banks')
      .values({
        tenant_id: tenantId,
        name: 'Ngân hàng G9',
        scope: 'school',
        context_id: courseId,
        created_by: guardianId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const exam = await db
      .insertInto('exams')
      .values({ bank_id: bank.id, created_by: guardianId })
      .returning('id')
      .executeTakeFirstOrThrow();
    const version = await db
      .insertInto('exam_versions')
      .values({ exam_id: exam.id, created_by: guardianId, name: 'Đề kiểm tra mẫu', version: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    const pin = await db
      .insertInto('exam_pins')
      .values({
        exam_id: exam.id,
        exam_version_id: version.id,
        course_id: courseId,
        created_by: guardianId,
        name: null,
        time_close: QUIZ_DUE_AT,
        variants: sql`'[]'::jsonb`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const latePin = await db
      .insertInto('exam_pins')
      .values({
        exam_id: exam.id,
        exam_version_id: version.id,
        course_id: courseId,
        created_by: guardianId,
        name: 'Đề muộn',
        time_close: new Date('2026-12-01T10:00:00.000Z'),
        variants: sql`'[]'::jsonb`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // Bài tập và bài nộp của học sinh.
    const assignment = await db
      .insertInto('assignments')
      .values({ course: courseId, name: 'Bài tập về nhà', due_date: ASSIGN_DUE_AT })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('assign_submissions')
      .values({ assignment_id: assignment.id, user_id: studentId, status: 'submitted' })
      .execute();

    // Các course module của khoá: hai module có hạn nộp, một module
    // thường có theo dõi hoàn thành, một module không theo dõi và
    // một module ẩn — hai module cuối không được tính vào tiến độ.
    cmQuizId = await insertCm({ component: 'mod_quiz', instanceId: pin.id, completion: 2, sectionId: section.id });
    cmAssignId = await insertCm({ component: 'mod_assign', instanceId: assignment.id, completion: 1, sectionId: section.id });
    const cmPageId = await insertCm({ component: 'mod_page', completion: 1, sectionId: section.id });
    await insertCm({ component: 'mod_quiz', instanceId: latePin.id, completion: 0, sectionId: section.id });
    await insertCm({ component: 'mod_page', completion: 0, sectionId: section.id });
    await insertCm({ component: 'mod_page', completion: 2, visible: false, sectionId: section.id });

    // Attempt thật (đã chốt) và attempt xem trước trên cùng pin.
    const usageReal = await db
      .insertInto('question_usages')
      .values({ component: 'mod_quiz', user_id: studentId })
      .returning('id')
      .executeTakeFirstOrThrow();
    const usagePreview = await db
      .insertInto('question_usages')
      .values({ component: 'mod_quiz', user_id: studentId })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('exam_attempts')
      .values({
        pin_id: pin.id,
        user_id: studentId,
        usage_id: usageReal.id,
        attempt_number: 1,
        state: 'finished',
        preview: false,
      })
      .execute();
    await db
      .insertInto('exam_attempts')
      .values({
        pin_id: pin.id,
        user_id: studentId,
        usage_id: usagePreview.id,
        attempt_number: 2,
        state: 'inprogress',
        preview: true,
      })
      .execute();

    // Trạng thái hoàn thành: cmQuiz đã xong (2), cmAssign ở trạng
    // thái 0 (chưa xong), cmPage chỉ có dòng của học sinh khác.
    await db
      .insertInto('course_modules_completion')
      .values({ course_module_id: cmQuizId, user_id: studentId, completion_state: 2, viewed: true })
      .execute();
    await db
      .insertInto('course_modules_completion')
      .values({ course_module_id: cmAssignId, user_id: studentId, completion_state: 0, viewed: true })
      .execute();
    await db
      .insertInto('course_modules_completion')
      .values({ course_module_id: cmPageId, user_id: otherStudentId, completion_state: 2, viewed: true })
      .execute();
    await db
      .insertInto('course_modules_completion')
      .values({ course_module_id: cmAssignId, user_id: otherStudentId, completion_state: 2, viewed: true })
      .execute();

    // Thông báo: hai thông báo cho học sinh (khác thời điểm), một
    // thông báo cho học sinh khác không được lọt vào danh sách.
    const mkNotification = async (userIdTo: string, subject: string, createdAt: Date): Promise<void> => {
      await db
        .insertInto('notifications')
        .values({
          user_id_to: userIdTo,
          subject,
          full_message: `Nội dung ${subject}`,
          event_type: 'course_announcement',
          context_url: `/courses/${courseId}/announce`,
          tenant_id: tenantId,
          created_at: createdAt,
        })
        .execute();
    };
    await mkNotification(studentId, 'Thông báo cũ', new Date('2026-11-01T08:00:00.000Z'));
    await mkNotification(studentId, 'Thông báo mới', new Date('2026-11-02T08:00:00.000Z'));
    await mkNotification(otherStudentId, 'Thông báo của người khác', new Date('2026-11-03T08:00:00.000Z'));
  });
}, 180_000);

afterAll(async () => {
  if (tenantPool) await tenantPool.end();
  if (adminUrl) {
    await dropTestDatabase(adminUrl, TEST_DATABASE);
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`DROP ROLE IF EXISTS "${TEST_ROLE}"`);
    } finally {
      await admin.end();
    }
  }
}, 60_000);

describe('GuardiansRepository trên database thật', () => {
  it('insertLink chèn liên kết và trả dòng có id UUIDv7; findActiveLink chỉ khớp liên kết đang hiệu lực của đúng cặp', async () => {
    await runInTestTenantContext(tenantId, async () => {
      const link = await linksRepo.insertLink({
        tenantId,
        guardianUserId: guardianId,
        studentUserId: studentId,
        relationship: 'mother',
        status: 'active',
        createdBy: guardianId,
        note: null,
      });
      expect(link.id).toMatch(UUIDV7_PATTERN);
      expect(link.status).toBe('active');
      expect(link.revokedAt).toBeNull();

      await expect(linksRepo.findActiveLink(guardianId, studentId)).resolves.toMatchObject({ id: link.id });
      await expect(linksRepo.findActiveLink(guardianId, otherStudentId)).resolves.toBeUndefined();
      await expect(linksRepo.getLink(link.id)).resolves.toMatchObject({ relationship: 'mother' });
    });
  });

  it('listLinks lọc theo từng trường và kết hợp nhiều trường; thu hồi xong thì liên kết rời khỏi tập đang hiệu lực', async () => {
    await runInTestTenantContext(tenantId, async () => {
      const all = await linksRepo.listLinks({});
      expect(all.length).toBeGreaterThanOrEqual(1);
      await expect(linksRepo.listLinks({ guardianUserId: guardianId })).resolves.toHaveLength(all.length);
      await expect(linksRepo.listLinks({ guardianUserId: guardianId, status: 'revoked' })).resolves.toEqual([]);

      const link = (await linksRepo.findActiveLink(guardianId, studentId))!;
      await linksRepo.updateLink(link.id, { status: 'revoked', revokedBy: guardianId, revokedAt: new Date() });

      await expect(linksRepo.findActiveLink(guardianId, studentId)).resolves.toBeUndefined();
      const revoked = await linksRepo.listLinks({ status: 'revoked' });
      expect(revoked).toHaveLength(1);
      expect(revoked[0]).toMatchObject({ id: link.id, revokedBy: guardianId });
      expect(revoked[0]!.revokedAt).toBeInstanceOf(Date);
    });
  });
});

describe('GuardianViewRepository trên database thật', () => {
  it('touchViewState tạo mốc lần đầu và cập nhật cùng một dòng ở các lần sau', async () => {
    await runInTestTenantContext(tenantId, async () => {
      await expect(viewRepo.getViewState(guardianId, studentId)).resolves.toBeUndefined();
      const first = new Date('2026-11-02T09:00:00.000Z');
      const second = new Date('2026-11-03T09:00:00.000Z');
      await viewRepo.touchViewState(guardianId, studentId, first);
      await expect(viewRepo.getViewState(guardianId, studentId)).resolves.toMatchObject({ lastSeenAt: first });
      await viewRepo.touchViewState(guardianId, studentId, second);
      const state = await viewRepo.getViewState(guardianId, studentId);
      expect(state?.lastSeenAt).toEqual(second);
      await expect(viewRepo.getViewState(guardianId, otherStudentId)).resolves.toBeUndefined();
    });
  });

  it('quizDueRows: chỉ attempt thật được nối (attempt xem trước không sinh dòng), tên lấy từ phiên bản đề khi pin không có tên — khớp bản Drizzle cũ trên cùng dữ kiện', async () => {
    await runInTestTenantContext(tenantId, async () => {
      const rows = await viewRepo.quizDueRows([courseId], studentId, UNTIL);
      expect(rows).toEqual([
        {
          cmId: cmQuizId,
          courseId,
          name: 'Đề kiểm tra mẫu',
          dueAt: QUIZ_DUE_AT,
          attemptState: 'finished',
        },
      ]);
      const before = await oldQuizDueRows([courseId], studentId, UNTIL);
      expect(rows).toEqual(before);
    });
  });

  it('assignmentDueRows: bài tập kèm trạng thái bài nộp của học sinh — khớp bản Drizzle cũ trên cùng dữ kiện', async () => {
    await runInTestTenantContext(tenantId, async () => {
      const rows = await viewRepo.assignmentDueRows([courseId], studentId, UNTIL);
      expect(rows).toEqual([
        {
          cmId: cmAssignId,
          courseId,
          name: 'Bài tập về nhà',
          dueAt: ASSIGN_DUE_AT,
          submissionStatus: 'submitted',
        },
      ]);
      const before = await oldAssignmentDueRows([courseId], studentId, UNTIL);
      expect(rows).toEqual(before);
    });
  });

  it('recentNotificationsForStudent: chỉ thông báo của đúng học sinh, mới nhất trước', async () => {
    await runInTestTenantContext(tenantId, async () => {
      const rows = await viewRepo.recentNotificationsForStudent(studentId, 10);
      expect(rows.map((r) => r.subject)).toEqual(['Thông báo mới', 'Thông báo cũ']);
      expect(rows[0]).toMatchObject({
        fullMessage: 'Nội dung Thông báo mới',
        eventType: 'course_announcement',
        contextUrl: `/courses/${courseId}/announce`,
      });
      expect(rows[0]!.createdAt).toEqual(new Date('2026-11-02T08:00:00.000Z'));
    });
  });

  it('courseProgressRows: module có trạng thái hoàn thành 0 vẫn tính vào tổng nhưng không tính đã xong (điều kiện nằm trong ON) — khớp bản Drizzle cũ trên cùng dữ kiện', async () => {
    await runInTestTenantContext(tenantId, async () => {
      const rows = await viewRepo.courseProgressRows([courseId], studentId);
      expect(rows).toEqual([{ courseId, total: 3, completed: 1 }]);
      const before = await oldCourseProgressRows([courseId], studentId);
      expect(rows).toEqual(before);
    });
  });
});

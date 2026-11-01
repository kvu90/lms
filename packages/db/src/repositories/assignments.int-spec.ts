import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CentreDb } from '../client';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { createTestKysely } from '../test-support/create-test-kysely';
import {
  runInTestPlatformContext,
  runInTestTenantContext,
  TestTenantPool,
} from '../test-support/tenant-context';
import { AssignmentsRepository } from './assignments';

/**
 * Spec tích hợp của repository bài tập trên Kysely (issue #649).
 *
 * Database trung tâm được dựng từ rỗng bằng chính cầu nối migration
 * của package trên cụm PostgreSQL thật của môi trường test (biến
 * `LMS_DB_TEST_ADMIN_URL` ghi đè cụm khi cần, mặc định suy từ
 * `DATABASE_URL` của package). Mọi ca chạy qua repository production
 * trong ngữ cảnh tenant qua pool gắn GUC như đường production.
 *
 * Các bất biến được khoá ở đây là hợp đồng của đường Drizzle trước
 * đây mà tầng service dựa vào:
 * - Gói chấm và kết quả theo tiêu chí ghi/đè theo khoá duy nhất tự
 *   nhiên, nhánh cập nhật khi trùng ghi `null` tường minh cho các
 *   trường kết quả vắng mặt (ghi đè là thay toàn bộ, không giữ
 *   trường cũ).
 * - Cột jsonb `points` của dấu chấm đọc lại đúng mảng điểm đã ghi
 *   (đường ghi serialize tường minh + `::jsonb`), patch không nhắc
 *   tới `points` thì mảng điểm giữ nguyên, patch `points: null` thì
 *   xoá mảng điểm.
 * - Thứ tự các danh sách theo thứ tự tạo/hiển thị như đường cũ.
 */
const TEST_DATABASE = 'lms_db_g649_assignments';
const TEST_ROLE = 'lms_db_g649_assignments';
const TEST_ROLE_PASSWORD = 'lms_db_g649_assignments_pw';

const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : undefined);

const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let tenantPool: TestTenantPool;
let db: CentreDb;
let repo: AssignmentsRepository;

let tenantId = '';
let teacherId = '';
let studentId = '';
let courseId = '';
let fileId = '';

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
  repo = new AssignmentsRepository(db);

  tenantId = await runInTestPlatformContext(async () => {
    const row = await db
      .insertInto('tenants')
      .values({ slug: 'g649-assignments', name: 'Trung tâm G9 assignments', kind: 'centre' })
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
    teacherId = await mkUser('g649-a-teacher');
    studentId = await mkUser('g649-a-student');

    const category = await db
      .insertInto('course_categories')
      .values({ name: 'Danh mục G9 assignments', tenant_id: tenantId })
      .returning('id')
      .executeTakeFirstOrThrow();
    const course = await db
      .insertInto('course')
      .values({ category: category.id, full_name: 'Khoá G9 assignments', short_name: 'G9A', tenant_id: tenantId, is_template: true })
      .returning('id')
      .executeTakeFirstOrThrow();
    courseId = course.id;

    const file = await db
      .insertInto('files')
      .values({
        component: 'mod_assign',
        context_id: courseId,
        file_area: 'submission_files',
        file_name: 'bai-nop.png',
        content_hash: 'g649-hash',
        file_size: 128,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    fileId = file.id;
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

describe('AssignmentsRepository — bài tập, bài nộp và tệp', () => {
  it('insertAssignment/getAssignment/listAssignmentsInCourse/updateAssignment/deleteAssignment giữ đúng hợp đồng', async () => {
    await runInTestTenantContext(tenantId, async () => {
      const created = await repo.insertAssignment({
        course: courseId, cmId: null, name: 'Bài tập 1', intro: '',
        dueDate: new Date('2026-11-10T10:00:00.000Z'), maxFiles: 5,
        acceptedFileTypes: null, grade: 10, resultMode: 'score_feedback',
      });
      expect(created.id).toMatch(UUIDV7_PATTERN);
      expect(created.maxFiles).toBe(5);
      await expect(repo.getAssignment(created.id)).resolves.toMatchObject({ name: 'Bài tập 1' });
      await expect(repo.listAssignmentsInCourse(courseId)).resolves.toHaveLength(1);

      await repo.updateAssignment(created.id, { name: 'Bài tập 1 (đổi tên)', cmId: null });
      const updated = await repo.getAssignment(created.id);
      expect(updated?.name).toBe('Bài tập 1 (đổi tên)');
      expect(updated?.grade).toBe(10);

      await repo.deleteAssignment(created.id);
      await expect(repo.getAssignment(created.id)).resolves.toBeUndefined();
    });
  });

  it('bài nộp và quan hệ tệp: chèn, cập nhật trạng thái nộp, liệt kê và gỡ tệp', async () => {
    await runInTestTenantContext(tenantId, async () => {
      const assignment = await repo.insertAssignment({
        course: courseId, cmId: null, name: 'Bài tập nộp tệp', intro: '',
        dueDate: null, maxFiles: 10, acceptedFileTypes: null, grade: 10, resultMode: 'score_feedback',
      });
      const submission = await repo.insertSubmission({ assignmentId: assignment.id, userId: studentId, status: 'draft', attemptNumber: 1 });
      expect(submission.status).toBe('draft');
      await expect(repo.getSubmission(assignment.id, studentId)).resolves.toMatchObject({ id: submission.id });

      const submittedAt = new Date('2026-11-03T09:00:00.000Z');
      await repo.updateSubmission(submission.id, { status: 'submitted', submittedAt });
      await expect(repo.getSubmission(assignment.id, studentId)).resolves.toMatchObject({ status: 'submitted', submittedAt });
      await expect(repo.listSubmissions(assignment.id)).resolves.toHaveLength(1);

      const link = await repo.insertSubmissionFile({ submissionId: submission.id, fileId });
      expect(link.fileId).toBe(fileId);
      await expect(repo.listSubmissionFiles(submission.id)).resolves.toHaveLength(1);
      await repo.deleteSubmissionFile(submission.id, fileId);
      await expect(repo.listSubmissionFiles(submission.id)).resolves.toEqual([]);
    });
  });
});

describe('AssignmentsRepository — gói chấm, dấu chấm và bảng chấm', () => {
  it('upsertGrade: ghi đè thay toàn bộ gói — trường kết quả vắng mặt ở lượt sau về null, trạng thái về draft', async () => {
    await runInTestTenantContext(tenantId, async () => {
      const assignment = await repo.insertAssignment({
        course: courseId, cmId: null, name: 'Bài tập chấm', intro: '',
        dueDate: null, maxFiles: 10, acceptedFileTypes: null, grade: 10, resultMode: 'score_feedback',
      });
      const releasedAt = new Date('2026-11-04T09:00:00.000Z');
      const first = await repo.upsertGrade({
        assignmentId: assignment.id, userId: studentId, graderId: teacherId, attemptNumber: 1,
        grade: 9, level: null, feedback: 'Tốt', feedbackProgress: null, feedbackStrengths: null,
        feedbackWeaknesses: null, status: 'released', releasedAt, releasedBy: teacherId,
      });
      expect(first.status).toBe('released');

      const second = await repo.upsertGrade({
        assignmentId: assignment.id, userId: studentId, graderId: teacherId, attemptNumber: 2,
      });
      expect(second.id).toBe(first.id);
      expect(second.attemptNumber).toBe(2);
      expect(second.grade).toBeNull();
      expect(second.feedback).toBeNull();
      expect(second.status).toBe('draft');
      expect(second.releasedAt).toBeNull();

      await repo.updateGrade(second.id, { status: 'released', releasedAt, releasedBy: teacherId });
      await expect(repo.getGrade(assignment.id, studentId)).resolves.toMatchObject({ status: 'released', releasedBy: teacherId });
      await expect(repo.listGrades(assignment.id)).resolves.toHaveLength(1);
    });
  });

  it('dấu chấm: mảng points jsonb đọc lại đúng giá trị đã ghi; patch bỏ qua points giữ nguyên, patch points null xoá mảng', async () => {
    await runInTestTenantContext(tenantId, async () => {
      const assignment = await repo.insertAssignment({
        course: courseId, cmId: null, name: 'Bài tập dấu chấm', intro: '',
        dueDate: null, maxFiles: 10, acceptedFileTypes: null, grade: 10, resultMode: 'score_feedback',
      });
      const submission = await repo.insertSubmission({ assignmentId: assignment.id, userId: studentId, status: 'submitted', attemptNumber: 1 });
      const points = [
        { x: 0.1, y: 0.2 },
        { x: 0.3, y: 0.4 },
      ];
      const annotation = await repo.insertAnnotation({
        submissionId: submission.id, fileId, page: 1, x: 0.1, y: 0.2, kind: 'draw',
        color: '#ff0000', text: null, points, authorId: teacherId,
      });
      expect(annotation.points).toEqual(points);

      await repo.updateAnnotation(annotation.id, { color: '#00ff00' });
      const afterColorPatch = await repo.getAnnotation(annotation.id);
      expect(afterColorPatch?.color).toBe('#00ff00');
      expect(afterColorPatch?.points).toEqual(points);

      await repo.updateAnnotation(annotation.id, { points: null });
      const afterNullPatch = await repo.getAnnotation(annotation.id);
      expect(afterNullPatch?.points).toBeNull();

      await expect(repo.listAnnotations(submission.id)).resolves.toHaveLength(1);
      await repo.deleteAnnotation(annotation.id);
      await expect(repo.getAnnotation(annotation.id)).resolves.toBeUndefined();
    });
  });

  it('bảng chấm: tiêu chí/mức theo thứ tự hiển thị, đánh giá ghi/đè theo cặp (gói chấm, tiêu chí), xoá bảng chấm cascade cây con', async () => {
    await runInTestTenantContext(tenantId, async () => {
      const assignment = await repo.insertAssignment({
        course: courseId, cmId: null, name: 'Bài tập rubric', intro: '',
        dueDate: null, maxFiles: 10, acceptedFileTypes: null, grade: 10, resultMode: 'score_feedback',
      });
      const rubric = await repo.insertRubric({ assignmentId: assignment.id, title: 'Bảng chấm mẫu' });
      await expect(repo.getRubric(assignment.id)).resolves.toMatchObject({ id: rubric.id });

      const criterionB = await repo.insertCriterion({
        rubricId: rubric.id, name: 'Tiêu chí B', descriptionForStudent: null, descriptionForGrader: null,
        mode: 'levels', maxScore: null, outcomeId: null, outcomeText: null, sortOrder: 1,
      });
      const criterionA = await repo.insertCriterion({
        rubricId: rubric.id, name: 'Tiêu chí A', descriptionForStudent: null, descriptionForGrader: null,
        mode: 'score', maxScore: 5, outcomeId: null, outcomeText: null, sortOrder: 0,
      });
      const criteria = await repo.listCriteria(rubric.id);
      expect(criteria.map((c) => c.name)).toEqual(['Tiêu chí A', 'Tiêu chí B']);

      const levelLow = await repo.insertLevel({ criterionId: criterionB.id, label: 'Yếu', score: 1, sortOrder: 0 });
      await repo.insertLevel({ criterionId: criterionB.id, label: 'Tốt', score: 3, sortOrder: 1 });
      const levels = await repo.listLevels(criterionB.id);
      expect(levels.map((l) => l.label)).toEqual(['Yếu', 'Tốt']);

      const grade = await repo.upsertGrade({
        assignmentId: assignment.id, userId: studentId, graderId: teacherId, attemptNumber: 1, grade: null,
      });
      const evaluation = await repo.upsertEvaluation({
        gradeId: grade.id, criterionId: criterionB.id, levelId: levelLow.id, score: null, note: 'Cần cố gắng',
      });
      const reEvaluated = await repo.upsertEvaluation({
        gradeId: grade.id, criterionId: criterionB.id, levelId: null, score: 2.5, note: null,
      });
      expect(reEvaluated.id).toBe(evaluation.id);
      expect(reEvaluated.levelId).toBeNull();
      expect(reEvaluated.score).toBe(2.5);
      expect(reEvaluated.note).toBeNull();
      await expect(repo.listEvaluations(grade.id)).resolves.toHaveLength(1);
      await repo.deleteEvaluations(grade.id);
      await expect(repo.listEvaluations(grade.id)).resolves.toEqual([]);

      await repo.deleteRubricByAssignment(assignment.id);
      await expect(repo.getRubric(assignment.id)).resolves.toBeUndefined();
      await expect(repo.listCriteria(rubric.id)).resolves.toEqual([]);
      void criterionA;
    });
  });

  it('vết kiểm toán, hội thoại phản hồi và ngân hàng lời phê giữ đúng hợp đồng đọc/ghi', async () => {
    await runInTestTenantContext(tenantId, async () => {
      const assignment = await repo.insertAssignment({
        course: courseId, cmId: null, name: 'Bài tập phản hồi', intro: '',
        dueDate: null, maxFiles: 10, acceptedFileTypes: null, grade: 10, resultMode: 'score_feedback',
      });
      const grade = await repo.upsertGrade({
        assignmentId: assignment.id, userId: studentId, graderId: teacherId, attemptNumber: 1, grade: 7,
      });
      const revision = await repo.insertRevision({
        gradeId: grade.id, actorId: teacherId,
        previousGrade: 7, newGrade: 8, previousLevel: null, newLevel: null,
        previousFeedback: null, newFeedback: 'Đã sửa điểm',
      });
      expect(revision.reason).toBeNull();
      await expect(repo.listRevisions(grade.id)).resolves.toHaveLength(1);

      const message = await repo.insertMessage({ gradeId: grade.id, authorId: studentId, body: 'Em cảm ơn cô' });
      expect(message.body).toBe('Em cảm ơn cô');
      await expect(repo.listMessages(grade.id)).resolves.toHaveLength(1);

      const entry = await repo.insertCommentBankEntry({ ownerId: teacherId, category: null, text: 'Làm tốt lắm' });
      await expect(repo.listCommentBank(teacherId)).resolves.toHaveLength(1);
      await repo.deleteCommentBankEntry(entry.id, studentId);
      await expect(repo.listCommentBank(teacherId)).resolves.toHaveLength(1);
      await repo.deleteCommentBankEntry(entry.id, teacherId);
      await expect(repo.listCommentBank(teacherId)).resolves.toEqual([]);
    });
  });
});

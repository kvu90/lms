import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Kysely, PostgresDialect } from 'kysely';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CentreDb, CentreDB } from '../client';
import { examAttempts } from '../quiz.schema';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { createTestKysely } from '../test-support/create-test-kysely';
import { runInTestPlatformContext, TestTenantPool } from '../test-support/tenant-context';
import { QuizRepository, type ExamAttemptRow, type ExamPinRow } from './quiz';

/**
 * Spec tích hợp của repository quiz trên Kysely (issue #643, nhóm G3).
 *
 * Database trung tâm được dựng từ rỗng bằng chính bộ máy migration
 * của package (carrier đóng băng) trên cụm PostgreSQL thật của môi
 * trường test; mọi ca chạy qua repository production ở `quiz.ts` —
 * không mô phỏng handle. Vì superuser bỏ qua RLS, suite tạo một
 * role thường riêng và chạy mọi truy vấn qua role đó trong ngữ
 * cảnh platform tường minh (hợp đồng GUC/RLS tự nó đã được spec
 * khói của harness chốt; suite này chốt HÀNH VI của repository).
 *
 * Các chốt bằng chứng của nhóm theo hồ sơ chuẩn bị:
 * - JSON của lượt làm đọc/ghi khớp hai ORM (T-7): cùng một dòng
 *   `exam_attempts` đọc qua repository Kysely và qua Drizzle trên
 *   cùng database phải deep-equal từng trường, kể cả cột jsonb
 *   `applied_settings`, và thứ tự `listAttempts` hai đường trùng
 *   nhau (điểm duy nhất ở tầng repository có thể làm lệch kết quả
 *   chấm là kiểu runtime của jsonb/số và thứ tự đọc lượt làm).
 * - Patch cập nhật loại `undefined` tường minh (T-4): trường vắng
 *   mặt hoặc mang `undefined` trong patch không bị ghi thành NULL.
 * - Tăng bộ đếm ma trận giữ dạng biểu thức SQL nguyên tử (điểm nóng
 *   R-G3-1): SQL thực thi của `bumpMatrixCopyCount` chứa đúng biểu
 *   thức `"exam_matrices"."copy_count" + 1`, cấm đọc-cộng-ghi.
 */
const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : 'postgres://postgres:postgres@localhost:5432/postgres');

const TEST_DATABASE = 'lms_db_g3_quiz';
const TEST_ROLE = 'lms_db_g3_quiz';
const TEST_ROLE_PASSWORD = 'lms_db_g3_quiz_pw';

const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTOR_ID = '01a19887-6b35-7760-8e64-a5960bfd0875';
const USER_A = '01a19887-6b35-7760-8e64-a5960bfd0801';
const USER_B = '01a19887-6b35-7760-8e64-a5960bfd0802';
const CONTEXT_ID = '01a19887-6b35-7760-8e64-a5960bfd0900';

let pool: TestTenantPool;
let db: CentreDb;
let repo: QuizRepository;
let drizzleDb: NodePgDatabase;

let tenantId = '';
let courseId = '';
let examId = '';
let examVersionId = '';
let curriculumId = '';
let subjectId = '';
let nodeId = '';
let questionId = '';
let questionVersionId = '';

/** Chạy một thao tác trong ngữ cảnh platform tường minh (GUC platform = on). */
function platform<T>(fn: () => Promise<T>): Promise<T> {
  return runInTestPlatformContext(fn);
}

/** Gieo các dòng cha tối thiểu mà khoá ngoại của cụm ghim/lượt làm đòi (qua Kysely thô). */
async function seedParents(): Promise<void> {
  const tenant = await db
    .insertInto('tenants')
    .values({ slug: 'g3-quiz', name: 'Trung tâm G3 Quiz', kind: 'centre' })
    .returning('id')
    .executeTakeFirstOrThrow();
  tenantId = tenant.id;
  const bank = await db
    .insertInto('question_banks')
    .values({ context_id: CONTEXT_ID, created_by: ACTOR_ID, name: 'Ngân hàng G3 Quiz', scope: 'centre', tenant_id: tenant.id })
    .returning('id')
    .executeTakeFirstOrThrow();
  const category = await db
    .insertInto('question_categories')
    .values({ bank_id: bank.id, context_id: CONTEXT_ID, name: 'Danh mục G3' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const courseCategory = await db
    .insertInto('course_categories')
    .values({ tenant_id: tenant.id, name: 'Danh mục khoá G3' })
    .returning('id')
    .executeTakeFirstOrThrow();
  // Khoá thường (không phải mẫu) bắt buộc thuộc một lớp theo check
  // constraint `course_class_required_check` — gieo chuỗi lớp tối thiểu.
  const owner = await db
    .insertInto('users')
    .values({ email: 'g3-quiz-owner@example.com', username: 'g3-quiz-owner' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const cohort = await db
    .insertInto('cohort')
    .values({ context_id: CONTEXT_ID, name: 'Khoá tuyển G3', tenant_id: tenant.id })
    .returning('id')
    .executeTakeFirstOrThrow();
  const clazz = await db
    .insertInto('classes')
    .values({ cohort_id: cohort.id, name: 'Lớp G3 Quiz', owner_id: owner.id, tenant_id: tenant.id })
    .returning('id')
    .executeTakeFirstOrThrow();
  const course = await db
    .insertInto('course')
    .values({ tenant_id: tenant.id, category: courseCategory.id, class_id: clazz.id, full_name: 'Khoá học G3', short_name: 'G3Q' })
    .returning('id')
    .executeTakeFirstOrThrow();
  courseId = course.id;
  const exam = await db
    .insertInto('exams')
    .values({ bank_id: bank.id, created_by: ACTOR_ID })
    .returning('id')
    .executeTakeFirstOrThrow();
  examId = exam.id;
  const version = await db
    .insertInto('exam_versions')
    .values({ exam_id: exam.id, created_by: ACTOR_ID, name: 'Bản G3 số 1', version: 1 })
    .returning('id')
    .executeTakeFirstOrThrow();
  examVersionId = version.id;
  const question = await db
    .insertInto('question')
    .values({ category: category.id, qtype: 'multichoice' })
    .returning('id')
    .executeTakeFirstOrThrow();
  questionId = question.id;
  const subject = await db
    .insertInto('subjects')
    .values({ context_id: CONTEXT_ID, name: 'Toán G3', slug: 'toan-g3-quiz' })
    .returning('id')
    .executeTakeFirstOrThrow();
  subjectId = subject.id;
  const curriculum = await db
    .insertInto('curricula')
    .values({ grade: 9, subject_id: subject.id })
    .returning('id')
    .executeTakeFirstOrThrow();
  curriculumId = curriculum.id;
  const node = await db
    .insertInto('curriculum_nodes')
    .values({ curriculum_id: curriculum.id, title: 'Chương 1 G3' })
    .returning('id')
    .executeTakeFirstOrThrow();
  nodeId = node.id;
  const entry = await db
    .insertInto('question_bank_entries')
    .values({ question_category_id: category.id, question_id: question.id, status: 'ready' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const qVersion = await db
    .insertInto('question_versions')
    .values({ question_bank_entry_id: entry.id, question_id: question.id, version: 1 })
    .returning('id')
    .executeTakeFirstOrThrow();
  questionVersionId = qVersion.id;
}

/** Một usage mới cho một lượt làm (ràng buộc duy nhất `exam_attempts_usage_unique`: mỗi usage chỉ neo một lượt). */
async function freshUsageId(): Promise<string> {
  const usage = await db
    .insertInto('question_usages')
    .values({ component: 'mod_quiz' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return usage.id;
}

/** Chèn một lượt làm qua repository với một usage mới riêng (xem `freshUsageId`). */
async function seedAttempt(args: Omit<Parameters<QuizRepository['insertAttempt']>[0], 'usageId'>): Promise<ExamAttemptRow> {
  return repo.insertAttempt({ ...args, usageId: await freshUsageId() });
}

/** Tạo một lần ghim mẫu qua repository (mảng variants là jsonb cấp trên cùng — ca nhạy của khuôn ghi jsonb). */
async function seedPin(patch: Partial<ExamPinRow> = {}): Promise<ExamPinRow> {
  return repo.insertPin({
    courseId,
    createdBy: ACTOR_ID,
    examId,
    examVersionId,
    variants: [{ code: 'A', seed: 11 }, { code: 'B', seed: 22 }],
    ...patch,
  });
}

beforeAll(async () => {
  const storeUrl = await buildTestDatabase({ adminUrl, database: TEST_DATABASE, store: 'centre' });
  const admin = new Client({ connectionString: storeUrl });
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
  const roleUrl = new URL(storeUrl);
  roleUrl.username = TEST_ROLE;
  roleUrl.password = TEST_ROLE_PASSWORD;
  pool = new TestTenantPool({ connectionString: roleUrl.toString() });
  db = createTestKysely(pool).centre;
  repo = new QuizRepository(db);
  drizzleDb = drizzle({ client: pool });
  await platform(seedParents);
}, 300_000);

afterAll(async () => {
  if (pool) await pool.end();
  await dropTestDatabase(adminUrl, TEST_DATABASE).catch(() => undefined);
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP ROLE IF EXISTS "${TEST_ROLE}"`);
  } finally {
    await admin.end();
  }
}, 60_000);

describe('repository quiz trên Kysely — đối chiếu hành vi', () => {
  it('insertPin ghi mảng variants jsonb cấp trên cùng và getPin đọc lại nguyên vẹn; id sinh UUIDv7', async () => {
    const pin = await platform(() => seedPin({ name: 'Đợt thi G3' }));
    expect(pin.id).toMatch(UUIDV7_PATTERN);
    expect(pin.variants).toEqual([{ code: 'A', seed: 11 }, { code: 'B', seed: 22 }]);
    expect(pin.createdAt).toBeInstanceOf(Date);
    const read = await platform(() => repo.getPin(pin.id));
    expect(read).toEqual(pin);
    const inCourse = await platform(() => repo.listPinsInCourse(courseId));
    expect(inCourse.map((p) => p.id)).toContain(pin.id);
  });

  it('JSON lượt làm khớp hai ORM: cùng dòng exam_attempts đọc qua Kysely và qua Drizzle deep-equal từng trường', async () => {
    const pin = await platform(() => seedPin());
    const settings = { timeLimit: 45, attempts: 2, nested: { shuffle: true, tags: ['a', 'b'] } };
    const attempt = await platform(() =>
      seedAttempt({ pinId: pin.id, userId: USER_A, attemptNumber: 1, appliedSettings: settings, sumGrades: 7.5 }),
    );
    expect(attempt.appliedSettings).toEqual(settings);
    const viaDrizzle = await platform(async () => {
      const rows = await drizzleDb.select().from(examAttempts).where(eq(examAttempts.id, attempt.id));
      return rows[0];
    });
    expect(viaDrizzle).toEqual(attempt);
  });

  it('listAttempts giữ thứ tự (user_id, attempt_number) và khớp thứ tự của đường Drizzle trên cùng dữ kiện', async () => {
    const pin = await platform(() => seedPin());
    await platform(() => seedAttempt({ pinId: pin.id, userId: USER_B, attemptNumber: 2 }));
    await platform(() => seedAttempt({ pinId: pin.id, userId: USER_A, attemptNumber: 3 }));
    await platform(() => seedAttempt({ pinId: pin.id, userId: USER_B, attemptNumber: 1 }));
    await platform(() => seedAttempt({ pinId: pin.id, userId: USER_A, attemptNumber: 1 }));
    const viaRepo = await platform(() => repo.listAttempts(pin.id));
    expect(viaRepo.map((a) => `${a.userId}#${a.attemptNumber}`)).toEqual([
      `${USER_A}#1`,
      `${USER_A}#3`,
      `${USER_B}#1`,
      `${USER_B}#2`,
    ]);
    const viaDrizzle = await platform(() =>
      drizzleDb.select().from(examAttempts).where(eq(examAttempts.pinId, pin.id))
        .orderBy(examAttempts.userId, examAttempts.attemptNumber),
    );
    expect(viaRepo).toEqual(viaDrizzle);
  });

  it('listAttemptsForUser lọc lượt preview theo cờ includePreview', async () => {
    const pin = await platform(() => seedPin());
    await platform(() => seedAttempt({ pinId: pin.id, userId: USER_A, attemptNumber: 1 }));
    await platform(() => seedAttempt({ pinId: pin.id, userId: USER_A, attemptNumber: 2, preview: true }));
    const visible = await platform(() => repo.listAttemptsForUser(pin.id, USER_A));
    expect(visible.map((a) => a.attemptNumber)).toEqual([1]);
    const all = await platform(() => repo.listAttemptsForUser(pin.id, USER_A, true));
    expect(all.map((a) => a.attemptNumber)).toEqual([1, 2]);
  });

  it('updatePin loại trường undefined khỏi set (T-4): trường không có trong patch giữ nguyên, variants thay nguyên mảng', async () => {
    const pin = await platform(() => seedPin({ name: 'Tên gốc', preset: 'regular' }));
    await platform(() => repo.updatePin(pin.id, { name: 'Tên mới', preset: undefined }));
    const after = await platform(() => repo.getPin(pin.id));
    expect(after!.name).toBe('Tên mới');
    expect(after!.preset).toBe('regular');
    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(pin.updatedAt.getTime());
    await platform(() => repo.updatePin(pin.id, { variants: [{ code: 'C', seed: 33 }] }));
    expect((await platform(() => repo.getPin(pin.id)))!.variants).toEqual([{ code: 'C', seed: 33 }]);
  });

  it('updateAttempt không ghi đè applied_settings khi patch mang undefined; ghi object mới khi patch có giá trị', async () => {
    const pin = await platform(() => seedPin());
    const attempt = await platform(() =>
      seedAttempt({ pinId: pin.id, userId: USER_A, attemptNumber: 1, appliedSettings: { a: 1 } }),
    );
    await platform(() => repo.updateAttempt(attempt.id, { appliedSettings: undefined, state: 'finished' }));
    const after = await platform(() => repo.getAttempt(attempt.id));
    expect(after!.appliedSettings).toEqual({ a: 1 });
    expect(after!.state).toBe('finished');
    await platform(() => repo.updateAttempt(attempt.id, { appliedSettings: { a: 2, b: [1, 2] } }));
    expect((await platform(() => repo.getAttempt(attempt.id)))!.appliedSettings).toEqual({ a: 2, b: [1, 2] });
  });

  it('sessionLatestClose lấy max giữa mốc đóng của pin và mọi override; pin không mốc đóng thì hasUnbounded', async () => {
    const t1 = new Date('2026-11-10T10:00:00.000Z');
    const t2 = new Date('2026-11-12T10:00:00.000Z');
    const pin = await platform(() => seedPin({ timeClose: t1 }));
    await platform(() => repo.insertOverride({ pinId: pin.id, timeClose: t2, userId: USER_A }));
    await platform(() => repo.insertOverride({ pinId: pin.id, timeClose: null, userId: USER_B }));
    const result = await platform(() => repo.sessionLatestClose(pin.id));
    expect(result.hasUnbounded).toBe(false);
    expect(result.latest).toEqual(t2);

    const openPin = await platform(() => seedPin({ timeClose: null }));
    const open = await platform(() => repo.sessionLatestClose(openPin.id));
    expect(open.hasUnbounded).toBe(true);
    expect(open.latest).toBeNull();
  });

  it('transaction của repository: pin + lượt làm cùng commit; lỗi giữa chừng thì rollback cả hai', async () => {
    const txUsageId = await platform(freshUsageId);
    const committed = await platform(() =>
      repo.transaction(async (tx) => {
        const pin = await repo.insertPin(
          { courseId, createdBy: ACTOR_ID, examId, examVersionId, variants: [{ code: 'A', seed: 11 }] },
          tx,
        );
        const attempt = await repo.insertAttempt({ pinId: pin.id, usageId: txUsageId, userId: USER_A, attemptNumber: 1 }, tx);
        return { pin, attempt };
      }),
    );
    expect(await platform(() => repo.getPin(committed.pin.id))).toBeDefined();
    expect(await platform(() => repo.getAttempt(committed.attempt.id))).toBeDefined();

    let rolledBackPinId = '';
    await expect(
      platform(() =>
        repo.transaction(async (tx) => {
          const pin = await repo.insertPin(
            { courseId, createdBy: ACTOR_ID, examId, examVersionId, variants: [{ code: 'A', seed: 11 }] },
            tx,
          );
          rolledBackPinId = pin.id;
          throw new Error('cố ý hỏng giữa transaction');
        }),
      ),
    ).rejects.toThrow('cố ý hỏng giữa transaction');
    expect(await platform(() => repo.getPin(rolledBackPinId))).toBeUndefined();
  });

  it('ma trận + version + ô: listMatrixCells chỉ đọc ô của version hiện hành; ma trận chưa có hàng version thì đọc theo matrix_id', async () => {
    const matrix = await platform(() =>
      repo.insertMatrix({ contextId: CONTEXT_ID, curriculumId, name: 'Ma trận G3', subjectId }),
    );
    const v1 = await platform(() =>
      repo.insertMatrixVersion({ createdBy: ACTOR_ID, matrixId: matrix.id, version: 1, targetFormPercents: { mc: 60, tf: 40 } }),
    );
    const v2 = await platform(() =>
      repo.insertMatrixVersion({ createdBy: ACTOR_ID, matrixId: matrix.id, version: 2 }),
    );
    await platform(() => repo.updateMatrix(matrix.id, { version: 2 }));
    await platform(() =>
      repo.insertMatrixCell({
        cellScore: 1, cognitiveLevel: 'biet', curriculumNodeId: nodeId, matrixId: matrix.id,
        matrixVersionId: v1.id, qtype: 'multichoice', questionCount: 2, tfScale: [1, 2],
      }),
    );
    const current = await platform(() =>
      repo.insertMatrixCell({
        cellScore: 2, cognitiveLevel: 'van_dung', curriculumNodeId: nodeId, matrixId: matrix.id,
        matrixVersionId: v2.id, qtype: 'essay', questionCount: 1,
      }),
    );
    const cells = await platform(() => repo.listMatrixCells(matrix.id));
    expect(cells.map((c) => c.id)).toEqual([current.id]);
    const byVersion = await platform(() => repo.listMatrixCellsByVersionId(v1.id));
    expect(byVersion).toHaveLength(1);
    expect(byVersion[0]!.tfScale).toEqual([1, 2]);

    // Ma trận dựng tay chưa có hàng version nào cho số version hiện
    // hành: ô neo version của ma trận khác (chỉ gặp ở dữ kiện dựng
    // tay) vẫn đọc được theo matrix_id như đường cũ.
    const bare = await platform(() =>
      repo.insertMatrix({ contextId: CONTEXT_ID, curriculumId, name: 'Ma trận trần G3', subjectId }),
    );
    const bareCell = await platform(() =>
      repo.insertMatrixCell({
        cellScore: 1, cognitiveLevel: 'hieu', curriculumNodeId: nodeId, matrixId: bare.id,
        matrixVersionId: v1.id, qtype: 'shortanswer', questionCount: 1,
      }),
    );
    const bareCells = await platform(() => repo.listMatrixCells(bare.id));
    expect(bareCells.map((c) => c.id)).toEqual([bareCell.id]);
  });

  it('bumpMatrixCopyCount tăng nguyên tử bằng đúng biểu thức SQL của đường cũ (R-G3-1)', async () => {
    const matrix = await platform(() =>
      repo.insertMatrix({ contextId: CONTEXT_ID, curriculumId, name: 'Ma trận đếm G3', subjectId }),
    );
    const queries: string[] = [];
    const loggingPool = new TestTenantPool({ connectionString: pool.options.connectionString });
    const loggingDb = new Kysely<CentreDB>({
      dialect: new PostgresDialect({ pool: loggingPool }),
      log: (event) => {
        if (event.level === 'query') queries.push(event.query.sql);
      },
    });
    const loggingRepo = new QuizRepository(loggingDb);
    await platform(() => loggingRepo.bumpMatrixCopyCount(matrix.id));
    await platform(() => loggingRepo.bumpMatrixCopyCount(matrix.id));
    await loggingDb.destroy();
    const bumps = queries.filter((q) => q.includes('copy_count'));
    expect(bumps).toHaveLength(2);
    for (const q of bumps) {
      expect(q).toContain('"exam_matrices"."copy_count" + 1');
      expect(q.toLowerCase().startsWith('update')).toBe(true);
    }
    expect((await platform(() => repo.getMatrix(matrix.id)))!.copyCount).toBe(matrix.copyCount + 2);
    // Không có câu SELECT nào đọc copy_count trong các lượt tăng:
    // bằng chứng không phải đọc-cộng-ghi.
    expect(queries.some((q) => q.toLowerCase().startsWith('select') && q.includes('copy_count'))).toBe(false);
  });

  it('listRegradeItemsForUser trả hình lồng { regrade, item } chỉ của đúng học sinh', async () => {
    const pin = await platform(() => seedPin());
    const usageForAttempt = await platform(freshUsageId);
    const attemptA = await platform(() =>
      repo.insertAttempt({ pinId: pin.id, usageId: usageForAttempt, userId: USER_A, attemptNumber: 1 }),
    );
    // question_attempt_id của mục chấm lại neo vào bảng question_attempts
    // của question engine — gieo một dòng thật trên cùng usage.
    const questionAttempt = await platform(() =>
      db
        .insertInto('question_attempts')
        .values({ question_id: questionId, question_usage_id: usageForAttempt, slot: 1 })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    const regrade = await platform(() =>
      repo.insertRegrade({
        actorId: ACTOR_ID, fromVersionId: questionVersionId, pinId: pin.id,
        questionId, toVersionId: questionVersionId,
      }),
    );
    const itemA = await platform(() =>
      repo.insertRegradeItem({
        examAttemptId: attemptA.id, questionAttemptId: questionAttempt.id, regradeId: regrade.id,
        userId: USER_A, oldFraction: 0.5, newFraction: 1,
      }),
    );
    await platform(() =>
      repo.insertRegradeItem({
        examAttemptId: attemptA.id, questionAttemptId: questionAttempt.id, regradeId: regrade.id,
        userId: USER_B, oldFraction: 0, newFraction: 0.5,
      }),
    );
    const rows = await platform(() => repo.listRegradeItemsForUser(pin.id, USER_A));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.item.id).toBe(itemA.id);
    expect(rows[0]!.item.userId).toBe(USER_A);
    expect(rows[0]!.regrade.id).toBe(regrade.id);
    expect(rows[0]!.regrade.pinId).toBe(pin.id);
    expect(rows[0]!.regrade.questionId).toBe(questionId);
  });

  it('feedback + sự kiện lượt làm + vết cập nhật version ghi/đọc tròn trịa', async () => {
    const pin = await platform(() => seedPin());
    const feedback = await platform(() =>
      repo.insertFeedback({ pinId: pin.id, minPercent: 50, maxPercent: 100, feedback: 'Làm tốt' }),
    );
    expect((await platform(() => repo.listFeedbacks(pin.id))).map((f) => f.id)).toEqual([feedback.id]);
    expect((await platform(() => repo.getFeedback(feedback.id)))!.feedback).toBe('Làm tốt');

    const attempt = await platform(() =>
      seedAttempt({ pinId: pin.id, userId: USER_A, attemptNumber: 1 }),
    );
    const event = await platform(() =>
      repo.insertAttemptEvent({ attemptId: attempt.id, type: 'tab_switch', data: { count: 2 } }),
    );
    const events = await platform(() => repo.listAttemptEvents(attempt.id));
    expect(events.map((e) => e.id)).toEqual([event.id]);
    expect(events[0]!.data).toEqual({ count: 2 });

    await platform(() =>
      repo.insertPinVersionUpdate({ actorId: ACTOR_ID, fromExamVersionId: examVersionId, pinId: pin.id, toExamVersionId: examVersionId }),
    );
    expect(await platform(() => repo.listPinVersionUpdates(pin.id))).toHaveLength(1);
  });

  it('đóng góp ma trận: findPendingMatrixContribution chỉ khớp hàng pending của đúng bộ ba (ma trận, bank, người gửi)', async () => {
    const bank = await platform(() =>
      db
        .insertInto('question_banks')
        .values({ context_id: CONTEXT_ID, created_by: ACTOR_ID, name: 'Ngân hàng đích G3', scope: 'centre', tenant_id: tenantId })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    const matrix = await platform(() =>
      repo.insertMatrix({ contextId: CONTEXT_ID, curriculumId, name: 'Ma trận góp G3', subjectId }),
    );
    const contribution = await platform(() =>
      repo.insertMatrixContribution({ matrixId: matrix.id, proposerId: USER_A, targetBankId: bank.id }),
    );
    const found = await platform(() => repo.findPendingMatrixContribution(matrix.id, bank.id, USER_A));
    expect(found!.id).toBe(contribution.id);
    expect(await platform(() => repo.findPendingMatrixContribution(matrix.id, bank.id, USER_B))).toBeUndefined();
    await platform(() => repo.updateMatrixContribution(contribution.id, { status: 'approved' }));
    expect(await platform(() => repo.findPendingMatrixContribution(matrix.id, bank.id, USER_A))).toBeUndefined();
    const list = await platform(() => repo.listMatrixContributions(bank.id, 'approved'));
    expect(list.map((c) => c.id)).toEqual([contribution.id]);
  });

  it('đọc tham chiếu đề đã ghim: getExam/getExamVersion/listExamSlots/listExamVersions theo đúng thứ tự', async () => {
    const slotRows = await platform(async () => {
      await db
        .insertInto('exam_slots')
        .values([
          { exam_version_id: examVersionId, position: 2, question_id: questionId },
          { exam_version_id: examVersionId, position: 1, question_id: questionId },
        ])
        .execute();
      return repo.listExamSlots(examVersionId);
    });
    expect(slotRows.map((s) => s.position)).toEqual([1, 2]);
    expect((await platform(() => repo.getExam(examId)))!.id).toBe(examId);
    expect((await platform(() => repo.getExamVersion(examVersionId)))!.version).toBe(1);
    expect((await platform(() => repo.listExamVersions(examId))).map((v) => v.version)).toEqual([1]);
    const byMatrix = await platform(() => repo.listExamVersionsByMatrix('01a19887-6b35-7760-8e64-a5960bfd0999'));
    expect(byMatrix).toEqual([]);
  });
});

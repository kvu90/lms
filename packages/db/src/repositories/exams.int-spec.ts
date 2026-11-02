import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CentreDb, CentreDB } from '../client';
import { examDossiers } from '../exams.schema';
import type { ExamVariant } from '../quiz.schema';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { createTestKysely } from '../test-support/create-test-kysely';
import { runInTestPlatformContext, TestTenantPool } from '../test-support/tenant-context';
import { ExamsRepository, type ExamRow } from './exams';

/**
 * Spec tích hợp của repository exams trên Kysely (issue #643, nhóm G3).
 *
 * Database trung tâm được dựng từ rỗng bằng chính bộ máy migration
 * của package (carrier đóng băng) trên cụm PostgreSQL thật của môi
 * trường test; mọi ca chạy qua repository production ở `exams.ts` —
 * không mô phỏng handle. Vì superuser bỏ qua RLS, suite tạo một
 * role thường riêng và chạy mọi truy vấn qua role đó trong ngữ
 * cảnh platform tường minh (hợp đồng GUC/RLS tự nó đã được spec
 * khói của harness chốt; suite này chốt HÀNH VI của repository).
 *
 * Các chốt bằng chứng của nhóm theo hồ sơ chuẩn bị:
 * - Đọc/ghi jsonb của bộ hồ sơ (`spec_snapshot`,
 *   `dossier_spec_snapshot`) khớp hai ORM (T-7): cùng một dòng đọc
 *   qua repository Kysely và qua Drizzle deep-equal từng trường.
 * - Patch cập nhật loại `undefined` tường minh (T-4).
 * - Tăng bộ đếm copy của đề giữ dạng biểu thức SQL nguyên tử
 *   (điểm nóng R-G3-1): SQL thực thi chứa đúng biểu thức
 *   `"exams"."copy_count" + 1`, cấm đọc-cộng-ghi.
 * - Các truy vấn ghép điều kiện động (đóng góp chưa chốt theo mode,
 *   hồ sơ đang hiệu lực có loại trừ) giữ đúng ngữ nghĩa của đường
 *   Drizzle (T-13: điều kiện vắng mặt không thành `where(undefined)`).
 */
const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : 'postgres://postgres:postgres@localhost:5432/postgres');

const TEST_DATABASE = 'lms_db_g3_exams';
const TEST_ROLE = 'lms_db_g3_exams';
const TEST_ROLE_PASSWORD = 'lms_db_g3_exams_pw';

const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTOR_ID = '01a19887-6b35-7760-8e64-a5960bfd0875';
const TEACHER_ID = '01a19887-6b35-7760-8e64-a5960bfd0811';
const STUDENT_ID = '01a19887-6b35-7760-8e64-a5960bfd0812';
const CONTEXT_ID = '01a19887-6b35-7760-8e64-a5960bfd0900';

let pool: TestTenantPool;
let db: CentreDb;
let repo: ExamsRepository;
let drizzleDb: NodePgDatabase;

let bankId = '';
let targetBankId = '';
let courseId = '';
let questionId = '';
let categoryId = '';

/** Chạy một thao tác trong ngữ cảnh platform tường minh (GUC platform = on). */
function platform<T>(fn: () => Promise<T>): Promise<T> {
  return runInTestPlatformContext(fn);
}

/** Gieo các dòng cha tối thiểu mà khoá ngoại của cụm ngân hàng đề đòi (qua Kysely thô). */
async function seedParents(): Promise<void> {
  const tenant = await db
    .insertInto('tenants')
    .values({ slug: 'g3-exams', name: 'Trung tâm G3 Exams', kind: 'centre' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const bank = await db
    .insertInto('question_banks')
    .values({ context_id: CONTEXT_ID, created_by: ACTOR_ID, name: 'Ngân hàng G3 Exams', scope: 'centre', tenant_id: tenant.id })
    .returning('id')
    .executeTakeFirstOrThrow();
  bankId = bank.id;
  const target = await db
    .insertInto('question_banks')
    .values({ context_id: CONTEXT_ID, created_by: ACTOR_ID, name: 'Ngân hàng đích G3', scope: 'centre', tenant_id: tenant.id })
    .returning('id')
    .executeTakeFirstOrThrow();
  targetBankId = target.id;
  const category = await db
    .insertInto('question_categories')
    .values({ bank_id: bank.id, context_id: CONTEXT_ID, name: 'Danh mục G3 Exams' })
    .returning('id')
    .executeTakeFirstOrThrow();
  categoryId = category.id;
  const courseCategory = await db
    .insertInto('course_categories')
    .values({ tenant_id: tenant.id, name: 'Danh mục khoá G3 Exams' })
    .returning('id')
    .executeTakeFirstOrThrow();
  // Khoá thường (không phải mẫu) bắt buộc thuộc một lớp theo check
  // constraint `course_class_required_check` — gieo chuỗi lớp tối thiểu.
  const owner = await db
    .insertInto('users')
    .values({ email: 'g3-exams-owner@example.com', username: 'g3-exams-owner' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const cohort = await db
    .insertInto('cohort')
    .values({ context_id: CONTEXT_ID, name: 'Khoá tuyển G3', tenant_id: tenant.id })
    .returning('id')
    .executeTakeFirstOrThrow();
  const clazz = await db
    .insertInto('classes')
    .values({ cohort_id: cohort.id, name: 'Lớp G3 Exams', owner_id: owner.id, tenant_id: tenant.id })
    .returning('id')
    .executeTakeFirstOrThrow();
  const course = await db
    .insertInto('course')
    .values({ tenant_id: tenant.id, category: courseCategory.id, class_id: clazz.id, full_name: 'Khoá học khối 9', short_name: 'G3E', grade: 9 })
    .returning('id')
    .executeTakeFirstOrThrow();
  courseId = course.id;
  const question = await db
    .insertInto('question')
    .values({ category: category.id, qtype: 'multichoice' })
    .returning('id')
    .executeTakeFirstOrThrow();
  questionId = question.id;
}

/** Tạo một đề mẫu qua repository. */
async function seedPaper(): Promise<ExamRow> {
  return repo.insertPaper({ bankId, createdBy: ACTOR_ID });
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
  repo = new ExamsRepository(db);
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

describe('repository exams trên Kysely — đối chiếu hành vi', () => {
  it('insertPaper/getPaper tròn trịa, id UUIDv7; listPapersInBank sắp xếp updated_at giảm dần', async () => {
    const a = await platform(() => seedPaper());
    const b = await platform(() => seedPaper());
    expect(a.id).toMatch(UUIDV7_PATTERN);
    expect((await platform(() => repo.getPaper(a.id)))!.bankId).toBe(bankId);
    // Cập nhật A sau cùng → updated_at của A mới nhất → A đứng đầu.
    await platform(() => repo.updatePaper(a.id, { status: 'ready' }));
    const list = await platform(() => repo.listPapersInBank(bankId));
    expect(list.map((p) => p.id)).toEqual([a.id, b.id]);
    expect(list[0]!.status).toBe('ready');
  });

  it('updatePaper loại trường undefined khỏi set (T-4) và deletePaper xoá đúng dòng', async () => {
    const paper = await platform(() => seedPaper());
    await platform(() => repo.updatePaper(paper.id, { status: 'draft', kind: undefined }));
    const after = await platform(() => repo.getPaper(paper.id));
    expect(after!.status).toBe('draft');
    expect(after!.kind).toBe(paper.kind);
    await platform(() => repo.deletePaper(paper.id));
    expect(await platform(() => repo.getPaper(paper.id))).toBeUndefined();
  });

  it('version + slots: insertSlots ghi nhiều dòng một câu lệnh, listSlots theo position; getVersionByNumber khớp (đề, số version)', async () => {
    const paper = await platform(() => seedPaper());
    const version = await platform(() =>
      repo.insertVersion({ createdBy: ACTOR_ID, examId: paper.id, name: 'Bản 1', version: 1, tfScale: [0.5, 0.5] }),
    );
    expect(version.tfScale).toEqual([0.5, 0.5]);
    await platform(() =>
      repo.insertSlots([
        { examVersionId: version.id, position: 2, questionId },
        { examVersionId: version.id, position: 1, questionId },
      ]),
    );
    await platform(() => repo.insertSlots([]));
    const slots = await platform(() => repo.listSlots(version.id));
    expect(slots.map((s) => s.position)).toEqual([1, 2]);
    expect((await platform(() => repo.getVersionByNumber(paper.id, 1)))!.id).toBe(version.id);
    expect(await platform(() => repo.getVersionByNumber(paper.id, 99))).toBeUndefined();
    expect((await platform(() => repo.listVersions(paper.id))).map((v) => v.version)).toEqual([1]);
  });

  it('listPinsOfExam ghép đúng tên khoá, số version và mảng variants của lần ghim', async () => {
    const paper = await platform(() => seedPaper());
    const version = await platform(() =>
      repo.insertVersion({ createdBy: ACTOR_ID, examId: paper.id, name: 'Bản ghim', version: 3 }),
    );
    await platform(() =>
      db
        .insertInto('exam_pins')
        .values({
          course_id: courseId, created_by: ACTOR_ID, exam_id: paper.id, exam_version_id: version.id,
          name: 'Đợt ghim G3', variants: sql<ExamVariant[]>`${JSON.stringify([{ code: 'A', seed: 11 }, { code: 'B', seed: 22 }])}::jsonb`,
        })
        .execute(),
    );
    const pins = await platform(() => repo.listPinsOfExam(paper.id));
    expect(pins).toHaveLength(1);
    expect(pins[0]!.courseName).toBe('Khoá học khối 9');
    expect(pins[0]!.versionNumber).toBe(3);
    expect(pins[0]!.variants).toEqual([{ code: 'A', seed: 11 }, { code: 'B', seed: 22 }]);
    expect(pins[0]!.name).toBe('Đợt ghim G3');
  });

  it('thông tin câu của slot lấy nhãn từ version MỚI NHẤT của entry; resolveReadyVersion chỉ nhận entry ready', async () => {
    const longText = 'Nội dung câu hỏi G3 '.repeat(10).trim();
    const docV1 = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bản cũ không được lấy' }] }] };
    const docV2 = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: longText }] }] };
    const entry = await platform(() =>
      db
        .insertInto('question_bank_entries')
        .values({ question_category_id: categoryId, question_id: questionId, status: 'ready', latest_version: 2 })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    await platform(() =>
      db
        .insertInto('question_versions')
        .values([
          { question_bank_entry_id: entry.id, question_id: questionId, version: 1, question_text: docV1 },
          { question_bank_entry_id: entry.id, question_id: questionId, version: 2, question_text: docV2 },
        ])
        .execute(),
    );
    const info = await platform(() => repo.listSlotQuestionInfo([questionId]));
    expect(info).toHaveLength(1);
    expect(info[0]!.qtype).toBe('multichoice');
    expect(info[0]!.name).toBe(`${longText.slice(0, 120)}…`);
    expect(info[0]!.name).not.toContain('Bản cũ');

    const resolved = await platform(() => repo.resolveReadyVersion(questionId));
    expect(resolved!.versionNumber).toBe(2);
    const statuses = await platform(() => repo.listQuestionEntryStatuses([questionId]));
    expect(statuses).toEqual([{ questionId, status: 'ready' }]);
    expect(await platform(() => repo.questionExists(questionId))).toBe(true);
    expect(await platform(() => repo.questionExists('01a19887-6b35-7760-8e64-a5960bfd0999'))).toBe(false);
    expect(await platform(() => repo.listSlotQuestionInfo([]))).toEqual([]);
  });

  it('findPendingContribution khớp cả pending lẫn pending_board; mode update phân biệt theo đề đích', async () => {
    const paper = await platform(() => seedPaper());
    const other = await platform(() => seedPaper());
    const c1 = await platform(() =>
      repo.insertContribution({ examId: paper.id, proposerId: ACTOR_ID, targetBankId, status: 'pending_board' }),
    );
    expect((await platform(() => repo.findPendingContribution(paper.id, targetBankId)))!.id).toBe(c1.id);
    expect(await platform(() => repo.findPendingContribution(paper.id, targetBankId, 'update', other.id))).toBeUndefined();
    const c2 = await platform(() =>
      repo.insertContribution({ examId: paper.id, proposerId: ACTOR_ID, targetBankId, mode: 'update', targetExamId: other.id }),
    );
    expect((await platform(() => repo.findPendingContribution(paper.id, targetBankId, 'update', other.id)))!.id).toBe(c2.id);
    await platform(() => repo.updateContribution(c2.id, { status: 'approved' }));
    expect(await platform(() => repo.findPendingContribution(paper.id, targetBankId, 'update', other.id))).toBeUndefined();
    expect((await platform(() => repo.findContributionBySourceDossier('01a19887-6b35-7760-8e64-a5960bfd0998')))).toBeUndefined();
  });

  it('đóng góp + mốc duyệt: listContributionReviews theo thời gian; updateContribution loại undefined (T-4)', async () => {
    const paper = await platform(() => seedPaper());
    const contribution = await platform(() =>
      repo.insertContribution({ examId: paper.id, proposerId: ACTOR_ID, targetBankId, dossierSpecSnapshot: { sections: [{ name: 'S1', count: 3 }] } }),
    );
    expect(contribution.dossierSpecSnapshot).toEqual({ sections: [{ name: 'S1', count: 3 }] });
    await platform(() => repo.insertContributionReview({ contributionId: contribution.id, decision: 'approved', level: 1, reviewerId: ACTOR_ID }));
    await platform(() => repo.insertContributionReview({ contributionId: contribution.id, decision: 'approved', level: 2, reviewerId: ACTOR_ID }));
    const reviews = await platform(() => repo.listContributionReviews(contribution.id));
    expect(reviews.map((r) => r.level)).toEqual([1, 2]);
    await platform(() => repo.updateContribution(contribution.id, { status: 'pending_board', note: undefined }));
    const after = await platform(() => repo.getContribution(contribution.id));
    expect(after!.status).toBe('pending_board');
    expect(after!.note).toBe(contribution.note);
    expect((await platform(() => repo.listContributionsForBank(targetBankId))).map((c) => c.id)).toContain(contribution.id);
  });

  it('bộ hồ sơ: spec_snapshot jsonb khớp hai ORM (T-7); findActiveDossier tôn trọng excludeId', async () => {
    const paper = await platform(() => seedPaper());
    const snapshot = { totalScore: 10, cells: [{ qtype: 'essay', count: 1 }], note: null };
    const dossier = await platform(() =>
      repo.insertDossier({ examId: paper.id, proposerId: ACTOR_ID, targetBankId, specSnapshot: snapshot, status: 'pending' }),
    );
    expect(dossier.specSnapshot).toEqual(snapshot);
    const viaDrizzle = await platform(async () => {
      const rows = await drizzleDb.select().from(examDossiers).where(eq(examDossiers.id, dossier.id));
      return rows[0];
    });
    expect(viaDrizzle).toEqual(dossier);

    expect((await platform(() => repo.findActiveDossier(paper.id, targetBankId)))!.id).toBe(dossier.id);
    expect(await platform(() => repo.findActiveDossier(paper.id, targetBankId, dossier.id))).toBeUndefined();
    await platform(() => repo.insertDossierReview({ decision: 'rejected', dossierId: dossier.id, level: 1, reason: 'Thiếu ô', reviewerId: ACTOR_ID }));
    const reviews = await platform(() => repo.listDossierReviews(dossier.id));
    expect(reviews.map((r) => r.reason)).toEqual(['Thiếu ô']);
    await platform(() => repo.updateDossier(dossier.id, { status: 'rejected' }));
    expect(await platform(() => repo.findActiveDossier(paper.id, targetBankId))).toBeUndefined();
    expect((await platform(() => repo.listDossiersByProposer(ACTOR_ID))).map((d) => d.id)).toContain(dossier.id);
    expect((await platform(() => repo.listAllDossiers())).length).toBeGreaterThan(0);
  });

  it('bumpCopyCount tăng nguyên tử bằng đúng biểu thức SQL của đường cũ (R-G3-1)', async () => {
    const paper = await platform(() => seedPaper());
    const queries: string[] = [];
    const loggingPool = new TestTenantPool({ connectionString: pool.options.connectionString });
    const loggingDb = new Kysely<CentreDB>({
      dialect: new PostgresDialect({ pool: loggingPool }),
      log: (event) => {
        if (event.level === 'query') queries.push(event.query.sql);
      },
    });
    const loggingRepo = new ExamsRepository(loggingDb);
    await platform(() => loggingRepo.bumpCopyCount(paper.id));
    await platform(() => loggingRepo.bumpCopyCount(paper.id));
    await loggingDb.destroy();
    const bumps = queries.filter((q) => q.includes('copy_count'));
    expect(bumps).toHaveLength(2);
    for (const q of bumps) {
      expect(q).toContain('"exams"."copy_count" + 1');
      expect(q.toLowerCase().startsWith('update')).toBe(true);
    }
    expect((await platform(() => repo.getPaper(paper.id)))!.copyCount).toBe(paper.copyCount + 2);
    expect(queries.some((q) => q.toLowerCase().startsWith('select') && q.includes('copy_count'))).toBe(false);
  });

  it('transaction của repository rollback sạch khi lỗi giữa chừng', async () => {
    let rolledBackId = '';
    await expect(
      platform(() =>
        repo.transaction(async (tx) => {
          const paper = await repo.insertPaper({ bankId, createdBy: ACTOR_ID }, tx);
          rolledBackId = paper.id;
          throw new Error('cố ý hỏng giữa transaction');
        }),
      ),
    ).rejects.toThrow('cố ý hỏng giữa transaction');
    expect(await platform(() => repo.getPaper(rolledBackId))).toBeUndefined();
    const committed = await platform(() =>
      repo.transaction(async (tx) => repo.insertPaper({ bankId, createdBy: ACTOR_ID }, tx)),
    );
    expect(await platform(() => repo.getPaper(committed.id))).toBeDefined();
  });

  it('getMatrixInfo/getMatrixVersionRowId đọc đúng tên, số version và id hàng version của ma trận', async () => {
    const subject = await platform(() =>
      db.insertInto('subjects').values({ context_id: CONTEXT_ID, name: 'Văn G3', slug: 'van-g3-exams' }).returning('id').executeTakeFirstOrThrow(),
    );
    const curriculum = await platform(() =>
      db.insertInto('curricula').values({ grade: 9, subject_id: subject.id }).returning('id').executeTakeFirstOrThrow(),
    );
    const matrix = await platform(() =>
      db
        .insertInto('exam_matrices')
        .values({ context_id: CONTEXT_ID, curriculum_id: curriculum.id, name: 'Ma trận hồ sơ G3', subject_id: subject.id, version: 4 })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    const matrixVersion = await platform(() =>
      db
        .insertInto('exam_matrix_versions')
        .values({ created_by: ACTOR_ID, matrix_id: matrix.id, version: 4 })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    expect(await platform(() => repo.getMatrixInfo(matrix.id))).toEqual({ name: 'Ma trận hồ sơ G3', version: 4 });
    expect(await platform(() => repo.getMatrixVersionRowId(matrix.id, 4))).toBe(matrixVersion.id);
    expect(await platform(() => repo.getMatrixVersionRowId(matrix.id, 7))).toBeNull();
  });

  it('userTeachesGrade chỉ đúng với gán vai giáo viên tại context khoá có khối khớp', async () => {
    const teacherRole = await platform(() =>
      db.insertInto('role').values({ archetype: 'teacher', short_name: 'g3-teacher' }).returning('id').executeTakeFirstOrThrow(),
    );
    const studentRole = await platform(() =>
      db.insertInto('role').values({ archetype: 'student', short_name: 'g3-student' }).returning('id').executeTakeFirstOrThrow(),
    );
    const context = await platform(() =>
      db
        .insertInto('context')
        .values({ context_level: 50, depth: 2, instance_id: courseId, path: '/1/50' })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    await platform(() =>
      db.insertInto('role_assignments').values({ context_id: context.id, role_id: teacherRole.id, user_id: TEACHER_ID }).execute(),
    );
    await platform(() =>
      db.insertInto('role_assignments').values({ context_id: context.id, role_id: studentRole.id, user_id: STUDENT_ID }).execute(),
    );
    expect(await platform(() => repo.userTeachesGrade(TEACHER_ID, 9))).toBe(true);
    expect(await platform(() => repo.userTeachesGrade(TEACHER_ID, 8))).toBe(false);
    expect(await platform(() => repo.userTeachesGrade(STUDENT_ID, 9))).toBe(false);
  });
});

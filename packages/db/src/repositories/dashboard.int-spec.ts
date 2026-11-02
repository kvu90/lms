import { sql as kyselySql } from 'kysely';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCentreKysely, type CentreDb } from '../client';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { DashboardRepository, type ContextLevels } from './dashboard';

/**
 * Spec tích hợp của repository DASHBOARD trên Kysely (issue #652).
 *
 * Database kho trung tâm được dựng từ rỗng bằng chính cầu nối
 * migration của package (carrier đóng băng) trên cụm PostgreSQL
 * thật của môi trường test (biến `LMS_DB_TEST_ADMIN_URL` ghi đè cụm
 * khi cần, mặc định suy từ `DATABASE_URL` của package). Mọi ca chạy
 * qua repository production ở `dashboard.ts` — không mô phỏng
 * handle.
 *
 * Đối chiếu số liệu là tiêu chí nghiệm thu trung tâm của issue: với
 * MỖI method của repository, spec chạy cùng một truy vấn trên cùng
 * một dữ kiện mẫu qua hai đường — bản thực thi cũ (sao nguyên văn
 * logic thân method của repository cũ vào các hàm `old*` dưới đây;
 * từ #663 các hàm này dựng bằng Kysely thô vì ORM cũ đã rời khỏi
 * cây) và repository hiện hành — và khẳng định kết quả khớp nhau.
 * Các method ghi được kiểm hai chiều: ghi bằng đường này, đọc lại
 * bằng đường kia.
 *
 * Cổng registry ngữ cảnh: repository chỉ đọc khoá `COURSE` qua
 * cổng. Dữ kiện mẫu của spec tự chọn số mức cho context khoá là
 * `COURSE_LEVEL` (một giá trị riêng của spec, khác mọi giá trị
 * registry thật) và implementation cổng của spec cấp đúng giá trị
 * đó — nếu repository dùng bất kỳ hằng số mức nào khác ngoài cổng,
 * ca gán vai sẽ lệch kết quả ngay. Các khoá còn lại của cổng không
 * được repository tiêu thụ nên spec cấp 0.
 */
const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : undefined);

const TEST_DB = 'lms_db_dash_652';

/** Số mức của context khoá trong dữ kiện mẫu — giá trị riêng của spec, chỉ chảy qua cổng. */
const COURSE_LEVEL = 777;
/** Số mức của context không phải khoá trong dữ kiện mẫu. */
const OTHER_LEVEL = 555;

/** Implementation cổng của spec: chỉ khoá `COURSE` mang giá trị của dữ kiện mẫu. */
const TEST_CONTEXT_LEVELS: ContextLevels = {
  SYSTEM: 0,
  TENANT: 0,
  USER: 0,
  COURSECAT: 0,
  CLASS: 0,
  COURSE: COURSE_LEVEL,
  MODULE: 0,
  BLOCK: 0,
};

const TENANT_ID = '01a19887-6b35-7760-8e64-a5960bfd0001';
const STUDENT_ID = '01a19887-6b35-7760-8e64-a5960bfd0002';
const TEACHER_ID = '01a19887-6b35-7760-8e64-a5960bfd0003';
const OTHER_ID = '01a19887-6b35-7760-8e64-a5960bfd0004';
const COURSE_A = '01a19887-6b35-7760-8e64-a5960bfd0010';
const COURSE_B = '01a19887-6b35-7760-8e64-a5960bfd0011';

const NOW = new Date('2026-11-02T00:00:00.000Z');
const UNTIL = new Date('2026-11-09T00:00:00.000Z');
const SINCE = new Date('2026-11-01T00:00:00.000Z');

let pool: Pool;
let db: CentreDb;
let repo: DashboardRepository;

// ---------------------------------------------------------------------------
// Bản thực thi cũ — sao nguyên văn logic thân method của repository
// cũ (`apps/api/src/modules/dashboard/dashboard.repository.ts` tại
// main trước lượt chuyển đổi), chỉ đổi điểm nhận handle và hằng mức
// khoá qua cổng mẫu. Từ #663 các hàm này dựng bằng Kysely thô trên
// cùng handle (ORM cũ đã rời khỏi cây); logic truy vấn giữ nguyên
// từng điều kiện/nối/sắp xếp của bản sao.
// ---------------------------------------------------------------------------

type OldDb = CentreDb;

/** Bản cũ của enrolledCourseIds (sao nguyên văn để đối chiếu trước/sau). */
async function oldEnrolledCourseIds(oldDb: OldDb, userId: string, now: Date): Promise<string[]> {
  const rows = await oldDb
    .selectFrom('user_enrolments')
    .innerJoin('enrol', 'enrol.id', 'user_enrolments.enrol_id')
    .select('enrol.course_id as courseId')
    .distinct()
    .where('user_enrolments.user_id', '=', userId)
    .where('user_enrolments.status', '=', 0)
    .where((eb) => eb.or([
      eb('user_enrolments.time_end', 'is', null),
      eb('user_enrolments.time_end', '>', now),
    ]))
    .execute();
  return rows.map((r) => r.courseId);
}

/** Bản cũ của roleAssignedCourseIds (sao nguyên văn để đối chiếu trước/sau). */
async function oldRoleAssignedCourseIds(oldDb: OldDb, userId: string): Promise<string[]> {
  const rows = await oldDb
    .selectFrom('role_assignments')
    .innerJoin('context', 'context.id', 'role_assignments.context_id')
    .select('context.instance_id as courseId')
    .distinct()
    .where('role_assignments.user_id', '=', userId)
    .where('context.context_level', '=', COURSE_LEVEL)
    .where('context.instance_id', 'is not', null)
    .execute();
  return rows.map((r) => r.courseId!).filter(Boolean);
}

/** Bản cũ của courseNames (sao nguyên văn để đối chiếu trước/sau). */
async function oldCourseNames(oldDb: OldDb, courseIds: string[]): Promise<Map<string, string>> {
  if (!courseIds.length) return new Map();
  const rows = await oldDb.selectFrom('course')
    .select(['id', 'full_name as fullName'])
    .where('id', 'in', courseIds)
    .execute();
  return new Map(rows.map((r) => [r.id, r.fullName]));
}

/** Bản cũ của quizDueRows (sao nguyên văn để đối chiếu trước/sau). */
async function oldQuizDueRows(oldDb: OldDb, courseIds: string[], userId: string, until: Date) {
  if (!courseIds.length) return [];
  return oldDb
    .selectFrom('course_modules')
    .innerJoin('exam_pins', 'exam_pins.id', 'course_modules.instance_id')
    .innerJoin('exam_versions', 'exam_versions.id', 'exam_pins.exam_version_id')
    .leftJoin('exam_attempts', (join) => join
      .onRef('exam_attempts.pin_id', '=', 'exam_pins.id')
      .on('exam_attempts.user_id', '=', userId)
      .on('exam_attempts.preview', '=', false))
    .select([
      'course_modules.id as cmId',
      'course_modules.instance_id as activityId',
      'course_modules.course as courseId',
      kyselySql<string>`coalesce(exam_pins.name, exam_versions.name)`.as('name'),
      'exam_pins.time_close as dueAt',
      'exam_attempts.state as attemptState',
    ])
    .where('course_modules.course', 'in', courseIds)
    .where('course_modules.component', '=', 'mod_quiz')
    .where('course_modules.visible', '=', true)
    .where('course_modules.deletion_in_progress', '=', false)
    .where('exam_pins.time_close', 'is not', null)
    .where('exam_pins.time_close', '<=', until)
    .orderBy('exam_pins.time_close')
    .execute();
}

/** Bản cũ của assignmentDueRows (sao nguyên văn để đối chiếu trước/sau). */
async function oldAssignmentDueRows(oldDb: OldDb, courseIds: string[], userId: string, until: Date) {
  if (!courseIds.length) return [];
  return oldDb
    .selectFrom('course_modules')
    .innerJoin('assignments', 'assignments.id', 'course_modules.instance_id')
    .leftJoin('assign_submissions', (join) => join
      .onRef('assign_submissions.assignment_id', '=', 'assignments.id')
      .on('assign_submissions.user_id', '=', userId))
    .select([
      'course_modules.id as cmId',
      'course_modules.instance_id as activityId',
      'course_modules.course as courseId',
      'assignments.name as name',
      'assignments.due_date as dueAt',
      'assign_submissions.status as submissionStatus',
    ])
    .where('course_modules.course', 'in', courseIds)
    .where('course_modules.component', '=', 'mod_assign')
    .where('course_modules.visible', '=', true)
    .where('course_modules.deletion_in_progress', '=', false)
    .where('assignments.due_date', 'is not', null)
    .where('assignments.due_date', '<=', until)
    .orderBy('assignments.due_date')
    .execute();
}

/** Cột đọc của hai bản cũ gradeRows* — đúng hình dạng `DashboardGradeRow`. */
const OLD_GRADE_ROW_COLUMNS = [
  'grade_grades.id as gradeId',
  'grade_items.course_id as courseId',
  'grade_items.id as itemId',
  'grade_items.item_name as itemName',
  'grade_items.item_type as itemType',
  'grade_grades.final_grade as finalGrade',
  'grade_items.grade_max as gradeMax',
  'grade_grades.feedback as feedback',
  'grade_grades.updated_at as updatedAt',
] as const;

/** Mảnh điều kiện hiển thị của bản cũ: có điểm, hoặc có phản hồi khác rỗng. */
const OLD_VISIBLE_GRADE = kyselySql<boolean>`(grade_grades.final_grade is not null or (grade_grades.feedback is not null and grade_grades.feedback <> ''))`;

/** Bản cũ của gradeRowsSince (sao nguyên văn để đối chiếu trước/sau). */
async function oldGradeRowsSince(oldDb: OldDb, courseIds: string[], userId: string, since: Date) {
  if (!courseIds.length) return [];
  return oldDb
    .selectFrom('grade_grades')
    .innerJoin('grade_items', 'grade_items.id', 'grade_grades.item_id')
    .select(OLD_GRADE_ROW_COLUMNS)
    .where('grade_grades.user_id', '=', userId)
    .where('grade_items.course_id', 'in', courseIds)
    .where('grade_grades.updated_at', '>', since)
    .where(OLD_VISIBLE_GRADE)
    .orderBy('grade_grades.updated_at')
    .execute();
}

/** Bản cũ của itemPublications (sao nguyên văn để đối chiếu trước/sau). */
async function oldItemPublications(oldDb: OldDb, courseIds: string[]) {
  if (!courseIds.length) return [];
  return oldDb
    .selectFrom('grade_publications')
    .select([
      'id', 'course_id as courseId', 'item_id as itemId', 'scope', 'action',
      'actor_id as actorId', 'note', 'created_at as createdAt',
    ])
    .where('course_id', 'in', courseIds)
    .where('scope', '=', 'item')
    .orderBy('created_at')
    .execute();
}

/** Bản cũ của gradeRowsForItems (sao nguyên văn để đối chiếu trước/sau). */
async function oldGradeRowsForItems(oldDb: OldDb, itemIds: string[], userId: string) {
  if (!itemIds.length) return [];
  return oldDb
    .selectFrom('grade_grades')
    .innerJoin('grade_items', 'grade_items.id', 'grade_grades.item_id')
    .select(OLD_GRADE_ROW_COLUMNS)
    .where('grade_grades.user_id', '=', userId)
    .where('grade_grades.item_id', 'in', itemIds)
    .where(OLD_VISIBLE_GRADE)
    .execute();
}

/** Bản cũ của assignmentPendingRows (sao nguyên văn để đối chiếu trước/sau). */
async function oldAssignmentPendingRows(oldDb: OldDb, courseIds: string[]) {
  if (!courseIds.length) return [];
  return oldDb
    .selectFrom('assign_submissions')
    .innerJoin('assignments', 'assignments.id', 'assign_submissions.assignment_id')
    .leftJoin('assign_grades', (join) => join
      .onRef('assign_grades.assignment_id', '=', 'assign_submissions.assignment_id')
      .onRef('assign_grades.user_id', '=', 'assign_submissions.user_id')
      .onRef('assign_grades.attempt_number', '=', 'assign_submissions.attempt_number'))
    .select([
      'assignments.course as courseId',
      'assign_submissions.submitted_at as submittedAt',
      'assign_grades.status as gradeStatus',
    ])
    .where('assignments.course', 'in', courseIds)
    .where('assign_submissions.status', '=', 'submitted')
    .execute();
}

/** Bản cũ của quizPendingRows (sao nguyên văn để đối chiếu trước/sau). */
async function oldQuizPendingRows(oldDb: OldDb, courseIds: string[]) {
  if (!courseIds.length) return [];
  return oldDb
    .selectFrom('exam_attempts')
    .innerJoin('exam_pins', 'exam_pins.id', 'exam_attempts.pin_id')
    .select([
      'exam_pins.course_id as courseId',
      'exam_attempts.time_finish as timeFinish',
      'exam_attempts.time_start as timeStart',
    ])
    .where('exam_pins.course_id', 'in', courseIds)
    .where('exam_attempts.state', '=', 'needsgrading')
    .where('exam_attempts.preview', '=', false)
    .execute();
}

/** Bản cũ của paperPendingRows (sao nguyên văn để đối chiếu trước/sau). */
async function oldPaperPendingRows(oldDb: OldDb, courseIds: string[]) {
  if (!courseIds.length) return [];
  return oldDb
    .selectFrom('exam_scans')
    .innerJoin('exam_pins', 'exam_pins.id', 'exam_scans.exam_pin_id')
    .select([
      'exam_pins.course_id as courseId',
      'exam_scans.exam_pin_id as pinId',
      'exam_scans.created_at as createdAt',
    ])
    .where('exam_pins.course_id', 'in', courseIds)
    .where('exam_scans.status', 'in', ['needs_identity', 'needs_review'])
    .execute();
}

/** Cột đọc của hai bảng mốc xem/tuỳ chọn với bí danh camelCase (dùng cho select + returning). */
const OLD_STATE_COLUMNS = [
  'user_id as userId', 'last_seen_at as lastSeenAt', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;
const OLD_PREF_COLUMNS = [
  'user_id as userId', 'course_id as courseId', 'color', 'nickname', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;

/** Bản cũ của getState (sao nguyên văn để đối chiếu trước/sau). */
async function oldGetState(oldDb: OldDb, userId: string) {
  return oldDb.selectFrom('user_dashboard_state')
    .select(OLD_STATE_COLUMNS)
    .where('user_id', '=', userId)
    .executeTakeFirst();
}

/** Bản cũ của touchState (sao nguyên văn để đối chiếu trước/sau). */
async function oldTouchState(oldDb: OldDb, userId: string, at: Date): Promise<void> {
  await oldDb.insertInto('user_dashboard_state')
    .values({ user_id: userId, last_seen_at: at })
    .onConflict((oc) => oc.column('user_id').doUpdateSet({ last_seen_at: at, updated_at: new Date() }))
    .execute();
}

/** Bản cũ của listPrefs (sao nguyên văn để đối chiếu trước/sau). */
async function oldListPrefs(oldDb: OldDb, userId: string) {
  return oldDb.selectFrom('user_course_card_prefs')
    .select(OLD_PREF_COLUMNS)
    .where('user_id', '=', userId)
    .orderBy('course_id')
    .execute();
}

/** Bản cũ của upsertPref (sao nguyên văn để đối chiếu trước/sau). */
async function oldUpsertPref(oldDb: OldDb, userId: string, courseId: string, color: string | null, nickname: string | null) {
  return oldDb.insertInto('user_course_card_prefs')
    .values({ user_id: userId, course_id: courseId, color, nickname })
    .onConflict((oc) => oc.columns(['user_id', 'course_id']).doUpdateSet({ color, nickname, updated_at: new Date() }))
    .returning(OLD_PREF_COLUMNS)
    .executeTakeFirstOrThrow();
}

/** Bản cũ của deletePref (sao nguyên văn để đối chiếu trước/sau). */
async function oldDeletePref(oldDb: OldDb, userId: string, courseId: string): Promise<void> {
  await oldDb.deleteFrom('user_course_card_prefs')
    .where('user_id', '=', userId)
    .where('course_id', '=', courseId)
    .execute();
}

// ---------------------------------------------------------------------------
// Dữ kiện mẫu: một trung tâm, ba người dùng, hai khoá. Khoá A chứa đủ các
// nguồn của dashboard; khoá B chỉ để kiểm các biên lọc (ghi danh hết hạn).
// ---------------------------------------------------------------------------

let itemModId = '';
let itemManualId = '';
let itemOldId = '';

beforeAll(async () => {
  if (!adminUrl) {
    throw new Error('Thiếu kết nối quản trị cho spec tích hợp dashboard: đặt LMS_DB_TEST_ADMIN_URL hoặc DATABASE_URL.');
  }
  const url = await buildTestDatabase({ adminUrl, database: TEST_DB, store: 'centre' });
  pool = new Pool({ connectionString: url });
  db = createCentreKysely(pool);
  repo = new DashboardRepository(db, TEST_CONTEXT_LEVELS);

  await db.insertInto('tenants').values({ id: TENANT_ID, slug: 'dash-652', name: 'Trung tâm mẫu 652', kind: 'centre' }).execute();
  for (const [id, username] of [[STUDENT_ID, 'dash-student'], [TEACHER_ID, 'dash-teacher'], [OTHER_ID, 'dash-other']] as const) {
    await db.insertInto('users').values({ id, email: `${username}@example.test`, username }).execute();
  }
  const category = await db.insertInto('course_categories')
    .values({ name: 'Danh mục 652', tenant_id: TENANT_ID }).returning('id').executeTakeFirstOrThrow();
  for (const [id, fullName, shortName] of [[COURSE_A, 'Khoá Toán 652', 'TOAN652'], [COURSE_B, 'Khoá Văn 652', 'VAN652']] as const) {
    // is_template = true để qua check course_class_required_check
    // (khoá mẫu của spec không gắn lớp học thật).
    await db.insertInto('course').values({ id, category: category.id, full_name: fullName, short_name: shortName, tenant_id: TENANT_ID, is_template: true }).execute();
  }
  const section = await db.insertInto('course_sections').values({ course: COURSE_A }).returning('id').executeTakeFirstOrThrow();
  const sectionB = await db.insertInto('course_sections').values({ course: COURSE_B }).returning('id').executeTakeFirstOrThrow();
  void sectionB;

  // Ghi danh: học sinh hiệu lực ở khoá A; hết hạn ở khoá B; giáo viên có
  // dòng ghi danh không hiệu lực (status khác 0) ở khoá A.
  const enrolA = await db.insertInto('enrol').values({ course_id: COURSE_A, enrol: 'manual' }).returning('id').executeTakeFirstOrThrow();
  const enrolB = await db.insertInto('enrol').values({ course_id: COURSE_B, enrol: 'manual' }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('user_enrolments').values({ enrol_id: enrolA.id, user_id: STUDENT_ID, status: 0, time_end: null }).execute();
  await db.insertInto('user_enrolments').values({ enrol_id: enrolB.id, user_id: STUDENT_ID, status: 0, time_end: new Date('2026-10-01T00:00:00.000Z') }).execute();
  await db.insertInto('user_enrolments').values({ enrol_id: enrolA.id, user_id: TEACHER_ID, status: 1, time_end: null }).execute();

  // Context: một context mức khoá (qua cổng) gắn khoá A, một context mức
  // khác gắn khoá B, một context mức khoá không gắn instance.
  const role = await db.insertInto('role').values({ short_name: 'dash-teacher-role' }).returning('id').executeTakeFirstOrThrow();
  const ctxCourse = await db.insertInto('context')
    .values({ context_level: COURSE_LEVEL, instance_id: COURSE_A, path: '/1/777', depth: 2 }).returning('id').executeTakeFirstOrThrow();
  const ctxOther = await db.insertInto('context')
    .values({ context_level: OTHER_LEVEL, instance_id: COURSE_B, path: '/1/555', depth: 2 }).returning('id').executeTakeFirstOrThrow();
  const ctxNoInstance = await db.insertInto('context')
    .values({ context_level: COURSE_LEVEL, instance_id: null, path: '/1/778', depth: 2 }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('role_assignments').values({ role_id: role.id, user_id: TEACHER_ID, context_id: ctxCourse.id }).execute();
  await db.insertInto('role_assignments').values({ role_id: role.id, user_id: TEACHER_ID, context_id: ctxOther.id }).execute();
  await db.insertInto('role_assignments').values({ role_id: role.id, user_id: TEACHER_ID, context_id: ctxNoInstance.id }).execute();
  await db.insertInto('role_assignments').values({ role_id: role.id, user_id: STUDENT_ID, context_id: ctxCourse.id }).execute();

  // Chuỗi đề: ngân hàng → đề → phiên bản → ba pin (một pin không đặt tên
  // riêng để kiểm coalesce, một pin quá mốc until).
  const bank = await db.insertInto('question_banks')
    .values({ tenant_id: TENANT_ID, name: 'Ngân hàng 652', scope: 'school', context_id: ctxCourse.id, created_by: TEACHER_ID })
    .returning('id').executeTakeFirstOrThrow();
  const exam = await db.insertInto('exams').values({ bank_id: bank.id, created_by: TEACHER_ID }).returning('id').executeTakeFirstOrThrow();
  const version = await db.insertInto('exam_versions')
    .values({ exam_id: exam.id, created_by: TEACHER_ID, name: 'Đề kiểm tra mẫu', version: 1 }).returning('id').executeTakeFirstOrThrow();
  const mkPin = async (name: string | null, timeClose: Date) => db.insertInto('exam_pins')
    .values({ exam_id: exam.id, exam_version_id: version.id, course_id: COURSE_A, created_by: TEACHER_ID, name, time_close: timeClose, variants: kyselySql`'[]'::jsonb` })
    .returning('id').executeTakeFirstOrThrow();
  const pin1 = await mkPin(null, new Date('2026-11-05T10:00:00.000Z'));
  const pin2 = await mkPin('Pin hai', new Date('2026-11-06T10:00:00.000Z'));
  const pinLate = await mkPin('Pin muộn', new Date('2026-12-01T10:00:00.000Z'));

  const mkCm = async (component: string, instanceId: string, visible = true) => db.insertInto('course_modules')
    .values({ course: COURSE_A, section: section.id, component, instance_id: instanceId, visible })
    .returning('id').executeTakeFirstOrThrow();
  await mkCm('mod_quiz', pin1.id);
  await mkCm('mod_quiz', pin2.id);
  await mkCm('mod_quiz', pinLate.id);
  await mkCm('mod_quiz', pin1.id, false);

  // Attempt của học sinh trên pin1: một attempt thật đang làm, một attempt
  // xem trước (phải bị điều kiện ON của left join loại). Attempt chờ chấm
  // tay của người khác trên pin2 cho hàng đợi chấm.
  const mkUsage = async (userId: string) => db.insertInto('question_usages')
    .values({ component: 'mod_quiz', user_id: userId }).returning('id').executeTakeFirstOrThrow();
  const usage1 = await mkUsage(STUDENT_ID);
  const usage2 = await mkUsage(STUDENT_ID);
  const usage3 = await mkUsage(OTHER_ID);
  await db.insertInto('exam_attempts').values({ pin_id: pin1.id, user_id: STUDENT_ID, usage_id: usage1.id, attempt_number: 1, state: 'inprogress', preview: false, time_start: new Date('2026-11-02T08:00:00.000Z') }).execute();
  await db.insertInto('exam_attempts').values({ pin_id: pin1.id, user_id: STUDENT_ID, usage_id: usage2.id, attempt_number: 2, state: 'finished', preview: true, time_start: new Date('2026-11-02T08:30:00.000Z') }).execute();
  await db.insertInto('exam_attempts').values({ pin_id: pin2.id, user_id: OTHER_ID, usage_id: usage3.id, attempt_number: 1, state: 'needsgrading', preview: false, time_start: new Date('2026-11-02T09:00:00.000Z'), time_finish: new Date('2026-11-02T09:20:00.000Z') }).execute();

  // Bài tập: một bài có hạn nộp kèm bài nộp nháp của học sinh và bài nộp
  // đã nộp của người khác (kèm gói chấm attempt hiện tại); một bài không
  // hạn nộp (bị lọc khỏi danh sách đến hạn nhưng bài nộp của nó vẫn vào
  // hàng đợi chờ chấm khi đã nộp).
  const assignment1 = await db.insertInto('assignments')
    .values({ course: COURSE_A, name: 'Bài tập 1', due_date: new Date('2026-11-04T10:00:00.000Z') }).returning('id').executeTakeFirstOrThrow();
  const assignment2 = await db.insertInto('assignments')
    .values({ course: COURSE_A, name: 'Bài tập 2', due_date: null }).returning('id').executeTakeFirstOrThrow();
  await mkCm('mod_assign', assignment1.id);
  await mkCm('mod_assign', assignment2.id);
  await db.insertInto('assign_submissions').values({ assignment_id: assignment1.id, user_id: STUDENT_ID, status: 'draft', attempt_number: 1, submitted_at: null }).execute();
  await db.insertInto('assign_submissions').values({ assignment_id: assignment1.id, user_id: OTHER_ID, status: 'submitted', attempt_number: 1, submitted_at: new Date('2026-11-02T07:00:00.000Z') }).execute();
  await db.insertInto('assign_submissions').values({ assignment_id: assignment2.id, user_id: OTHER_ID, status: 'submitted', attempt_number: 1, submitted_at: new Date('2026-11-02T07:30:00.000Z') }).execute();
  await db.insertInto('assign_grades').values({ assignment_id: assignment1.id, user_id: OTHER_ID, grader_id: TEACHER_ID, attempt_number: 1, status: 'released' }).execute();

  // Điểm: bốn item (mỗi cặp item/người học chỉ có một dòng điểm theo
  // unique của bảng) phủ các nhánh của mảnh điều kiện hiển thị (có
  // điểm / chỉ có phản hồi / cả hai đều trống) và mốc thời gian (sau
  // mốc xem / trước mốc xem).
  const itemMod = await db.insertInto('grade_items')
    .values({ course_id: COURSE_A, item_name: 'Quiz 1', item_type: 'mod', grade_max: 10 }).returning('id').executeTakeFirstOrThrow();
  const itemManual = await db.insertInto('grade_items')
    .values({ course_id: COURSE_A, item_name: 'Điểm miệng', item_type: 'manual', grade_max: 10 }).returning('id').executeTakeFirstOrThrow();
  const itemBlank = await db.insertInto('grade_items')
    .values({ course_id: COURSE_A, item_name: 'Điểm trống', item_type: 'manual', grade_max: 10 }).returning('id').executeTakeFirstOrThrow();
  const itemOld = await db.insertInto('grade_items')
    .values({ course_id: COURSE_A, item_name: 'Điểm cũ', item_type: 'manual', grade_max: 10 }).returning('id').executeTakeFirstOrThrow();
  itemModId = itemMod.id;
  itemManualId = itemManual.id;
  itemOldId = itemOld.id;
  const mkGrade = async (itemId: string, patch: { finalGrade: number | null; feedback: string | null; updatedAt: Date }) => {
    await db.insertInto('grade_grades').values({
      item_id: itemId, user_id: STUDENT_ID, final_grade: patch.finalGrade, feedback: patch.feedback, updated_at: patch.updatedAt,
    }).execute();
  };
  await mkGrade(itemMod.id, { finalGrade: 8.5, feedback: null, updatedAt: new Date('2026-11-01T12:00:00.000Z') });
  await mkGrade(itemManual.id, { finalGrade: null, feedback: 'Làm tốt', updatedAt: new Date('2026-11-01T12:05:00.000Z') });
  await mkGrade(itemBlank.id, { finalGrade: null, feedback: '', updatedAt: new Date('2026-11-01T12:10:00.000Z') });
  await mkGrade(itemOld.id, { finalGrade: 7, feedback: null, updatedAt: new Date('2026-10-01T12:00:00.000Z') });

  // Vết công bố: một vết scope item sau mốc, một vết scope khác (bị lọc).
  await db.insertInto('grade_publications').values({ course_id: COURSE_A, scope: 'item', item_id: itemManual.id, action: 'publish', actor_id: TEACHER_ID, created_at: new Date('2026-11-01T13:00:00.000Z') }).execute();
  await db.insertInto('grade_publications').values({ course_id: COURSE_A, scope: 'course', item_id: null, action: 'publish', actor_id: TEACHER_ID, created_at: new Date('2026-11-01T13:05:00.000Z') }).execute();

  // Phiếu giấy: hai trạng thái chờ + một trạng thái đã đủ điều kiện ghi.
  const mkScan = async (status: string, createdAt: Date) => db.insertInto('exam_scans')
    .values({ exam_pin_id: pin1.id, file_id: '01a19887-6b35-7760-8e64-a5960bfd0099', uploaded_by: TEACHER_ID, status, created_at: createdAt }).execute();
  await mkScan('needs_review', new Date('2026-11-02T06:00:00.000Z'));
  await mkScan('needs_identity', new Date('2026-11-02T06:05:00.000Z'));
  await mkScan('ready', new Date('2026-11-02T06:10:00.000Z'));
}, 300_000);

afterAll(async () => {
  await db.destroy().catch(() => undefined);
  await dropTestDatabase(adminUrl!, TEST_DB).catch(() => undefined);
});

/** Sắp xếp ổn định cho các method không có thứ tự hợp đồng, để so hai đường theo tập dòng. */
function sortedBy<T>(rows: T[], key: (row: T) => string): T[] {
  return [...rows].sort((a, b) => key(a).localeCompare(key(b)));
}

describe('đối chiếu dashboard: tập khoá của người dùng', () => {
  it('enrolledCourseIds khớp đường cũ và chỉ gồm khoá còn ghi danh hiệu lực', async () => {
    const expected = await oldEnrolledCourseIds(db, STUDENT_ID, NOW);
    const actual = await repo.enrolledCourseIds(STUDENT_ID, NOW);
    expect(actual).toEqual(expected);
    expect(actual).toEqual([COURSE_A]);
    expect(await repo.enrolledCourseIds(TEACHER_ID, NOW)).toEqual([]);
  });

  it('roleAssignedCourseIds khớp đường cũ và mức khoá chỉ đến từ cổng', async () => {
    const expected = await oldRoleAssignedCourseIds(db, TEACHER_ID);
    const actual = await repo.roleAssignedCourseIds(TEACHER_ID);
    expect(actual).toEqual(expected);
    expect(actual).toEqual([COURSE_A]);
  });

  it('courseNames khớp đường cũ; tập rỗng trả Map rỗng ở cả hai đường', async () => {
    const expected = await oldCourseNames(db, [COURSE_A, COURSE_B]);
    const actual = await repo.courseNames([COURSE_A, COURSE_B]);
    expect([...actual.entries()].sort()).toEqual([...expected.entries()].sort());
    expect(actual.get(COURSE_A)).toBe('Khoá Toán 652');
    expect((await repo.courseNames([])).size).toBe(0);
    expect((await oldCourseNames(db, [])).size).toBe(0);
  });
});

describe('đối chiếu dashboard: việc đến hạn', () => {
  it('quizDueRows khớp đường cũ, gồm coalesce tên pin và loại attempt xem trước', async () => {
    const expected = await oldQuizDueRows(db, [COURSE_A], STUDENT_ID, UNTIL);
    const actual = await repo.quizDueRows([COURSE_A], STUDENT_ID, UNTIL);
    expect(actual).toEqual(expected);
    expect(actual.map((r) => r.name)).toEqual(['Đề kiểm tra mẫu', 'Pin hai']);
    expect(actual.map((r) => r.attemptState)).toEqual(['inprogress', null]);
  });

  it('assignmentDueRows khớp đường cũ; bài chưa nộp có submissionStatus null', async () => {
    const expected = await oldAssignmentDueRows(db, [COURSE_A], STUDENT_ID, UNTIL);
    const actual = await repo.assignmentDueRows([COURSE_A], STUDENT_ID, UNTIL);
    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(1);
    expect(actual[0]!.submissionStatus).toBe('draft');
  });

  it('tập khoá rỗng trả mảng rỗng ở mọi method đọc theo tập khoá, cả hai đường', async () => {
    expect(await repo.quizDueRows([], STUDENT_ID, UNTIL)).toEqual([]);
    expect(await repo.assignmentDueRows([], STUDENT_ID, UNTIL)).toEqual([]);
    expect(await repo.gradeRowsSince([], STUDENT_ID, SINCE)).toEqual([]);
    expect(await repo.itemPublications([])).toEqual([]);
    expect(await repo.gradeRowsForItems([], STUDENT_ID)).toEqual([]);
    expect(await repo.assignmentPendingRows([])).toEqual([]);
    expect(await repo.quizPendingRows([])).toEqual([]);
    expect(await repo.paperPendingRows([])).toEqual([]);
  });
});

describe('đối chiếu dashboard: điểm và công bố', () => {
  it('gradeRowsSince khớp đường cũ và mảnh điều kiện loại dòng không có điểm lẫn phản hồi', async () => {
    const expected = await oldGradeRowsSince(db, [COURSE_A], STUDENT_ID, SINCE);
    const actual = await repo.gradeRowsSince([COURSE_A], STUDENT_ID, SINCE);
    expect(actual).toEqual(expected);
    expect(actual.map((r) => r.finalGrade)).toEqual([8.5, null]);
    expect(actual.map((r) => r.feedback)).toEqual([null, 'Làm tốt']);
  });

  it('itemPublications khớp đường cũ và chỉ gồm vết scope item theo thời gian tăng dần', async () => {
    const expected = await oldItemPublications(db, [COURSE_A]);
    const actual = await repo.itemPublications([COURSE_A]);
    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(1);
    expect(actual[0]!.itemId).toBe(itemManualId);
  });

  it('gradeRowsForItems khớp đường cũ trên tập item ứng viên và không lọc theo mốc thời gian', async () => {
    const expected = await oldGradeRowsForItems(db, [itemManualId, itemModId, itemOldId], STUDENT_ID);
    const actual = await repo.gradeRowsForItems([itemManualId, itemModId, itemOldId], STUDENT_ID);
    expect(sortedBy(actual, (r) => r.gradeId)).toEqual(sortedBy(expected, (r) => r.gradeId));
    // Ba dòng: điểm hiện tại, dòng chỉ có phản hồi, và dòng điểm cũ
    // trước mốc xem (method này không có điều kiện thời gian); dòng
    // không có điểm lẫn phản hồi khác rỗng bị mảnh điều kiện loại.
    expect(actual).toHaveLength(3);
  });
});

describe('đối chiếu dashboard: hàng đợi chấm', () => {
  it('assignmentPendingRows khớp đường cũ, kèm trạng thái gói chấm của đúng attempt hiện tại', async () => {
    const expected = await oldAssignmentPendingRows(db, [COURSE_A]);
    const actual = await repo.assignmentPendingRows([COURSE_A]);
    const key = (r: { submittedAt: Date | null }) => String(r.submittedAt?.getTime());
    expect(sortedBy(actual, key)).toEqual(sortedBy(expected, key));
    expect(actual.map((r) => r.gradeStatus).sort()).toEqual([null, 'released']);
  });

  it('quizPendingRows khớp đường cũ và chỉ gồm lượt chờ chấm tay không phải xem trước', async () => {
    const expected = await oldQuizPendingRows(db, [COURSE_A]);
    const actual = await repo.quizPendingRows([COURSE_A]);
    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(1);
  });

  it('paperPendingRows khớp đường cũ và chỉ gồm hai trạng thái chờ xử lý', async () => {
    const expected = await oldPaperPendingRows(db, [COURSE_A]);
    const actual = await repo.paperPendingRows([COURSE_A]);
    const key = (r: { createdAt: Date }) => String(r.createdAt.getTime());
    expect(sortedBy(actual, key)).toEqual(sortedBy(expected, key));
    expect(actual).toHaveLength(2);
  });
});

describe('đối chiếu dashboard: mốc xem và tuỳ chọn thẻ khoá (ghi hai chiều)', () => {
  it('getState khi chưa từng xem là undefined ở cả hai đường', async () => {
    expect(await repo.getState(OTHER_ID)).toBeUndefined();
    expect(await oldGetState(db, OTHER_ID)).toBeUndefined();
  });

  it('touchState ghi bằng đường mới thì đường cũ đọc khớp, và ngược lại ở nhánh cập nhật', async () => {
    const first = new Date('2026-11-02T10:00:00.000Z');
    await repo.touchState(OTHER_ID, first);
    const readByOld = await oldGetState(db, OTHER_ID);
    expect(readByOld?.lastSeenAt.getTime()).toBe(first.getTime());

    const second = new Date('2026-11-02T11:00:00.000Z');
    await oldTouchState(db, OTHER_ID, second);
    const readByNew = await repo.getState(OTHER_ID);
    expect(readByNew?.lastSeenAt.getTime()).toBe(second.getTime());
    expect(readByNew?.userId).toBe(OTHER_ID);
  });

  it('upsertPref ghi bằng đường mới thì đường cũ đọc khớp; cập nhật bằng đường cũ thì đường mới đọc khớp', async () => {
    const created = await repo.upsertPref(STUDENT_ID, COURSE_A, 'blue', 'Toán của tôi');
    expect(created).toMatchObject({ userId: STUDENT_ID, courseId: COURSE_A, color: 'blue', nickname: 'Toán của tôi' });
    const readByOld = await oldListPrefs(db, STUDENT_ID);
    expect(readByOld).toHaveLength(1);
    expect(readByOld[0]).toMatchObject({ color: 'blue', nickname: 'Toán của tôi' });

    const updated = await oldUpsertPref(db, STUDENT_ID, COURSE_A, null, null);
    expect(updated).toMatchObject({ color: null, nickname: null });
    const readByNew = await repo.listPrefs(STUDENT_ID);
    expect(readByNew).toHaveLength(1);
    expect(readByNew[0]).toMatchObject({ color: null, nickname: null });
    expect(readByNew[0]!.createdAt.getTime()).toBe(created.createdAt.getTime());
  });

  it('deletePref bằng đường mới xoá được dòng do đường cũ ghi, và ngược lại', async () => {
    await oldUpsertPref(db, TEACHER_ID, COURSE_A, 'red', null);
    await repo.deletePref(TEACHER_ID, COURSE_A);
    expect(await oldListPrefs(db, TEACHER_ID)).toEqual([]);

    await repo.upsertPref(TEACHER_ID, COURSE_B, 'green', 'Văn');
    await oldDeletePref(db, TEACHER_ID, COURSE_B);
    expect(await repo.listPrefs(TEACHER_ID)).toEqual([]);
  });
});

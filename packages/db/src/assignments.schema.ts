/** Các bảng của bounded context Bài tập nộp tệp/ảnh (mod_assign) — định nghĩa Drizzle do module assignments sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { course } from './courses.schema';
import { files } from './files.schema';

/**
 * Hoạt động Bài tập nộp tệp/ảnh trong khoá học (Moodle `assign` với
 * submission type file/ảnh): instance của một course module
 * (course_modules trỏ instance_id về đây, component 'mod_assign'; cột
 * cm_id là bản sao tiện tra cứu — nguồn sự thật của quan hệ cm vẫn là
 * course_modules.instance_id). grade là thang điểm của BÀI. due_date là
 * hạn nộp: nộp sau hạn vẫn được nhận nhưng bị đánh dấu trễ (late).
 * accepted_file_types: danh sách đuôi tệp cách nhau bằng dấu phẩy
 * (không phân biệt hoa thường, không kèm dấu chấm); null = mọi loại tệp.
 */
export const assignments = pgTable('assignments', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  course: uuid('course').notNull().references(() => course.id, { onDelete: 'cascade' }),
  cmId: uuid('cm_id'),
  name: text('name').notNull(),
  intro: text('intro').notNull().default(''),
  dueDate: timestamp('due_date', { withTimezone: true }),
  maxFiles: integer('max_files').notNull().default(10),
  acceptedFileTypes: text('accepted_file_types'),
  grade: doublePrecision('grade').notNull().default(10),
  /**
   * Chế độ kết quả của bài theo TT 22/2021 Điều 5 (mục 1.1 hồ sơ chấm/
   * phản hồi): 'score' = chỉ điểm; 'level' = chỉ mức Đạt/Chưa đạt + nhận
   * xét (nhóm môn chỉ đánh giá bằng nhận xét); 'score_feedback' = điểm
   * kết hợp nhận xét. Chế độ 'level': bản ghi chấm giữ mức ở
   * assign_grades.level; sổ điểm nhận ánh xạ 1 (Đạt) / 0 (Chưa đạt) trên
   * grade item thang 1 tại thời điểm trả bài.
   */
  resultMode: text('result_mode').notNull().default('score_feedback'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('assignments_course_idx').on(table.course),
      index('assignments_cm_id_idx').on(table.cmId),
  ]);

/**
 * Bài nộp của một học sinh cho một bài tập (Moodle `assign_submission`):
 * mỗi (assignment, user) có đúng một bản ghi hiện hành. Vòng đời:
 * draft (đang soạn, thêm/bớt tệp được) → submitted (đã chốt nộp; muốn sửa
 * phải mở lại về draft khi gói chấm chưa được TRẢ BÀI — chấm nháp không
 * khoá) — gói chấm đã trả bài (assign_grades khớp attempt_number và
 * status 'released') thì khoá hẳn. attempt_number tăng
 * mỗi lần nộp lại sau khi mở lại. submitted_at là mốc nộp gần nhất; nộp
 * trễ khi submitted_at > assignments.due_date.
 */
export const assignSubmissions = pgTable('assign_submissions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  assignmentId: uuid('assignment_id').notNull().references(() => assignments.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  status: text('status').notNull().default('draft'),
  attemptNumber: integer('attempt_number').notNull().default(1),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('assign_submissions_assignment_id_idx').on(table.assignmentId),
      index('assign_submissions_user_id_idx').on(table.userId),
      unique('assign_submissions_assignment_user_unique').on(table.assignmentId, table.userId),
  ]);

/**
 * Tệp thuộc một bài nộp: bản ghi vật lý sống ở bảng `files` của module
 * Files (component 'mod_assign', file_area 'submission_files', item_id =
 * submission id, context = context của course module) — dedup theo
 * content hash và tải qua signed URL như mọi tệp trong hệ thống; bảng này
 * chỉ giữ quan hệ bài nộp ↔ tệp và thứ tự hiển thị khi chấm.
 */
export const assignSubmissionFiles = pgTable('assign_submission_files', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  submissionId: uuid('submission_id').notNull().references(() => assignSubmissions.id, { onDelete: 'cascade' }),
  fileId: uuid('file_id').notNull().references(() => files.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('assign_submission_files_submission_id_idx').on(table.submissionId),
      index('assign_submission_files_file_id_idx').on(table.fileId),
      unique('assign_submission_files_submission_file_unique').on(table.submissionId, table.fileId),
  ]);

/**
 * Gói chấm của giáo viên cho một bài nộp (Moodle `assign_grades` mở
 * rộng): mỗi (assignment, user) một bản ghi hiện hành; attempt_number
 * ghi lại gói chấm thuộc lần nộp nào.
 *
 * Vòng đời TRẢ BÀI (mục 5.2 hồ sơ chấm/phản hồi — Google Return / Canvas
 * posting policy): gói chấm ở trạng thái 'draft' là NHÁP — điểm, mức,
 * lời phê, annotation và kết quả rubric đều CHƯA hiện với học sinh và sổ
 * điểm CHƯA nhận điểm. Giáo viên bấm trả bài thì status chuyển
 * 'released' (+ released_at/released_by): toàn bộ gói chấm công bố
 * nguyên tử và điểm mới ghi vào sổ điểm qua grade item 'mod' của course
 * module (GradesService.recordActivityGrade, source 'mod/assign') tại
 * đúng thời điểm đó. Sửa gói chấm sau khi đã trả phải đi kèm một dòng ở
 * assign_grade_revisions (vết kiểm toán).
 *
 * Lời phê cấu trúc theo TT 22/2021 Điều 5: feedback_progress (sự tiến
 * bộ), feedback_strengths (ưu điểm nổi bật), feedback_weaknesses (hạn
 * chế chủ yếu); feedback là ô nhận xét chung tự do. level giữ mức của
 * chế độ chỉ-nhận-xét: 'dat' | 'chua_dat'.
 */
export const assignGrades = pgTable('assign_grades', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  assignmentId: uuid('assignment_id').notNull().references(() => assignments.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  graderId: uuid('grader_id').notNull(),
  attemptNumber: integer('attempt_number').notNull(),
  grade: doublePrecision('grade'),
  level: text('level'),
  feedback: text('feedback'),
  feedbackProgress: text('feedback_progress'),
  feedbackStrengths: text('feedback_strengths'),
  feedbackWeaknesses: text('feedback_weaknesses'),
  status: text('status').notNull().default('draft'),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  releasedBy: uuid('released_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('assign_grades_assignment_id_idx').on(table.assignmentId),
      index('assign_grades_user_id_idx').on(table.userId),
      unique('assign_grades_assignment_user_unique').on(table.assignmentId, table.userId),
  ]);

/**
 * Dấu chấm của giáo viên NGAY TRÊN bề mặt bài nộp (ảnh chụp vở/tệp) —
 * lưu dạng VECTOR (mục 3.4 hồ sơ chấm/phản hồi; chuẩn Azota/Canvas
 * DocViewer/Moodle Annotate PDF): (tệp của bài nộp, trang, toạ độ % so
 * với khổ trang) + loại dấu — 'correct' (chạm 1 lần = đúng), 'incorrect'
 * (chạm 2 lần = sai), 'draw' (vẽ tay: points là dãy điểm % của nét vẽ),
 * 'note' (ghim ghi chú: text là nội dung), 'highlight' (tô đoạn), 'frame'
 * (khoanh vùng). TUYỆT ĐỐI không đốt annotation vào file ảnh: ảnh gốc ở
 * module Files giữ nguyên, lớp dấu là dữ liệu riêng render đè khi xem,
 * để giáo viên sửa/xoá được và học sinh trả lời được trên từng dấu sau
 * khi trả bài. Căn cứ pháp lý: TT 27/2020 Điều 6 — "viết nhận xét vào vở
 * hoặc sản phẩm học tập của học sinh", chỉ rõ chỗ đúng/chưa đúng.
 */
export const assignAnnotations = pgTable('assign_annotations', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  submissionId: uuid('submission_id').notNull().references(() => assignSubmissions.id, { onDelete: 'cascade' }),
  fileId: uuid('file_id').notNull().references(() => files.id, { onDelete: 'cascade' }),
  page: integer('page').notNull().default(1),
  x: doublePrecision('x').notNull(),
  y: doublePrecision('y').notNull(),
  kind: text('kind').notNull(),
  color: text('color'),
  text: text('text'),
  points: jsonb('points'),
  authorId: uuid('author_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('assign_annotations_submission_id_idx').on(table.submissionId),
      index('assign_annotations_file_id_idx').on(table.fileId),
  ]);

/**
 * Bảng chấm (rubric / hướng dẫn chấm) của một bài tập — tối đa một bảng
 * cho mỗi bài. Theo TT 22/2021 Điều 7 khoản 1, bài đánh giá bằng nhận
 * xét/bài thực hành/phải có hướng dẫn và tiêu chí đánh giá theo YCCĐ
 * TRƯỚC khi thực hiện: bảng chấm được công khai cho học sinh trong trang
 * bài (trước khi nộp) và hiển thị lại kèm mức đã chọn khi trả bài.
 */
export const assignRubrics = pgTable('assign_rubrics', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  assignmentId: uuid('assignment_id').notNull().references(() => assignments.id, { onDelete: 'cascade' }),
  title: text('title'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      unique('assign_rubrics_assignment_unique').on(table.assignmentId),
  ]);

/**
 * Một tiêu chí trong bảng chấm. Hai chế độ (mục 2.4 hồ sơ): 'levels' =
 * rubric chọn mức (các mức ở assign_rubric_levels — số mức/nhãn/điểm là
 * CẤU HÌNH của bài, không có thang quốc gia cho bài thường); 'score' =
 * marking guide nhập điểm tự do trong [0, max_score] + nhận xét.
 * outcome_id/outcome_text neo tiêu chí vào một YCCĐ của Curriculum (id
 * bản ghi + bản chụp nguyên văn tại thời điểm gắn) để kết quả theo tiêu
 * chí chảy ngược thành bằng chứng mức đạt YCCĐ.
 */
export const assignRubricCriteria = pgTable('assign_rubric_criteria', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  rubricId: uuid('rubric_id').notNull().references(() => assignRubrics.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  descriptionForStudent: text('description_for_student'),
  descriptionForGrader: text('description_for_grader'),
  mode: text('mode').notNull().default('levels'),
  maxScore: doublePrecision('max_score'),
  outcomeId: text('outcome_id'),
  outcomeText: text('outcome_text'),
  sortOrder: integer('sort_order').notNull().default(0),
},
  (table) => [
      index('assign_rubric_criteria_rubric_id_idx').on(table.rubricId),
  ]);

/** Một mức thể hiện của tiêu chí dạng rubric: nhãn mức + điểm của mức. */
export const assignRubricLevels = pgTable('assign_rubric_levels', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  criterionId: uuid('criterion_id').notNull().references(() => assignRubricCriteria.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  score: doublePrecision('score').notNull().default(0),
  sortOrder: integer('sort_order').notNull().default(0),
},
  (table) => [
      index('assign_rubric_levels_criterion_id_idx').on(table.criterionId),
  ]);

/**
 * Kết quả chấm theo từng tiêu chí, thuộc gói chấm (assign_grades): mức
 * đã chọn (level_id) ở chế độ rubric, hoặc điểm đã nhập (score) ở chế độ
 * marking guide, kèm nhận xét riêng của tiêu chí. Là thành phần của gói
 * chấm nháp → chỉ hiện với học sinh khi gói chấm được trả bài.
 */
export const assignRubricEvaluations = pgTable('assign_rubric_evaluations', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  gradeId: uuid('grade_id').notNull().references(() => assignGrades.id, { onDelete: 'cascade' }),
  criterionId: uuid('criterion_id').notNull().references(() => assignRubricCriteria.id, { onDelete: 'cascade' }),
  levelId: uuid('level_id').references(() => assignRubricLevels.id, { onDelete: 'set null' }),
  score: doublePrecision('score'),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('assign_rubric_evaluations_grade_id_idx').on(table.gradeId),
      index('assign_rubric_evaluations_criterion_id_idx').on(table.criterionId),
      index('assign_rubric_evaluations_level_id_idx').on(table.levelId),
      unique('assign_rubric_evaluations_grade_criterion_unique').on(table.gradeId, table.criterionId),
  ]);

/**
 * Vết kiểm toán khi gói chấm ĐÃ TRẢ bị sửa (mục 5.2 hồ sơ: chỉnh sửa sau
 * khi trả phải ghi vết — ai sửa, khi nào, giá trị trước/sau; đây là yêu
 * cầu công bằng/khách quan của TT 22 Điều 4 ở dạng dữ liệu). Mỗi lần sửa
 * sau trả ghi một dòng chụp giá trị điểm/mức/lời phê TRƯỚC và SAU.
 */
export const assignGradeRevisions = pgTable('assign_grade_revisions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  gradeId: uuid('grade_id').notNull().references(() => assignGrades.id, { onDelete: 'cascade' }),
  actorId: uuid('actor_id').notNull(),
  previousGrade: doublePrecision('previous_grade'),
  newGrade: doublePrecision('new_grade'),
  previousLevel: text('previous_level'),
  newLevel: text('new_level'),
  previousFeedback: text('previous_feedback'),
  newFeedback: text('new_feedback'),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('assign_grade_revisions_grade_id_idx').on(table.gradeId),
  ]);

/**
 * Hội thoại phản hồi trên bài ĐÃ TRẢ (Google private comment / Canvas
 * reply trên annotation — mục 5.2 hồ sơ): học sinh trả lời lại được trên
 * bài đã trả, giáo viên trao đổi tiếp trong cùng bề mặt chấm. Dữ liệu
 * neo vào bản ghi chấm (grade_id) ngay từ lát C2 này để lát hội thoại
 * (GR1) nối tiếp không phải di trú.
 */
export const assignFeedbackMessages = pgTable('assign_feedback_messages', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  gradeId: uuid('grade_id').notNull().references(() => assignGrades.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('assign_feedback_messages_grade_id_idx').on(table.gradeId),
  ]);

/**
 * Ngân hàng lời phê cá nhân của giáo viên (comment bank — Google
 * Classroom comment bank / Canvas comment library / Moodle frequently
 * used comments): các câu nhận xét thường dùng của CHÍNH giáo viên, phân
 * nhóm theo cấu trúc lời phê (strengths/weaknesses/improvement/progress/
 * general) để chèn một chạm vào ô lời phê tương ứng khi chấm. Phạm vi cá
 * nhân: chỉ chủ sở hữu thấy và dùng kho của mình.
 */
export const teacherCommentBank = pgTable('teacher_comment_bank', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  ownerId: uuid('owner_id').notNull(),
  category: text('category'),
  text: text('text').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('teacher_comment_bank_owner_id_idx').on(table.ownerId),
  ]);

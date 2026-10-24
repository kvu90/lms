/** Các bảng của bounded context Courses — định nghĩa Drizzle do module courses sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { curricula, curriculumNodes, learningOutcomes, subjects } from '../curriculum/schema';

/** Course categories form a tree (Moodle `course_categories`): path/depth like contexts. parent=0 means top level. */
export const courseCategories = pgTable('course_categories', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  idNumber: text('id_number'),
  description: text('description').notNull().default(''),
  parent: uuid('parent'),
  sortOrder: integer('sort_order').notNull().default(0),
  path: text('path').notNull().default(''),
  depth: integer('depth').notNull().default(1),
  visible: boolean('visible').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('course_categories_parent_idx').on(table.parent),
  ]);


/** Courses (Moodle `course`). group_mode: 0=NOGROUPS, 1=SEPARATEGROUPS, 2=VISIBLEGROUPS; group_mode_force=true ép chế độ nhóm của khoá lên mọi activity (bỏ qua group_mode riêng của course module). */
export const course = pgTable('course', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  category: uuid('category').notNull().references(() => courseCategories.id, { onDelete: 'cascade' }),
  fullName: text('full_name').notNull(),
  shortName: text('short_name').notNull().unique(),
  idNumber: text('id_number').notNull().default(''),
  summary: text('summary').notNull().default(''),
  format: text('format').notNull().default('topics'),
  visible: boolean('visible').notNull().default(true),
  startDate: timestamp('start_date', { withTimezone: true }),
  endDate: timestamp('end_date', { withTimezone: true }),
  groupMode: integer('group_mode').notNull().default(0),
  groupModeForce: boolean('group_mode_force').notNull().default(false),
  enableCompletion: boolean('enable_completion').notNull().default(true),
  /**
   * Môn × khối của khoá theo chương trình GDPT 2018 (K0a): neo mềm về
   * môn học trong cây chương trình — môn bị xoá thì khoá chỉ mất neo
   * (set null), không mất khoá. Đây là căn cứ để chọn đúng khung chương
   * trình khi nạp khung vào khoá; khoá không đặt hai trường này vẫn hợp
   * lệ như trước (khoá ngoài chương trình chuẩn).
   */
  subjectId: uuid('subject_id').references(() => subjects.id, { onDelete: 'set null' }),
  grade: smallint('grade'),
  /**
   * Khoá mẫu tổ/trường (K1): khoá đánh dấu mẫu không phải khoá dạy thật —
   * danh sách khoá thường bỏ qua, wizard tạo khoá liệt kê riêng để nhân
   * bản thành khoá thật. Mặc định false nên mọi khoá hiện có giữ nguyên.
   */
  isTemplate: boolean('is_template').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('course_category_idx').on(table.category),
      index('course_subject_id_idx').on(table.subjectId),
      check('course_grade_check', sql`${table.grade} is null or (${table.grade} between 1 and 12)`),
  ]);


/** Course sections (Moodle `course_sections`). `availability` is the AvailabilityTree JSON (report §2#10). */
export const courseSections = pgTable(
  'course_sections',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    course: uuid('course').notNull().references(() => course.id, { onDelete: 'cascade' }),
    section: integer('section').notNull().default(0),
    name: text('name'),
    summary: text('summary').notNull().default(''),
    visible: boolean('visible').notNull().default(true),
    availability: jsonb('availability'),
    /**
     * Ngày mở theo lịch riêng của section (K1): trường ngày mở tường
     * minh thay cho việc giáo viên phải dựng lá `date` trong cây
     * availability. null = không hẹn lịch; visible=true + openAt ở tương
     * lai = trạng thái "Mở theo lịch" (học viên chưa xem được tới ngày đó).
     */
    openAt: timestamp('open_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('course_sections_course_section_unique').on(table.course, table.section)],
);

/**
 * Course modules (Moodle `course_modules`) — the generic container joining a
 * section to an activity instance via (component, instance_id). This ships the
 * container only; activity content lives in its owning modules.
 * completion: 0=none, 1=manual, 2=automatic. group_mode 0 inherits course mode.
 */
export const courseModules = pgTable('course_modules', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  course: uuid('course').notNull().references(() => course.id, { onDelete: 'cascade' }),
  section: uuid('section').notNull().references(() => courseSections.id, { onDelete: 'cascade' }),
  component: text('component').notNull(),
  instanceId: uuid('instance_id'),
  name: text('name').notNull().default(''),
  visible: boolean('visible').notNull().default(true),
  groupMode: integer('group_mode').notNull().default(0),
  availability: jsonb('availability'),
  completion: integer('completion').notNull().default(0),
  completionView: boolean('completion_view').notNull().default(false),
  completionUseGrade: boolean('completion_use_grade').notNull().default(false),
  completionManual: boolean('completion_manual').notNull().default(false),
  completionExpected: timestamp('completion_expected', { withTimezone: true }),
  /** Ngày mở theo lịch riêng của module (K1) — cùng ngữ nghĩa như `course_sections.open_at`. */
  openAt: timestamp('open_at', { withTimezone: true }),
  /**
   * Thứ tự hiển thị tường minh của module trong section (K1): trước K1
   * thứ tự suy từ id uuidv7 (thời gian tạo) nên không đổi được bằng
   * kéo–thả; từ K1 builder ghi sortOrder, thứ tự đọc là (sortOrder, id).
   */
  sortOrder: integer('sort_order').notNull().default(0),
  deletionInProgress: boolean('deletion_in_progress').notNull().default(false),
  added: timestamp('added', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('course_modules_course_idx').on(table.course),
      index('course_modules_instance_id_idx').on(table.instanceId),
      index('course_modules_section_idx').on(table.section),
  ]);


/**
 * Neo khung chương trình trên section (K0a — "bản sao có neo"): khi giáo
 * viên nạp một node khung (chủ đề/mạch) vào khoá, section được tạo là bản
 * sao độc lập của khoá; dòng neo này ghi lại node nguồn + **tựa node chụp
 * tại thời điểm nạp** để truy vết. Node nguồn bị sửa/xoá về sau KHÔNG đổi
 * section đã nạp (xoá node → node_id về null, bản chụp vẫn còn).
 */
export const courseSectionAnchors = pgTable('course_section_anchors', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  sectionId: uuid('section_id').notNull().references(() => courseSections.id, { onDelete: 'cascade' }),
  nodeId: uuid('node_id').references(() => curriculumNodes.id, { onDelete: 'set null' }),
  curriculumId: uuid('curriculum_id').references(() => curricula.id, { onDelete: 'set null' }),
  nodeTitle: text('node_title').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      unique('course_section_anchors_section_unique').on(table.sectionId),
      index('course_section_anchors_node_id_idx').on(table.nodeId),
      index('course_section_anchors_curriculum_id_idx').on(table.curriculumId),
  ]);

/**
 * YCCĐ chụp kèm theo một neo khung: mỗi dòng là một yêu cầu cần đạt thuộc
 * subtree của node khung đã nạp, **chép nguyên văn tại thời điểm nạp**
 * (đây là nội dung hiển thị trong khoá — sửa cây chương trình sau đó
 * không làm đổi khoá đã nạp); `outcome_id` chỉ còn vai trò truy vết về
 * YCCĐ gốc (gốc bị xoá → null, bản chụp giữ nguyên).
 */
export const courseSectionAnchorOutcomes = pgTable('course_section_anchor_outcomes', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  anchorId: uuid('anchor_id').notNull().references(() => courseSectionAnchors.id, { onDelete: 'cascade' }),
  outcomeId: uuid('outcome_id').references(() => learningOutcomes.id, { onDelete: 'set null' }),
  content: text('content').notNull(),
  position: integer('position').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('course_section_anchor_outcomes_anchor_idx').on(table.anchorId, table.position),
      index('course_section_anchor_outcomes_outcome_id_idx').on(table.outcomeId),
      check('course_section_anchor_outcomes_position_check', sql`${table.position} > 0`),
  ]);

/** Per-course format options (Moodle `course_format_options`). */
export const courseFormatOptions = pgTable(
  'course_format_options',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    courseId: uuid('course_id').notNull().references(() => course.id, { onDelete: 'cascade' }),
    format: text('format').notNull(),
    sectionId: uuid('section_id'),
    name: text('name').notNull(),
    value: text('value'),
  },
  (table) => [
      index('course_format_options_section_id_idx').on(table.sectionId),unique('course_format_options_unique').on(table.courseId, table.format, table.sectionId, table.name)],
);

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { BackupRepository, type JobRow } from '@lms/db/repositories/backup';
import { sql, type CentreDB, type RawBuilder, type Selectable } from '@lms/db';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { RoleSeparationService } from '../access/role-separation.service';
import { ENROL_ASSIGNMENT_COMPONENT, RolesService } from '../access/roles.service';
import { CoursesService } from '../courses/courses.service';
import { FilesService } from '../files/files.service';
import type {
  BadgeCriteriaRow, BadgeRow, CalendarEventsRow, CalendarSubscriptionsRow,
  CourseCompletionsRow, CourseCompletionCriteriaRow, CourseCompletionCritComplRow, CourseCompletionSettingsRow,
  CourseGroupsRow, CourseModulesCompletionRow, CourseModulesRow, CourseSectionsRow,
  EnrolRow, FilesRow, GradeGradesRow, GradeItemsRow, GroupingsGroupsRow, GroupingsRow, GroupsMembersRow,
  QuestionAnswerKeysRow, QuestionAnswersRow, QuestionBankEntriesRow, QuestionCategoriesRow, QuestionRow,
  QuestionTruefalseRow, QuestionVersionsRow, QtypeEssayOptionsRow, QtypeMultichoiceOptionsRow,
  QtypeShortanswerOptionsRow, StimuliRow, UserEnrolmentsRow,
} from './backup-archive.types';

/**
 * Danh sách cột tường minh có bí danh camelCase cho các bảng mà các
 * contributor tích hợp sẵn đọc/ghi (chuyển Kysely, issue #648): dòng
 * đọc ra giữ đúng hình dạng camelCase của archive như khi còn đọc
 * qua Drizzle; insert/update viết bằng tên cột snake_case của
 * database. Kiểu dòng tương ứng nằm ở `backup-archive.types.ts`.
 */
const COURSE_COLUMNS = [
  'id', 'tenant_id as tenantId', 'category', 'full_name as fullName', 'short_name as shortName', 'id_number as idNumber',
  'summary', 'format', 'visible', 'start_date as startDate', 'end_date as endDate', 'group_mode as groupMode',
  'group_mode_force as groupModeForce', 'enable_completion as enableCompletion', 'subject_id as subjectId', 'grade',
  'is_template as isTemplate', 'class_id as classId', 'sort_order as sortOrder', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;
const COURSE_SECTIONS_COLUMNS = [
  'id', 'course', 'section', 'name', 'summary', 'visible', 'availability', 'open_at as openAt', 'updated_at as updatedAt',
] as const;
const COURSE_MODULES_COLUMNS = [
  'id', 'course', 'section', 'component', 'instance_id as instanceId', 'name', 'visible', 'group_mode as groupMode',
  'availability', 'completion', 'completion_view as completionView', 'completion_use_grade as completionUseGrade',
  'completion_manual as completionManual', 'completion_expected as completionExpected', 'open_at as openAt',
  'sort_order as sortOrder', 'deletion_in_progress as deletionInProgress', 'added',
] as const;
const ENROL_COLUMNS = [
  'id', 'course_id as courseId', 'enrol', 'status', 'name', 'role_id as roleId', 'enrol_period as enrolPeriod',
  'time_start as timeStart', 'time_end as timeEnd', 'custom_int1 as customInt1', 'custom_int2 as customInt2',
  'custom_text1 as customText1', 'cost', 'currency', 'payment_account_id as paymentAccountId',
  'enrolment_key as enrolmentKey', 'send_welcome_message as sendWelcomeMessage', 'welcome_message as welcomeMessage',
  'created_at as createdAt', 'updated_at as updatedAt',
] as const;
const USER_ENROLMENTS_COLUMNS = [
  'id', 'enrol_id as enrolId', 'user_id as userId', 'status', 'time_start as timeStart',
  'time_end as timeEnd', 'modifier_id as modifierId', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;
const COURSE_GROUPS_COLUMNS = [
  'id', 'course_id as courseId', 'name', 'id_number as idNumber', 'description',
  'enrolment_key as enrolmentKey', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;
const GROUPS_MEMBERS_COLUMNS = [
  'id', 'group_id as groupId', 'user_id as userId', 'time_added as timeAdded', 'component', 'item_id as itemId',
] as const;
const GROUPINGS_COLUMNS = [
  'id', 'course_id as courseId', 'name', 'id_number as idNumber', 'description', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;
const GROUPINGS_GROUPS_COLUMNS = ['grouping_id as groupingId', 'group_id as groupId', 'time_added as timeAdded'] as const;
const GRADE_ITEMS_COLUMNS = [
  'id', 'course_id as courseId', 'item_name as itemName', 'item_type as itemType',
  'item_module as itemModule', 'item_instance as itemInstance', 'grade_type as gradeType',
  'grade_max as gradeMax', 'grade_min as gradeMin', 'grade_pass as gradePass', 'id_number as idNumber',
  'multiplicator', 'plus_factor as plusFactor', 'hidden', 'locked', 'sort_order as sortOrder',
  'posting_policy as postingPolicy', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;
const GRADE_GRADES_COLUMNS = [
  'id', 'item_id as itemId', 'user_id as userId', 'raw_grade as rawGrade', 'raw_grade_max as rawGradeMax',
  'raw_grade_min as rawGradeMin', 'final_grade as finalGrade', 'hidden', 'locked', 'lock_time as lockTime',
  'overridden', 'excluded', 'frozen', 'feedback', 'information', 'aggregation_status as aggregationStatus',
  'aggregation_weight as aggregationWeight', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;
const COURSE_MODULES_COMPLETION_COLUMNS = [
  'id', 'course_module_id as courseModuleId', 'user_id as userId', 'completion_state as completionState',
  'viewed', 'override_by as overrideBy', 'updated_at as updatedAt',
] as const;
const COURSE_COMPLETIONS_COLUMNS = [
  'id', 'user_id as userId', 'course', 'status', 'time_enrolled as timeEnrolled',
  'time_started as timeStarted', 'time_completed as timeCompleted', 're_aggregate as reAggregate',
] as const;
const COURSE_COMPLETION_CRITERIA_COLUMNS = [
  'id', 'course', 'criteria_type as criteriaType', 'module_instance as moduleInstance', 'date',
  'course_instance as courseInstance', 'enrol_period_days as enrolPeriodDays', 'role_id as roleId',
  'sort_order as sortOrder', 'created_at as createdAt',
] as const;
const COURSE_COMPLETION_CRIT_COMPL_COLUMNS = [
  'id', 'criteria_id as criteriaId', 'user_id as userId', 'marked_by as markedBy', 'time_completed as timeCompleted',
] as const;
const COURSE_COMPLETION_SETTINGS_COLUMNS = ['course', 'method'] as const;
const FILES_COLUMNS = [
  'id', 'content_hash as contentHash', 'context_id as contextId', 'component', 'file_area as fileArea',
  'item_id as itemId', 'file_path as filePath', 'file_name as fileName', 'user_id as userId',
  'file_size as fileSize', 'mime_type as mimeType', 'status', 'source', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;
const QUESTION_CATEGORIES_COLUMNS = [
  'id', 'name', 'context_id as contextId', 'bank_id as bankId', 'info', 'parent',
  'sort_order as sortOrder', 'stamp', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;
const QUESTION_COLUMNS = [
  'id', 'category', 'qtype', 'created_by as createdBy', 'modified_by as modifiedBy',
  'derived_from_question_id as derivedFromQuestionId', 'derived_from_version_id as derivedFromVersionId',
  'derived_from_bank_id as derivedFromBankId', 'original_author_id as originalAuthorId', 'source_kind as sourceKind',
  'source_ref as sourceRef', 'idnumber', 'copy_count as copyCount', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;
const QUESTION_BANK_ENTRIES_COLUMNS = [
  'id', 'question_category_id as questionCategoryId', 'question_id as questionId', 'latest_version as latestVersion',
  'status', 'withdrawn_reason as withdrawnReason', 'withdrawn_by as withdrawnBy', 'withdrawn_at as withdrawnAt',
  'created_at as createdAt', 'updated_at as updatedAt',
] as const;
const QUESTION_VERSIONS_COLUMNS = [
  'id', 'question_bank_entry_id as questionBankEntryId', 'question_id as questionId', 'version', 'status',
  'question_text as questionText', 'general_feedback as generalFeedback', 'default_mark as defaultMark', 'penalty',
  'stimulus_id as stimulusId', 'created_at as createdAt',
] as const;
const STIMULI_COLUMNS = [
  'id', 'category_id as categoryId', 'created_by as createdBy', 'content', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;
const QUESTION_ANSWERS_COLUMNS = [
  'id', 'question_version_id as questionVersionId', 'answer', 'is_correct as isCorrect', 'feedback', 'sort_order as sortOrder',
] as const;
const QUESTION_ANSWER_KEYS_COLUMNS = ['id', 'question_version_id as questionVersionId', 'guidance', 'solution'] as const;
const QTYPE_MULTICHOICE_OPTIONS_COLUMNS = [
  'id', 'question_version_id as questionVersionId', 'shuffle_answers as shuffleAnswers', 'answer_numbering as answerNumbering',
  'correct_feedback as correctFeedback', 'incorrect_feedback as incorrectFeedback', 'show_standard_instruction as showStandardInstruction',
] as const;
const QUESTION_TRUEFALSE_COLUMNS = [
  'id', 'question_version_id as questionVersionId', 'true_answer as trueAnswer', 'false_answer as falseAnswer',
  'show_standard_instruction as showStandardInstruction',
] as const;
const QTYPE_SHORTANSWER_OPTIONS_COLUMNS = [
  'id', 'question_version_id as questionVersionId', 'use_case as useCase', 'numeric_answer as numericAnswer',
  'numeric_max_length as numericMaxLength', 'numeric_allow_sign as numericAllowSign', 'numeric_allow_decimal as numericAllowDecimal',
] as const;
const QTYPE_ESSAY_OPTIONS_COLUMNS = [
  'id', 'question_version_id as questionVersionId', 'response_format as responseFormat', 'response_required as responseRequired',
  'response_field_lines as responseFieldLines', 'min_word_limit as minWordLimit', 'max_word_limit as maxWordLimit',
  'grader_info as graderInfo', 'response_template as responseTemplate',
] as const;
const BADGE_COLUMNS = [
  'id', 'name', 'description', 'type', 'course_id as courseId', 'issuer_name as issuerName', 'issuer_url as issuerUrl',
  'issuer_contact as issuerContact', 'expire_date as expireDate', 'expire_period as expirePeriod', 'status', 'version',
  'language', 'user_created as userCreated', 'user_modified as userModified', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;
const BADGE_CRITERIA_COLUMNS = [
  'id', 'badge_id as badgeId', 'criteria_type as criteriaType', 'method', 'params', 'description',
] as const;
const CALENDAR_EVENTS_COLUMNS = [
  'id', 'name', 'description', 'event_type as eventType', 'course_id as courseId', 'group_id as groupId',
  'category_id as categoryId', 'user_id as userId', 'context_id as contextId', 'subscription_id as subscriptionId',
  'uuid', 'repeat_id as repeatId', 'rrule', 'is_exception as isException', 'exception_of as exceptionOf',
  'time_start as timeStart', 'time_duration as timeDuration', 'visible', 'location', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;
const CALENDAR_SUBSCRIPTIONS_COLUMNS = [
  'id', 'name', 'url', 'ics_data as icsData', 'event_type as eventType', 'course_id as courseId', 'category_id as categoryId',
  'user_id as userId', 'poll_interval as pollInterval', 'last_updated as lastUpdated', 'created_at as createdAt',
] as const;

/** Kiểu jsonb của cột `badge_criteria.params` theo schema codegen của package @lms/db. */
type BadgeCriteriaParams = Selectable<CentreDB['badge_criteria']>['params'];

/**
 * Bọc `params` của một tiêu chí badge thành biểu thức jsonb tường
 * minh (serialize + `::jsonb`) — cùng khuôn jsonbValue của các
 * repository ở package: giá trị là một object ở cấp cao nhất nên
 * không gắn tham số trực tiếp qua driver.
 */
function badgeCriteriaParamsJsonb(value: Record<string, unknown>): RawBuilder<BadgeCriteriaParams> {
  return sql<BadgeCriteriaParams>`${JSON.stringify(value)}::jsonb`;
}

/** Định dạng archive riêng có version — không phải .mbz. */
export const BACKUP_FORMAT = 'lms-backup';
export const BACKUP_FORMAT_VERSION = 1;

/** Ngữ cảnh import dùng chung cho các contributor: tra cứu và ghi id mapping của job restore. */
export interface RestoreMapping {
  map(itemType: string, oldId: string, newId: string): Promise<void>;
  get(itemType: string, oldId: string): string | undefined;
}

/**
 * Một BackupContributor đăng ký đảo ngược (§3.12): export phần dữ liệu của
 * mình theo course và import với id-mapping. BackupService không import
 * service của module khác để lấy dữ liệu — contributor tự biết bảng của mình.
 * `courseId = null` nghĩa là phạm vi SITE (sao lưu mức hệ thống): chỉ các
 * contributor có `supportsSite = true` mới tham gia job site; các contributor
 * chỉ-mức-khoá bị bỏ qua ở cả export lẫn import của job site.
 */
export interface BackupContributor {
  name: string;
  /** Contributor có dữ liệu ở phạm vi hệ thống (site) hay không. */
  supportsSite?: boolean;
  export(courseId: string | null, anonymize: boolean): Promise<unknown>;
  /**
   * Import dữ liệu của contributor vào khoá đích. Trả về tuỳ chọn
   * `detail` để runner ghi vào chi tiết của bước (step) trong job
   * restore — kênh ghi nhận chính thức của restore (vd contributor
   * `enrol` báo số ghi danh bị bỏ qua vì chốt tách vai); không trả gì
   * thì bước được ghi hoàn tất không kèm chi tiết như trước.
   */
  import(targetCourseId: string | null, data: never, mapping: RestoreMapping, actorId: string): Promise<{ detail?: Record<string, unknown> } | void>;
}

/**
 * Viết lại các tham chiếu id trong `params` của một lá tiêu chí badge qua
 * id-mapping của job restore: `courseId` → khoá mới, `cmId` → cm mới,
 * `competencyId` → năng lực mới (chỉ khi có mapping — năng lực là thực thể
 * mức site dùng chung, không nằm trong archive nên thường giữ nguyên),
 * `badgeId` → badge mới (khi badge được tham chiếu cũng nằm trong cùng
 * archive). Các khoá khác (cohortId/cohortIds/roleId/field/byDate…) là
 * tham chiếu mức site dùng chung nên giữ nguyên.
 */
export function remapBadgeCriteriaParams(
  params: unknown,
  mapping: RestoreMapping,
): Record<string, unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {};
  const out: Record<string, unknown> = { ...(params as Record<string, unknown>) };
  const remap = (key: string, itemType: string): void => {
    const value = out[key];
    if (typeof value === 'string') {
      const mapped = mapping.get(itemType, value);
      if (mapped) out[key] = mapped;
    }
  };
  remap('courseId', 'course');
  remap('cmId', 'cm');
  remap('competencyId', 'competency');
  remap('badgeId', 'badge');
  return out;
}

/**
 * Facade của BackupModule (Moodle core_backup, §2#22).
 * Backup là một kế hoạch nhiều bước theo contributor; restore map lại mọi id
 * qua backup_id_mappings — không bao giờ giữ id gốc. Ba chế độ: new/merge/replace.
 */
@Injectable()
export class BackupService {
  private readonly contributors: BackupContributor[] = [];

  constructor(
    private readonly repo: BackupRepository,
    private readonly evaluator: PermissionEvaluator,
    private readonly contexts: ContextsService,
    private readonly roles: RolesService,
    private readonly courses: CoursesService,
    private readonly files: FilesService,
    private readonly roleSeparation: RoleSeparationService,
  ) {
    this.registerBuiltinContributors();
  }

  /** Đăng ký contributor — thứ tự đăng ký là thứ tự export/import. */
  registerContributor(c: BackupContributor): void { this.contributors.push(c); }
  listContributors(): string[] { return this.contributors.map((c) => c.name); }

  private registerBuiltinContributors(): void {
    const db = this.repo.dbHandle;
    // --- courses/sections/cm -------------------------------------------------
    this.registerContributor({
      name: 'courses',
      export: async (courseId) => {
        if (!courseId) return { course: null, sections: [], cms: [] };
        const c = await db.selectFrom('course').select(COURSE_COLUMNS).where('id', '=', courseId).executeTakeFirst();
        const sections = await db.selectFrom('course_sections').select(COURSE_SECTIONS_COLUMNS).where('course', '=', courseId).execute();
        const cms = await db.selectFrom('course_modules').select(COURSE_MODULES_COLUMNS).where('course', '=', courseId).execute();
        return { course: c, sections, cms };
      },
      import: async (targetCourseId, data, mapping, actorId) => {
        if (!targetCourseId) return;
        const d = data as { sections: CourseSectionsRow[]; cms: CourseModulesRow[] };
        const existing = await this.courses.listSections(targetCourseId);
        const sorted = [...d.sections].sort((a, b) => a.section - b.section);
        for (const s of sorted) {
          const already = existing.find((e) => e.section === s.section);
          if (already) { await mapping.map('section', s.id, already.id); continue; }
          const created = await this.courses.createSection(actorId, targetCourseId, { name: s.name ?? undefined, summary: s.summary, visible: s.visible });
          await mapping.map('section', s.id, created.id);
        }
        for (const cm of d.cms) {
          const sectionId = mapping.get('section', cm.section);
          if (!sectionId) continue;
          const created = await this.courses.createCm(actorId, targetCourseId, {
            sectionId, component: cm.component, instanceId: undefined, name: cm.name, visible: cm.visible,
            groupMode: cm.groupMode, completion: cm.completion, completionView: cm.completionView,
            completionUseGrade: cm.completionUseGrade, completionManual: cm.completionManual,
          });
          await mapping.map('cm', cm.id, created.id);
        }
      },
    });
    // --- enrol ---------------------------------------------------------------
    this.registerContributor({
      name: 'enrol',
      export: async (courseId, anonymize) => {
        if (!courseId) return { instances: [], enrolments: [] };
        const instances = await db.selectFrom('enrol').select(ENROL_COLUMNS).where('course_id', '=', courseId).execute();
        const ues = instances.length ? await db.selectFrom('user_enrolments').select(USER_ENROLMENTS_COLUMNS).where('enrol_id', 'in', instances.map((i) => i.id)).execute() : [];
        return {
          instances,
          enrolments: ues.map((ue) => ({ ...ue, userId: anonymize ? null : ue.userId })),
        };
      },
      import: async (targetCourseId, data, mapping) => {
        if (!targetCourseId) return;
        const d = data as { instances: EnrolRow[]; enrolments: UserEnrolmentsRow[] };
        const targetCtx = await this.courses.courseContextId(targetCourseId);
        for (const inst of d.instances) {
          const [row] = await db.insertInto('enrol').values({
            course_id: targetCourseId, enrol: inst.enrol, status: inst.status, name: inst.name, role_id: inst.roleId,
            enrol_period: inst.enrolPeriod, custom_int1: inst.customInt1, custom_int2: null, custom_text1: inst.customText1,
            cost: inst.cost, currency: inst.currency, payment_account_id: inst.paymentAccountId,
          }).returning(ENROL_COLUMNS).execute();
          await mapping.map('enrol', inst.id, row!.id);
        }
        let skippedRoleConflicts = 0;
        for (const ue of d.enrolments) {
          if (!ue.userId) continue; // anonymize: không khôi phục danh tính
          const newInstance = mapping.get('enrol', ue.enrolId);
          if (!newInstance) continue;
          const inst = d.instances.find((i) => i.id === ue.enrolId);
          // Chốt TÁCH VAI — funnel 3 (RoleSeparationService giữ định
          // nghĩa dùng chung): contributor này ghi thẳng ghi danh nên
          // không đi qua funnel 1/2. Một ghi danh khôi phục sẽ ở trạng
          // thái ĐANG HOẠT ĐỘNG, qua instance cấp vai học viên, cho
          // người đã có cấp quyền giảng dạy bao phủ chính khoá ĐÍCH
          // là lẫn vai cùng khoá — BỎ QUA riêng ghi danh đó (không
          // tạo bản ghi, không gán vai) và ĐẾM để báo vào chi tiết
          // bước restore; các ghi danh còn lại khôi phục bình thường,
          // một ghi danh vi phạm không làm hỏng toàn bộ lượt restore.
          if (
            ue.status === 0
            && inst
            && (await this.roleSeparation.isLearnerGrantRole(inst.roleId))
            && (await this.roleSeparation.hasTeachingCoverageForCourse(ue.userId, targetCourseId))
          ) {
            skippedRoleConflicts += 1;
            continue;
          }
          const [ueRow] = await db.insertInto('user_enrolments').values({
            enrol_id: newInstance, user_id: ue.userId, status: ue.status, time_start: ue.timeStart, time_end: ue.timeEnd,
          }).onConflict((oc) => oc.doNothing()).returning(USER_ENROLMENTS_COLUMNS).execute();
          if (ueRow) await mapping.map('user_enrolment', ue.id, ueRow.id);
          // Ghi danh khôi phục vẫn là gán do enrol cấp: mang truy vết của
          // instance MỚI ở khoá đích để unenrol sau này gỡ đúng dòng này
          // (issue #157).
          if (inst?.roleId) await this.roles.assignRole(ue.userId, inst.roleId, targetCtx, undefined, { component: ENROL_ASSIGNMENT_COMPONENT, itemId: newInstance }).catch(() => undefined);
        }
        if (skippedRoleConflicts > 0) return { detail: { skippedRoleConflictEnrolments: skippedRoleConflicts } };
        return undefined;
      },
    });
    // --- groups ---------------------------------------------------------------
    this.registerContributor({
      name: 'groups',
      export: async (courseId) => {
        if (!courseId) return { groups: [], members: [], groupings: [], links: [] };
        const groups = await db.selectFrom('course_groups').select(COURSE_GROUPS_COLUMNS).where('course_id', '=', courseId).execute();
        const members = groups.length ? await db.selectFrom('groups_members').select(GROUPS_MEMBERS_COLUMNS).where('group_id', 'in', groups.map((g) => g.id)).execute() : [];
        const gps = await db.selectFrom('groupings').select(GROUPINGS_COLUMNS).where('course_id', '=', courseId).execute();
        const links = gps.length ? await db.selectFrom('groupings_groups').select(GROUPINGS_GROUPS_COLUMNS).where('grouping_id', 'in', gps.map((g) => g.id)).execute() : [];
        return { groups, members, groupings: gps, links };
      },
      import: async (targetCourseId, data, mapping) => {
        if (!targetCourseId) return;
        const d = data as {
          groups: CourseGroupsRow[]; members: GroupsMembersRow[];
          groupings: GroupingsRow[]; links: GroupingsGroupsRow[];
        };
        for (const g of d.groups) {
          const [row] = await db.insertInto('course_groups').values({ course_id: targetCourseId, name: g.name, id_number: g.idNumber, description: g.description })
            .onConflict((oc) => oc.doNothing()).returning(COURSE_GROUPS_COLUMNS).execute();
          const existing = row ?? (await db.selectFrom('course_groups').select(COURSE_GROUPS_COLUMNS).where('course_id', '=', targetCourseId).where('name', '=', g.name).execute())[0];
          if (existing) await mapping.map('group', g.id, existing.id);
        }
        for (const m of d.members) {
          const ng = mapping.get('group', m.groupId); if (!ng) continue;
          await db.insertInto('groups_members').values({ group_id: ng, user_id: m.userId, component: m.component, item_id: m.itemId }).onConflict((oc) => oc.doNothing()).execute();
        }
        for (const gp of d.groupings) {
          const [row] = await db.insertInto('groupings').values({ course_id: targetCourseId, name: gp.name, id_number: gp.idNumber, description: gp.description })
            .onConflict((oc) => oc.doNothing()).returning(GROUPINGS_COLUMNS).execute();
          const existing = row ?? (await db.selectFrom('groupings').select(GROUPINGS_COLUMNS).where('course_id', '=', targetCourseId).where('name', '=', gp.name).execute())[0];
          if (existing) await mapping.map('grouping', gp.id, existing.id);
        }
        for (const link of d.links) {
          const ngp = mapping.get('grouping', link.groupingId); const ng = mapping.get('group', link.groupId);
          if (!ngp || !ng) continue;
          await db.insertInto('groupings_groups').values({ grouping_id: ngp, group_id: ng }).onConflict((oc) => oc.doNothing()).execute();
        }
      },
    });
    // --- grades ---------------------------------------------------------------
    this.registerContributor({
      name: 'grades',
      export: async (courseId, anonymize) => {
        if (!courseId) return { items: [], grades: [] };
        const items = await db.selectFrom('grade_items').select(GRADE_ITEMS_COLUMNS).where('course_id', '=', courseId).execute();
        const grades = items.length ? await db.selectFrom('grade_grades').select(GRADE_GRADES_COLUMNS).where('item_id', 'in', items.map((i) => i.id)).execute() : [];
        return { items, grades: grades.map((g) => ({ ...g, userId: anonymize ? 0 : g.userId })) };
      },
      import: async (targetCourseId, data, mapping) => {
        if (!targetCourseId) return;
        // Bản backup cũ có thể mang trường categories/item loại
        // category/course của gradebook tổng hợp đã gỡ (issue #224) —
        // các phần đó bị BỎ QUA khi khôi phục, chỉ item điểm theo bài
        // (manual/mod) và điểm của chúng được khôi phục.
        const d = data as {
          items: GradeItemsRow[]; grades: GradeGradesRow[];
        };
        for (const item of d.items) {
          if (item.itemType !== 'mod' && item.itemType !== 'manual') continue;
          let instance = item.itemInstance;
          if (item.itemType === 'mod') instance = item.itemInstance ? (mapping.get('cm', item.itemInstance) ?? null) : null;
          const [row] = await db.insertInto('grade_items').values({
            course_id: targetCourseId, item_name: item.itemName, item_type: item.itemType,
            item_module: item.itemModule, item_instance: instance, grade_type: item.gradeType, grade_max: item.gradeMax,
            grade_min: item.gradeMin, grade_pass: item.gradePass,
            multiplicator: item.multiplicator, plus_factor: item.plusFactor,
            hidden: item.hidden, sort_order: item.sortOrder, posting_policy: item.postingPolicy,
          }).onConflict((oc) => oc.doNothing()).returning(GRADE_ITEMS_COLUMNS).execute();
          const existing = row ?? (await db.selectFrom('grade_items').select(GRADE_ITEMS_COLUMNS)
            .where('course_id', '=', targetCourseId).where('item_type', '=', item.itemType)
            .where((eb) => instance === null ? eb('item_instance', 'is', null) : eb('item_instance', '=', instance))
            .execute())[0];
          if (existing) await mapping.map('grade_item', item.id, existing.id);
        }
        for (const g of d.grades) {
          if (!g.userId) continue;
          const newItem = mapping.get('grade_item', g.itemId); if (!newItem) continue;
          await db.insertInto('grade_grades').values({
            item_id: newItem, user_id: g.userId, raw_grade: g.rawGrade, raw_grade_max: g.rawGradeMax, raw_grade_min: g.rawGradeMin,
            final_grade: g.finalGrade, hidden: g.hidden, overridden: g.overridden, excluded: g.excluded, frozen: g.frozen, feedback: g.feedback,
          }).onConflict((oc) => oc.doNothing()).execute();
        }
      },
    });
    // --- completion -------------------------------------------------------------
    this.registerContributor({
      name: 'completion',
      export: async (courseId, anonymize) => {
        if (!courseId) return { cmCompletion: [], courseCompletions: [], criteria: [], critCompl: [], settings: null };
        const cms = await db.selectFrom('course_modules').select(COURSE_MODULES_COLUMNS).where('course', '=', courseId).execute();
        const cmComp = cms.length ? await db.selectFrom('course_modules_completion').select(COURSE_MODULES_COMPLETION_COLUMNS).where('course_module_id', 'in', cms.map((c) => c.id)).execute() : [];
        const courseComp = await db.selectFrom('course_completions').select(COURSE_COMPLETIONS_COLUMNS).where('course', '=', courseId).execute();
        const criteria = await db.selectFrom('course_completion_criteria').select(COURSE_COMPLETION_CRITERIA_COLUMNS).where('course', '=', courseId).execute();
        // Bằng chứng đánh dấu thủ công (self/role crit_compl) đi kèm với
        // tiêu chí mà nó thuộc về, giống bản backup các dòng crit_compl của Moodle.
        const critCompl = criteria.length ? await db.selectFrom('course_completion_crit_compl').select(COURSE_COMPLETION_CRIT_COMPL_COLUMNS).where('criteria_id', 'in', criteria.map((c) => c.id)).execute() : [];
        const settings = await db.selectFrom('course_completion_settings').select(COURSE_COMPLETION_SETTINGS_COLUMNS).where('course', '=', courseId).executeTakeFirst();
        const scrub = <T extends { userId: string }>(rows: T[]): T[] => anonymize ? rows.map((r) => ({ ...r, userId: 0 })) : rows;
        return { cmCompletion: scrub(cmComp), courseCompletions: scrub(courseComp), criteria, critCompl: scrub(critCompl), settings: settings ?? null };
      },
      import: async (targetCourseId, data, mapping) => {
        if (!targetCourseId) return;
        const d = data as {
          cmCompletion: CourseModulesCompletionRow[]; courseCompletions: CourseCompletionsRow[];
          criteria: CourseCompletionCriteriaRow[]; critCompl?: CourseCompletionCritComplRow[];
          settings: CourseCompletionSettingsRow | null;
        };
        if (d.settings) {
          // Chốt giá trị trước khi vào callback onConflict: thu hẹp
          // kiểu của `d.settings` không giữ qua biên closure.
          const settingsMethod = d.settings.method;
          await db.insertInto('course_completion_settings').values({ course: targetCourseId, method: settingsMethod })
            .onConflict((oc) => oc.column('course').doUpdateSet({ method: settingsMethod })).execute();
        }
        const criteriaIdMap = new Map<string, string>();
        for (const crit of d.criteria) {
          const moduleInstance = crit.moduleInstance ? mapping.get('cm', crit.moduleInstance) ?? null : null;
          const [inserted] = await db.insertInto('course_completion_criteria').values({
            course: targetCourseId, criteria_type: crit.criteriaType, module_instance: moduleInstance, date: crit.date,
            // courseInstance/roleId tham chiếu tới các đối tượng NGOÀI bản backup của
            // khoá học này (khoá học tiên quyết, role hệ thống) và được giữ nguyên như cũ.
            course_instance: crit.courseInstance ?? null, enrol_period_days: crit.enrolPeriodDays ?? null, role_id: crit.roleId ?? null,
            sort_order: crit.sortOrder,
          }).returning(COURSE_COMPLETION_CRITERIA_COLUMNS).execute();
          if (inserted) criteriaIdMap.set(crit.id, inserted.id);
        }
        for (const mark of d.critCompl ?? []) {
          if (!mark.userId) continue;
          const newCriteriaId = criteriaIdMap.get(mark.criteriaId); if (!newCriteriaId) continue;
          await db.insertInto('course_completion_crit_compl').values({
            criteria_id: newCriteriaId, user_id: mark.userId, marked_by: mark.markedBy, time_completed: mark.timeCompleted,
          }).onConflict((oc) => oc.doNothing()).execute();
        }
        for (const row of d.cmCompletion) {
          if (!row.userId) continue;
          const newCm = mapping.get('cm', row.courseModuleId); if (!newCm) continue;
          await db.insertInto('course_modules_completion').values({
            course_module_id: newCm, user_id: row.userId, completion_state: row.completionState, viewed: row.viewed, override_by: row.overrideBy,
          }).onConflict((oc) => oc.doNothing()).execute();
        }
        for (const row of d.courseCompletions) {
          if (!row.userId) continue;
          await db.insertInto('course_completions').values({
            user_id: row.userId, course: targetCourseId, status: row.status, time_enrolled: row.timeEnrolled,
            time_started: row.timeStarted, time_completed: row.timeCompleted,
          }).onConflict((oc) => oc.doNothing()).execute();
        }
      },
    });
    // --- files (theo contentHash) -------------------------------------------------
    this.registerContributor({
      name: 'files',
      export: async (courseId) => {
        if (!courseId) return { files: [] };
        const courseCtx = await this.contexts.getByLevelInstance(50, courseId);
        const cms = await db.selectFrom('course_modules').select(COURSE_MODULES_COLUMNS).where('course', '=', courseId).execute();
        const ctxIds: string[] = courseCtx ? [courseCtx.id] : [];
        for (const cm of cms) {
          const ctx = await this.contexts.getByLevelInstance(70, cm.id);
          if (ctx) ctxIds.push(ctx.id);
        }
        if (!ctxIds.length) return { files: [] };
        const rows = await db.selectFrom('files').select(FILES_COLUMNS).where('context_id', 'in', ctxIds).execute();
        const out = [];
        for (const f of rows) {
          const { data } = await this.files.readContent(f.id);
          out.push({ ...f, dataBase64: data.toString('base64') });
        }
        return { files: out };
      },
      import: async (targetCourseId, data, mapping) => {
        if (!targetCourseId) return;
        const d = data as { files: (FilesRow & { dataBase64: string })[] };
        const newCourseCtx = await this.courses.courseContextId(targetCourseId);
        for (const f of d.files) {
          // Context mới: cm context nếu item thuộc cm đã map, ngược lại course context mới.
          let newContextId = newCourseCtx;
          const oldCtx = await this.contexts.getContext(f.contextId).catch(() => undefined);
          if (oldCtx?.contextLevel === 70) {
            const newCm = oldCtx.instanceId ? mapping.get('cm', oldCtx.instanceId) : undefined;
            if (newCm) {
              const ctx = await this.contexts.getByLevelInstance(70, newCm);
              if (ctx) newContextId = ctx.id;
            }
          }
          const itemId = f.itemId ? (mapping.get('cm', f.itemId) ?? f.itemId) : null;
          const created = await this.files.upload({
            contextId: newContextId, component: f.component, fileArea: f.fileArea, itemId: itemId ?? undefined,
            filePath: f.filePath, fileName: f.fileName, data: Buffer.from(f.dataBase64, 'base64'),
            mimeType: f.mimeType ?? undefined, userId: f.userId ?? undefined,
          });
          await mapping.map('file', f.id, created.id);
        }
      },
    });
    // --- ngân hàng câu hỏi ---------------------------------------------------------
    // Ngân hàng câu hỏi bám theo CONTEXT (bản model hiện hữu): category của
    // khoá nằm ở context của khoá (level 50), category mức site nằm ở context
    // hệ thống (level 10). Export cây category + question + bank entry + MỌI
    // version. KHÔNG export question_usages / question_attempts / steps:
    // đó là dữ liệu vận hành (lượt làm bài) chứ không phải nội dung bank.
    this.registerContributor({
      name: 'questions',
      supportsSite: true,
      export: async (courseId) => {
        const ctxId = courseId
          ? (await this.contexts.getByLevelInstance(50, courseId))?.id
          : (await this.contexts.ensureSystemContext()).id;
        if (!ctxId) return { categories: [], questions: [], entries: [], versions: [], stimuli: [], answers: [], answerKeys: [], multichoiceOptions: [], truefalseOptions: [], shortanswerOptions: [], essayOptions: [] };
        const categories = await db.selectFrom('question_categories').select(QUESTION_CATEGORIES_COLUMNS).where('context_id', '=', ctxId).execute();
        const catIds = categories.map((c) => c.id);
        const questions = catIds.length ? await db.selectFrom('question').select(QUESTION_COLUMNS).where('category', 'in', catIds).execute() : [];
        const entries = catIds.length ? await db.selectFrom('question_bank_entries').select(QUESTION_BANK_ENTRIES_COLUMNS).where('question_category_id', 'in', catIds).execute() : [];
        const entryIds = entries.map((e) => e.id);
        const versions = entryIds.length ? await db.selectFrom('question_versions').select(QUESTION_VERSIONS_COLUMNS).where('question_bank_entry_id', 'in', entryIds).execute() : [];
        const versionIds = versions.map((v) => v.id);
        // Nội dung chấm của version (answers + options từng qtype) và ngữ
        // liệu của category đi cùng archive — thiếu chúng thì bản restore
        // mất toàn bộ dữ liệu chấm.
        const stimuliRows = catIds.length ? await db.selectFrom('stimuli').select(STIMULI_COLUMNS).where('category_id', 'in', catIds).execute() : [];
        const answers = versionIds.length ? await db.selectFrom('question_answers').select(QUESTION_ANSWERS_COLUMNS).where('question_version_id', 'in', versionIds).execute() : [];
        // Bản ghi phía đáp án (guidance + solution) của từng version —
        // thiếu nó thì bản restore mất hướng dẫn và lời giải mẫu.
        const answerKeys = versionIds.length ? await db.selectFrom('question_answer_keys').select(QUESTION_ANSWER_KEYS_COLUMNS).where('question_version_id', 'in', versionIds).execute() : [];
        const multichoiceOptions = versionIds.length ? await db.selectFrom('qtype_multichoice_options').select(QTYPE_MULTICHOICE_OPTIONS_COLUMNS).where('question_version_id', 'in', versionIds).execute() : [];
        const truefalseOptions = versionIds.length ? await db.selectFrom('question_truefalse').select(QUESTION_TRUEFALSE_COLUMNS).where('question_version_id', 'in', versionIds).execute() : [];
        const shortanswerOptions = versionIds.length ? await db.selectFrom('qtype_shortanswer_options').select(QTYPE_SHORTANSWER_OPTIONS_COLUMNS).where('question_version_id', 'in', versionIds).execute() : [];
        const essayOptions = versionIds.length ? await db.selectFrom('qtype_essay_options').select(QTYPE_ESSAY_OPTIONS_COLUMNS).where('question_version_id', 'in', versionIds).execute() : [];
        return { categories, questions, entries, versions, stimuli: stimuliRows, answers, answerKeys, multichoiceOptions, truefalseOptions, shortanswerOptions, essayOptions };
      },
      import: async (targetCourseId, data, mapping) => {
        const d = data as {
          categories: QuestionCategoriesRow[]; questions: QuestionRow[];
          entries: QuestionBankEntriesRow[]; versions: QuestionVersionsRow[];
          stimuli?: StimuliRow[]; answers?: QuestionAnswersRow[];
          answerKeys?: QuestionAnswerKeysRow[];
          multichoiceOptions?: QtypeMultichoiceOptionsRow[]; truefalseOptions?: QuestionTruefalseRow[];
          shortanswerOptions?: QtypeShortanswerOptionsRow[]; essayOptions?: QtypeEssayOptionsRow[];
        };
        if (!d.categories?.length && !d.questions?.length) return;
        const targetCtxId = targetCourseId
          ? await this.courses.courseContextId(targetCourseId)
          : (await this.contexts.ensureSystemContext()).id;
        // Category là cây theo `parent`: tạo cha trước con (lặp tới khi hết
        // tiến triển); category nào có cha NGOÀI phạm vi archive thì gắn gốc.
        const pending = [...(d.categories ?? [])];
        let progressed = true;
        while (pending.length && progressed) {
          progressed = false;
          for (let i = pending.length - 1; i >= 0; i--) {
            const cat = pending[i]!;
            if (cat.parent && !mapping.get('question_category', cat.parent)) continue;
            const [row] = await db.insertInto('question_categories').values({
              name: cat.name, context_id: targetCtxId, info: cat.info,
              parent: cat.parent ? mapping.get('question_category', cat.parent)! : null,
              sort_order: cat.sortOrder, stamp: cat.stamp,
            }).returning(QUESTION_CATEGORIES_COLUMNS).execute();
            await mapping.map('question_category', cat.id, row!.id);
            pending.splice(i, 1);
            progressed = true;
          }
        }
        for (const cat of pending) {
          const [row] = await db.insertInto('question_categories').values({
            name: cat.name, context_id: targetCtxId, info: cat.info, parent: null, sort_order: cat.sortOrder, stamp: cat.stamp,
          }).returning(QUESTION_CATEGORIES_COLUMNS).execute();
          await mapping.map('question_category', cat.id, row!.id);
        }
        for (const q of d.questions ?? []) {
          const newCategory = mapping.get('question_category', q.category);
          if (!newCategory) continue;
          const [row] = await db.insertInto('question').values({
            category: newCategory, qtype: q.qtype, created_by: q.createdBy, modified_by: q.modifiedBy,
          }).returning(QUESTION_COLUMNS).execute();
          await mapping.map('question', q.id, row!.id);
        }
        for (const e of d.entries ?? []) {
          const newCategory = mapping.get('question_category', e.questionCategoryId);
          const newQuestion = mapping.get('question', e.questionId);
          if (!newCategory || !newQuestion) continue;
          const [row] = await db.insertInto('question_bank_entries').values({
            question_category_id: newCategory, question_id: newQuestion, latest_version: e.latestVersion, status: e.status,
          }).onConflict((oc) => oc.doNothing()).returning(QUESTION_BANK_ENTRIES_COLUMNS).execute();
          const created = row ?? (await db.selectFrom('question_bank_entries').select(QUESTION_BANK_ENTRIES_COLUMNS).where('question_id', '=', newQuestion).execute())[0];
          if (created) await mapping.map('question_bank_entry', e.id, created.id);
        }
        for (const s of d.stimuli ?? []) {
          const newCategory = mapping.get('question_category', s.categoryId);
          if (!newCategory) continue;
          const [row] = await db.insertInto('stimuli').values({
            category_id: newCategory, created_by: s.createdBy, content: s.content,
          }).returning(STIMULI_COLUMNS).execute();
          await mapping.map('stimulus', s.id, row!.id);
        }
        for (const v of [...(d.versions ?? [])].sort((a, b) => a.version - b.version)) {
          const newEntry = mapping.get('question_bank_entry', v.questionBankEntryId);
          const newQuestion = mapping.get('question', v.questionId);
          if (!newEntry || !newQuestion) continue;
          const [row] = await db.insertInto('question_versions').values({
            question_bank_entry_id: newEntry, question_id: newQuestion, version: v.version, status: v.status,
            question_text: v.questionText, general_feedback: v.generalFeedback,
            default_mark: v.defaultMark, penalty: v.penalty,
            stimulus_id: v.stimulusId ? (mapping.get('stimulus', v.stimulusId) ?? null) : null,
          }).onConflict((oc) => oc.doNothing()).returning(QUESTION_VERSIONS_COLUMNS).execute();
          if (row) await mapping.map('question_version', v.id, row.id);
        }
        for (const a of d.answers ?? []) {
          const newVersion = mapping.get('question_version', a.questionVersionId);
          if (!newVersion) continue;
          const [row] = await db.insertInto('question_answers').values({
            question_version_id: newVersion, answer: a.answer, is_correct: a.isCorrect,
            feedback: a.feedback, sort_order: a.sortOrder,
          }).returning(QUESTION_ANSWERS_COLUMNS).execute();
          await mapping.map('question_answer', a.id, row!.id);
        }
        for (const k of d.answerKeys ?? []) {
          const newVersion = mapping.get('question_version', k.questionVersionId);
          if (!newVersion) continue;
          await db.insertInto('question_answer_keys').values({
            question_version_id: newVersion, guidance: k.guidance, solution: k.solution,
          }).onConflict((oc) => oc.doNothing()).execute();
        }
        for (const o of d.multichoiceOptions ?? []) {
          const newVersion = mapping.get('question_version', o.questionVersionId);
          if (!newVersion) continue;
          await db.insertInto('qtype_multichoice_options').values({
            question_version_id: newVersion, shuffle_answers: o.shuffleAnswers,
            answer_numbering: o.answerNumbering, correct_feedback: o.correctFeedback,
            incorrect_feedback: o.incorrectFeedback,
            show_standard_instruction: o.showStandardInstruction,
          }).onConflict((oc) => oc.doNothing()).execute();
        }
        for (const o of d.truefalseOptions ?? []) {
          const newVersion = mapping.get('question_version', o.questionVersionId);
          const newTrue = mapping.get('question_answer', o.trueAnswer);
          const newFalse = mapping.get('question_answer', o.falseAnswer);
          if (!newVersion || !newTrue || !newFalse) continue;
          await db.insertInto('question_truefalse').values({
            question_version_id: newVersion, true_answer: newTrue, false_answer: newFalse,
            show_standard_instruction: o.showStandardInstruction,
          }).onConflict((oc) => oc.doNothing()).execute();
        }
        for (const o of d.shortanswerOptions ?? []) {
          const newVersion = mapping.get('question_version', o.questionVersionId);
          if (!newVersion) continue;
          await db.insertInto('qtype_shortanswer_options').values({
            question_version_id: newVersion, use_case: o.useCase,
          }).onConflict((oc) => oc.doNothing()).execute();
        }
        for (const o of d.essayOptions ?? []) {
          const newVersion = mapping.get('question_version', o.questionVersionId);
          if (!newVersion) continue;
          await db.insertInto('qtype_essay_options').values({
            question_version_id: newVersion, response_format: o.responseFormat, response_required: o.responseRequired,
            response_field_lines: o.responseFieldLines, min_word_limit: o.minWordLimit, max_word_limit: o.maxWordLimit,
            grader_info: o.graderInfo, response_template: o.responseTemplate,
          }).onConflict((oc) => oc.doNothing()).execute();
        }
      },
    });
    // --- badges ------------------------------------------------------------------
    // Định nghĩa badge của khoá (type=2) hoặc mức site (type=1) + toàn bộ
    // criteria; params của criteria được viết lại qua mapping (xem
    // remapBadgeCriteriaParams). KHÔNG export badge_issued (lượt đã cấp —
    // assertion là bằng chứng lịch sử của khoá gốc) và badge_manual_award.
    this.registerContributor({
      name: 'badges',
      supportsSite: true,
      export: async (courseId) => {
        const badges = courseId
          ? await db.selectFrom('badge').select(BADGE_COLUMNS).where('course_id', '=', courseId).execute()
          : await db.selectFrom('badge').select(BADGE_COLUMNS).where('course_id', 'is', null).execute();
        const criteria = badges.length ? await db.selectFrom('badge_criteria').select(BADGE_CRITERIA_COLUMNS).where('badge_id', 'in', badges.map((b) => b.id)).execute() : [];
        return { badges, criteria };
      },
      import: async (targetCourseId, data, mapping, actorId) => {
        const d = data as { badges: BadgeRow[]; criteria: BadgeCriteriaRow[] };
        // Pha 1: tạo badge trước để tiêu chí `badge` tham chiếu chéo trong
        // cùng archive tra được mapping ở pha 2.
        for (const b of d.badges ?? []) {
          const [row] = await db.insertInto('badge').values({
            name: b.name, description: b.description, type: targetCourseId ? 2 : b.type,
            course_id: targetCourseId ?? null,
            issuer_name: b.issuerName, issuer_url: b.issuerUrl, issuer_contact: b.issuerContact,
            expire_date: b.expireDate ? new Date(b.expireDate as unknown as string) : null,
            expire_period: b.expirePeriod, status: b.status, version: b.version, language: b.language,
            user_created: actorId, user_modified: actorId,
          }).returning(BADGE_COLUMNS).execute();
          await mapping.map('badge', b.id, row!.id);
        }
        for (const c of d.criteria ?? []) {
          const newBadge = mapping.get('badge', c.badgeId);
          if (!newBadge) continue;
          const [row] = await db.insertInto('badge_criteria').values({
            badge_id: newBadge, criteria_type: c.criteriaType, method: c.method,
            params: badgeCriteriaParamsJsonb(remapBadgeCriteriaParams(c.params, mapping)), description: c.description,
          }).returning(BADGE_CRITERIA_COLUMNS).execute();
          if (row) await mapping.map('badge_criteria', c.id, row.id);
        }
      },
    });
    // --- calendar ------------------------------------------------------------------
    // Sự kiện mức khoá (course + group; group được map qua contributor groups
    // chạy trước) và subscription của khoá; ở phạm vi site là sự kiện
    // eventType='site' + subscription mức site. Chuỗi lặp: repeatId /
    // exceptionOf được nối lại ở pha 2 sau khi mọi sự kiện đã có id mới.
    this.registerContributor({
      name: 'calendar',
      supportsSite: true,
      export: async (courseId) => {
        const events = courseId
          ? await db.selectFrom('calendar_events').select(CALENDAR_EVENTS_COLUMNS).where('course_id', '=', courseId).execute()
          : await db.selectFrom('calendar_events').select(CALENDAR_EVENTS_COLUMNS).where('event_type', '=', 'site').execute();
        const subscriptions = courseId
          ? await db.selectFrom('calendar_subscriptions').select(CALENDAR_SUBSCRIPTIONS_COLUMNS).where('course_id', '=', courseId).execute()
          : await db.selectFrom('calendar_subscriptions').select(CALENDAR_SUBSCRIPTIONS_COLUMNS).where('event_type', '=', 'site').execute();
        return { events, subscriptions };
      },
      import: async (targetCourseId, data, mapping) => {
        const d = data as { events: CalendarEventsRow[]; subscriptions: CalendarSubscriptionsRow[] };
        for (const s of d.subscriptions ?? []) {
          const [row] = await db.insertInto('calendar_subscriptions').values({
            name: s.name, url: s.url, ics_data: s.icsData, event_type: s.eventType,
            course_id: s.courseId ? targetCourseId ?? null : null,
            category_id: s.categoryId, user_id: s.userId, poll_interval: s.pollInterval, last_updated: s.lastUpdated,
          }).returning(CALENDAR_SUBSCRIPTIONS_COLUMNS).execute();
          await mapping.map('calendar_subscription', s.id, row!.id);
        }
        const targetCtxId = targetCourseId ? await this.courses.courseContextId(targetCourseId).catch(() => null) : null;
        const systemCtxId = (await this.contexts.ensureSystemContext()).id;
        for (const e of d.events ?? []) {
          const newCourseId = e.courseId ? targetCourseId ?? null : null;
          const newContextId = newCourseId ? targetCtxId : e.eventType === 'site' ? systemCtxId : e.contextId;
          const [row] = await db.insertInto('calendar_events').values({
            name: e.name, description: e.description, event_type: e.eventType,
            course_id: newCourseId,
            group_id: e.groupId ? mapping.get('group', e.groupId) ?? null : null,
            category_id: e.categoryId, user_id: e.userId, context_id: newContextId,
            subscription_id: e.subscriptionId ? mapping.get('calendar_subscription', e.subscriptionId) ?? null : null,
            uuid: e.uuid, repeat_id: null, rrule: e.rrule,
            is_exception: e.isException, exception_of: null,
            time_start: new Date(e.timeStart as unknown as string), time_duration: e.timeDuration,
            visible: e.visible, location: e.location,
          }).returning(CALENDAR_EVENTS_COLUMNS).execute();
          await mapping.map('calendar_event', e.id, row!.id);
        }
        for (const e of d.events ?? []) {
          const newId = mapping.get('calendar_event', e.id);
          if (!newId) continue;
          const patch: { repeat_id?: string | null; exception_of?: string | null } = {};
          if (e.repeatId) patch.repeat_id = mapping.get('calendar_event', e.repeatId) ?? null;
          if (e.exceptionOf) patch.exception_of = mapping.get('calendar_event', e.exceptionOf) ?? null;
          if (Object.keys(patch).length) {
            await db.updateTable('calendar_events').set(patch).where('id', '=', newId).execute();
          }
        }
      },
    });
  }

  async getJob(id: string): Promise<JobRow> {
    const row = await this.repo.getJob(id);
    if (!row) throw new NotFoundException({ message: `Backup job ${id} not found`, code: 'backup.job_not_found' });
    return row;
  }

  /**
   * Cổng đọc job (H7, rà soát #134): các đường đọc job/steps/mappings/
   * checklist trước đây không gác gì trong khi create/restore đã đòi
   * capability — nay người đọc phải có `backup:backupcourse` hoặc
   * `backup:restorecourse` tại context của khoá thuộc job (job site-scope
   * thì tại context hệ thống), đúng khuôn hai đường ghi.
   */
  private async jobReadContextId(job: JobRow): Promise<string> {
    if (job.scope === 'course' && job.courseId) return this.courses.courseContextId(job.courseId);
    return (await this.contexts.ensureSystemContext()).id;
  }
  private async canReadJob(actorId: string, job: JobRow): Promise<boolean> {
    const ctxId = await this.jobReadContextId(job);
    if (await this.evaluator.hasCapability(actorId, 'backup:backupcourse', ctxId)) return true;
    return this.evaluator.hasCapability(actorId, 'backup:restorecourse', ctxId);
  }
  private async assertJobReadable(actorId: string, job: JobRow): Promise<void> {
    if (await this.canReadJob(actorId, job)) return;
    throw new ForbiddenException({ message: 'You cannot view this backup job', code: 'backup.job_forbidden' });
  }
  /** Chi tiết job qua HTTP: qua cổng đọc job (H7). */
  async getJobForRead(actorId: string, id: string): Promise<JobRow> {
    const job = await this.getJob(id);
    await this.assertJobReadable(actorId, job);
    return job;
  }
  /** Danh sách job qua HTTP: chỉ các job người gọi qua được cổng đọc (H7). */
  async listJobs(actorId: string): Promise<JobRow[]> {
    const rows = await this.repo.listJobs();
    const out: JobRow[] = [];
    for (const row of rows) if (await this.canReadJob(actorId, row)) out.push(row);
    return out;
  }
  async listSteps(actorId: string, jobId: string) {
    await this.assertJobReadable(actorId, await this.getJob(jobId));
    return this.repo.listSteps(jobId);
  }
  async listMappings(actorId: string, jobId: string) {
    await this.assertJobReadable(actorId, await this.getJob(jobId));
    return this.repo.listMappings(jobId);
  }

  /**
   * Tạo và chạy backup job (API twin của worker processor): ghi bước cho từng
   * contributor. Phạm vi `course` cần `courseId`; phạm vi `site` sao lưu mức
   * hệ thống (courseId = null, chỉ các contributor `supportsSite` tham gia —
   * question bank mức site, badge mức site, calendar mức site) và kiểm tra
   * capability tại context hệ thống.
   */
  async createBackup(actorId: string, courseId: string | null, anonymize = false, scope: 'course' | 'site' = 'course'): Promise<JobRow> {
    if (scope === 'site' && courseId) {
      throw new BadRequestException({ message: 'A site backup must not be attached to a course', code: 'backup.site_course_forbidden' });
    }
    if (scope === 'course' && !courseId) {
      throw new BadRequestException({ message: 'A course backup requires a course', code: 'backup.course_required' });
    }
    const courseRow = scope === 'course' ? await this.courses.getCourse(courseId!) : null;
    if (scope === 'course') {
      await this.evaluator.requireCapability(actorId, 'backup:backupcourse', await this.courses.courseContextId(courseId!));
    } else {
      await this.evaluator.requireCapability(actorId, 'backup:backupcourse', (await this.contexts.ensureSystemContext()).id);
    }
    const job = await this.repo.insertJob({ type: 'backup', scope, courseId: courseId, userId: actorId, anonymize, status: 'running' });
    try {
      const contributorsData: Record<string, unknown> = {};
      for (const c of this.contributors) {
        if (scope === 'site' && !c.supportsSite) {
          const step = await this.repo.insertStep({ jobId: job.id, name: c.name, status: 'running' });
          await this.repo.updateStep(step.id, { status: 'completed', detail: { skipped: 'course-scope-only' } });
          continue;
        }
        const step = await this.repo.insertStep({ jobId: job.id, name: c.name, status: 'running' });
        const data = await c.export(courseId, anonymize);
        contributorsData[c.name] = data;
        await this.repo.updateStep(step.id, { status: 'completed', detail: { exported: true } });
      }
      const archive = {
        format: BACKUP_FORMAT, version: BACKUP_FORMAT_VERSION, scope, courseId,
        course: courseRow
          ? { fullName: courseRow.fullName, shortName: courseRow.shortName, category: courseRow.category, summary: courseRow.summary }
          : null,
        anonymize, contributors: contributorsData,
      };
      await this.repo.updateJob(job.id, { status: 'completed', archive, timeFinished: new Date() });
    } catch (e) {
      await this.repo.updateJob(job.id, { status: 'failed', error: e instanceof Error ? e.message : String(e), timeFinished: new Date() });
    }
    return this.getJob(job.id);
  }

  /**
   * Tạo và chạy restore job với 3 chế độ tường minh. Backup mức SITE chỉ
   * khôi phục ở chế độ `new` (tạo dữ liệu mức site MỚI, không có khoá đích):
   * merge/replace/khoá đích đều bị từ chối vì không có course đích để gộp.
   * Trước mọi xử lý, người gọi phải qua cổng đọc tại khoá NGUỒN của job
   * backup (cùng cổng `assertJobReadable` với các đường đọc) — restore là
   * đường chép dữ kiện khoá nên không được nhẹ cổng hơn đường đọc.
   */
  async restore(actorId: string, backupJobId: string, mode: 'new' | 'merge' | 'replace', targetCourseId?: string): Promise<JobRow> {
    const backup = await this.getJob(backupJobId);
    if (backup.type !== 'backup' || backup.status !== 'completed' || !backup.archive) {
      throw new BadRequestException({ message: 'Backup job is not a completed backup', code: 'backup.not_completed' });
    }
    // Cổng đọc tại NGUỒN: mọi đường chép dữ kiện khoá phải qua cùng cổng
    // đọc tại nguồn như các đường đọc — người gọi phải có
    // `backup:backupcourse` hoặc `backup:restorecourse` tại context của
    // khoá thuộc job (job site thì tại context hệ thống, nơi đường
    // restore site vốn đã đòi `restorecourse` nên hành vi site không
    // đổi). Biết ID của job không đồng nghĩa có quyền trên dữ kiện của
    // job. Kiểm này chạy TRƯỚC mọi xử lý archive và trước mọi kiểm tra
    // phía đích để phủ cả 3 chế độ merge/new/replace: nếu chỉ kiểm phía
    // đích, ai có quyền khôi phục ở khoá của mình cũng chép được toàn bộ
    // dữ kiện (ngân hàng câu hỏi kèm đáp án/lời giải, điểm, ghi danh,
    // tệp) của khoá bất kỳ — kể cả khoá của tenant khác — chỉ bằng ID.
    await this.assertJobReadable(actorId, backup);
    const archive = backup.archive as {
      format: string; version: number; scope?: string;
      course: { fullName: string; shortName: string; category: string; summary: string } | null;
      contributors: Record<string, unknown>;
    };
    if (archive.format !== BACKUP_FORMAT || archive.version !== BACKUP_FORMAT_VERSION) {
      throw new BadRequestException({ message: `Unsupported backup format ${archive.format} v${archive.version}`, code: 'backup.unsupported_format' });
    }
    const scope: 'course' | 'site' = backup.scope === 'site' || archive.scope === 'site' ? 'site' : 'course';

    if (scope === 'site') {
      if (mode !== 'new' || targetCourseId) {
        throw new BadRequestException({ message: 'A site backup can only be restored as new site-level data, without a target course', code: 'backup.site_target_forbidden' });
      }
      await this.evaluator.requireCapability(actorId, 'backup:restorecourse', (await this.contexts.ensureSystemContext()).id);
      const job = await this.repo.insertJob({
        type: 'restore', scope: 'site', courseId: null, targetCourseId: null, mode, userId: actorId, status: 'running',
      });
      const mappingState = new Map<string, string>();
      const mapping: RestoreMapping = {
        map: async (itemType, oldId, newId) => {
          mappingState.set(`${itemType}:${oldId}`, newId);
          await this.repo.insertMapping({ jobId: job.id, itemType, oldId, newId });
        },
        get: (itemType, oldId) => mappingState.get(`${itemType}:${oldId}`),
      };
      try {
        for (const c of this.contributors) {
          const step = await this.repo.insertStep({ jobId: job.id, name: c.name, status: 'running' });
          const data = archive.contributors[c.name];
          const importResult = data !== undefined ? await c.import(null, data as never, mapping, actorId) : undefined;
          await this.repo.updateStep(step.id, {
            status: 'completed',
            ...(importResult?.detail ? { detail: importResult.detail } : {}),
          });
        }
        await this.repo.updateJob(job.id, { status: 'completed', timeFinished: new Date() });
      } catch (e) {
        await this.repo.updateJob(job.id, { status: 'failed', error: e instanceof Error ? e.message : String(e), timeFinished: new Date() });
      }
      return this.getJob(job.id);
    }

    if (!archive.course) {
      throw new BadRequestException({ message: 'Backup archive has no course payload', code: 'backup.not_completed' });
    }
    if (mode !== 'new' && !targetCourseId) throw new BadRequestException({ message: `Restore mode ${mode} requires targetCourseId`, code: 'backup.target_required' });
    if (mode === 'new' && targetCourseId) throw new BadRequestException({ message: 'Restore mode new must not pass targetCourseId', code: 'backup.target_forbidden' });

    let targetId: string;
    if (mode === 'new') {
      await this.evaluator.requireCapability(actorId, 'backup:restorecourse', await this.courses.categoryContextId(archive.course.category));
      const created = await this.courses.createCourse(actorId, {
        fullName: archive.course.fullName, shortName: `${archive.course.shortName}-r${Date.now().toString(36)}`,
        category: archive.course.category, summary: archive.course.summary,
      });
      targetId = created.id;
    } else {
      targetId = targetCourseId!;
      await this.evaluator.requireCapability(actorId, 'backup:restorecourse', await this.courses.courseContextId(targetId));
    }

    const job = await this.repo.insertJob({
      type: 'restore', scope: 'course', courseId: backup.courseId, targetCourseId: targetId, mode, userId: actorId, status: 'running',
    });
    const mappingState = new Map<string, string>();
    const mapping: RestoreMapping = {
      map: async (itemType, oldId, newId) => {
        mappingState.set(`${itemType}:${oldId}`, newId);
        await this.repo.insertMapping({ jobId: job.id, itemType, oldId, newId });
      },
      get: (itemType, oldId) => mappingState.get(`${itemType}:${oldId}`),
    };
    if (backup.courseId) await mapping.map('course', backup.courseId, targetId);
    try {
      if (mode === 'replace') await this.clearCourseContent(targetId);
      for (const c of this.contributors) {
        const step = await this.repo.insertStep({ jobId: job.id, name: c.name, status: 'running' });
        const data = archive.contributors[c.name];
        const importResult = data !== undefined ? await c.import(targetId, data as never, mapping, actorId) : undefined;
        await this.repo.updateStep(step.id, {
          status: 'completed',
          ...(importResult?.detail ? { detail: importResult.detail } : {}),
        });
      }
      await this.repo.updateJob(job.id, { status: 'completed', timeFinished: new Date() });
    } catch (e) {
      await this.repo.updateJob(job.id, { status: 'failed', error: e instanceof Error ? e.message : String(e), timeFinished: new Date() });
    }
    return this.getJob(job.id);
  }

  /** Replace mode: xoá nội dung hiện có của course đích trước khi khôi phục. */
  private async clearCourseContent(courseId: string): Promise<void> {
    const db = this.repo.dbHandle;
    await db.deleteFrom('course_sections').where('course', '=', courseId).execute();
    await db.deleteFrom('enrol').where('course_id', '=', courseId).execute();
    await db.deleteFrom('grade_items').where('course_id', '=', courseId).execute();
    await db.deleteFrom('course_completions').where('course', '=', courseId).execute();
    await db.deleteFrom('course_groups').where('course_id', '=', courseId).execute();
    await db.deleteFrom('groupings').where('course_id', '=', courseId).execute();
    await db.deleteFrom('badge').where('course_id', '=', courseId).execute();
    await db.deleteFrom('calendar_events').where('course_id', '=', courseId).execute();
    await db.deleteFrom('calendar_subscriptions').where('course_id', '=', courseId).execute();
    const courseCtx = await this.contexts.getByLevelInstance(50, courseId);
    if (courseCtx) await db.deleteFrom('question_categories').where('context_id', '=', courseCtx.id).execute();
  }

  /**
   * Checklist tương đương giữa course nguồn và course đích của một restore job.
   * Với restore mức SITE không có khoá đích: phía đích sống CÙNG không gian
   * với phía nguồn (cùng context hệ thống) nên không đếm trực tiếp được —
   * `target` là số bản ghi MỚI mà job đã tạo theo từng itemType trong
   * backup_id_mappings, `source` là tổng hiện có trừ đi phần mới tạo đó.
   */
  async restoreChecklist(actorId: string, restoreJobId: string): Promise<Record<string, { source: number; target: number }>> {
    const job = await this.getJob(restoreJobId);
    await this.assertJobReadable(actorId, job);
    const db = this.repo.dbHandle;
    if (job.scope === 'site' || !job.targetCourseId) {
      const mappings = await this.repo.listMappings(job.id);
      const mapped = (itemType: string) => mappings.filter((m) => m.itemType === itemType).length;
      const systemCtx = await this.contexts.ensureSystemContext();
      const siteCategories = await db.selectFrom('question_categories').select(QUESTION_CATEGORIES_COLUMNS).where('context_id', '=', systemCtx.id).execute();
      const siteQuestions = siteCategories.length
        ? await db.selectFrom('question').select(QUESTION_COLUMNS).where('category', 'in', siteCategories.map((c) => c.id)).execute()
        : [];
      const siteBadges = await db.selectFrom('badge').select(BADGE_COLUMNS).where('course_id', 'is', null).execute();
      const siteEvents = await db.selectFrom('calendar_events').select(CALENDAR_EVENTS_COLUMNS).where('event_type', '=', 'site').execute();
      const siteSubs = await db.selectFrom('calendar_subscriptions').select(CALENDAR_SUBSCRIPTIONS_COLUMNS).where('event_type', '=', 'site').execute();
      const entry = (total: number, itemType: string) => ({ source: Math.max(0, total - mapped(itemType)), target: mapped(itemType) });
      return {
        questionCategories: entry(siteCategories.length, 'question_category'),
        questions: entry(siteQuestions.length, 'question'),
        badges: entry(siteBadges.length, 'badge'),
        calendarEvents: entry(siteEvents.length, 'calendar_event'),
        calendarSubscriptions: entry(siteSubs.length, 'calendar_subscription'),
      };
    }
    const targetId = job.targetCourseId;
    const countFor = async (courseId: string) => {
      const sections = await db.selectFrom('course_sections').select(COURSE_SECTIONS_COLUMNS).where('course', '=', courseId).execute();
      const cms = await db.selectFrom('course_modules').select(COURSE_MODULES_COLUMNS).where('course', '=', courseId).execute();
      const instances = await db.selectFrom('enrol').select(ENROL_COLUMNS).where('course_id', '=', courseId).execute();
      const ues = instances.length ? await db.selectFrom('user_enrolments').select(USER_ENROLMENTS_COLUMNS).where('enrol_id', 'in', instances.map((i) => i.id)).execute() : [];
      const items = await db.selectFrom('grade_items').select(GRADE_ITEMS_COLUMNS).where('course_id', '=', courseId).execute();
      const grades = items.length ? await db.selectFrom('grade_grades').select(GRADE_GRADES_COLUMNS).where('item_id', 'in', items.map((i) => i.id)).execute() : [];
      const cmComp = cms.length ? await db.selectFrom('course_modules_completion').select(COURSE_MODULES_COMPLETION_COLUMNS).where('course_module_id', 'in', cms.map((c) => c.id)).execute() : [];
      const courseCtx = await this.contexts.getByLevelInstance(50, courseId);
      const qCats = courseCtx ? await db.selectFrom('question_categories').select(QUESTION_CATEGORIES_COLUMNS).where('context_id', '=', courseCtx.id).execute() : [];
      const qRows = qCats.length ? await db.selectFrom('question').select(QUESTION_COLUMNS).where('category', 'in', qCats.map((c) => c.id)).execute() : [];
      const qEntries = qCats.length ? await db.selectFrom('question_bank_entries').select(QUESTION_BANK_ENTRIES_COLUMNS).where('question_category_id', 'in', qCats.map((c) => c.id)).execute() : [];
      const qVersions = qEntries.length ? await db.selectFrom('question_versions').select(QUESTION_VERSIONS_COLUMNS).where('question_bank_entry_id', 'in', qEntries.map((e) => e.id)).execute() : [];
      const courseBadges = await db.selectFrom('badge').select(BADGE_COLUMNS).where('course_id', '=', courseId).execute();
      const badgeCriteriaCount = courseBadges.length
        ? (await db.selectFrom('badge_criteria').select(BADGE_CRITERIA_COLUMNS).where('badge_id', 'in', courseBadges.map((b) => b.id)).execute()).length
        : 0;
      const calEvents = await db.selectFrom('calendar_events').select(CALENDAR_EVENTS_COLUMNS).where('course_id', '=', courseId).execute();
      const calSubs = await db.selectFrom('calendar_subscriptions').select(CALENDAR_SUBSCRIPTIONS_COLUMNS).where('course_id', '=', courseId).execute();
      // completion nguồn tính theo cms nguồn — hàm này chỉ gọi với course tương ứng nên cms ở đây là của course đó.
      return {
        sections: sections.length, cms: cms.length, enrolInstances: instances.length, enrolments: ues.length,
        gradeItems: items.length, grades: grades.length, cmCompletion: cmComp.length,
        questionCategories: qCats.length, questions: qRows.length, questionVersions: qVersions.length,
        badges: courseBadges.length, badgeCriteria: badgeCriteriaCount,
        calendarEvents: calEvents.length, calendarSubscriptions: calSubs.length,
      };
    };
    const source = await countFor(job.courseId!);
    const target = await countFor(targetId);
    const out: Record<string, { source: number; target: number }> = {};
    for (const k of Object.keys(source) as (keyof typeof source)[]) out[k] = { source: source[k], target: target[k] };
    return out;
  }
}

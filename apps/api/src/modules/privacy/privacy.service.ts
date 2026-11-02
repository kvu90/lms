import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrivacyRepository, type PrivacyRequestRow } from '@lms/db/repositories/privacy';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { FilesService } from '../files/files.service';
import { UsersService } from '../users/users.service';

/**
 * Danh sách cột tường minh có bí danh camelCase cho các bảng mà các
 * provider tích hợp sẵn của module này đọc/xoá (chuyển Kysely, issue
 * #648): bản xuất dữ liệu của chủ thể giữ nguyên hình dạng dòng
 * camelCase như khi còn đọc qua Drizzle. Việc xoá đếm số dòng bằng
 * `returning('id')` — cùng khuôn đếm với `.returning()` của bản cũ.
 */
const USER_PREFERENCES_COLUMNS = ['id', 'user_id as userId', 'name', 'value'] as const;
const USER_ENROLMENTS_COLUMNS = [
  'id', 'enrol_id as enrolId', 'user_id as userId', 'status', 'time_start as timeStart',
  'time_end as timeEnd', 'modifier_id as modifierId', 'created_at as createdAt', 'updated_at as updatedAt',
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
const FILES_COLUMNS = [
  'id', 'content_hash as contentHash', 'context_id as contextId', 'component', 'file_area as fileArea',
  'item_id as itemId', 'file_path as filePath', 'file_name as fileName', 'user_id as userId',
  'file_size as fileSize', 'mime_type as mimeType', 'status', 'source', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;
const MESSAGE_COLUMNS = [
  'id', 'conversation_id as conversationId', 'user_id_from as userIdFrom', 'subject', 'full_message as fullMessage',
  'small_message as smallMessage', 'seq', 'client_message_id as clientMessageId', 'reply_to_message_id as replyToMessageId',
  'deleted_at as deletedAt', 'deleted_by as deletedBy', 'recalled_at as recalledAt', 'recalled_by as recalledBy', 'created_at as createdAt',
] as const;
const NOTIFICATIONS_COLUMNS = [
  'id', 'user_id_from as userIdFrom', 'user_id_to as userIdTo', 'tenant_id as tenantId', 'subject',
  'full_message as fullMessage', 'small_message as smallMessage', 'component', 'event_type as eventType',
  'context_url as contextUrl', 'context_url_name as contextUrlName', 'created_at as createdAt', 'time_read as timeRead',
] as const;
const CALENDAR_EVENTS_COLUMNS = [
  'id', 'name', 'description', 'event_type as eventType', 'course_id as courseId', 'group_id as groupId',
  'category_id as categoryId', 'user_id as userId', 'context_id as contextId', 'subscription_id as subscriptionId',
  'uuid', 'repeat_id as repeatId', 'rrule', 'is_exception as isException', 'exception_of as exceptionOf',
  'time_start as timeStart', 'time_duration as timeDuration', 'visible', 'location', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;
const BADGE_ISSUED_COLUMNS = [
  'id', 'badge_id as badgeId', 'user_id as userId', 'unique_hash as uniqueHash', 'snapshot', 'evidence',
  'date_issued as dateIssued', 'date_expire as dateExpire', 'visible', 'revoked', 'revoked_at as revokedAt', 'issuer_notified as issuerNotified',
] as const;
const COMPETENCY_USER_COMP_COLUMNS = [
  'id', 'user_id as userId', 'competency_id as competencyId', 'plan_id as planId', 'course_id as courseId',
  'status', 'proficiency', 'grade', 'reviewer_id as reviewerId', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;
const LEARNING_PLANS_COLUMNS = [
  'id', 'name', 'description', 'user_id as userId', 'template_id as templateId', 'status',
  'due_date as dueDate', 'reviewer_id as reviewerId', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;
const COMMENTS_COLUMNS = [
  'id', 'context_id as contextId', 'component', 'comment_area as commentArea', 'item_id as itemId',
  'content', 'format', 'user_id as userId', 'created_at as createdAt', 'time_deleted as timeDeleted',
] as const;
const RATING_COLUMNS = [
  'id', 'context_id as contextId', 'component', 'rating_area as ratingArea', 'item_id as itemId',
  'scale_id as scaleId', 'rating', 'user_id as userId', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;
const NOTES_COLUMNS = [
  'id', 'course_id as courseId', 'user_id as userId', 'created_by as createdBy', 'content', 'format',
  'publish_state as publishState', 'group_id as groupId', 'user_modified as userModified', 'created', 'last_modified as lastModified',
] as const;
const TAG_INSTANCE_COLUMNS = [
  'id', 'tag_id as tagId', 'component', 'item_type as itemType', 'item_id as itemId', 'context_id as contextId',
  'ti_user_id as tiUserId', 'ordering', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;
const SEARCH_DOCUMENTS_COLUMNS = [
  'id', 'area', 'item_id as itemId', 'context_id as contextId', 'title', 'content', 'owner_id as ownerId', 'updated_at as updatedAt',
] as const;
const CONTENT_BANK_CONTENT_COLUMNS = [
  'id', 'name', 'content_type as contentType', 'context_id as contextId', 'creator_id as creatorId', 'visibility',
  'file_id as fileId', 'config_data as configData', 'resource_type as resourceType', 'scope', 'space_id as spaceId',
  'subject_id as subjectId', 'grade', 'level', 'curriculum_node_id as curriculumNodeId', 'outcome_ids as outcomeIds',
  'question_category_id as questionCategoryId', 'external_url as externalUrl', 'description', 'keywords',
  'target_audience as targetAudience', 'lesson_position as lessonPosition', 'tech_format as techFormat',
  'size_bytes as sizeBytes', 'duration_seconds as durationSeconds', 'language', 'original_author as originalAuthor',
  'source_kind as sourceKind', 'source_citation as sourceCitation', 'license', 'derived_from_id as derivedFromId',
  'review_status as reviewStatus', 'reviewed_by as reviewedBy', 'reviewed_at as reviewedAt', 'review_note as reviewNote',
  'review_checklist as reviewChecklist', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;
const PAYMENTS_COLUMNS = [
  'id', 'account_id as accountId', 'tenant_id as tenantId', 'user_id as userId', 'amount', 'currency', 'status',
  'gateway', 'external_transaction_id as externalTransactionId', 'component', 'item_id as itemId', 'payment_code as paymentCode',
  'expires_at as expiresAt', 'review_decision as reviewDecision', 'review_reason as reviewReason',
  'review_handled_by as reviewHandledBy', 'review_handled_at as reviewHandledAt', 'data', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;

/**
 * Một PrivacyProvider đăng ký đảo ngược (§3.12/§2#28): khai báo metadata
 * dữ liệu cá nhân của subsystem mình + export + delete cho một user.
 * Kể cả subsystem tuyên bố không giữ dữ liệu cũng phải đăng ký.
 */
export interface PrivacyProvider {
  subsystem: string;
  /** Metadata: các bảng/trường giữ dữ liệu cá nhân của subsystem. */
  metadata: string[];
  export(userId: string): Promise<unknown>;
  delete(userId: string): Promise<{ deleted: number }>;
}

/** Danh sách subsystem nghiệp vụ BẮT BUỘC có provider — completeness test đối chiếu danh sách này với registry. */
export const EXPECTED_PRIVACY_SUBSYSTEMS = [
  'users', 'enrol', 'grades', 'completion', 'files', 'messaging', 'calendar',
  'badges', 'competencies', 'social', 'search', 'contentbank', 'payments',
] as const;

/**
 * PrivacyModule facade (Moodle core_privacy, §2#28) — GATE trước go-live.
 * Yêu cầu export/delete có phê duyệt bởi admin có capability, chạy nền
 * (API twin đồng bộ ở đây; worker có processor tương đương), có trạng thái.
 * Delete phải lan đủ mọi subsystem đã khai — sót một provider là lỗi.
 */
@Injectable()
export class PrivacyService {
  private readonly providers = new Map<string, PrivacyProvider>();

  constructor(
    private readonly repo: PrivacyRepository,
    private readonly evaluator: PermissionEvaluator,
    private readonly contexts: ContextsService,
    private readonly files: FilesService,
    private readonly usersService: UsersService,
  ) {
    this.registerBuiltinProviders();
  }

  /** Đăng ký provider — module nghiệp vụ đăng ký provider của mình qua đây. */
  registerProvider(p: PrivacyProvider): void { this.providers.set(p.subsystem, p); }
  listProviders(): { subsystem: string; metadata: string[] }[] {
    return [...this.providers.values()].map((p) => ({ subsystem: p.subsystem, metadata: p.metadata }));
  }
  /** Completeness: subsystem kỳ vọng nào chưa có provider? */
  missingProviders(): string[] {
    return EXPECTED_PRIVACY_SUBSYSTEMS.filter((s) => !this.providers.has(s));
  }

  private registerBuiltinProviders(): void {
    const db = this.repo.dbHandle;
    const simple = (
      subsystem: string, metadata: string[],
      exportFn: (userId: string) => Promise<unknown>,
      deleteFn: (userId: string) => Promise<number>,
    ) => this.registerProvider({
      subsystem, metadata, export: exportFn,
      delete: async (userId) => ({ deleted: await deleteFn(userId) }),
    });

    simple('users', ['users.username/email/first_name/last_name', 'user_preferences'],
      async (userId) => {
        const u = await db
          .selectFrom('users')
          .select(['id', 'username', 'email', 'first_name as firstName', 'last_name as lastName'])
          .where('id', '=', userId)
          .executeTakeFirst();
        const prefs = await db.selectFrom('user_preferences').select(USER_PREFERENCES_COLUMNS).where('user_id', '=', userId).execute();
        return { user: u ? { id: u.id, username: u.username, email: u.email, firstName: u.firstName, lastName: u.lastName } : null, preferences: prefs };
      },
      async (userId) => {
        await db.deleteFrom('user_preferences').where('user_id', '=', userId).execute();
        // Anonymize/soft-delete danh tính — provider khác vẫn chạy độc lập sau đó.
        await this.usersService.deleteUser(userId).catch(() => undefined);
        return 1;
      });
    simple('enrol', ['user_enrolments.user_id'],
      async (userId) => db.selectFrom('user_enrolments').select(USER_ENROLMENTS_COLUMNS).where('user_id', '=', userId).execute(),
      async (userId) => (await db.deleteFrom('user_enrolments').where('user_id', '=', userId).returning('id').execute()).length);
    simple('grades', ['grade_grades.user_id/final_grade/feedback'],
      async (userId) => db.selectFrom('grade_grades').select(GRADE_GRADES_COLUMNS).where('user_id', '=', userId).execute(),
      async (userId) => (await db.deleteFrom('grade_grades').where('user_id', '=', userId).returning('id').execute()).length);
    simple('completion', ['course_modules_completion.user_id', 'course_completions.user_id'],
      async (userId) => ({
        cm: await db.selectFrom('course_modules_completion').select(COURSE_MODULES_COMPLETION_COLUMNS).where('user_id', '=', userId).execute(),
        course: await db.selectFrom('course_completions').select(COURSE_COMPLETIONS_COLUMNS).where('user_id', '=', userId).execute(),
      }),
      async (userId) => {
        const a = (await db.deleteFrom('course_modules_completion').where('user_id', '=', userId).returning('id').execute()).length;
        const b = (await db.deleteFrom('course_completions').where('user_id', '=', userId).returning('id').execute()).length;
        return a + b;
      });
    simple('files', ['files.user_id'],
      async (userId) => db.selectFrom('files').select(FILES_COLUMNS).where('user_id', '=', userId).execute(),
      async (userId) => {
        const rows = await db.selectFrom('files').select(FILES_COLUMNS).where('user_id', '=', userId).execute();
        for (const f of rows) await this.files.deleteFile(f.id).catch(() => undefined);
        return rows.length;
      });
    simple('messaging', ['message.user_id_from', 'notifications.user_id_to'],
      async (userId) => ({
        sent: await db.selectFrom('message').select(MESSAGE_COLUMNS).where('user_id_from', '=', userId).execute(),
        notifications: await db.selectFrom('notifications').select(NOTIFICATIONS_COLUMNS).where('user_id_to', '=', userId).execute(),
      }),
      async (userId) => {
        const a = (await db.deleteFrom('notifications').where('user_id_to', '=', userId).returning('id').execute()).length;
        const b = (await db.deleteFrom('message').where('user_id_from', '=', userId).returning('id').execute()).length;
        return a + b;
      });
    simple('calendar', ['calendar_events.user_id'],
      async (userId) => db.selectFrom('calendar_events').select(CALENDAR_EVENTS_COLUMNS).where('user_id', '=', userId).execute(),
      async (userId) => (await db.deleteFrom('calendar_events').where('user_id', '=', userId).returning('id').execute()).length);
    simple('badges', ['badge_issued.user_id'],
      async (userId) => db.selectFrom('badge_issued').select(BADGE_ISSUED_COLUMNS).where('user_id', '=', userId).execute(),
      async (userId) => (await db.deleteFrom('badge_issued').where('user_id', '=', userId).returning('id').execute()).length);
    simple('competencies', ['competency_user_comp.user_id', 'learning_plans.user_id'],
      async (userId) => ({
        usercomp: await db.selectFrom('competency_user_comp').select(COMPETENCY_USER_COMP_COLUMNS).where('user_id', '=', userId).execute(),
        plans: await db.selectFrom('learning_plans').select(LEARNING_PLANS_COLUMNS).where('user_id', '=', userId).execute(),
      }),
      async (userId) => {
        const a = (await db.deleteFrom('competency_user_comp').where('user_id', '=', userId).returning('id').execute()).length;
        const b = (await db.deleteFrom('learning_plans').where('user_id', '=', userId).returning('id').execute()).length;
        return a + b;
      });
    simple('social', ['comments.user_id', 'rating.user_id', 'notes.user_id/created_by', 'tag_instance.ti_user_id'],
      async (userId) => ({
        comments: await db.selectFrom('comments').select(COMMENTS_COLUMNS).where('user_id', '=', userId).execute(),
        ratings: await db.selectFrom('rating').select(RATING_COLUMNS).where('user_id', '=', userId).execute(),
        notesAbout: await db.selectFrom('notes').select(NOTES_COLUMNS).where('user_id', '=', userId).execute(),
        tags: await db.selectFrom('tag_instance').select(TAG_INSTANCE_COLUMNS).where('ti_user_id', '=', userId).execute(),
      }),
      async (userId) => {
        let n = 0;
        n += (await db.deleteFrom('comments').where('user_id', '=', userId).returning('id').execute()).length;
        n += (await db.deleteFrom('rating').where('user_id', '=', userId).returning('id').execute()).length;
        n += (await db.deleteFrom('notes').where('user_id', '=', userId).returning('id').execute()).length;
        n += (await db.deleteFrom('notes').where('created_by', '=', userId).returning('id').execute()).length;
        n += (await db.deleteFrom('tag_instance').where('ti_user_id', '=', userId).returning('id').execute()).length;
        return n;
      });
    simple('search', ['search_documents.owner_id'],
      async (userId) => db.selectFrom('search_documents').select(SEARCH_DOCUMENTS_COLUMNS).where('owner_id', '=', userId).execute(),
      async (userId) => (await db.deleteFrom('search_documents').where('owner_id', '=', userId).returning('id').execute()).length);
    simple('contentbank', ['content_bank_content.creator_id'],
      // sizeBytes là cột int8: qua Kysely nó đọc về là chuỗi (luật
      // int8 của package @lms/db) — chuyển lại thành số tại biên này
      // để bản xuất giữ nguyên hình dạng dữ kiện như trước.
      async (userId) => (await db.selectFrom('content_bank_content').select(CONTENT_BANK_CONTENT_COLUMNS).where('creator_id', '=', userId).execute())
        .map((row) => ({ ...row, sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes) })),
      async (userId) => (await db.deleteFrom('content_bank_content').where('creator_id', '=', userId).returning('id').execute()).length);
    simple('payments', ['payments.user_id/amount/currency'],
      async (userId) => db.selectFrom('payments').select(PAYMENTS_COLUMNS).where('user_id', '=', userId).execute(),
      // Dữ liệu tài chính được ẩn danh hoá (userId → 0) thay vì xoá cứng để giữ vết đối soát; danh tính không còn truy được.
      async (userId) => (await db.updateTable('payments').set({ user_id: '00000000-0000-0000-0000-000000000000' }).where('user_id', '=', userId).returning('id').execute()).length);
  }

  // --- vòng đời yêu cầu -------------------------------------------------------

  /** Người dùng tự gửi yêu cầu cho chính mình; admin có manage có thể gửi hộ. */
  async createRequest(actorId: string, input: { type: 'export' | 'delete'; userId?: string }): Promise<PrivacyRequestRow> {
    const target = input.userId ?? actorId;
    if (target !== actorId) {
      const sys = await this.contexts.ensureSystemContext();
      await this.evaluator.requireCapability(actorId, 'privacy:manage', sys.id);
    }
    if (!['export', 'delete'].includes(input.type)) throw new BadRequestException({ message: 'Unknown privacy request type', code: 'privacy.bad_type' });
    const user = await this.usersService.getByIdOrUndefined(target);
    if (!user) throw new NotFoundException({ message: `User ${target} not found`, code: 'privacy.user_not_found' });
    return this.repo.insertRequest({ userId: target, type: input.type, requestedBy: actorId, status: 'pending' });
  }
  async getRequest(id: string): Promise<PrivacyRequestRow> {
    const row = await this.repo.getRequest(id);
    if (!row) throw new NotFoundException({ message: `Privacy request ${id} not found`, code: 'privacy.request_not_found' });
    return row;
  }
  /**
   * Đọc một privacy request qua HTTP (H15, rà soát #134): chỉ chủ thể của
   * request (userId), người đã gửi request hộ, hoặc người có
   * `privacy:manage` tại system mới đọc được — người ngoài nhận đúng 404
   * như request không tồn tại, không lộ metadata (userId, loại, trạng
   * thái) của yêu cầu quyền riêng tư của người khác.
   */
  async getRequestFor(actorId: string, id: string): Promise<PrivacyRequestRow> {
    const row = await this.getRequest(id);
    if (row.userId === actorId || row.requestedBy === actorId) return row;
    const sys = await this.contexts.ensureSystemContext();
    if (await this.evaluator.hasCapability(actorId, 'privacy:manage', sys.id)) return row;
    throw new NotFoundException({ message: `Privacy request ${id} not found`, code: 'privacy.request_not_found' });
  }
  async listRequestsFor(actorId: string): Promise<PrivacyRequestRow[]> {
    const sys = await this.contexts.ensureSystemContext();
    if (await this.evaluator.hasCapability(actorId, 'privacy:manage', sys.id)) return this.repo.listRequests();
    return this.repo.listRequestsForUser(actorId);
  }

  /** Phê duyệt/từ chối bởi admin có capability privacy:manage; approve ⇒ xử lý ngay (API twin của worker job). */
  async decide(actorId: string, id: string, decision: 'approved' | 'rejected'): Promise<PrivacyRequestRow> {
    const sys = await this.contexts.ensureSystemContext();
    await this.evaluator.requireCapability(actorId, 'privacy:manage', sys.id);
    const req = await this.getRequest(id);
    if (req.status !== 'pending') throw new BadRequestException({ message: `Request is ${req.status}, not pending`, code: 'privacy.not_pending' });
    if (decision === 'rejected') {
      await this.repo.updateRequest(id, { status: 'rejected', approvedBy: actorId });
      return this.getRequest(id);
    }
    await this.repo.updateRequest(id, { status: 'approved', approvedBy: actorId });
    return this.processRequest(id);
  }

  /**
   * Xử lý một yêu cầu đã duyệt: export ⇒ gói JSON theo subsystem + manifest
   * qua FilesModule; delete ⇒ gọi delete của MỌI provider đã đăng ký và ghi
   * kết quả từng subsystem — thiếu provider nào (completeness) là FAIL.
   */
  async processRequest(id: string): Promise<PrivacyRequestRow> {
    const req = await this.getRequest(id);
    if (req.status !== 'approved') throw new ForbiddenException({ message: 'Privacy request is not approved', code: 'privacy.not_approved' });
    const missing = this.missingProviders();
    if (missing.length) {
      await this.repo.updateRequest(id, { status: 'failed', result: { missingProviders: missing } });
      return this.getRequest(id);
    }
    try {
      if (req.type === 'export') {
        const bundle: Record<string, unknown> = {};
        for (const p of this.providers.values()) bundle[p.subsystem] = await p.export(req.userId);
        const manifest = { requestId: id, userId: req.userId, subsystems: Object.keys(bundle), format: 'lms-privacy-export', version: 1 };
        const sys = await this.contexts.ensureSystemContext();
        const file = await this.files.upload({
          contextId: sys.id, component: 'core_privacy', fileArea: 'export', itemId: id,
          fileName: `privacy-export-${id}.json`, data: Buffer.from(JSON.stringify({ manifest, data: bundle }, null, 2)),
          mimeType: 'application/json', userId: req.userId,
        });
        await this.repo.insertExportFile({ requestId: id, fileId: file.id, subsystem: 'all', manifest });
        await this.repo.updateRequest(id, { status: 'completed', result: { manifest, fileId: file.id, subsystems: Object.keys(bundle) } });
      } else {
        const perSubsystem: Record<string, number> = {};
        for (const p of this.providers.values()) {
          const { deleted } = await p.delete(req.userId);
          perSubsystem[p.subsystem] = deleted;
        }
        await this.repo.updateRequest(id, { status: 'completed', result: { deleted: perSubsystem, subsystems: Object.keys(perSubsystem) } });
      }
    } catch (e) {
      await this.repo.updateRequest(id, { status: 'failed', result: { error: e instanceof Error ? e.message : String(e) } });
    }
    return this.getRequest(id);
  }
  async listExportFiles(requestId: string) { return this.repo.listExportFiles(requestId); }
  /** Danh sách file xuất qua HTTP: qua cùng cổng sở hữu như getRequestFor (H15). */
  async listExportFilesFor(actorId: string, requestId: string) {
    await this.getRequestFor(actorId, requestId);
    return this.repo.listExportFiles(requestId);
  }
}

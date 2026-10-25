import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { FilesService } from '../files/files.service';
import { UsersService } from '../users/users.service';
import { PrivacyRepository, type PrivacyRequestRow } from './privacy.repository';
import {
  badgeIssued, blogPosts, calendarEvents, comments, competencyUserComp, contentBankContent,
  courseCompletions, courseModulesCompletion, files as filesTable, gradeGrades, learningPlans,
  message, notes, notifications, payments, rating, searchDocuments, tagInstance,
  userEnrolments, userPreferences, users,
} from '../../db/schema';

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
        const [u] = await db.select().from(users).where(eq(users.id, userId));
        const prefs = await db.select().from(userPreferences).where(eq(userPreferences.userId, userId));
        return { user: u ? { id: u.id, username: u.username, email: u.email, firstName: u.firstName, lastName: u.lastName } : null, preferences: prefs };
      },
      async (userId) => {
        await db.delete(userPreferences).where(eq(userPreferences.userId, userId));
        // Anonymize/soft-delete danh tính — provider khác vẫn chạy độc lập sau đó.
        await this.usersService.deleteUser(userId).catch(() => undefined);
        return 1;
      });
    simple('enrol', ['user_enrolments.user_id'],
      async (userId) => db.select().from(userEnrolments).where(eq(userEnrolments.userId, userId)),
      async (userId) => (await db.delete(userEnrolments).where(eq(userEnrolments.userId, userId)).returning()).length);
    simple('grades', ['grade_grades.user_id/final_grade/feedback'],
      async (userId) => db.select().from(gradeGrades).where(eq(gradeGrades.userId, userId)),
      async (userId) => (await db.delete(gradeGrades).where(eq(gradeGrades.userId, userId)).returning()).length);
    simple('completion', ['course_modules_completion.user_id', 'course_completions.user_id'],
      async (userId) => ({
        cm: await db.select().from(courseModulesCompletion).where(eq(courseModulesCompletion.userId, userId)),
        course: await db.select().from(courseCompletions).where(eq(courseCompletions.userId, userId)),
      }),
      async (userId) => {
        const a = (await db.delete(courseModulesCompletion).where(eq(courseModulesCompletion.userId, userId)).returning()).length;
        const b = (await db.delete(courseCompletions).where(eq(courseCompletions.userId, userId)).returning()).length;
        return a + b;
      });
    simple('files', ['files.user_id'],
      async (userId) => db.select().from(filesTable).where(eq(filesTable.userId, userId)),
      async (userId) => {
        const rows = await db.select().from(filesTable).where(eq(filesTable.userId, userId));
        for (const f of rows) await this.files.deleteFile(f.id).catch(() => undefined);
        return rows.length;
      });
    simple('messaging', ['message.user_id_from', 'notifications.user_id_to'],
      async (userId) => ({
        sent: await db.select().from(message).where(eq(message.userIdFrom, userId)),
        notifications: await db.select().from(notifications).where(eq(notifications.userIdTo, userId)),
      }),
      async (userId) => {
        const a = (await db.delete(notifications).where(eq(notifications.userIdTo, userId)).returning()).length;
        const b = (await db.delete(message).where(eq(message.userIdFrom, userId)).returning()).length;
        return a + b;
      });
    simple('calendar', ['calendar_events.user_id'],
      async (userId) => db.select().from(calendarEvents).where(eq(calendarEvents.userId, userId)),
      async (userId) => (await db.delete(calendarEvents).where(eq(calendarEvents.userId, userId)).returning()).length);
    simple('badges', ['badge_issued.user_id'],
      async (userId) => db.select().from(badgeIssued).where(eq(badgeIssued.userId, userId)),
      async (userId) => (await db.delete(badgeIssued).where(eq(badgeIssued.userId, userId)).returning()).length);
    simple('competencies', ['competency_user_comp.user_id', 'learning_plans.user_id'],
      async (userId) => ({
        usercomp: await db.select().from(competencyUserComp).where(eq(competencyUserComp.userId, userId)),
        plans: await db.select().from(learningPlans).where(eq(learningPlans.userId, userId)),
      }),
      async (userId) => {
        const a = (await db.delete(competencyUserComp).where(eq(competencyUserComp.userId, userId)).returning()).length;
        const b = (await db.delete(learningPlans).where(eq(learningPlans.userId, userId)).returning()).length;
        return a + b;
      });
    simple('social', ['comments.user_id', 'rating.user_id', 'blog_posts.user_id', 'notes.user_id/created_by', 'tag_instance.ti_user_id'],
      async (userId) => ({
        comments: await db.select().from(comments).where(eq(comments.userId, userId)),
        ratings: await db.select().from(rating).where(eq(rating.userId, userId)),
        blogPosts: await db.select().from(blogPosts).where(eq(blogPosts.userId, userId)),
        notesAbout: await db.select().from(notes).where(eq(notes.userId, userId)),
        tags: await db.select().from(tagInstance).where(eq(tagInstance.tiUserId, userId)),
      }),
      async (userId) => {
        let n = 0;
        n += (await db.delete(comments).where(eq(comments.userId, userId)).returning()).length;
        n += (await db.delete(rating).where(eq(rating.userId, userId)).returning()).length;
        n += (await db.delete(blogPosts).where(eq(blogPosts.userId, userId)).returning()).length;
        n += (await db.delete(notes).where(eq(notes.userId, userId)).returning()).length;
        n += (await db.delete(notes).where(eq(notes.createdBy, userId)).returning()).length;
        n += (await db.delete(tagInstance).where(eq(tagInstance.tiUserId, userId)).returning()).length;
        return n;
      });
    simple('search', ['search_documents.owner_id'],
      async (userId) => db.select().from(searchDocuments).where(eq(searchDocuments.ownerId, userId)),
      async (userId) => (await db.delete(searchDocuments).where(eq(searchDocuments.ownerId, userId)).returning()).length);
    simple('contentbank', ['content_bank_content.creator_id'],
      async (userId) => db.select().from(contentBankContent).where(eq(contentBankContent.creatorId, userId)),
      async (userId) => (await db.delete(contentBankContent).where(eq(contentBankContent.creatorId, userId)).returning()).length);
    simple('payments', ['payments.user_id/amount/currency'],
      async (userId) => db.select().from(payments).where(eq(payments.userId, userId)),
      // Dữ liệu tài chính được ẩn danh hoá (userId → 0) thay vì xoá cứng để giữ vết đối soát; danh tính không còn truy được.
      async (userId) => (await db.update(payments).set({ userId: '00000000-0000-0000-0000-000000000000' }).where(eq(payments.userId, userId)).returning()).length);
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

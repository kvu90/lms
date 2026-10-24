import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  AssignGradeView, AssignSubmissionDetail, AssignSubmissionFileView, AssignSubmissionSummary,
  AssignmentForUserView, AssignmentView,
} from '@lms/contracts';
import { OutboxService } from '../../infra/events/outbox.service';
import { ContextsService } from '../access/contexts.service';
import { CONTEXT_LEVELS } from '../access/domain/capabilities';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CoursesService } from '../courses/courses.service';
import { EnrolService } from '../enrol/enrol.service';
import { FilesService } from '../files/files.service';
import { GradesService } from '../grades/grades.service';
import {
  AssignmentsRepository, type AssignGradeRow, type AssignSubmissionRow, type AssignmentRow,
} from './assignments.repository';

export const ASSIGN_COMPONENT = 'mod_assign';
export const ASSIGN_CAPABILITIES = {
  view: 'assign:view',
  submit: 'assign:submit',
  manage: 'assign:manage',
  grade: 'assign:grade',
  viewAllSubmissions: 'assign:viewallsubmissions',
} as const;

/** Component/file area của tệp bài nộp trong module Files. */
export const ASSIGN_FILE_AREA = 'submission_files';

/**
 * Hoạt động Bài tập nộp tệp/ảnh (Moodle mod_assign, submission type
 * file/ảnh) — lát C2 của Đợt 3.
 *
 * Luồng nghiệp vụ: giáo viên tạo bài tập trong một section (kèm course
 * module + grade item 'mod' như mọi hoạt động); học sinh tải 1–nhiều
 * ảnh/tệp vào bài nộp nháp của mình (nội dung qua module Files: dedup
 * theo content hash, tải xuống bằng signed URL), chốt nộp trước/sau hạn
 * (sau hạn vẫn nhận, đánh dấu trễ); giáo viên xem tệp kèm URL đã ký (bề
 * mặt chấm toàn màn ở phía client), nhập điểm + lời phê — điểm đồng thời
 * ghi vào sổ điểm qua grade item của course module
 * (GradesService.recordActivityGrade, source 'mod/assign') nên chảy vào
 * gradebook và completion (completion theo điểm như mod_quiz) mà không
 * cần nhập lại ở nơi khác.
 *
 * Máy trạng thái bài nộp: (chưa có) → draft → submitted → graded (khi
 * assign_grades khớp attempt_number hiện hành). Chưa chấm thì học sinh
 * mở lại được về draft để sửa (nộp lại tăng attempt_number); đã chấm thì
 * khoá hẳn.
 */
@Injectable()
export class AssignmentsService {
  private readonly logger = new Logger(AssignmentsService.name);

  constructor(
    private readonly repo: AssignmentsRepository,
    private readonly courses: CoursesService,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly enrol: EnrolService,
    private readonly files: FilesService,
    private readonly grades: GradesService,
    private readonly outbox: OutboxService,
  ) {}

  // --- helpers ---------------------------------------------------------------

  /** Lấy bài tập; ném assign.not_found khi vắng. */
  async getAssignment(id: string): Promise<AssignmentRow> {
    const row = await this.repo.getAssignment(id);
    if (!row) throw new NotFoundException({ message: `Assignment ${id} not found`, code: 'assign.not_found' });
    return row;
  }
  /** Context của course module chứa bài tập — mọi capability assign:* kiểm tại đây. */
  private async cmContextId(assignment: AssignmentRow): Promise<string> {
    if (assignment.cmId) {
      const ctx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.MODULE, assignment.cmId);
      if (ctx) return ctx.id;
    }
    const courseCtx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.COURSE, assignment.course);
    if (!courseCtx) throw new NotFoundException({ message: `No context for assignment ${assignment.id}`, code: 'assign.context_missing' });
    return courseCtx.id;
  }
  private async requireCap(actorId: string, assignment: AssignmentRow, capability: string): Promise<void> {
    await this.evaluator.requireCapability(actorId, capability, await this.cmContextId(assignment));
  }
  private async hasCap(actorId: string, assignment: AssignmentRow, capability: string): Promise<boolean> {
    return this.evaluator.hasCapability(actorId, capability, await this.cmContextId(assignment));
  }

  private assignmentView(a: AssignmentRow): AssignmentView {
    return {
      id: a.id, courseId: a.course, cmId: a.cmId, name: a.name, intro: a.intro,
      dueDate: a.dueDate?.toISOString() ?? null,
      maxFiles: a.maxFiles, acceptedFileTypes: a.acceptedFileTypes, grade: a.grade,
    };
  }
  /** Nộp trễ: đã chốt nộp sau hạn nộp (khi bài có đặt hạn). */
  private isLate(a: AssignmentRow, s: AssignSubmissionRow | undefined): boolean {
    return !!a.dueDate && !!s?.submittedAt && s.submittedAt > a.dueDate;
  }
  /** Điểm thuộc đúng lần nộp hiện hành mới tính là đã chấm. */
  private currentGrade(s: AssignSubmissionRow | undefined, g: AssignGradeRow | undefined): AssignGradeRow | undefined {
    if (!s || !g) return undefined;
    return g.attemptNumber === s.attemptNumber ? g : undefined;
  }
  private gradeView(g: AssignGradeRow): AssignGradeView {
    return {
      grade: g.grade, feedback: g.feedback, graderId: g.graderId,
      gradedAt: g.updatedAt.toISOString(), attemptNumber: g.attemptNumber,
    };
  }
  /** Trạng thái hiển thị của một bài nộp: none | draft | submitted | graded. */
  private displayStatus(s: AssignSubmissionRow | undefined, g: AssignGradeRow | undefined): 'none' | 'draft' | 'submitted' | 'graded' {
    if (!s) return 'none';
    if (this.currentGrade(s, g)) return 'graded';
    return s.status === 'submitted' ? 'submitted' : 'draft';
  }
  /** View các tệp của bài nộp, kèm signed URL để client xem toàn màn (chỉ gọi sau khi đã kiểm quyền truy cập bài nộp). */
  private async submissionFilesView(submissionId: string, viewerId: string): Promise<AssignSubmissionFileView[]> {
    const links = await this.repo.listSubmissionFiles(submissionId);
    const out: AssignSubmissionFileView[] = [];
    for (const link of links) {
      const file = await this.files.getFile(link.fileId);
      const { url, expiresAt } = await this.files.createSignedUrl(file.id, viewerId);
      out.push({
        fileId: file.id, fileName: file.fileName, fileSize: file.fileSize,
        mimeType: file.mimeType, contentHash: file.contentHash,
        signedUrl: url, signedUrlExpiresAt: expiresAt,
      });
    }
    return out;
  }
  /** Bài nộp hiện hành của user; tạo bản nháp mới khi chưa có (chỉ đường ghi của học sinh). */
  private async getOrCreateDraft(userId: string, assignmentId: string): Promise<AssignSubmissionRow> {
    const existing = await this.repo.getSubmission(assignmentId, userId);
    if (existing) return existing;
    return this.repo.insertSubmission({ assignmentId, userId, status: 'draft', attemptNumber: 1 });
  }
  /** Chặn sửa bài nộp đã chấm (điểm khớp lần nộp hiện hành). */
  private async assertSubmissionEditable(userId: string, assignment: AssignmentRow, s: AssignSubmissionRow): Promise<void> {
    const g = await this.repo.getGrade(assignment.id, userId);
    if (this.currentGrade(s, g)) {
      throw new ConflictException({ message: 'Submission has been graded and is locked', code: 'assign.already_graded' });
    }
  }

  // --- CRUD bài tập ------------------------------------------------------------

  /**
   * Tạo bài tập: bản ghi assignment + course module (component mod_assign,
   * completion tự động theo điểm) + grade item 'mod' mang thang điểm của
   * bài. Quyền tạo hoạt động do CoursesService kiểm (course:manageactivities).
   */
  async createAssignment(actorId: string, courseId: string, input: {
    sectionId: string; name: string; intro?: string;
    dueDate?: string | null; maxFiles?: number; acceptedFileTypes?: string | null; grade?: number;
  }): Promise<AssignmentView> {
    await this.courses.getCourse(courseId);
    const dueDate = input.dueDate ? new Date(input.dueDate) : null;
    if (dueDate && Number.isNaN(dueDate.getTime())) {
      throw new BadRequestException({ message: 'dueDate must be an ISO datetime', code: 'assign.bad_due_date' });
    }
    const assignment = await this.repo.insertAssignment({
      course: courseId, cmId: null, name: input.name, intro: input.intro ?? '',
      dueDate, maxFiles: input.maxFiles ?? 10,
      acceptedFileTypes: input.acceptedFileTypes ?? null,
      grade: input.grade ?? 10,
    });
    try {
      const cm = await this.courses.createCm(actorId, courseId, {
        sectionId: input.sectionId, component: ASSIGN_COMPONENT, instanceId: assignment.id, name: input.name,
        completion: 2, completionUseGrade: true,
      });
      await this.repo.updateAssignment(assignment.id, { cmId: cm.id });
      await this.grades.createItem(actorId, courseId, {
        itemName: input.name, itemType: 'mod', cmId: cm.id, gradeMax: assignment.grade,
      });
    } catch (err) {
      // Dọn dẹp best-effort để không để lại bài tập mồ côi không có cm.
      await this.repo.deleteAssignment(assignment.id).catch(() => undefined);
      throw err;
    }
    await this.outbox.enqueueStandalone({ aggregate: 'assignment', type: 'assignment_created', payload: { assignmentId: assignment.id, courseId, actorId } });
    return this.assignmentView(await this.getAssignment(assignment.id));
  }

  /**
   * Sửa cài đặt bài tập (assign:manage); tên và thang điểm được đồng bộ
   * sang course module và grade item của hoạt động.
   */
  async updateAssignment(actorId: string, assignmentId: string, input: {
    name?: string; intro?: string;
    dueDate?: string | null; maxFiles?: number; acceptedFileTypes?: string | null; grade?: number;
  }): Promise<AssignmentView> {
    const assignment = await this.getAssignment(assignmentId);
    await this.requireCap(actorId, assignment, ASSIGN_CAPABILITIES.manage);
    const patch: Partial<AssignmentRow> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.intro !== undefined) patch.intro = input.intro;
    if (input.dueDate !== undefined) {
      patch.dueDate = input.dueDate ? new Date(input.dueDate) : null;
      if (patch.dueDate && Number.isNaN(patch.dueDate.getTime())) {
        throw new BadRequestException({ message: 'dueDate must be an ISO datetime', code: 'assign.bad_due_date' });
      }
    }
    if (input.maxFiles !== undefined) patch.maxFiles = input.maxFiles;
    if (input.acceptedFileTypes !== undefined) patch.acceptedFileTypes = input.acceptedFileTypes;
    if (input.grade !== undefined) patch.grade = input.grade;
    if (Object.keys(patch).length) await this.repo.updateAssignment(assignment.id, patch);
    const updated = await this.getAssignment(assignment.id);
    if (updated.cmId && input.name !== undefined) {
      await this.courses.updateCm(actorId, updated.cmId, { name: input.name });
    }
    if (updated.cmId && (input.grade !== undefined || input.name !== undefined)) {
      const item = await this.grades.getItemForCm(updated.course, updated.cmId);
      if (item) {
        await this.grades.updateItem(actorId, item.id, {
          ...(input.grade !== undefined ? { gradeMax: input.grade } : {}),
          ...(input.name !== undefined ? { itemName: input.name } : {}),
        });
      }
    }
    await this.outbox.enqueueStandalone({ aggregate: 'assignment', type: 'assignment_updated', payload: { assignmentId: assignment.id, courseId: assignment.course, actorId } });
    return this.assignmentView(updated);
  }

  /**
   * Xoá bài tập cùng bài nộp, tệp liên kết, điểm, course module và grade
   * item của hoạt động (assign:manage). Bản ghi files của bài nộp được
   * xoá qua FilesService để refcount/orphan-cleanup chạy đúng.
   */
  async deleteAssignment(actorId: string, assignmentId: string): Promise<void> {
    const assignment = await this.getAssignment(assignmentId);
    await this.requireCap(actorId, assignment, ASSIGN_CAPABILITIES.manage);
    const submissions = await this.repo.listSubmissions(assignment.id);
    for (const s of submissions) {
      const links = await this.repo.listSubmissionFiles(s.id);
      for (const link of links) await this.files.deleteFile(link.fileId).catch(() => undefined);
    }
    if (assignment.cmId) {
      const item = await this.grades.getItemForCm(assignment.course, assignment.cmId).catch(() => undefined);
      if (item) await this.grades.deleteItem(actorId, item.id).catch(() => undefined);
    }
    await this.repo.deleteAssignment(assignment.id);
    if (assignment.cmId) await this.courses.deleteCm(actorId, assignment.cmId);
    await this.outbox.enqueueStandalone({ aggregate: 'assignment', type: 'assignment_deleted', payload: { assignmentId: assignment.id, courseId: assignment.course, actorId } });
  }

  /** Các bài tập trong khoá học (cho trang khoá học/danh sách hoạt động). */
  async listAssignments(courseId: string): Promise<AssignmentView[]> {
    const rows = await this.repo.listAssignmentsInCourse(courseId);
    return rows.map((r) => this.assignmentView(r));
  }

  // --- View cho người dùng -------------------------------------------------------

  /**
   * View bài tập cho một người xem: cấu hình + bài nộp của chính mình +
   * cờ quyền tại context của module. Người xem phải có assign:view (học
   * sinh đã ghi danh hoặc vai giảng dạy tại khoá).
   */
  async getAssignmentForUser(actorId: string, assignmentId: string): Promise<AssignmentForUserView> {
    const assignment = await this.getAssignment(assignmentId);
    await this.requireCap(actorId, assignment, ASSIGN_CAPABILITIES.view);
    const [canSubmit, canManage, canGrade, canViewAll] = await Promise.all([
      this.hasCap(actorId, assignment, ASSIGN_CAPABILITIES.submit),
      this.hasCap(actorId, assignment, ASSIGN_CAPABILITIES.manage),
      this.hasCap(actorId, assignment, ASSIGN_CAPABILITIES.grade),
      this.hasCap(actorId, assignment, ASSIGN_CAPABILITIES.viewAllSubmissions),
    ]);
    const submission = await this.repo.getSubmission(assignment.id, actorId);
    const grade = await this.repo.getGrade(assignment.id, actorId);
    const current = this.currentGrade(submission, grade);
    return {
      assignment: this.assignmentView(assignment),
      mySubmission: {
        submissionId: submission?.id ?? null,
        status: this.displayStatus(submission, grade),
        attemptNumber: submission?.attemptNumber ?? 0,
        submittedAt: submission?.submittedAt?.toISOString() ?? null,
        late: this.isLate(assignment, submission),
        files: submission ? await this.submissionFilesView(submission.id, actorId) : [],
        grade: current ? this.gradeView(current) : null,
      },
      canSubmit, canManage, canGrade, canViewAllSubmissions: canViewAll,
    };
  }

  // --- Luồng nộp của học sinh ------------------------------------------------------

  /**
   * Tải một tệp vào bài nộp của chính mình (assign:submit). Bài nộp được
   * tạo dạng nháp khi chưa có; chỉ sửa được khi đang nháp và chưa bị
   * chấm. Nội dung đi qua FilesService (dedup + signed URL) với context
   * là context của course module, component 'mod_assign', file area
   * 'submission_files', item là bài nộp.
   */
  async uploadSubmissionFile(actorId: string, assignmentId: string, file: {
    fileName: string; data: Buffer; mimeType?: string;
  }): Promise<AssignSubmissionFileView> {
    const assignment = await this.getAssignment(assignmentId);
    await this.requireCap(actorId, assignment, ASSIGN_CAPABILITIES.submit);
    const submission = await this.getOrCreateDraft(actorId, assignment.id);
    await this.assertSubmissionEditable(actorId, assignment, submission);
    if (submission.status !== 'draft') {
      throw new ConflictException({ message: 'Submission is finalized; reopen it before changing files', code: 'assign.submission_finalized' });
    }
    if (assignment.acceptedFileTypes) {
      const allowed = assignment.acceptedFileTypes.split(',').map((t) => t.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
      const ext = file.fileName.includes('.') ? file.fileName.split('.').pop()!.toLowerCase() : '';
      if (!allowed.includes(ext)) {
        throw new BadRequestException({ message: `File type .${ext} is not accepted for this assignment`, code: 'assign.file_type_not_accepted' });
      }
    }
    const existing = await this.repo.listSubmissionFiles(submission.id);
    if (existing.length >= assignment.maxFiles) {
      throw new BadRequestException({ message: `A submission can hold at most ${assignment.maxFiles} files`, code: 'assign.too_many_files' });
    }
    const row = await this.files.upload({
      contextId: await this.cmContextId(assignment), component: ASSIGN_COMPONENT, fileArea: ASSIGN_FILE_AREA,
      itemId: submission.id, fileName: file.fileName, data: file.data, mimeType: file.mimeType, userId: actorId,
    });
    await this.repo.insertSubmissionFile({ submissionId: submission.id, fileId: row.id });
    const { url, expiresAt } = await this.files.createSignedUrl(row.id, actorId);
    return {
      fileId: row.id, fileName: row.fileName, fileSize: row.fileSize, mimeType: row.mimeType,
      contentHash: row.contentHash, signedUrl: url, signedUrlExpiresAt: expiresAt,
    };
  }

  /**
   * Gỡ một tệp khỏi bài nộp của chính mình (chỉ khi đang nháp, chưa bị
   * chấm); bản ghi files được xoá qua FilesService.
   */
  async removeSubmissionFile(actorId: string, assignmentId: string, fileId: string): Promise<void> {
    const assignment = await this.getAssignment(assignmentId);
    await this.requireCap(actorId, assignment, ASSIGN_CAPABILITIES.submit);
    const submission = await this.repo.getSubmission(assignment.id, actorId);
    if (!submission) throw new NotFoundException({ message: 'No submission to edit', code: 'assign.submission_not_found' });
    await this.assertSubmissionEditable(actorId, assignment, submission);
    if (submission.status !== 'draft') {
      throw new ConflictException({ message: 'Submission is finalized; reopen it before changing files', code: 'assign.submission_finalized' });
    }
    const links = await this.repo.listSubmissionFiles(submission.id);
    if (!links.some((l) => l.fileId === fileId)) {
      throw new NotFoundException({ message: `File ${fileId} is not part of this submission`, code: 'assign.submission_file_not_found' });
    }
    await this.repo.deleteSubmissionFile(submission.id, fileId);
    await this.files.deleteFile(fileId);
  }

  /**
   * Chốt nộp bài (assign:submit): bài nộp phải đang nháp và có ít nhất
   * một tệp. Nộp sau hạn vẫn được nhận nhưng đánh dấu trễ theo hạn nộp.
   */
  async submitSubmission(actorId: string, assignmentId: string): Promise<AssignmentForUserView> {
    const assignment = await this.getAssignment(assignmentId);
    await this.requireCap(actorId, assignment, ASSIGN_CAPABILITIES.submit);
    const submission = await this.repo.getSubmission(assignment.id, actorId);
    if (!submission) throw new NotFoundException({ message: 'No submission to submit', code: 'assign.submission_not_found' });
    await this.assertSubmissionEditable(actorId, assignment, submission);
    if (submission.status !== 'draft') {
      throw new ConflictException({ message: 'Submission has already been submitted', code: 'assign.already_submitted' });
    }
    const links = await this.repo.listSubmissionFiles(submission.id);
    if (links.length === 0) {
      throw new BadRequestException({ message: 'A submission needs at least one file', code: 'assign.submission_empty' });
    }
    const now = new Date();
    await this.repo.updateSubmission(submission.id, { status: 'submitted', submittedAt: now });
    await this.outbox.enqueueStandalone({
      aggregate: 'assignment', type: 'assignment_submitted',
      payload: { assignmentId: assignment.id, courseId: assignment.course, userId: actorId, attemptNumber: submission.attemptNumber, late: this.isLate(assignment, { ...submission, submittedAt: now }) },
    });
    return this.getAssignmentForUser(actorId, assignmentId);
  }

  /**
   * Mở lại bài đã nộp về nháp để sửa (chỉ khi chưa bị chấm): lần nộp sau
   * tăng attempt_number; submitted_at được giữ làm dấu vết lần nộp trước
   * cho tới khi nộp lại.
   */
  async reopenSubmission(actorId: string, assignmentId: string): Promise<AssignmentForUserView> {
    const assignment = await this.getAssignment(assignmentId);
    await this.requireCap(actorId, assignment, ASSIGN_CAPABILITIES.submit);
    const submission = await this.repo.getSubmission(assignment.id, actorId);
    if (!submission) throw new NotFoundException({ message: 'No submission to reopen', code: 'assign.submission_not_found' });
    await this.assertSubmissionEditable(actorId, assignment, submission);
    if (submission.status !== 'submitted') {
      throw new ConflictException({ message: 'Only a submitted submission can be reopened', code: 'assign.not_submitted' });
    }
    await this.repo.updateSubmission(submission.id, { status: 'draft', attemptNumber: submission.attemptNumber + 1 });
    return this.getAssignmentForUser(actorId, assignmentId);
  }

  // --- Luồng chấm của giáo viên ------------------------------------------------------

  /**
   * Danh sách bài nộp cho giáo viên (assign:viewallsubmissions hoặc
   * assign:grade): mọi học sinh đang ghi danh hiệu lực của khoá, kể cả
   * người chưa nộp (trạng thái none), kèm trạng thái theo hạn và điểm
   * hiện tại.
   */
  async listSubmissionsForTeacher(actorId: string, assignmentId: string): Promise<AssignSubmissionSummary[]> {
    const assignment = await this.getAssignment(assignmentId);
    const canViewAll = await this.hasCap(actorId, assignment, ASSIGN_CAPABILITIES.viewAllSubmissions);
    const canGrade = await this.hasCap(actorId, assignment, ASSIGN_CAPABILITIES.grade);
    if (!canViewAll && !canGrade) {
      await this.requireCap(actorId, assignment, ASSIGN_CAPABILITIES.viewAllSubmissions);
    }
    const enrolments = await this.enrol.listEnrolmentsForCourse(assignment.course);
    const enrolledIds = [...new Set(enrolments.filter((e) => e.status === 0).map((e) => e.userId))];
    const submissions = await this.repo.listSubmissions(assignment.id);
    const byUser = new Map(submissions.map((s) => [s.userId, s]));
    const grades = await this.repo.listGrades(assignment.id);
    const gradeByUser = new Map(grades.map((g) => [g.userId, g]));
    // Bài nộp của người không còn ghi danh vẫn hiện ở cuối danh sách để giáo viên xử lý nốt.
    for (const s of submissions) if (!enrolledIds.includes(s.userId)) enrolledIds.push(s.userId);
    const out: AssignSubmissionSummary[] = [];
    for (const userId of enrolledIds) {
      const s = byUser.get(userId);
      const g = gradeByUser.get(userId);
      const links = s ? await this.repo.listSubmissionFiles(s.id) : [];
      out.push({
        userId,
        status: this.displayStatus(s, g),
        attemptNumber: s?.attemptNumber ?? 0,
        submittedAt: s?.submittedAt?.toISOString() ?? null,
        late: this.isLate(assignment, s),
        fileCount: links.length,
        grade: this.currentGrade(s, g)?.grade ?? null,
        feedback: this.currentGrade(s, g)?.feedback ?? null,
      });
    }
    return out;
  }

  /**
   * Chi tiết một bài nộp cho giáo viên chấm (assign:viewallsubmissions
   * hoặc assign:grade): các tệp kèm signed URL xem toàn màn + điểm/lời
   * phê hiện tại.
   */
  async getSubmissionForTeacher(actorId: string, assignmentId: string, userId: string): Promise<AssignSubmissionDetail> {
    const assignment = await this.getAssignment(assignmentId);
    const canViewAll = await this.hasCap(actorId, assignment, ASSIGN_CAPABILITIES.viewAllSubmissions);
    const canGrade = await this.hasCap(actorId, assignment, ASSIGN_CAPABILITIES.grade);
    if (!canViewAll && !canGrade) {
      await this.requireCap(actorId, assignment, ASSIGN_CAPABILITIES.viewAllSubmissions);
    }
    const submission = await this.repo.getSubmission(assignment.id, userId);
    const grade = await this.repo.getGrade(assignment.id, userId);
    const current = this.currentGrade(submission, grade);
    return {
      userId,
      status: this.displayStatus(submission, grade),
      attemptNumber: submission?.attemptNumber ?? 0,
      submittedAt: submission?.submittedAt?.toISOString() ?? null,
      late: this.isLate(assignment, submission),
      files: submission ? await this.submissionFilesView(submission.id, actorId) : [],
      grade: current ? this.gradeView(current) : null,
    };
  }

  /**
   * Chấm một bài nộp (assign:grade): lưu điểm + lời phê vào
   * assign_grades và ghi điểm vào sổ điểm qua grade item của course
   * module — điểm chảy tiếp vào gradebook + completion (theo điểm) mà
   * giáo viên không phải nhập lần hai. Chỉ chấm được bài đã chốt nộp.
   */
  async gradeSubmission(actorId: string, assignmentId: string, userId: string, input: {
    grade: number; feedback?: string;
  }): Promise<AssignSubmissionDetail> {
    const assignment = await this.getAssignment(assignmentId);
    await this.requireCap(actorId, assignment, ASSIGN_CAPABILITIES.grade);
    if (input.grade < 0 || input.grade > assignment.grade) {
      throw new BadRequestException({ message: `Grade must be within [0, ${assignment.grade}]`, code: 'assign.grade_out_of_range' });
    }
    const submission = await this.repo.getSubmission(assignment.id, userId);
    if (!submission || submission.status !== 'submitted') {
      throw new ConflictException({ message: 'Only a submitted submission can be graded', code: 'assign.not_submitted' });
    }
    // Ghi sổ điểm trước: sổ từ chối (item bị khoá...) thì không lưu điểm ở tầng hoạt động.
    if (assignment.cmId) {
      const item = await this.grades.getItemForCm(assignment.course, assignment.cmId);
      if (item) await this.grades.recordActivityGrade(item.id, userId, input.grade, ASSIGN_COMPONENT);
    }
    await this.repo.upsertGrade({
      assignmentId: assignment.id, userId, graderId: actorId,
      attemptNumber: submission.attemptNumber, grade: input.grade, feedback: input.feedback ?? null,
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'assignment', type: 'assignment_graded',
      payload: { assignmentId: assignment.id, courseId: assignment.course, userId, graderId: actorId, grade: input.grade, attemptNumber: submission.attemptNumber },
    });
    return this.getSubmissionForTeacher(actorId, assignmentId, userId);
  }
}

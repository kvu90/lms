import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  AssignAnnotationView, AssignFeedbackMessageView, AssignGradeView, AssignRubricEvaluationInput,
  AssignRubricView, AssignSubmissionDetail, AssignSubmissionFileView, AssignSubmissionSummary,
  AssignmentForUserView, AssignmentView, TeacherCommentBankEntryView,
} from '@lms/contracts';
import { OutboxService } from '../../infra/events/outbox.service';
import { ContextsService } from '../access/contexts.service';
import { CONTEXT_LEVELS } from '../access/domain/capabilities';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CoursesService } from '../courses/courses.service';
import { EnrolService } from '../enrol/enrol.service';
import { FilesService } from '../files/files.service';
import { GradesService } from '../grades/grades.service';
import { UsersService } from '../users/users.service';
import {
  AssignmentsRepository, type AssignAnnotationRow, type AssignGradeRow, type AssignSubmissionRow, type AssignmentRow,
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
 * file/ảnh) — lát C2 của Đợt 3, đã hấp thụ hồ sơ "Chấm bài và phản hồi
 * theo năng lực GDPT 2018" (mục 6.1: C2-a..C2-e).
 *
 * Luồng nghiệp vụ: giáo viên tạo bài tập trong một section (kèm course
 * module + grade item 'mod' như mọi hoạt động); học sinh tải 1–nhiều
 * ảnh/tệp vào bài nộp nháp của mình (nội dung qua module Files: dedup
 * theo content hash, tải xuống bằng signed URL), chốt nộp trước/sau hạn
 * (sau hạn vẫn nhận, đánh dấu trễ).
 *
 * Chấm theo vòng đời TRẢ BÀI (Google Return / Canvas posting policy):
 * giáo viên chấm trên bề mặt bài nộp — dấu vector trên ảnh (đúng/sai/vẽ
 * tay/ghi chú), điểm hoặc mức Đạt/Chưa đạt theo chế độ kết quả của bài,
 * lời phê cấu trúc 3 ô TT 22 (tiến bộ / ưu điểm / hạn chế), kết quả
 * rubric neo YCCĐ — tất cả ở trạng thái NHÁP, học sinh chưa thấy và sổ
 * điểm chưa nhận. Bấm TRẢ BÀI (từng em hoặc theo đợt) mới công bố
 * nguyên tử: gói chấm hiện với học sinh, điểm ghi vào sổ điểm qua grade
 * item của course module (GradesService.recordActivityGrade, source
 * 'mod/assign') tại đúng thời điểm trả nên chảy vào gradebook +
 * completion (theo điểm như mod_quiz), kèm sự kiện thông báo. Sửa gói
 * chấm sau khi đã trả ghi vết kiểm toán (assign_grade_revisions).
 *
 * Máy trạng thái bài nộp: (chưa có) → draft → submitted → graded (khi
 * gói chấm khớp attempt_number hiện hành VÀ đã trả bài). Gói chấm còn
 * nháp thì học sinh mở lại được về draft để sửa (nộp lại tăng
 * attempt_number); đã trả bài thì khoá hẳn.
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
    private readonly users: UsersService,
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
      resultMode: a.resultMode as AssignmentView['resultMode'],
    };
  }
  /** Nộp trễ: đã chốt nộp sau hạn nộp (khi bài có đặt hạn). */
  private isLate(a: AssignmentRow, s: AssignSubmissionRow | undefined): boolean {
    return !!a.dueDate && !!s?.submittedAt && s.submittedAt > a.dueDate;
  }
  /** Gói chấm thuộc đúng lần nộp hiện hành mới tính cho bài nộp đó. */
  private currentGrade(s: AssignSubmissionRow | undefined, g: AssignGradeRow | undefined): AssignGradeRow | undefined {
    if (!s || !g) return undefined;
    return g.attemptNumber === s.attemptNumber ? g : undefined;
  }
  private gradeView(g: AssignGradeRow): AssignGradeView {
    return {
      grade: g.grade,
      level: (g.level as AssignGradeView['level']) ?? null,
      feedback: g.feedback,
      feedbackProgress: g.feedbackProgress,
      feedbackStrengths: g.feedbackStrengths,
      feedbackWeaknesses: g.feedbackWeaknesses,
      graderId: g.graderId,
      gradedAt: g.updatedAt.toISOString(), attemptNumber: g.attemptNumber,
      status: g.status as AssignGradeView['status'],
      releasedAt: g.releasedAt?.toISOString() ?? null,
    };
  }
  /** Trạng thái hiển thị phía học sinh: 'graded' CHỈ khi gói chấm đã trả bài (nháp chấm không lộ). */
  private displayStatus(s: AssignSubmissionRow | undefined, g: AssignGradeRow | undefined): 'none' | 'draft' | 'submitted' | 'graded' {
    if (!s) return 'none';
    const current = this.currentGrade(s, g);
    if (current && current.status === 'released') return 'graded';
    return s.status === 'submitted' ? 'submitted' : 'draft';
  }
  private annotationView(a: AssignAnnotationRow): AssignAnnotationView {
    return {
      id: a.id, submissionId: a.submissionId, fileId: a.fileId, page: a.page,
      x: a.x, y: a.y, kind: a.kind as AssignAnnotationView['kind'],
      color: a.color, text: a.text,
      points: (a.points as { x: number; y: number }[] | null) ?? null,
      authorId: a.authorId,
      createdAt: a.createdAt.toISOString(), updatedAt: a.updatedAt.toISOString(),
    };
  }
  private messageView(m: { id: string; authorId: string; body: string; createdAt: Date }): AssignFeedbackMessageView {
    return { id: m.id, authorId: m.authorId, body: m.body, createdAt: m.createdAt.toISOString() };
  }
  /** Kết quả theo tiêu chí của một gói chấm (cho view). */
  private async evaluationsView(gradeId: string) {
    const rows = await this.repo.listEvaluations(gradeId);
    return rows.map((r) => ({ criterionId: r.criterionId, levelId: r.levelId, score: r.score, note: r.note }));
  }
  /** Giá trị ghi sổ điểm của gói chấm: chế độ chỉ-mức ánh xạ Đạt → 1, Chưa đạt → 0 (grade item thang 1). */
  private gradebookValue(assignment: AssignmentRow, g: AssignGradeRow): number | null {
    if (assignment.resultMode === 'level') {
      return g.level ? (g.level === 'dat' ? 1 : 0) : null;
    }
    return g.grade;
  }
  /** Ghi điểm của gói chấm vào sổ điểm qua grade item của course module (chỉ gọi tại trả bài / sửa sau trả). */
  private async writeGradebook(assignment: AssignmentRow, userId: string, g: AssignGradeRow): Promise<void> {
    if (!assignment.cmId) return;
    const value = this.gradebookValue(assignment, g);
    if (value == null) return;
    const item = await this.grades.getItemForCm(assignment.course, assignment.cmId);
    if (item) await this.grades.recordActivityGrade(item.id, userId, value, 'mod/assign');
  }
  /** Gói chấm phải đầy đủ theo chế độ kết quả của bài mới trả bài được. */
  private assertGradeComplete(assignment: AssignmentRow, g: AssignGradeRow): void {
    if (assignment.resultMode === 'level') {
      if (!g.level) {
        throw new BadRequestException({ message: 'A level (Đạt/Chưa đạt) is required before returning this assignment', code: 'assign.grade_incomplete' });
      }
    } else if (g.grade == null) {
      throw new BadRequestException({ message: 'A grade is required before returning this assignment', code: 'assign.grade_incomplete' });
    }
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
  /** Chặn sửa bài nộp khi gói chấm của lần nộp hiện hành ĐÃ TRẢ BÀI (chấm nháp chưa khoá). */
  private async assertSubmissionEditable(userId: string, assignment: AssignmentRow, s: AssignSubmissionRow): Promise<void> {
    const g = await this.repo.getGrade(assignment.id, userId);
    const current = this.currentGrade(s, g);
    if (current && current.status === 'released') {
      throw new ConflictException({ message: 'Submission has been returned and is locked', code: 'assign.already_graded' });
    }
  }
  /** Quyền bề mặt chấm: assign:viewallsubmissions hoặc assign:grade. */
  private async requireTeacherSurface(actorId: string, assignment: AssignmentRow): Promise<void> {
    const canViewAll = await this.hasCap(actorId, assignment, ASSIGN_CAPABILITIES.viewAllSubmissions);
    const canGrade = await this.hasCap(actorId, assignment, ASSIGN_CAPABILITIES.grade);
    if (!canViewAll && !canGrade) {
      await this.requireCap(actorId, assignment, ASSIGN_CAPABILITIES.viewAllSubmissions);
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
    resultMode?: string;
  }): Promise<AssignmentView> {
    await this.courses.getCourse(courseId);
    const dueDate = input.dueDate ? new Date(input.dueDate) : null;
    if (dueDate && Number.isNaN(dueDate.getTime())) {
      throw new BadRequestException({ message: 'dueDate must be an ISO datetime', code: 'assign.bad_due_date' });
    }
    const resultMode = input.resultMode ?? 'score_feedback';
    const assignment = await this.repo.insertAssignment({
      course: courseId, cmId: null, name: input.name, intro: input.intro ?? '',
      dueDate, maxFiles: input.maxFiles ?? 10,
      acceptedFileTypes: input.acceptedFileTypes ?? null,
      grade: input.grade ?? 10, resultMode,
    });
    try {
      const cm = await this.courses.createCm(actorId, courseId, {
        sectionId: input.sectionId, component: ASSIGN_COMPONENT, instanceId: assignment.id, name: input.name,
        completion: 2, completionUseGrade: true,
      });
      await this.repo.updateAssignment(assignment.id, { cmId: cm.id });
      // Chế độ chỉ-mức: grade item thang 1, đạt tại 1 (Đạt → 1, Chưa đạt → 0 khi trả bài).
      await this.grades.createItem(actorId, courseId, {
        itemName: input.name, itemType: 'mod', cmId: cm.id,
        ...(resultMode === 'level' ? { gradeMax: 1, gradePass: 1 } : { gradeMax: assignment.grade }),
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
    resultMode?: string;
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
    if (input.resultMode !== undefined) patch.resultMode = input.resultMode;
    if (Object.keys(patch).length) await this.repo.updateAssignment(assignment.id, patch);
    const updated = await this.getAssignment(assignment.id);
    if (updated.cmId && input.name !== undefined) {
      await this.courses.updateCm(actorId, updated.cmId, { name: input.name });
    }
    if (updated.cmId && (input.grade !== undefined || input.name !== undefined || input.resultMode !== undefined)) {
      const item = await this.grades.getItemForCm(updated.course, updated.cmId);
      if (item) {
        await this.grades.updateItem(actorId, item.id, {
          ...(input.name !== undefined ? { itemName: input.name } : {}),
          // Đổi sang chế độ chỉ-mức thì grade item co về thang 1/đạt 1; đổi ra thì trả thang điểm của bài.
          ...(updated.resultMode === 'level'
            ? { gradeMax: 1, gradePass: 1 }
            : (input.grade !== undefined || input.resultMode !== undefined) ? { gradeMax: updated.grade, gradePass: 0 } : {}),
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

  /**
   * Các bài tập trong khoá học (cho trang khoá học/danh sách hoạt động).
   * H14 (rà soát #134): danh sách + cài đặt bài tập là cấu trúc theo khoá —
   * qua cổng truy cập khoá như các đường đọc nội dung theo khoá khác.
   */
  async listAssignments(actorId: string, courseId: string): Promise<AssignmentView[]> {
    await this.courses.assertCourseAccess(actorId, courseId);
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
    // Vòng đời trả bài: gói chấm chỉ hiện với học sinh khi ĐÃ TRẢ — nháp chấm ẩn hoàn toàn.
    const released = current && current.status === 'released' ? current : undefined;
    return {
      assignment: this.assignmentView(assignment),
      mySubmission: {
        submissionId: submission?.id ?? null,
        status: this.displayStatus(submission, grade),
        attemptNumber: submission?.attemptNumber ?? 0,
        submittedAt: submission?.submittedAt?.toISOString() ?? null,
        late: this.isLate(assignment, submission),
        files: submission ? await this.submissionFilesView(submission.id, actorId) : [],
        grade: released ? this.gradeView(released) : null,
        annotations: released && submission
          ? (await this.repo.listAnnotations(submission.id)).map((a) => this.annotationView(a))
          : [],
        rubricEvaluations: released ? await this.evaluationsView(released.id) : [],
        feedbackMessages: released
          ? (await this.repo.listMessages(released.id)).map((m) => this.messageView(m))
          : [],
      },
      rubric: await this.rubricView(assignment, canManage || canGrade),
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
    await this.requireTeacherSurface(actorId, assignment);
    const enrolments = await this.enrol.listEnrolmentsForCourse(assignment.course);
    const enrolledIds = [...new Set(enrolments.filter((e) => e.status === 0).map((e) => e.userId))];
    const submissions = await this.repo.listSubmissions(assignment.id);
    const byUser = new Map(submissions.map((s) => [s.userId, s]));
    const grades = await this.repo.listGrades(assignment.id);
    const gradeByUser = new Map(grades.map((g) => [g.userId, g]));
    // Bài nộp của người không còn ghi danh vẫn hiện ở cuối danh sách để giáo viên xử lý nốt.
    for (const s of submissions) if (!enrolledIds.includes(s.userId)) enrolledIds.push(s.userId);
    // Tên hiển thị cho bề mặt chấm (cùng khuôn quiz.service): họ tên, thiếu thì username.
    const nameById = new Map<string, string>();
    if (enrolledIds.length) {
      for (const u of await this.users.getUsersByIds(enrolledIds)) {
        const full = `${u.firstName} ${u.lastName}`.trim();
        nameById.set(u.id, full || u.username);
      }
    }
    const out: AssignSubmissionSummary[] = [];
    for (const userId of enrolledIds) {
      const s = byUser.get(userId);
      const g = gradeByUser.get(userId);
      const current = this.currentGrade(s, g);
      const links = s ? await this.repo.listSubmissionFiles(s.id) : [];
      out.push({
        userId,
        displayName: nameById.get(userId) ?? userId,
        status: this.displayStatus(s, g),
        attemptNumber: s?.attemptNumber ?? 0,
        submittedAt: s?.submittedAt?.toISOString() ?? null,
        late: this.isLate(assignment, s),
        fileCount: links.length,
        grade: current?.grade ?? null,
        level: (current?.level as AssignSubmissionSummary['level']) ?? null,
        feedback: current?.feedback ?? null,
        gradeStatus: !current ? 'none' : (current.status as 'draft' | 'released'),
      });
    }
    return out;
  }

  /**
   * Kết quả của MỘT bài tập cho giáo viên (issue #224 — bộ thống kê
   * Azota, cùng khuôn với quiz results): tham gia = số HS ghi danh đã
   * nộp so với tổng ghi danh + danh sách chưa nộp; điểm trung bình và
   * phổ điểm tính trên điểm đã chấm của bài (kể cả gói chấm đang nháp
   * chưa trả — đây là màn thống kê nội bộ của giáo viên); bảng điểm
   * từng HS chính là danh sách bài nộp của giáo viên.
   */
  async getResults(actorId: string, assignmentId: string): Promise<{
    assignment: AssignmentView;
    rows: AssignSubmissionSummary[];
    summary: {
      enrolledCount: number;
      submittedCount: number;
      notSubmittedStudents: { userId: string; displayName: string }[];
      gradedCount: number;
      averageGrade: number | null;
      gradeMax: number;
      distribution: { fromPct: number; toPct: number; count: number }[];
    };
  }> {
    const assignment = await this.getAssignment(assignmentId);
    const rows = await this.listSubmissionsForTeacher(actorId, assignmentId);
    const enrolments = await this.enrol.listEnrolmentsForCourse(assignment.course);
    const enrolledIds = new Set(enrolments.filter((e) => e.status === 0).map((e) => e.userId));
    const enrolledRows = rows.filter((r) => enrolledIds.has(r.userId));
    const notSubmittedStudents = enrolledRows
      .filter((r) => r.status === 'none' || r.status === 'draft')
      .map((r) => ({ userId: r.userId, displayName: r.displayName }));
    const gradedValues = rows.map((r) => r.grade).filter((g): g is number => g !== null);
    const gradeMax = assignment.grade;
    const distribution = Array.from({ length: 10 }, (_, i) => ({ fromPct: i * 10, toPct: (i + 1) * 10, count: 0 }));
    for (const g of gradedValues) {
      const pct = gradeMax > 0 ? (g / gradeMax) * 100 : 0;
      distribution[Math.min(9, Math.max(0, Math.floor(pct / 10)))]!.count += 1;
    }
    return {
      assignment: this.assignmentView(assignment),
      rows,
      summary: {
        enrolledCount: enrolledIds.size,
        submittedCount: enrolledRows.length - notSubmittedStudents.length,
        notSubmittedStudents,
        gradedCount: gradedValues.length,
        averageGrade: gradedValues.length ? gradedValues.reduce((a, b) => a + b, 0) / gradedValues.length : null,
        gradeMax,
        distribution,
      },
    };
  }

  /**
   * Chi tiết một bài nộp cho giáo viên chấm (assign:viewallsubmissions
   * hoặc assign:grade): các tệp kèm signed URL xem toàn màn + điểm/lời
   * phê hiện tại.
   */
  async getSubmissionForTeacher(actorId: string, assignmentId: string, userId: string): Promise<AssignSubmissionDetail> {
    const assignment = await this.getAssignment(assignmentId);
    await this.requireTeacherSurface(actorId, assignment);
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
      annotations: submission
        ? (await this.repo.listAnnotations(submission.id)).map((a) => this.annotationView(a))
        : [],
      rubricEvaluations: current ? await this.evaluationsView(current.id) : [],
      revisions: current
        ? (await this.repo.listRevisions(current.id)).map((r) => ({
          id: r.id, actorId: r.actorId, createdAt: r.createdAt.toISOString(),
          previousGrade: r.previousGrade, newGrade: r.newGrade,
          previousLevel: (r.previousLevel as AssignGradeView['level']) ?? null,
          newLevel: (r.newLevel as AssignGradeView['level']) ?? null,
        }))
        : [],
      feedbackMessages: current
        ? (await this.repo.listMessages(current.id)).map((m) => this.messageView(m))
        : [],
    };
  }

  /** Kiểm tra bộ kết quả theo tiêu chí gửi kèm thuộc đúng bảng chấm của bài và hợp lệ theo chế độ từng tiêu chí. */
  private async validateEvaluations(assignment: AssignmentRow, evaluations: AssignRubricEvaluationInput[]): Promise<void> {
    const rubric = await this.repo.getRubric(assignment.id);
    if (!rubric) {
      throw new BadRequestException({ message: 'This assignment has no rubric', code: 'assign.no_rubric' });
    }
    const criteria = await this.repo.listCriteria(rubric.id);
    const byId = new Map(criteria.map((c) => [c.id, c]));
    for (const ev of evaluations) {
      const c = byId.get(ev.criterionId);
      if (!c) {
        throw new BadRequestException({ message: `Criterion ${ev.criterionId} is not part of this assignment's rubric`, code: 'assign.bad_criterion' });
      }
      if (c.mode === 'levels') {
        if (!ev.levelId) {
          throw new BadRequestException({ message: `Criterion "${c.name}" needs a chosen level`, code: 'assign.bad_evaluation' });
        }
        const levels = await this.repo.listLevels(c.id);
        if (!levels.some((l) => l.id === ev.levelId)) {
          throw new BadRequestException({ message: `Level is not part of criterion "${c.name}"`, code: 'assign.bad_evaluation' });
        }
      } else if (ev.score != null && c.maxScore != null && ev.score > c.maxScore) {
        throw new BadRequestException({ message: `Score for criterion "${c.name}" exceeds its max ${c.maxScore}`, code: 'assign.bad_evaluation' });
      }
    }
  }

  /** Điểm suy từ rubric khi giáo viên chấm theo tiêu chí mà không nhập điểm tổng: tổng điểm tiêu chí quy về thang bài, làm tròn 0,1. */
  private async suggestGradeFromEvaluations(assignment: AssignmentRow, evaluations: AssignRubricEvaluationInput[]): Promise<number | null> {
    const rubric = await this.repo.getRubric(assignment.id);
    if (!rubric) return null;
    const criteria = await this.repo.listCriteria(rubric.id);
    let raw = 0;
    let max = 0;
    let any = false;
    for (const c of criteria) {
      const levels = await this.repo.listLevels(c.id);
      const cMax = c.mode === 'levels' ? Math.max(0, ...levels.map((l) => l.score)) : (c.maxScore ?? 0);
      max += cMax;
      const ev = evaluations.find((e) => e.criterionId === c.id);
      if (!ev) continue;
      any = true;
      if (c.mode === 'levels') raw += levels.find((l) => l.id === ev.levelId)?.score ?? 0;
      else raw += ev.score ?? 0;
    }
    if (!any || max <= 0) return null;
    return Math.round((raw / max) * assignment.grade * 10) / 10;
  }

  /**
   * LƯU gói chấm (assign:grade) — bản NHÁP theo vòng đời trả bài: điểm/
   * mức + lời phê cấu trúc + kết quả rubric được lưu vào assign_grades
   * nhưng CHƯA công bố (học sinh không thấy, sổ điểm chưa nhận). Chỉ
   * chấm được bài đã chốt nộp. Nếu gói chấm của lần nộp hiện hành ĐÃ TRẢ
   * thì lần lưu này là SỬA SAU TRẢ: ghi vết kiểm toán (giá trị trước →
   * sau), ghi lại sổ điểm ngay và phát sự kiện điểm thay đổi.
   */
  async gradeSubmission(actorId: string, assignmentId: string, userId: string, input: {
    grade?: number; level?: string | null; feedback?: string;
    feedbackProgress?: string | null; feedbackStrengths?: string | null; feedbackWeaknesses?: string | null;
    evaluations?: AssignRubricEvaluationInput[];
  }): Promise<AssignSubmissionDetail> {
    const assignment = await this.getAssignment(assignmentId);
    await this.requireCap(actorId, assignment, ASSIGN_CAPABILITIES.grade);
    const submission = await this.repo.getSubmission(assignment.id, userId);
    if (!submission || submission.status !== 'submitted') {
      throw new ConflictException({ message: 'Only a submitted submission can be graded', code: 'assign.not_submitted' });
    }
    const existing = await this.repo.getGrade(assignment.id, userId);
    const existingCurrent = this.currentGrade(submission, existing);
    if (input.evaluations) await this.validateEvaluations(assignment, input.evaluations);
    let grade = input.grade;
    if (grade === undefined && input.evaluations) {
      grade = (await this.suggestGradeFromEvaluations(assignment, input.evaluations)) ?? undefined;
    }
    if (grade !== undefined && (grade < 0 || grade > assignment.grade)) {
      throw new BadRequestException({ message: `Grade must be within [0, ${assignment.grade}]`, code: 'assign.grade_out_of_range' });
    }
    const isPostReleaseEdit = !!existingCurrent && existingCurrent.status === 'released';
    const next = {
      grade: grade !== undefined ? grade : (existingCurrent?.grade ?? null),
      level: input.level !== undefined ? input.level : (existingCurrent?.level ?? null),
      feedback: input.feedback !== undefined ? input.feedback : (existingCurrent?.feedback ?? null),
      feedbackProgress: input.feedbackProgress !== undefined ? input.feedbackProgress : (existingCurrent?.feedbackProgress ?? null),
      feedbackStrengths: input.feedbackStrengths !== undefined ? input.feedbackStrengths : (existingCurrent?.feedbackStrengths ?? null),
      feedbackWeaknesses: input.feedbackWeaknesses !== undefined ? input.feedbackWeaknesses : (existingCurrent?.feedbackWeaknesses ?? null),
    };
    if (isPostReleaseEdit && existingCurrent) {
      await this.repo.insertRevision({
        gradeId: existingCurrent.id, actorId,
        previousGrade: existingCurrent.grade, newGrade: next.grade,
        previousLevel: existingCurrent.level, newLevel: next.level,
        previousFeedback: existingCurrent.feedback, newFeedback: next.feedback,
      });
    }
    const saved = await this.repo.upsertGrade({
      assignmentId: assignment.id, userId, graderId: actorId,
      attemptNumber: submission.attemptNumber, ...next,
      status: existingCurrent?.status ?? 'draft',
      releasedAt: existingCurrent?.releasedAt ?? null,
      releasedBy: existingCurrent?.releasedBy ?? null,
    });
    if (input.evaluations) {
      await this.repo.deleteEvaluations(saved.id);
      for (const ev of input.evaluations) {
        await this.repo.upsertEvaluation({
          gradeId: saved.id, criterionId: ev.criterionId,
          levelId: ev.levelId ?? null, score: ev.score ?? null, note: ev.note ?? null,
        });
      }
    }
    if (isPostReleaseEdit) {
      await this.writeGradebook(assignment, userId, saved);
      await this.outbox.enqueueStandalone({
        aggregate: 'assignment', type: 'assignment_grade_changed',
        payload: { assignmentId: assignment.id, courseId: assignment.course, userId, graderId: actorId, grade: saved.grade, level: saved.level, attemptNumber: saved.attemptNumber },
      });
    } else {
      await this.outbox.enqueueStandalone({
        aggregate: 'assignment', type: 'assignment_grading_saved',
        payload: { assignmentId: assignment.id, courseId: assignment.course, userId, graderId: actorId, draft: true, attemptNumber: submission.attemptNumber },
      });
    }
    return this.getSubmissionForTeacher(actorId, assignmentId, userId);
  }

  /**
   * TRẢ BÀI cho một học sinh (assign:grade): công bố nguyên tử gói chấm
   * nháp của lần nộp hiện hành — điểm/mức + lời phê + annotation + kết
   * quả rubric cùng hiện với học sinh, điểm ghi vào sổ điểm tại đúng
   * thời điểm này, kèm sự kiện để tầng thông báo báo cho học sinh.
   */
  async releaseSubmission(actorId: string, assignmentId: string, userId: string): Promise<AssignSubmissionDetail> {
    const assignment = await this.getAssignment(assignmentId);
    await this.requireCap(actorId, assignment, ASSIGN_CAPABILITIES.grade);
    await this.releaseOne(actorId, assignment, userId, true);
    return this.getSubmissionForTeacher(actorId, assignmentId, userId);
  }

  /**
   * TRẢ BÀI theo đợt (assign:grade): trả mọi gói chấm nháp đã đầy đủ
   * (hoặc chỉ các học sinh được liệt kê); gói chấm chưa đầy đủ/chưa chấm
   * bị bỏ qua và được kê trong kết quả để giáo viên xử lý tiếp.
   */
  async releaseBatch(actorId: string, assignmentId: string, userIds?: string[]): Promise<{ releasedCount: number; skippedUserIds: string[] }> {
    const assignment = await this.getAssignment(assignmentId);
    await this.requireCap(actorId, assignment, ASSIGN_CAPABILITIES.grade);
    const targets = userIds ?? (await this.repo.listGrades(assignment.id))
      .filter((g) => g.status === 'draft')
      .map((g) => g.userId);
    let releasedCount = 0;
    const skippedUserIds: string[] = [];
    for (const uid of [...new Set(targets)]) {
      if (await this.releaseOne(actorId, assignment, uid, false)) releasedCount += 1;
      else skippedUserIds.push(uid);
    }
    return { releasedCount, skippedUserIds };
  }

  /** Trả bài cho một học sinh; strict=true thì ném lỗi rõ lý do, ngược lại trả false để đợt bỏ qua. */
  private async releaseOne(actorId: string, assignment: AssignmentRow, userId: string, strict: boolean): Promise<boolean> {
    const submission = await this.repo.getSubmission(assignment.id, userId);
    const gradeRow = submission ? await this.repo.getGrade(assignment.id, userId) : undefined;
    const current = this.currentGrade(submission, gradeRow);
    if (!current) {
      if (strict) throw new ConflictException({ message: 'There is no grading draft to return for this submission', code: 'assign.nothing_to_release' });
      return false;
    }
    if (current.status === 'released') {
      if (strict) throw new ConflictException({ message: 'This submission has already been returned', code: 'assign.already_released' });
      return false;
    }
    try {
      this.assertGradeComplete(assignment, current);
    } catch (err) {
      if (strict) throw err;
      return false;
    }
    // Ghi sổ điểm trước khi công bố: sổ từ chối thì bài chưa coi là đã trả.
    await this.writeGradebook(assignment, userId, current);
    await this.repo.updateGrade(current.id, { status: 'released', releasedAt: new Date(), releasedBy: actorId });
    const payload = {
      assignmentId: assignment.id, courseId: assignment.course, userId, graderId: actorId,
      grade: current.grade, level: current.level, attemptNumber: current.attemptNumber,
    };
    await this.outbox.enqueueStandalone({ aggregate: 'assignment', type: 'assignment_returned', payload });
    await this.outbox.enqueueStandalone({ aggregate: 'assignment', type: 'assignment_graded', payload: { ...payload, released: true } });
    return true;
  }

  // --- Annotation vector trên bề mặt bài nộp --------------------------------

  /**
   * Thả một dấu chấm vector lên tệp của bài nộp (assign:grade) — chạm
   * đúng/sai tại vị trí, vẽ tay, ghim ghi chú... Dấu thuộc gói chấm:
   * học sinh chỉ thấy sau khi trả bài.
   */
  async createAnnotation(actorId: string, assignmentId: string, userId: string, input: {
    fileId: string; page?: number; x: number; y: number; kind: string;
    color?: string | null; text?: string | null; points?: { x: number; y: number }[] | null;
  }): Promise<AssignAnnotationView> {
    const assignment = await this.getAssignment(assignmentId);
    await this.requireCap(actorId, assignment, ASSIGN_CAPABILITIES.grade);
    const submission = await this.repo.getSubmission(assignment.id, userId);
    if (!submission) throw new NotFoundException({ message: 'No submission to annotate', code: 'assign.submission_not_found' });
    const links = await this.repo.listSubmissionFiles(submission.id);
    if (!links.some((l) => l.fileId === input.fileId)) {
      throw new BadRequestException({ message: 'fileId is not part of this submission', code: 'assign.annotation_file_mismatch' });
    }
    if (input.kind === 'note' && !input.text) {
      throw new BadRequestException({ message: 'A note annotation needs text', code: 'assign.annotation_text_required' });
    }
    if (input.kind === 'draw' && (!input.points || input.points.length === 0)) {
      throw new BadRequestException({ message: 'A draw annotation needs stroke points', code: 'assign.annotation_points_required' });
    }
    const row = await this.repo.insertAnnotation({
      submissionId: submission.id, fileId: input.fileId, page: input.page ?? 1,
      x: input.x, y: input.y, kind: input.kind,
      color: input.color ?? null, text: input.text ?? null, points: input.points ?? null,
      authorId: actorId,
    });
    return this.annotationView(row);
  }

  /** Các dấu chấm trên bài nộp của một học sinh (bề mặt chấm của giáo viên). */
  async listAnnotationsForTeacher(actorId: string, assignmentId: string, userId: string): Promise<AssignAnnotationView[]> {
    const assignment = await this.getAssignment(assignmentId);
    await this.requireTeacherSurface(actorId, assignment);
    const submission = await this.repo.getSubmission(assignment.id, userId);
    if (!submission) return [];
    return (await this.repo.listAnnotations(submission.id)).map((a) => this.annotationView(a));
  }

  /** Sửa một dấu chấm (dời vị trí/đổi nội dung) — assign:grade. */
  async updateAnnotation(actorId: string, assignmentId: string, userId: string, annotationId: string, input: {
    page?: number; x?: number; y?: number;
    color?: string | null; text?: string | null; points?: { x: number; y: number }[] | null;
  }): Promise<AssignAnnotationView> {
    const assignment = await this.getAssignment(assignmentId);
    await this.requireCap(actorId, assignment, ASSIGN_CAPABILITIES.grade);
    const annotation = await this.getOwnedAnnotation(assignment.id, userId, annotationId);
    const patch: Partial<AssignAnnotationRow> = {};
    if (input.page !== undefined) patch.page = input.page;
    if (input.x !== undefined) patch.x = input.x;
    if (input.y !== undefined) patch.y = input.y;
    if (input.color !== undefined) patch.color = input.color;
    if (input.text !== undefined) patch.text = input.text;
    if (input.points !== undefined) patch.points = input.points;
    if (Object.keys(patch).length) await this.repo.updateAnnotation(annotation.id, patch);
    const updated = await this.repo.getAnnotation(annotation.id);
    return this.annotationView(updated!);
  }

  /** Xoá một dấu chấm — assign:grade. */
  async deleteAnnotation(actorId: string, assignmentId: string, userId: string, annotationId: string): Promise<void> {
    const assignment = await this.getAssignment(assignmentId);
    await this.requireCap(actorId, assignment, ASSIGN_CAPABILITIES.grade);
    const annotation = await this.getOwnedAnnotation(assignment.id, userId, annotationId);
    await this.repo.deleteAnnotation(annotation.id);
  }

  /** Dấu chấm phải thuộc đúng bài nộp của (bài tập, học sinh) đang xét. */
  private async getOwnedAnnotation(assignmentId: string, userId: string, annotationId: string): Promise<AssignAnnotationRow> {
    const submission = await this.repo.getSubmission(assignmentId, userId);
    const annotation = await this.repo.getAnnotation(annotationId);
    if (!submission || !annotation || annotation.submissionId !== submission.id) {
      throw new NotFoundException({ message: `Annotation ${annotationId} not found`, code: 'assign.annotation_not_found' });
    }
    return annotation;
  }

  // --- Bảng chấm (rubric / marking guide) -------------------------------------

  /** View bảng chấm của bài; mô tả dành cho người chấm chỉ hiện với vai quản lý/chấm. */
  private async rubricView(assignment: AssignmentRow, includeGraderNotes: boolean): Promise<AssignRubricView | null> {
    const rubric = await this.repo.getRubric(assignment.id);
    if (!rubric) return null;
    const criteria = await this.repo.listCriteria(rubric.id);
    const out: AssignRubricView['criteria'] = [];
    for (const c of criteria) {
      const levels = await this.repo.listLevels(c.id);
      out.push({
        id: c.id, name: c.name,
        descriptionForStudent: c.descriptionForStudent,
        descriptionForGrader: includeGraderNotes ? c.descriptionForGrader : null,
        mode: c.mode as 'levels' | 'score', maxScore: c.maxScore,
        outcomeId: c.outcomeId, outcomeText: c.outcomeText,
        levels: levels.map((l) => ({ id: l.id, label: l.label, score: l.score })),
      });
    }
    return { id: rubric.id, assignmentId: rubric.assignmentId, title: rubric.title, criteria: out };
  }

  /** Bảng chấm của bài cho người xem có assign:view (học sinh thấy bản công khai trước khi nộp). */
  async getRubric(actorId: string, assignmentId: string): Promise<AssignRubricView | null> {
    const assignment = await this.getAssignment(assignmentId);
    await this.requireCap(actorId, assignment, ASSIGN_CAPABILITIES.view);
    const privileged = (await this.hasCap(actorId, assignment, ASSIGN_CAPABILITIES.manage))
      || (await this.hasCap(actorId, assignment, ASSIGN_CAPABILITIES.grade));
    return this.rubricView(assignment, privileged);
  }

  /**
   * Dựng/cập nhật bảng chấm của bài (assign:manage; thay toàn bộ). Tiêu
   * chí phải tồn tại TRƯỚC khi chấm (TT 22 Điều 7): bảng chấm bị khoá
   * ngay khi đã có gói chấm được trả bài, vì tiêu chí là căn cứ của kết
   * quả đã công bố.
   */
  async upsertRubric(actorId: string, assignmentId: string, input: {
    title?: string | null;
    criteria: {
      name: string; descriptionForStudent?: string | null; descriptionForGrader?: string | null;
      mode: string; maxScore?: number | null;
      outcomeId?: string | null; outcomeText?: string | null;
      levels?: { label: string; score: number }[];
    }[];
  }): Promise<AssignRubricView> {
    const assignment = await this.getAssignment(assignmentId);
    await this.requireCap(actorId, assignment, ASSIGN_CAPABILITIES.manage);
    const grades = await this.repo.listGrades(assignment.id);
    if (grades.some((g) => g.status === 'released')) {
      throw new ConflictException({ message: 'The rubric cannot change after grades have been returned', code: 'assign.rubric_locked' });
    }
    for (const c of input.criteria) {
      if (c.mode === 'levels' && (!c.levels || c.levels.length === 0)) {
        throw new BadRequestException({ message: `Criterion "${c.name}" (levels mode) needs at least one level`, code: 'assign.rubric_levels_required' });
      }
      if (c.mode === 'score' && (c.maxScore == null || c.maxScore <= 0)) {
        throw new BadRequestException({ message: `Criterion "${c.name}" (score mode) needs a positive maxScore`, code: 'assign.rubric_max_score_required' });
      }
    }
    await this.repo.deleteRubricByAssignment(assignment.id);
    const rubric = await this.repo.insertRubric({ assignmentId: assignment.id, title: input.title ?? null });
    let order = 0;
    for (const c of input.criteria) {
      const criterion = await this.repo.insertCriterion({
        rubricId: rubric.id, name: c.name,
        descriptionForStudent: c.descriptionForStudent ?? null,
        descriptionForGrader: c.descriptionForGrader ?? null,
        mode: c.mode, maxScore: c.mode === 'score' ? (c.maxScore ?? null) : null,
        outcomeId: c.outcomeId ?? null, outcomeText: c.outcomeText ?? null,
        sortOrder: order++,
      });
      let levelOrder = 0;
      for (const l of c.levels ?? []) {
        await this.repo.insertLevel({ criterionId: criterion.id, label: l.label, score: l.score, sortOrder: levelOrder++ });
      }
    }
    const view = await this.rubricView(assignment, true);
    return view!;
  }

  // --- Hội thoại phản hồi trên bài đã trả ---------------------------------------

  /** Hội thoại phản hồi của một bài nộp: chỉ tồn tại sau khi trả bài; học sinh chỉ xem hội thoại của chính mình. */
  async listFeedbackMessages(actorId: string, assignmentId: string, userId: string): Promise<AssignFeedbackMessageView[]> {
    const assignment = await this.getAssignment(assignmentId);
    if (actorId === userId) await this.requireCap(actorId, assignment, ASSIGN_CAPABILITIES.view);
    else await this.requireTeacherSurface(actorId, assignment);
    const submission = await this.repo.getSubmission(assignment.id, userId);
    const gradeRow = await this.repo.getGrade(assignment.id, userId);
    const current = this.currentGrade(submission, gradeRow);
    if (!current || current.status !== 'released') return [];
    return (await this.repo.listMessages(current.id)).map((m) => this.messageView(m));
  }

  /**
   * Gửi một tin nhắn vào hội thoại phản hồi (học sinh trả lời lại trên
   * bài đã trả, hoặc giáo viên trao đổi tiếp) — hội thoại chỉ mở SAU khi
   * trả bài.
   */
  async postFeedbackMessage(actorId: string, assignmentId: string, userId: string, body: string): Promise<AssignFeedbackMessageView> {
    const assignment = await this.getAssignment(assignmentId);
    if (actorId === userId) await this.requireCap(actorId, assignment, ASSIGN_CAPABILITIES.view);
    else await this.requireCap(actorId, assignment, ASSIGN_CAPABILITIES.grade);
    const submission = await this.repo.getSubmission(assignment.id, userId);
    const gradeRow = await this.repo.getGrade(assignment.id, userId);
    const current = this.currentGrade(submission, gradeRow);
    if (!current || current.status !== 'released') {
      throw new ConflictException({ message: 'The feedback conversation opens after the work is returned', code: 'assign.not_released' });
    }
    const row = await this.repo.insertMessage({ gradeId: current.id, authorId: actorId, body });
    await this.outbox.enqueueStandalone({
      aggregate: 'assignment', type: 'assignment_feedback_message',
      payload: { assignmentId: assignment.id, courseId: assignment.course, userId, authorId: actorId },
    });
    return this.messageView(row);
  }

  // --- Ngân hàng lời phê cá nhân của giáo viên ---------------------------------

  private commentBankView(r: { id: string; category: string | null; text: string; createdAt: Date }): TeacherCommentBankEntryView {
    return {
      id: r.id,
      category: (r.category as TeacherCommentBankEntryView['category']) ?? null,
      text: r.text, createdAt: r.createdAt.toISOString(),
    };
  }

  /** Ngân hàng lời phê của chính giáo viên đang đăng nhập (phạm vi cá nhân). */
  async listMyCommentBank(actorId: string): Promise<TeacherCommentBankEntryView[]> {
    return (await this.repo.listCommentBank(actorId)).map((r) => this.commentBankView(r));
  }

  /** Thêm một câu vào ngân hàng lời phê cá nhân (kể cả lưu nhanh từ câu vừa gõ khi chấm). */
  async addCommentBankEntry(actorId: string, input: { text: string; category?: string | null }): Promise<TeacherCommentBankEntryView> {
    const row = await this.repo.insertCommentBankEntry({ ownerId: actorId, category: input.category ?? null, text: input.text });
    return this.commentBankView(row);
  }

  /** Xoá một câu khỏi ngân hàng lời phê cá nhân. */
  async deleteCommentBankEntry(actorId: string, entryId: string): Promise<void> {
    await this.repo.deleteCommentBankEntry(entryId, actorId);
  }
}

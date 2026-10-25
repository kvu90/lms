import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { OutboxService } from '../../infra/events/outbox.service';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CoursesService } from '../courses/courses.service';
import { CurriculumService } from '../curriculum/curriculum.service';
import {
  classifyLearningLevel, computeDtbCn, computeDtbHk, convertGradeToScale10, dgtxQuotaForPeriods, isCommentOnlySubjectName,
  round1, VN_COMMENT_EVALUATIONS_PER_TERM, type VnAssessmentMode, type VnClassification, type VnCommentResult,
  type VnSubjectLevelInput, type VnTerm,
} from './domain/vn-gradebook';
import { GradesService } from './grades.service';
import {
  GradesRepository, type GradeRow, type ItemRow, type VnActivityMappingRow, type VnBookRow,
  type VnCandidateActionRow, type VnTermResultRow,
} from './grades.repository';

/** Sổ VN kèm các cột điểm của nó (môn nhận xét không có cột điểm). */
export interface VnBookView {
  book: VnBookRow;
  items: ItemRow[];
}

/** Trạng thái một cột của một học sinh: đã có điểm / GV đánh dấu chờ kiểm tra bù (Điều 7.4) / chưa có điểm. */
export type VnColumnStatus = 'graded' | 'awaiting_makeup' | 'missing';

/** Một cột điểm trong lần tính kết quả: vai trò + thứ tự + điểm hiện có (null = chưa có điểm) + trạng thái kiểm tra bù. */
export interface VnColumnScore {
  itemId: string;
  role: string;
  ordinal: number | null;
  grade: number | null;
  status: VnColumnStatus;
}

/** Kết quả học kì tính trực tiếp từ điểm cột hiện tại (chưa chốt): đủ cột mới có ĐTBmhk. */
export interface VnTermComputation {
  bookId: string;
  userId: string;
  complete: boolean;
  missingRoles: string[];
  /** Các vai trò cột đang ở trạng thái chờ kiểm tra bù (GB-VN-2) — chốt sổ bị chặn riêng khi danh sách này không rỗng. */
  awaitingMakeupRoles: string[];
  columns: VnColumnScore[];
  dtbHk: number | null;
}

/** Khai vai trò điểm của hoạt động vào sổ, kèm mô tả hoạt động nguồn và cột đích để truy vết về bài làm. */
export interface VnActivityMappingView {
  id: string;
  courseId: string;
  bookId: string;
  cmId: string;
  itemId: string;
  targetItemId: string;
  role: string;
  ordinal: number | null;
  activityName: string;
  component: string | null;
  targetRole: string | null;
  targetOrdinal: number | null;
  createdBy: string | null;
  createdAt: Date;
}

/** Trạng thái quyết định của giáo viên trên một ứng viên điểm. */
export type VnCandidateState = 'pending' | 'committed' | 'dismissed';

/** Một ứng viên điểm trong hộp ứng viên của sổ (GB-VN-2): điểm hoạt động + giá trị quy đổi thang 10 + quyết định đã ghi. */
export interface VnCandidateView {
  mappingId: string;
  userId: string;
  cmId: string;
  component: string | null;
  activityName: string;
  sourceItemId: string;
  targetItemId: string;
  targetRole: string | null;
  targetOrdinal: number | null;
  activityGrade: number;
  activityGradeMin: number;
  activityGradeMax: number;
  convertedGrade: number;
  state: VnCandidateState;
  /** Đã từng có quyết định nhưng điểm hoạt động đã đổi sau đó — ứng viên chờ quyết lại. */
  activityGradeChanged: boolean;
  committedValue: number | null;
  decidedBy: string | null;
  decidedAt: Date | null;
}

/** Trạng thái một cột của một học sinh sau thao tác kiểm tra bù / ghi 0 điểm (GB-VN-2). */
export interface VnColumnStatusView {
  itemId: string;
  userId: string;
  role: string | null;
  grade: number | null;
  status: VnColumnStatus;
}

/** Xếp mức chung của một học sinh trong một kì (hoặc cả năm) theo Điều 9, kèm các môn đầu vào để truy vết. */
export interface VnStudentClassification extends VnClassification {
  userId: string;
  period: VnTerm | 'year';
  subjects: VnSubjectLevelInput[];
}

/** Một học kì trong bề mặt "kết quả của tôi" (issue #180): chưa công bố thì bookId + mọi số đều null. */
export interface MyVnTermResultView {
  bookId: string | null;
  term: VnTerm;
  assessmentMode: VnAssessmentMode;
  published: boolean;
  dtbHk: number | null;
  commentResult: string | null;
  comment: string | null;
  awaitingMakeup: boolean;
}

/** Bề mặt "kết quả của tôi" của chính học sinh trong một khoá (issue #180) — hình dạng khớp contracts MyVnCourseResultsView. */
export interface MyVnCourseResultsView {
  courseId: string;
  terms: MyVnTermResultView[];
  year: { published: boolean; dtbYear: number | null; comment: string | null } | null;
  levels: { hk1: string | null; hk2: string | null; year: string | null };
}

/**
 * Nghiệp vụ sổ điểm VN (GB-VN-1, issue #95) — lớp preset TT 22 trên gradebook
 * engine: sổ tự sinh cột theo quota số tiết vào một category weightedmean
 * (hệ số 1/2/3), ĐTB tính ở tầng service theo đúng Điều 9 (dùng ĐTBmhk đã làm
 * tròn để tính ĐTBmcn) và chốt thành bản snapshot trong vn_term_results.
 * Điểm từ hoạt động online KHÔNG tự chảy vào cột: chúng chỉ là ứng viên và
 * giáo viên là người chốt (GB-VN-2 — khai vai trò, hộp ứng viên, quyết định
 * lưu vết, trạng thái kiểm tra bù Điều 7.4–7.5); chuyên cần/tiến độ không
 * bao giờ cộng vào ĐTB (kết luận kiểm chứng âm từ TT 22/TT 27).
 */
@Injectable()
export class VnGradebooksService {
  constructor(
    private readonly repo: GradesRepository,
    private readonly grades: GradesService,
    private readonly courses: CoursesService,
    private readonly evaluator: PermissionEvaluator,
    private readonly contexts: ContextsService,
    private readonly curriculum: CurriculumService,
    private readonly outbox: OutboxService,
  ) {}

  private async requireCap(actorId: string, capability: string, courseId: string): Promise<void> {
    await this.evaluator.requireCapability(actorId, capability, await this.courses.courseContextId(courseId));
  }

  /**
   * Cổng đọc dữ liệu điểm của MỘT học sinh trong một khoá (kết quả tính trực
   * tiếp, bản chốt kì, bản chốt năm) — đúng tiền lệ GradesService.getGradebook:
   * chính chủ thì phải truy cập được khoá (assertCourseAccess); người khác
   * phải có grade:viewall tại context khoá (requireCapability ném 403
   * access.capability_denied — cùng cơ chế getReport/history). Vá lỗ hổng rò
   * điểm phát hiện khi probe live v85 (issue #95): trước đây các hàm đọc này
   * không nhận actor nên học sinh đọc được điểm của nhau chỉ với bookId+userId.
   */
  private async assertCanReadStudentResult(actorId: string, courseId: string, userId: string): Promise<void> {
    if (actorId === userId) {
      await this.courses.assertCourseAccess(actorId, courseId);
      return;
    }
    await this.requireCap(actorId, 'grade:viewall', courseId);
  }

  // --- Công bố kết quả VN (PH-0, issue #116) --------------------------------
  // Finalize/setCommentResult của GB-VN-1/2 chỉ là CHỐT NỘI BỘ của giáo
  // viên; kết quả chỉ tới tay học sinh/phụ huynh khi giáo viên CÔNG BỐ
  // (TT 22 Đ.20.2/20.6: xác nhận xong mới thông báo riêng). Trạng thái hiệu
  // lực suy từ vết mới nhất trong grade_publications theo đúng phạm vi.

  /** Kết quả kì của một học sinh trong một sổ đã được công bố chưa. */
  async isTermResultPublished(book: VnBookRow, userId: string): Promise<boolean> {
    const publications = await this.repo.listPublications(book.courseId);
    let latest: string | null = null;
    for (const p of publications) {
      if (p.scope === 'vn_term' && p.bookId === book.id && p.userId === userId) latest = p.action;
    }
    return latest === 'publish';
  }

  /** Kết quả cả năm của một học sinh trong một khoá đã được công bố chưa. */
  async isYearResultPublished(courseId: string, userId: string): Promise<boolean> {
    const publications = await this.repo.listPublications(courseId);
    let latest: string | null = null;
    for (const p of publications) {
      if (p.scope === 'vn_year' && p.userId === userId) latest = p.action;
    }
    return latest === 'publish';
  }

  /** Cổng công bố cho đường đọc của CHÍNH CHỦ: chưa công bố → 403 mã riêng để client hiển thị "chưa công bố" thay vì điểm. */
  private async assertTermPublishedForSelf(actorId: string, book: VnBookRow, userId: string): Promise<void> {
    if (actorId !== userId) return;
    if (!(await this.isTermResultPublished(book, userId))) {
      throw new ForbiddenException({ message: 'Term result has not been published yet', code: 'grades.vn_result_not_published' });
    }
  }

  /** Công bố / rút công bố kết quả học kì của một học sinh trong một sổ (grade:publish tại context khoá); ghi vết grade_publications + event_log qua outbox. */
  async setTermResultPublication(actorId: string, bookId: string, userId: string, action: 'publish' | 'unpublish', note?: string): Promise<{ published: boolean }> {
    const book = await this.getBook(bookId);
    await this.requireCap(actorId, 'grade:publish', book.courseId);
    await this.repo.insertPublication({
      courseId: book.courseId, scope: 'vn_term', itemId: null, bookId, userId,
      action, actorId, note: note ?? null,
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'grades', type: action === 'publish' ? 'vn_term_result_published' : 'vn_term_result_unpublished',
      payload: { actorId, courseId: book.courseId, bookId, userId, objectId: bookId, note: note ?? null },
    });
    return { published: action === 'publish' };
  }

  /** Công bố / rút công bố kết quả cả năm của một học sinh trong một khoá (grade:publish tại context khoá). */
  async setYearResultPublication(actorId: string, courseId: string, userId: string, action: 'publish' | 'unpublish', note?: string): Promise<{ published: boolean }> {
    await this.courses.getCourse(courseId);
    await this.requireCap(actorId, 'grade:publish', courseId);
    await this.repo.insertPublication({
      courseId, scope: 'vn_year', itemId: null, bookId: null, userId,
      action, actorId, note: note ?? null,
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'grades', type: action === 'publish' ? 'vn_year_result_published' : 'vn_year_result_unpublished',
      payload: { actorId, courseId, userId, objectId: courseId, note: note ?? null },
    });
    return { published: action === 'publish' };
  }

  /**
   * Kết quả kì cho PHỤ HUYNH có liên kết giám hộ (PH-0): GuardiansService đã
   * kiểm liên kết active trước khi gọi; ở đây chỉ áp cổng công bố — chưa
   * công bố thì coi như chưa có kết quả (403 cùng mã với đường chính chủ).
   */
  async computeTermResultForGuardian(bookId: string, userId: string): Promise<VnTermComputation> {
    const book = await this.getBook(bookId);
    if (!(await this.isTermResultPublished(book, userId))) {
      throw new ForbiddenException({ message: 'Term result has not been published yet', code: 'grades.vn_result_not_published' });
    }
    return this.computeTermResultUnchecked(book, userId);
  }

  /**
   * Các sổ VN của một khoá cho bề mặt phụ huynh (PH-1): quyền đọc suy từ
   * liên kết giám hộ do GuardiansService kiểm tra trước — hàm này không
   * gác capability theo actor như listBooks (đường của giáo viên).
   */
  async listBooksForGuardian(courseId: string): Promise<VnBookRow[]> {
    return this.repo.listVnBooks(courseId);
  }

  /** Bản chốt kì mới nhất của một học sinh trong một sổ (nhận xét tổng kỳ sống ở đây); null khi chưa chốt. */
  async finalizedTermResultForGuardian(bookId: string, userId: string): Promise<VnTermResultRow | null> {
    const rows = await this.repo.listVnTermResults(bookId, userId);
    return rows.at(-1) ?? null;
  }

  /** Bản chốt năm mới nhất của một học sinh trong một khoá; null khi chưa chốt. */
  async finalizedYearResultForGuardian(courseId: string, userId: string): Promise<VnTermResultRow | null> {
    const rows = await this.repo.listVnYearResults(courseId, userId);
    return rows.at(-1) ?? null;
  }

  /**
   * Bề mặt "kết quả của tôi" cho CHÍNH học sinh trong một khoá (issue
   * #180): đường khám phá sổ VN duy nhất cho chính chủ — danh sách sổ
   * của khoá thuộc về staff (grade:viewall) nên học sinh không tự tra
   * bookId được; ở đây server tự duyệt sổ và CHỈ trả dữ liệu qua đúng
   * cổng công bố PH-0 như bề mặt phụ huynh: kỳ/năm chưa công bố thì
   * `published=false`, mọi trường điểm/nhận xét đều null và bookId
   * cũng null (không lộ định danh sổ). Đã công bố thì lấy cùng nguồn
   * với phụ huynh: bản chốt mới nhất, thiếu bản chốt thì tính trực
   * tiếp từ điểm cột (computeTermResultUnchecked — cổng đã kiểm ở
   * trên). Mức học tập Điều 9 lấy từ getStudentClassification vốn đã
   * tự gác công bố cho chính chủ (403 khi mọi môn đều chưa công bố →
   * mức null).
   */
  async getMyVnResults(actorId: string, courseId: string): Promise<MyVnCourseResultsView> {
    await this.assertCanReadStudentResult(actorId, courseId, actorId);
    const books = await this.repo.listVnBooks(courseId);
    const terms: MyVnTermResultView[] = [];
    for (const book of books) {
      if (!(await this.isTermResultPublished(book, actorId))) {
        terms.push({
          bookId: null, term: book.term, assessmentMode: book.assessmentMode, published: false,
          dtbHk: null, commentResult: null, comment: null, awaitingMakeup: false,
        });
        continue;
      }
      const finalized = await this.finalizedTermResultForGuardian(book.id, actorId);
      let dtbHk = finalized?.dtbHk ?? null;
      let awaitingMakeup = false;
      if (!finalized && book.assessmentMode === 'score') {
        const computed = await this.computeTermResultUnchecked(book, actorId);
        dtbHk = computed.dtbHk;
        awaitingMakeup = computed.awaitingMakeupRoles.length > 0;
      }
      terms.push({
        bookId: book.id, term: book.term, assessmentMode: book.assessmentMode, published: true,
        dtbHk, commentResult: finalized?.commentResult ?? null, comment: finalized?.comment ?? null, awaitingMakeup,
      });
    }
    let year: MyVnCourseResultsView['year'] = null;
    if (books.length > 0) {
      if (await this.isYearResultPublished(courseId, actorId)) {
        const finalizedYear = await this.finalizedYearResultForGuardian(courseId, actorId);
        year = { published: true, dtbYear: finalizedYear?.dtbYear ?? null, comment: finalizedYear?.comment ?? null };
      } else {
        year = { published: false, dtbYear: null, comment: null };
      }
    }
    const levels: MyVnCourseResultsView['levels'] = { hk1: null, hk2: null, year: null };
    for (const period of ['hk1', 'hk2', 'year'] as const) {
      try {
        const classification = await this.getStudentClassification(actorId, actorId, period);
        levels[period] = classification.subjects.length > 0 ? classification.level : null;
      } catch {
        levels[period] = null;
      }
    }
    return { courseId, terms, year, levels };
  }

  /** Lấy sổ VN; ném grades.vn_book_not_found khi vắng. */
  async getBook(bookId: string): Promise<VnBookRow> {
    const row = await this.repo.getVnBook(bookId);
    if (!row) throw new NotFoundException({ message: `VN gradebook ${bookId} not found`, code: 'grades.vn_book_not_found' });
    return row;
  }

  /**
   * Suy chế độ đánh giá từ môn học của khoá khi người mở sổ không khai tường minh:
   * môn thuộc nhóm Điều 5.3a → 'comment', còn lại 'score'. Không đọc được môn
   * (khoá không gắn môn, hoặc không có quyền xem chương trình) thì mặc định 'score'.
   */
  private async deriveAssessmentMode(actorId: string, courseId: string): Promise<VnAssessmentMode> {
    const course = await this.courses.getCourse(courseId);
    if (!course.subjectId) return 'score';
    try {
      const subject = await this.curriculum.getSubject(actorId, course.subjectId);
      return isCommentOnlySubjectName(subject.name) ? 'comment' : 'score';
    } catch {
      return 'score';
    }
  }

  /**
   * Mở sổ VN cho một khoá học × học kì và (với môn điểm số) tự sinh cấu trúc cột:
   * quota ĐĐGtx theo số tiết/năm (Điều 6.2b) + đúng 1 ĐĐGgk + 1 ĐĐGck (Điều 7.3),
   * tất cả là grade item manual thang 10 trong một category weightedmean hệ số 1/2/3
   * mà item tổng của nó mang thang 10 (chính là ĐTBmhk khi đủ cột).
   * Môn chỉ-nhận-xét chỉ tạo bản ghi sổ để phân biệt dữ liệu — không sinh cột điểm.
   */
  async createBook(actorId: string, courseId: string, input: {
    term: VnTerm; subjectPeriodsPerYear?: number; assessmentMode?: VnAssessmentMode; regime?: string;
  }): Promise<VnBookView> {
    await this.courses.getCourse(courseId);
    await this.requireCap(actorId, 'grade:manage', courseId);
    if (input.regime !== undefined && input.regime !== 'tt22') {
      throw new BadRequestException({ message: `Regime ${input.regime} is not supported in GB-VN-1 (tt27 arrives in GB-VN-3)`, code: 'grades.vn_regime_unsupported' });
    }
    const existing = (await this.repo.listVnBooks(courseId)).find((b) => b.term === input.term);
    if (existing) {
      throw new BadRequestException({ message: `Course already has a VN gradebook for ${input.term}`, code: 'grades.vn_book_exists' });
    }
    const mode = input.assessmentMode ?? (await this.deriveAssessmentMode(actorId, courseId));

    if (mode === 'comment') {
      const book = await this.repo.insertVnBook({
        courseId, term: input.term, regime: 'tt22', assessmentMode: 'comment',
        subjectPeriodsPerYear: input.subjectPeriodsPerYear ?? null,
        dgtxQuota: VN_COMMENT_EVALUATIONS_PER_TERM, categoryId: null, status: 'open',
      });
      return { book, items: [] };
    }

    if (input.subjectPeriodsPerYear === undefined) {
      throw new BadRequestException({ message: 'subjectPeriodsPerYear is required for a score subject (Điều 6.2b quota)', code: 'grades.vn_periods_required' });
    }
    const quota = dgtxQuotaForPeriods(input.subjectPeriodsPerYear);
    const category = await this.grades.createCategory(actorId, courseId, {
      fullName: input.term === 'hk1' ? 'Sổ điểm TT 22 — Học kì I' : 'Sổ điểm TT 22 — Học kì II',
      aggregation: 'weightedmean',
    });
    // Item tổng của category mang thang 10 để tổng weightedmean chính là thang ĐTB.
    const totalItem = await this.repo.findItemByTypeInstance(courseId, 'category', category.id);
    if (totalItem) await this.repo.updateItem(totalItem.id, { gradeMax: 10, gradeMin: 0 });

    const book = await this.repo.insertVnBook({
      courseId, term: input.term, regime: 'tt22', assessmentMode: 'score',
      subjectPeriodsPerYear: input.subjectPeriodsPerYear, dgtxQuota: quota,
      categoryId: category.id, status: 'open',
    });
    const items: ItemRow[] = [];
    let sortOrder = 1;
    for (let ordinal = 1; ordinal <= quota; ordinal += 1) {
      items.push(await this.repo.insertItem({
        courseId, categoryId: category.id, itemName: `ĐĐGtx ${ordinal}`, itemType: 'manual',
        gradeType: 'value', gradeMax: 10, gradeMin: 0, aggregationCoef: 1,
        vnBookId: book.id, vnRole: 'dgtx', vnOrdinal: ordinal, sortOrder: sortOrder++,
      }));
    }
    items.push(await this.repo.insertItem({
      courseId, categoryId: category.id, itemName: 'ĐĐGgk', itemType: 'manual',
      gradeType: 'value', gradeMax: 10, gradeMin: 0, aggregationCoef: 2,
      vnBookId: book.id, vnRole: 'dggk', vnOrdinal: null, sortOrder: sortOrder++,
    }));
    items.push(await this.repo.insertItem({
      courseId, categoryId: category.id, itemName: 'ĐĐGck', itemType: 'manual',
      gradeType: 'value', gradeMax: 10, gradeMin: 0, aggregationCoef: 3,
      vnBookId: book.id, vnRole: 'dgck', vnOrdinal: null, sortOrder: sortOrder++,
    }));
    await this.grades.regradeCourse(courseId);
    return { book, items };
  }

  /**
   * Các sổ VN của một khoá học kèm cột của chúng. Payload chỉ là CẤU TRÚC sổ
   * (kì, chế độ, quota, cột) — không có điểm của học sinh nào — nhưng vẫn là
   * bề mặt quản trị sổ: gác `grade:viewall` tại context khoá như hộp ứng viên
   * (lát cứng hoá nối tiếp #104; trước đây hàm này không nhận actor nên bất kỳ
   * người dùng đã đăng nhập nào cũng đọc được cấu trúc sổ của mọi khoá).
   */
  async listBooks(actorId: string, courseId: string): Promise<VnBookView[]> {
    await this.courses.getCourse(courseId);
    await this.requireCap(actorId, 'grade:viewall', courseId);
    const books = await this.repo.listVnBooks(courseId);
    const views: VnBookView[] = [];
    for (const book of books) views.push({ book, items: await this.repo.listItemsByVnBook(book.id) });
    return views;
  }

  /** Một sổ VN kèm cột của nó. Gác `grade:viewall` như listBooks (lát cứng hoá nối tiếp #104). */
  async getBookView(actorId: string, bookId: string): Promise<VnBookView> {
    const book = await this.getBook(bookId);
    await this.requireCap(actorId, 'grade:viewall', book.courseId);
    return { book, items: await this.repo.listItemsByVnBook(book.id) };
  }

  /** Hành động trạng thái cột (chờ bù / gỡ chờ bù / ghi 0) mới nhất cho một (cột, học sinh), nếu có. */
  private latestMakeupAction(actions: VnCandidateActionRow[], itemId: string, userId: string): VnCandidateActionRow | undefined {
    let found: VnCandidateActionRow | undefined;
    for (const a of actions) {
      if (a.targetItemId === itemId && a.userId === userId && a.mappingId === null
        && (a.action === 'awaiting_makeup' || a.action === 'clear_makeup' || a.action === 'zero')) found = a;
    }
    return found;
  }

  /** Trạng thái một cột của một học sinh: có điểm → graded; chưa điểm nhưng GV đánh dấu chờ bù → awaiting_makeup; còn lại missing. */
  private columnStatus(actions: VnCandidateActionRow[], itemId: string, userId: string, value: number | null): VnColumnStatus {
    if (value !== null) return 'graded';
    return this.latestMakeupAction(actions, itemId, userId)?.action === 'awaiting_makeup' ? 'awaiting_makeup' : 'missing';
  }

  /**
   * Tính kết quả học kì TRỰC TIẾP từ điểm cột hiện tại của học sinh: thiếu bất
   * kỳ cột bắt buộc nào thì complete=false và dtbHk=null (không tự điền 0).
   * Cột chưa có điểm nhưng được GV đánh dấu chờ kiểm tra bù (Điều 7.4, GB-VN-2)
   * mang trạng thái riêng `awaiting_makeup` để phân biệt với thiếu thường và
   * với 0 điểm thật (Điều 7.5 — 0 điểm là một grade có giá trị 0).
   */
  async computeTermResult(actorId: string, bookId: string, userId: string): Promise<VnTermComputation> {
    const book = await this.getBook(bookId);
    await this.assertCanReadStudentResult(actorId, book.courseId, userId);
    await this.assertTermPublishedForSelf(actorId, book, userId);
    return this.computeTermResultUnchecked(book, userId);
  }

  /** Phần tính thuần trên sổ đã nạp — chỉ gọi từ biên đã gác actor (route đọc) hoặc luồng chốt đã gác grade:edit. */
  private async computeTermResultUnchecked(book: VnBookRow, userId: string): Promise<VnTermComputation> {
    const bookId = book.id;
    if (book.assessmentMode !== 'score') {
      throw new BadRequestException({ message: 'Comment-only subjects have no score columns to compute (Điều 5.3a)', code: 'grades.vn_comment_book' });
    }
    const items = await this.repo.listItemsByVnBook(bookId);
    const actions = await this.repo.listVnCandidateActions(bookId);
    const columns: VnColumnScore[] = [];
    const missingRoles: string[] = [];
    const awaitingMakeupRoles: string[] = [];
    const dgtx: number[] = [];
    let dggk: number | null = null;
    let dgck: number | null = null;
    for (const item of items) {
      const grade = await this.repo.getGrade(item.id, userId);
      const value = grade?.finalGrade ?? grade?.rawGrade ?? null;
      const status = this.columnStatus(actions, item.id, userId, value);
      columns.push({ itemId: item.id, role: item.vnRole ?? '', ordinal: item.vnOrdinal, grade: value, status });
      if (status === 'awaiting_makeup') awaitingMakeupRoles.push(item.vnRole ?? item.itemName);
      if (value === null) { missingRoles.push(item.vnRole ?? item.itemName); continue; }
      if (item.vnRole === 'dgtx') dgtx.push(value);
      else if (item.vnRole === 'dggk') dggk = value;
      else if (item.vnRole === 'dgck') dgck = value;
    }
    const complete = missingRoles.length === 0 && dgtx.length === book.dgtxQuota && dggk !== null && dgck !== null;
    return {
      bookId, userId, complete, missingRoles, awaitingMakeupRoles, columns,
      dtbHk: complete ? computeDtbHk({ dgtx, dggk: dggk!, dgck: dgck! }) : null,
    };
  }

  /** Bản chốt term mới nhất của một học sinh trong một sổ (undefined nếu chưa chốt). */
  private async latestTermResult(bookId: string, userId: string): Promise<VnTermResultRow | undefined> {
    const rows = await this.repo.listVnTermResults(bookId, userId);
    return rows.filter((r) => r.scope === 'term').at(-1);
  }

  /**
   * Chốt kết quả học kì của môn điểm số: tính ĐTBmhk từ điểm cột và ghi bản
   * snapshot mới vào vn_term_results (chốt lại = version mới, không sửa đè).
   * Thiếu cột thì từ chối chốt với mã grades.vn_result_incomplete.
   */
  async finalizeTermResult(actorId: string, bookId: string, userId: string, comment?: string): Promise<VnTermResultRow> {
    const book = await this.getBook(bookId);
    await this.requireCap(actorId, 'grade:edit', book.courseId);
    const computation = await this.computeTermResultUnchecked(book, userId);
    if (computation.awaitingMakeupRoles.length > 0) {
      throw new BadRequestException({
        message: `Cannot finalize: columns awaiting makeup assessment (Điều 7.4) ${computation.awaitingMakeupRoles.join(', ')}`,
        code: 'grades.vn_result_awaiting_makeup',
      });
    }
    if (!computation.complete || computation.dtbHk === null) {
      throw new BadRequestException({
        message: `Cannot finalize: missing grade columns ${computation.missingRoles.join(', ')}`,
        code: 'grades.vn_result_incomplete',
      });
    }
    const previous = await this.latestTermResult(bookId, userId);
    return this.repo.insertVnTermResult({
      bookId, courseId: book.courseId, userId, scope: 'term',
      dtbHk: computation.dtbHk, dtbYear: null, commentResult: null,
      comment: comment ?? null, version: (previous?.version ?? 0) + 1,
    });
  }

  /**
   * Ghi kết quả của môn chỉ-nhận-xét cho một học sinh trong học kì (dữ liệu tối
   * thiểu để xếp mức Điều 9 dùng được; bề mặt/luồng đầy đủ của môn nhận xét là GB-VN-3).
   */
  async setCommentResult(actorId: string, bookId: string, userId: string, input: {
    result: VnCommentResult; comment?: string;
  }): Promise<VnTermResultRow> {
    const book = await this.getBook(bookId);
    await this.requireCap(actorId, 'grade:edit', book.courseId);
    if (book.assessmentMode !== 'comment') {
      throw new BadRequestException({ message: 'This VN gradebook is a score subject', code: 'grades.vn_score_book' });
    }
    const previous = await this.latestTermResult(bookId, userId);
    return this.repo.insertVnTermResult({
      bookId, courseId: book.courseId, userId, scope: 'term',
      dtbHk: null, dtbYear: null, commentResult: input.result,
      comment: input.comment ?? null, version: (previous?.version ?? 0) + 1,
    });
  }

  /** Các bản chốt term của một học sinh trong một sổ (mọi version, cũ → mới). Đọc qua cổng actor như computeTermResult. */
  async listTermResults(actorId: string, bookId: string, userId: string): Promise<VnTermResultRow[]> {
    const book = await this.getBook(bookId);
    await this.assertCanReadStudentResult(actorId, book.courseId, userId);
    // Chính chủ chỉ thấy bản chốt khi kết quả của sổ đã công bố cho mình;
    // chưa công bố thì danh sách rỗng (bản chốt chưa tồn tại phía học sinh).
    if (actorId === userId && !(await this.isTermResultPublished(book, userId))) return [];
    return this.repo.listVnTermResults(bookId, userId);
  }

  /**
   * Chốt kết quả cả năm của một học sinh trong một khoá học:
   * ĐTBmcn = (ĐTBmhkI + 2×ĐTBmhkII)/3 trên hai ĐTBmhk ĐÃ CHỐT (đã làm tròn).
   * Thiếu bản chốt của một trong hai kì thì từ chối.
   */
  async finalizeYearResult(actorId: string, courseId: string, userId: string, comment?: string): Promise<VnTermResultRow> {
    await this.courses.getCourse(courseId);
    await this.requireCap(actorId, 'grade:edit', courseId);
    const books = await this.repo.listVnBooks(courseId);
    const hk1 = books.find((b) => b.term === 'hk1');
    const hk2 = books.find((b) => b.term === 'hk2');
    if (!hk1 || !hk2) {
      throw new BadRequestException({ message: 'Year result requires VN gradebooks for both terms', code: 'grades.vn_result_incomplete' });
    }
    if (hk1.assessmentMode !== 'score' || hk2.assessmentMode !== 'score') {
      throw new BadRequestException({ message: 'Year average only applies to score subjects', code: 'grades.vn_comment_book' });
    }
    const r1 = await this.latestTermResult(hk1.id, userId);
    const r2 = await this.latestTermResult(hk2.id, userId);
    if (r1?.dtbHk == null || r2?.dtbHk == null) {
      throw new BadRequestException({ message: 'Year result requires finalized term results for both terms', code: 'grades.vn_result_incomplete' });
    }
    const previous = (await this.repo.listVnYearResults(courseId, userId)).at(-1);
    return this.repo.insertVnTermResult({
      bookId: null, courseId, userId, scope: 'year',
      dtbHk: null, dtbYear: computeDtbCn(r1.dtbHk, r2.dtbHk), commentResult: null,
      comment: comment ?? null, version: (previous?.version ?? 0) + 1,
    });
  }

  /** Bản chốt cả năm mới nhất của một học sinh trong một khoá học. Đọc qua cổng actor như computeTermResult. */
  async latestYearResult(actorId: string, courseId: string, userId: string): Promise<VnTermResultRow | undefined> {
    await this.assertCanReadStudentResult(actorId, courseId, userId);
    if (actorId === userId && !(await this.isYearResultPublished(courseId, userId))) {
      throw new ForbiddenException({ message: 'Year result has not been published yet', code: 'grades.vn_result_not_published' });
    }
    return (await this.repo.listVnYearResults(courseId, userId)).at(-1);
  }

  /**
   * Xếp mức kết quả học tập chung (Điều 9.2 + điều chỉnh 9.3) cho một học sinh
   * trong một học kì hoặc cả năm, trên các BẢN CHỐT mới nhất của mọi sổ VN:
   * kì hk1/hk2 dùng ĐTBmhk của từng sổ trong kì đó; cả năm dùng ĐTBmcn của từng
   * khoá (môn nhận xét của cả năm lấy kết quả đã chốt ở học kì II).
   * Người xem phải là chính học sinh hoặc có grade:viewall ở ngữ cảnh hệ thống.
   */
  async getStudentClassification(actorId: string, userId: string, period: VnTerm | 'year'): Promise<VnStudentClassification> {
    if (actorId !== userId) {
      const system = await this.contexts.ensureSystemContext();
      const allowed = await this.evaluator.hasCapability(actorId, 'grade:viewall', system.id).catch(() => false);
      if (!allowed) {
        throw new ForbiddenException({ message: 'Only the student or a grade:viewall holder can read this classification', code: 'grades.vn_classification_forbidden' });
      }
    }
    const allResults = await this.repo.listVnResultsForUser(userId);
    const latestByKey = new Map<string, VnTermResultRow>();
    for (const row of allResults) {
      const key = row.scope === 'year' ? `year:${row.courseId}` : `term:${row.bookId}`;
      const prev = latestByKey.get(key);
      if (!prev || row.version >= prev.version) latestByKey.set(key, row);
    }
    const subjects: VnSubjectLevelInput[] = [];
    // PH-0: chính chủ chỉ xếp mức trên các bản chốt ĐÃ CÔNG BỐ cho mình —
    // bản chưa công bố bị loại khỏi đầu vào như chưa tồn tại phía học sinh.
    const selfView = actorId === userId;
    let suppressedUnpublished = 0;
    if (period === 'year') {
      for (const row of latestByKey.values()) {
        if (row.scope === 'year' && row.dtbYear != null) {
          if (selfView && !(await this.isYearResultPublished(row.courseId, userId))) { suppressedUnpublished++; continue; }
          subjects.push({ key: row.courseId, kind: 'score', dtb: row.dtbYear });
        }
      }
      // Môn nhận xét cả năm: lấy bản chốt term của sổ hk2 của khoá.
      const hk2Books = await this.repo.listVnBooksByTerm('hk2');
      for (const book of hk2Books) {
        if (book.assessmentMode !== 'comment') continue;
        const row = latestByKey.get(`term:${book.id}`);
        if (row?.commentResult === 'Đạt' || row?.commentResult === 'Chưa đạt') {
          if (selfView && !(await this.isTermResultPublished(book, userId))) { suppressedUnpublished++; continue; }
          subjects.push({ key: book.courseId, kind: 'comment', commentResult: row.commentResult });
        }
      }
    } else {
      const books = await this.repo.listVnBooksByTerm(period);
      for (const book of books) {
        const row = latestByKey.get(`term:${book.id}`);
        if (!row) continue;
        const usable = book.assessmentMode === 'comment'
          ? (row.commentResult === 'Đạt' || row.commentResult === 'Chưa đạt')
          : row.dtbHk != null;
        if (!usable) continue;
        if (selfView && !(await this.isTermResultPublished(book, userId))) { suppressedUnpublished++; continue; }
        if (book.assessmentMode === 'comment') {
          subjects.push({ key: book.courseId, kind: 'comment', commentResult: row.commentResult as VnCommentResult });
        } else {
          subjects.push({ key: book.courseId, kind: 'score', dtb: row.dtbHk! });
        }
      }
    }
    if (selfView && subjects.length === 0 && suppressedUnpublished > 0) {
      throw new ForbiddenException({ message: 'Results for this period have not been published yet', code: 'grades.vn_result_not_published' });
    }
    return { userId, period, subjects, ...classifyLearningLevel(subjects) };
  }

  // --- GB-VN-2: luồng hoạt động → cột --------------------------------------

  /** Gắn mô tả truy vết (tên/loại hoạt động nguồn + vai trò cột đích) vào một khai vai trò. */
  private async mappingView(row: VnActivityMappingRow): Promise<VnActivityMappingView> {
    const source = await this.repo.getItem(row.itemId);
    const target = await this.repo.getItem(row.targetItemId);
    return {
      id: row.id, courseId: row.courseId, bookId: row.bookId, cmId: row.cmId,
      itemId: row.itemId, targetItemId: row.targetItemId, role: row.role, ordinal: row.ordinal,
      activityName: source?.itemName ?? '', component: source?.itemModule ?? null,
      targetRole: target?.vnRole ?? null, targetOrdinal: target?.vnOrdinal ?? null,
      createdBy: row.createdBy, createdAt: row.createdAt,
    };
  }

  /**
   * Khai vai trò điểm cho một hoạt động vào một cột của sổ (Điều 6.2 — hoạt
   * động là ỨNG VIÊN của cột, không tự ghi điểm): hoạt động phải đã có grade
   * item loại 'mod' trong khoá (quiz/assignment đều có khi tạo); một hoạt
   * động chỉ khai vào đúng một cột; vai dgtx bắt buộc ordinal trong quota,
   * dggk/dgck là cột đơn. Sổ môn chỉ-nhận-xét không có cột điểm để khai.
   */
  async createActivityMapping(actorId: string, bookId: string, input: {
    cmId: string; role: string; ordinal?: number;
  }): Promise<VnActivityMappingView> {
    const book = await this.getBook(bookId);
    await this.requireCap(actorId, 'grade:manage', book.courseId);
    if (book.assessmentMode !== 'score') {
      throw new BadRequestException({ message: 'Comment-only subjects have no score columns to map activities into (Điều 5.3a)', code: 'grades.vn_comment_book' });
    }
    if (input.role === 'dgtx') {
      if (input.ordinal === undefined) {
        throw new BadRequestException({ message: 'Mapping an activity to a ĐĐGtx column requires its ordinal', code: 'grades.vn_mapping_ordinal_required' });
      }
      if (input.ordinal < 1 || input.ordinal > book.dgtxQuota) {
        throw new BadRequestException({ message: `ĐĐGtx ordinal ${input.ordinal} is outside this book quota 1..${book.dgtxQuota}`, code: 'grades.vn_mapping_ordinal_out_of_range' });
      }
    } else if (input.ordinal !== undefined) {
      throw new BadRequestException({ message: `Role ${input.role} is a single column and takes no ordinal`, code: 'grades.vn_mapping_ordinal_forbidden' });
    }
    const sourceItem = await this.grades.getItemForCm(book.courseId, input.cmId);
    if (!sourceItem) {
      throw new BadRequestException({ message: 'Activity has no grade item in this course (only graded activities can feed a VN column)', code: 'grades.vn_activity_not_gradable' });
    }
    if (await this.repo.findVnActivityMappingByCm(input.cmId)) {
      throw new BadRequestException({ message: 'This activity is already mapped to a VN gradebook column', code: 'grades.vn_mapping_exists' });
    }
    const items = await this.repo.listItemsByVnBook(bookId);
    const target = items.find((i) => i.vnRole === input.role && (i.vnOrdinal ?? null) === (input.ordinal ?? null));
    if (!target) {
      throw new BadRequestException({ message: `VN gradebook has no ${input.role} column to map into`, code: 'grades.vn_mapping_target_not_found' });
    }
    const row = await this.repo.insertVnActivityMapping({
      courseId: book.courseId, bookId, cmId: input.cmId, itemId: sourceItem.id,
      targetItemId: target.id, role: input.role, ordinal: input.ordinal ?? null, createdBy: actorId,
    });
    return this.mappingView(row);
  }

  /**
   * Các khai vai trò điểm của một sổ, kèm truy vết hoạt động nguồn và cột đích.
   * Gác `grade:viewall` tại context khoá (lát cứng hoá nối tiếp #104 — điểm ghi
   * nhận không chặn của đánh giá độc lập GB-VN-2, phán quyết 6389458366: trước
   * đây hàm này không nhận actor, học sinh và người ngoài khoá đều đọc được).
   */
  async listActivityMappings(actorId: string, bookId: string): Promise<VnActivityMappingView[]> {
    const book = await this.getBook(bookId);
    await this.requireCap(actorId, 'grade:viewall', book.courseId);
    const rows = await this.repo.listVnActivityMappings(bookId);
    const views: VnActivityMappingView[] = [];
    for (const row of rows) views.push(await this.mappingView(row));
    return views;
  }

  /** Gỡ khai vai trò của một hoạt động khỏi sổ (vết quyết định đã ghi không đổi). */
  async deleteActivityMapping(actorId: string, bookId: string, mappingId: string): Promise<{ deleted: true }> {
    const book = await this.getBook(bookId);
    await this.requireCap(actorId, 'grade:manage', book.courseId);
    const row = await this.repo.getVnActivityMapping(mappingId);
    if (!row || row.bookId !== bookId) {
      throw new NotFoundException({ message: `VN activity mapping ${mappingId} not found`, code: 'grades.vn_mapping_not_found' });
    }
    await this.repo.deleteVnActivityMapping(mappingId);
    return { deleted: true };
  }

  /** Quyết định chốt/bỏ qua mới nhất cho một (khai vai trò, học sinh). */
  private latestDecision(actions: VnCandidateActionRow[], mappingId: string, userId: string): VnCandidateActionRow | undefined {
    let found: VnCandidateActionRow | undefined;
    for (const a of actions) {
      if (a.mappingId === mappingId && a.userId === userId && (a.action === 'commit' || a.action === 'dismiss')) found = a;
    }
    return found;
  }

  /** Vân tay điểm nguồn (giá trị hiệu lực + thời điểm cập nhật của bản ghi điểm) còn khớp quyết định đã ghi hay không. */
  private decisionMatchesGrade(decision: VnCandidateActionRow, grade: GradeRow): boolean {
    const value = grade.finalGrade ?? grade.rawGrade;
    return decision.sourceGradeValue === value
      && (decision.sourceGradeUpdatedAt?.getTime() ?? null) === grade.updatedAt.getTime();
  }

  /**
   * Hộp ứng viên của sổ: mọi (hoạt động đã khai vai trò × học sinh đã có điểm
   * hoạt động) kèm giá trị quy đổi thang 10 và trạng thái quyết định. Ứng
   * viên đã chốt/bỏ qua hiện lại dạng `pending` với cờ activityGradeChanged
   * khi điểm hoạt động thay đổi sau quyết định (vân tay không còn khớp).
   */
  async listCandidates(actorId: string, bookId: string): Promise<{ bookId: string; candidates: VnCandidateView[] }> {
    const book = await this.getBook(bookId);
    await this.requireCap(actorId, 'grade:viewall', book.courseId);
    const mappings = await this.repo.listVnActivityMappings(bookId);
    const actions = await this.repo.listVnCandidateActions(bookId);
    const candidates: VnCandidateView[] = [];
    for (const mapping of mappings) {
      const source = await this.repo.getItem(mapping.itemId);
      const target = await this.repo.getItem(mapping.targetItemId);
      if (!source || !target) continue;
      const grades = await this.repo.listGradesForItem(mapping.itemId);
      for (const grade of grades) {
        const value = grade.finalGrade ?? grade.rawGrade;
        if (value === null) continue;
        let converted: number;
        try {
          converted = convertGradeToScale10(value, source.gradeMin, source.gradeMax);
        } catch {
          continue; // Thang của item nguồn không hợp lệ — không sinh ứng viên thay vì bịa số.
        }
        const decision = this.latestDecision(actions, mapping.id, grade.userId);
        let state: VnCandidateState = 'pending';
        let changed = false;
        if (decision) {
          if (this.decisionMatchesGrade(decision, grade)) state = decision.action === 'commit' ? 'committed' : 'dismissed';
          else changed = true;
        }
        candidates.push({
          mappingId: mapping.id, userId: grade.userId, cmId: mapping.cmId,
          component: source.itemModule, activityName: source.itemName,
          sourceItemId: mapping.itemId, targetItemId: mapping.targetItemId,
          targetRole: target.vnRole, targetOrdinal: target.vnOrdinal,
          activityGrade: value, activityGradeMin: source.gradeMin, activityGradeMax: source.gradeMax,
          convertedGrade: converted, state, activityGradeChanged: changed,
          committedValue: state === 'committed' ? (decision?.committedValue ?? null) : null,
          decidedBy: decision?.actorId ?? null, decidedAt: decision?.createdAt ?? null,
        });
      }
    }
    return { bookId, candidates };
  }

  /** Lấy (khai vai trò + điểm hoạt động hiện tại) của một ứng viên; chưa có điểm hoạt động thì không có ứng viên để quyết. */
  private async requireCandidate(bookId: string, mappingId: string, userId: string): Promise<{
    mapping: VnActivityMappingRow; grade: GradeRow; value: number; converted: number;
  }> {
    const mapping = await this.repo.getVnActivityMapping(mappingId);
    if (!mapping || mapping.bookId !== bookId) {
      throw new NotFoundException({ message: `VN activity mapping ${mappingId} not found`, code: 'grades.vn_mapping_not_found' });
    }
    const source = await this.repo.getItem(mapping.itemId);
    const grade = await this.repo.getGrade(mapping.itemId, userId);
    const value = grade?.finalGrade ?? grade?.rawGrade ?? null;
    if (!source || !grade || value === null) {
      throw new BadRequestException({ message: 'Student has no grade in the mapped activity yet — no candidate to decide', code: 'grades.vn_candidate_not_found' });
    }
    let converted: number;
    try {
      converted = convertGradeToScale10(value, source.gradeMin, source.gradeMax);
    } catch {
      throw new BadRequestException({ message: 'Activity grade range cannot be converted to scale 10', code: 'grades.vn_candidate_unconvertible' });
    }
    return { mapping, grade, value, converted };
  }

  /**
   * Chốt một ứng viên vào cột (thao tác của giáo viên theo Điều 6.2): ghi giá
   * trị quy đổi — hoặc giá trị GV sửa, khi đó điểm vào cột mang cờ overridden
   * của engine — qua đúng đường ghi điểm của gradebook (tôn trọng khoá của
   * cột, ghi history với nguồn vn-candidate), rồi lưu vết quyết định kèm vân
   * tay điểm hoạt động tại lúc chốt.
   */
  async commitCandidate(actorId: string, bookId: string, mappingId: string, userId: string, input: {
    value?: number;
  }): Promise<VnCandidateActionRow> {
    const book = await this.getBook(bookId);
    await this.requireCap(actorId, 'grade:edit', book.courseId);
    const { mapping, grade, value, converted } = await this.requireCandidate(bookId, mappingId, userId);
    const committed = input.value !== undefined ? round1(input.value) : converted;
    const adjusted = Math.abs(committed - converted) > 1e-9;
    const source = await this.repo.getItem(mapping.itemId);
    await this.grades.setGrade(actorId, mapping.targetItemId, userId, { rawGrade: committed }, {
      source: `vn-candidate:${source?.itemModule ?? 'mod'}`, overridden: adjusted,
    });
    return this.repo.insertVnCandidateAction({
      courseId: book.courseId, bookId, mappingId, targetItemId: mapping.targetItemId,
      sourceItemId: mapping.itemId, userId, action: 'commit',
      sourceGradeValue: value, sourceGradeUpdatedAt: grade.updatedAt,
      convertedGrade: converted, committedValue: committed, actorId,
    });
  }

  /** Bỏ qua một ứng viên: lưu vết kèm vân tay — ứng viên chỉ hiện lại khi điểm hoạt động thay đổi. */
  async dismissCandidate(actorId: string, bookId: string, mappingId: string, userId: string): Promise<VnCandidateActionRow> {
    const book = await this.getBook(bookId);
    await this.requireCap(actorId, 'grade:edit', book.courseId);
    const { mapping, grade, value, converted } = await this.requireCandidate(bookId, mappingId, userId);
    return this.repo.insertVnCandidateAction({
      courseId: book.courseId, bookId, mappingId, targetItemId: mapping.targetItemId,
      sourceItemId: mapping.itemId, userId, action: 'dismiss',
      sourceGradeValue: value, sourceGradeUpdatedAt: grade.updatedAt,
      convertedGrade: converted, committedValue: null, actorId,
    });
  }

  /**
   * Đặt trạng thái kiểm tra bù cho một cột định kì (ĐĐGgk/ĐĐGck) của một học
   * sinh (Điều 7.4–7.5): `awaiting_makeup` chỉ đánh dấu (chưa có điểm, chốt
   * sổ bị chặn bằng mã riêng); `zero` ghi hẳn 0 điểm vào cột qua đường ghi
   * điểm của engine kèm vết quyết định; `clear` gỡ đánh dấu chờ bù.
   */
  async setMakeupStatus(actorId: string, bookId: string, itemId: string, userId: string, input: {
    state: 'awaiting_makeup' | 'zero' | 'clear';
  }): Promise<VnColumnStatusView> {
    const book = await this.getBook(bookId);
    await this.requireCap(actorId, 'grade:edit', book.courseId);
    if (book.assessmentMode !== 'score') {
      throw new BadRequestException({ message: 'Comment-only subjects have no score columns (Điều 5.3a)', code: 'grades.vn_comment_book' });
    }
    const items = await this.repo.listItemsByVnBook(bookId);
    const item = items.find((i) => i.id === itemId);
    if (!item) {
      throw new NotFoundException({ message: `VN gradebook column ${itemId} not found`, code: 'grades.vn_column_not_found' });
    }
    if (item.vnRole !== 'dggk' && item.vnRole !== 'dgck') {
      throw new BadRequestException({ message: 'Makeup status applies to periodic columns (ĐĐGgk/ĐĐGck) only — Điều 7', code: 'grades.vn_makeup_role_invalid' });
    }
    if (input.state === 'zero') {
      await this.grades.setGrade(actorId, itemId, userId, { rawGrade: 0 }, { source: 'vn-makeup-zero' });
      await this.repo.insertVnCandidateAction({
        courseId: book.courseId, bookId, mappingId: null, targetItemId: itemId, sourceItemId: null,
        userId, action: 'zero', sourceGradeValue: null, sourceGradeUpdatedAt: null,
        convertedGrade: null, committedValue: 0, actorId,
      });
    } else {
      await this.repo.insertVnCandidateAction({
        courseId: book.courseId, bookId, mappingId: null, targetItemId: itemId, sourceItemId: null,
        userId, action: input.state === 'awaiting_makeup' ? 'awaiting_makeup' : 'clear_makeup',
        sourceGradeValue: null, sourceGradeUpdatedAt: null,
        convertedGrade: null, committedValue: null, actorId,
      });
    }
    const grade = await this.repo.getGrade(itemId, userId);
    const value = grade?.finalGrade ?? grade?.rawGrade ?? null;
    const actions = await this.repo.listVnCandidateActions(bookId);
    return { itemId, userId, role: item.vnRole, grade: value, status: this.columnStatus(actions, itemId, userId, value) };
  }
}

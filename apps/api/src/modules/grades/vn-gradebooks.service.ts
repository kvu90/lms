import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CoursesService } from '../courses/courses.service';
import { CurriculumService } from '../curriculum/curriculum.service';
import {
  classifyLearningLevel, computeDtbCn, computeDtbHk, dgtxQuotaForPeriods, isCommentOnlySubjectName,
  VN_COMMENT_EVALUATIONS_PER_TERM, type VnAssessmentMode, type VnClassification, type VnCommentResult,
  type VnSubjectLevelInput, type VnTerm,
} from './domain/vn-gradebook';
import { GradesService } from './grades.service';
import { GradesRepository, type ItemRow, type VnBookRow, type VnTermResultRow } from './grades.repository';

/** Sổ VN kèm các cột điểm của nó (môn nhận xét không có cột điểm). */
export interface VnBookView {
  book: VnBookRow;
  items: ItemRow[];
}

/** Một cột điểm trong lần tính kết quả: vai trò + thứ tự + điểm hiện có (null = chưa có điểm). */
export interface VnColumnScore {
  itemId: string;
  role: string;
  ordinal: number | null;
  grade: number | null;
}

/** Kết quả học kì tính trực tiếp từ điểm cột hiện tại (chưa chốt): đủ cột mới có ĐTBmhk. */
export interface VnTermComputation {
  bookId: string;
  userId: string;
  complete: boolean;
  missingRoles: string[];
  columns: VnColumnScore[];
  dtbHk: number | null;
}

/** Xếp mức chung của một học sinh trong một kì (hoặc cả năm) theo Điều 9, kèm các môn đầu vào để truy vết. */
export interface VnStudentClassification extends VnClassification {
  userId: string;
  period: VnTerm | 'year';
  subjects: VnSubjectLevelInput[];
}

/**
 * Nghiệp vụ sổ điểm VN (GB-VN-1, issue #95) — lớp preset TT 22 trên gradebook
 * engine: sổ tự sinh cột theo quota số tiết vào một category weightedmean
 * (hệ số 1/2/3), ĐTB tính ở tầng service theo đúng Điều 9 (dùng ĐTBmhk đã làm
 * tròn để tính ĐTBmcn) và chốt thành bản snapshot trong vn_term_results.
 * Điểm từ hoạt động online KHÔNG tự chảy vào cột ở lát này (chúng chỉ là ứng
 * viên — luồng chốt của giáo viên là GB-VN-2); chuyên cần/tiến độ không bao
 * giờ cộng vào ĐTB (kết luận kiểm chứng âm từ TT 22/TT 27).
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

  /** Các sổ VN của một khoá học kèm cột của chúng. */
  async listBooks(courseId: string): Promise<VnBookView[]> {
    await this.courses.getCourse(courseId);
    const books = await this.repo.listVnBooks(courseId);
    const views: VnBookView[] = [];
    for (const book of books) views.push({ book, items: await this.repo.listItemsByVnBook(book.id) });
    return views;
  }

  /** Một sổ VN kèm cột của nó. */
  async getBookView(bookId: string): Promise<VnBookView> {
    const book = await this.getBook(bookId);
    return { book, items: await this.repo.listItemsByVnBook(book.id) };
  }

  /**
   * Tính kết quả học kì TRỰC TIẾP từ điểm cột hiện tại của học sinh: thiếu bất
   * kỳ cột bắt buộc nào thì complete=false và dtbHk=null (không tự điền 0 —
   * phân biệt "chờ kiểm tra bù" với "0 điểm" là GB-VN-2, Điều 7.4–7.5).
   */
  async computeTermResult(actorId: string, bookId: string, userId: string): Promise<VnTermComputation> {
    const book = await this.getBook(bookId);
    await this.assertCanReadStudentResult(actorId, book.courseId, userId);
    return this.computeTermResultUnchecked(book, userId);
  }

  /** Phần tính thuần trên sổ đã nạp — chỉ gọi từ biên đã gác actor (route đọc) hoặc luồng chốt đã gác grade:edit. */
  private async computeTermResultUnchecked(book: VnBookRow, userId: string): Promise<VnTermComputation> {
    const bookId = book.id;
    if (book.assessmentMode !== 'score') {
      throw new BadRequestException({ message: 'Comment-only subjects have no score columns to compute (Điều 5.3a)', code: 'grades.vn_comment_book' });
    }
    const items = await this.repo.listItemsByVnBook(bookId);
    const columns: VnColumnScore[] = [];
    const missingRoles: string[] = [];
    const dgtx: number[] = [];
    let dggk: number | null = null;
    let dgck: number | null = null;
    for (const item of items) {
      const grade = await this.repo.getGrade(item.id, userId);
      const value = grade?.finalGrade ?? grade?.rawGrade ?? null;
      columns.push({ itemId: item.id, role: item.vnRole ?? '', ordinal: item.vnOrdinal, grade: value });
      if (value === null) { missingRoles.push(item.vnRole ?? item.itemName); continue; }
      if (item.vnRole === 'dgtx') dgtx.push(value);
      else if (item.vnRole === 'dggk') dggk = value;
      else if (item.vnRole === 'dgck') dgck = value;
    }
    const complete = missingRoles.length === 0 && dgtx.length === book.dgtxQuota && dggk !== null && dgck !== null;
    return {
      bookId, userId, complete, missingRoles, columns,
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
    if (period === 'year') {
      for (const row of latestByKey.values()) {
        if (row.scope === 'year' && row.dtbYear != null) {
          subjects.push({ key: row.courseId, kind: 'score', dtb: row.dtbYear });
        }
      }
      // Môn nhận xét cả năm: lấy bản chốt term của sổ hk2 của khoá.
      const hk2Books = await this.repo.listVnBooksByTerm('hk2');
      for (const book of hk2Books) {
        if (book.assessmentMode !== 'comment') continue;
        const row = latestByKey.get(`term:${book.id}`);
        if (row?.commentResult === 'Đạt' || row?.commentResult === 'Chưa đạt') {
          subjects.push({ key: book.courseId, kind: 'comment', commentResult: row.commentResult });
        }
      }
    } else {
      const books = await this.repo.listVnBooksByTerm(period);
      for (const book of books) {
        const row = latestByKey.get(`term:${book.id}`);
        if (!row) continue;
        if (book.assessmentMode === 'comment') {
          if (row.commentResult === 'Đạt' || row.commentResult === 'Chưa đạt') {
            subjects.push({ key: book.courseId, kind: 'comment', commentResult: row.commentResult });
          }
        } else if (row.dtbHk != null) {
          subjects.push({ key: book.courseId, kind: 'score', dtb: row.dtbHk });
        }
      }
    }
    return { userId, period, subjects, ...classifyLearningLevel(subjects) };
  }
}

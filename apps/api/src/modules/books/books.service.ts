import { BadRequestException, ConflictException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import type { BookDatasetStatus, BookImportResult } from '@lms/contracts';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { CoursesService } from '../courses/courses.service';
import { CurriculumRepository, type SubjectRow } from '../curriculum/curriculum.repository';
import { CURRICULUM_MANAGE, CURRICULUM_VIEW } from '../curriculum/curriculum.service';
import { BookRepository, type BookNodeRow, type BookRow } from './books.repository';
import {
  loadBookDataset, bookDatasetByKey, bookRecordHash, BOOK_DATASETS, type BookDatasetDef, type BookRecord,
} from './book-datasets';

const COURSE_UPDATE = 'course:update';

/** Một đích ánh xạ của một bài SGK trong cây sách: node chương trình hoặc YCCĐ cụ thể, kèm mã bản ghi chương trình để truy vết. */
export interface BookMappingView {
  curriculumNodeId: string | null;
  learningOutcomeId: string | null;
  programRecordId: string | null;
  targetTitle: string | null;
}

/** Một bài SGK trong cây sách, kèm ánh xạ và YCCĐ suy qua ánh xạ. */
export interface BookLessonView {
  id: string;
  title: string;
  volume: number | null;
  lessonNumber: number | null;
  position: number;
  recordId: string | null;
  mappings: BookMappingView[];
  outcomes: { outcomeId: string; content: string }[];
}

/** Một chủ đề SGK và các bài trong nó. */
export interface BookChapterView {
  id: string;
  title: string;
  volume: number | null;
  position: number;
  lessons: BookLessonView[];
}

/** Cây đầy đủ của một cuốn SGK cho bề mặt quản trị và bề mặt chọn khung. */
export interface BookTreeView {
  book: BookRow;
  subject: { id: string; name: string; slug: string } | null;
  chapters: BookChapterView[];
}

/** Chỉ mục cây trong bộ nhớ cho một cuốn sách trong một lượt nạp (theo mẫu ProgramImportService). */
interface TreeIndex {
  chapterByKey: Map<string, BookNodeRow>;
  nextPosByParent: Map<string, number>;
}

@Injectable()
/**
 * Tầng SGK "Kết nối tri thức với cuộc sống" (K0b): nạp dataset sách đã
 * kiểm chứng vào cây sách + ánh xạ sang chương trình, đọc cây sách, và
 * cung cấp đơn vị khung SGK cho cơ chế nạp khung vào khoá của Courses.
 *
 * Nạp idempotent theo sổ đăng ký `book_records` (khoá
 * dataset + mã bản ghi, hash nội dung gồm cả danh sách ánh xạ) — cùng
 * kỷ luật với nạp chương trình của K0a. Khác biệt cốt lõi: trước khi
 * ghi bất cứ dòng nào, lượt nạp **phân giải toàn bộ mã ánh xạ** sang
 * node chương trình thật qua sổ đăng ký chương trình; mã nào không
 * phân giải được → lỗi cứng, không ghi dở (ánh xạ treo là lỗi dữ liệu,
 * không phải trạng thái chấp nhận được).
 *
 * Cổng quyền như K0a: quản trị dataset/cây sách cần `curriculum:view` /
 * `curriculum:manage` tại context hệ thống; đường đọc phục vụ chọn
 * khung cho một khoá (`forCourseId`) mở thêm nhánh `course:update` tại
 * khoá đích.
 */
export class BookService implements OnModuleInit {
  private readonly running = new Set<string>();

  constructor(
    private readonly repo: BookRepository,
    private readonly curriculumRepo: CurriculumRepository,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly courses: CoursesService,
  ) {}

  /** Khởi tạo: đăng ký nguồn đơn vị khung SGK cho cơ chế nạp khung vào khoá của Courses (dependency inversion như khung chương trình). */
  onModuleInit(): void {
    this.courses.registerBookFrameProvider({
      getBookFrameUnits: (actorId, bookId) => this.getBookFrameUnits(actorId, bookId),
    });
  }

  // --- nạp dataset ---------------------------------------------------------------

  /** Trạng thái nạp của mọi dataset SGK trong manifest (đọc cần curriculum:view tại context hệ thống). */
  async listDatasetStatus(actorId: string): Promise<BookDatasetStatus[]> {
    const sys = await this.contexts.ensureSystemContext();
    await this.evaluator.requireCapability(actorId, CURRICULUM_VIEW, sys.id);
    const out: BookDatasetStatus[] = [];
    for (const def of BOOK_DATASETS) {
      const file = loadBookDataset(def);
      const rows = await this.repo.listBookRecords(def.key);
      const subject = await this.curriculumRepo.getSubjectBySlug(def.slug);
      const book = subject ? await this.repo.findBook(subject.id, def.grade, def.bookTitle) : undefined;
      const last = rows.reduce<Date | null>((acc, r) => (acc === null || r.updatedAt > acc ? r.updatedAt : acc), null);
      out.push({
        datasetKey: def.key,
        subjectName: def.subjectName,
        slug: def.slug,
        bookTitle: def.bookTitle,
        grade: def.grade,
        totalRecords: file.records.length,
        importedRecords: rows.length,
        mappedRecords: file.records.filter((r) => r.programRecords.length > 0).length,
        bookId: book?.id ?? null,
        subjectId: subject?.id ?? null,
        lastImportedAt: last ? last.toISOString() : null,
      });
    }
    return out;
  }

  /** Nạp (hoặc nạp lại) một dataset SGK theo khoá. Cần curriculum:manage tại context hệ thống. */
  async importDataset(actorId: string, datasetKey: string): Promise<BookImportResult> {
    const def = bookDatasetByKey(datasetKey);
    if (!def) {
      throw new NotFoundException({ message: `Book dataset ${datasetKey} is not in the manifest`, code: 'book.dataset_not_found' });
    }
    const sys = await this.contexts.ensureSystemContext();
    await this.evaluator.requireCapability(actorId, CURRICULUM_MANAGE, sys.id);
    if (this.running.has(def.key)) {
      throw new ConflictException({ message: `Import of book dataset ${def.key} is already running`, code: 'book.import_in_progress' });
    }
    this.running.add(def.key);
    try {
      return await this.runImport(def, sys.id);
    } finally {
      this.running.delete(def.key);
    }
  }

  private async runImport(def: BookDatasetDef, systemContextId: string): Promise<BookImportResult> {
    const file = loadBookDataset(def);
    if (file.records.length === 0) {
      throw new BadRequestException({ message: `Book dataset ${def.key} has no records`, code: 'book.dataset_empty' });
    }
    // Phân giải TRƯỚC toàn bộ ánh xạ: mã bản ghi chương trình → node id.
    const nodeIdByProgramRecord = new Map<string, string>();
    const unresolved: string[] = [];
    for (const record of file.records) {
      for (const code of record.programRecords) {
        if (nodeIdByProgramRecord.has(code)) continue;
        const reg = await this.curriculumRepo.getProgramRecord(def.programDatasetKey, code);
        if (!reg) unresolved.push(code);
        else nodeIdByProgramRecord.set(code, reg.nodeId);
      }
    }
    if (unresolved.length > 0) {
      throw new BadRequestException({
        message: `Book dataset ${def.key} maps to program records that are not imported yet: ${[...new Set(unresolved)].join(', ')} (import the program dataset '${def.programDatasetKey}' first)`,
        code: 'book.mapping_unresolved',
      });
    }
    // Môn đích ở context hệ thống: tìm theo slug, chưa có thì tạo (như nạp chương trình).
    let subject = await this.curriculumRepo.getSubjectBySlug(def.slug);
    if (!subject) {
      subject = await this.curriculumRepo.insertSubject({
        contextId: systemContextId,
        name: def.subjectName,
        slug: def.slug,
        position: BOOK_DATASETS.indexOf(def) + 1,
      });
    }
    // Cuốn sách đích: tìm theo (môn, khối, tựa), chưa có thì tạo.
    let book = await this.repo.findBook(subject.id, def.grade, def.bookTitle);
    if (!book) {
      book = await this.repo.insertBook({ kind: 'textbook', subjectId: subject.id, grade: def.grade, title: def.bookTitle, series: file.series, publisher: file.publisher, attributionPublic: def.attributionPublic, position: 1 });
    }
    // Chỉ mục cây sách hiện có.
    const nodes = await this.repo.listBookNodes(book.id);
    const index: TreeIndex = { chapterByKey: new Map(), nextPosByParent: new Map() };
    for (const node of nodes) {
      if (node.kind === 'chapter') {
        // Khoá chương dựng lại từ dữ liệu node: volume|thứ tự chương suy từ position — xem ensureChapter.
        index.chapterByKey.set(`${node.volume ?? ''}|${node.title}`, node);
      }
      const key = node.parentId ?? '';
      index.nextPosByParent.set(key, Math.max(index.nextPosByParent.get(key) ?? 1, node.position + 1));
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let mappingsWritten = 0;
    for (const record of file.records) {
      const chapter = await this.ensureChapter(index, book.id, record);
      const hash = bookRecordHash(record);
      const reg = await this.repo.getBookRecord(def.key, record.id);
      if (reg && reg.contentHash === hash) {
        skipped += 1;
        continue;
      }
      const mappingNodeIds = record.programRecords.map((code) => nodeIdByProgramRecord.get(code)!);
      if (!reg) {
        const position = this.takePosition(index, chapter.id);
        await this.repo.dbHandle.transaction(async (tx) => {
          const lesson = await this.repo.insertBookNode({
            bookId: book.id, parentId: chapter.id, title: record.lesson, kind: 'lesson',
            volume: record.volume, lessonNumber: record.lessonNumber, position,
          }, tx as never);
          for (const [mi, nodeId] of mappingNodeIds.entries()) {
            await this.repo.insertMapping({ bookNodeId: lesson.id, curriculumNodeId: nodeId, learningOutcomeId: null, position: mi + 1 }, tx as never);
          }
          await this.repo.insertBookRecord({
            datasetKey: def.key, recordId: record.id, bookId: book.id,
            nodeId: lesson.id, contentHash: hash, source: record.source,
          }, tx as never);
        });
        created += 1;
        mappingsWritten += mappingNodeIds.length;
        continue;
      }
      // Dataset đã đính chính (hash lệch): cập nhật node bài + thay toàn bộ ánh xạ.
      await this.repo.dbHandle.transaction(async (tx) => {
        const current = await this.repo.getBookNode(reg.nodeId);
        const patch: { title: string; volume: number; lessonNumber: number | null; parentId?: string; position?: number } = {
          title: record.lesson, volume: record.volume, lessonNumber: record.lessonNumber,
        };
        if (current && current.parentId !== chapter.id) {
          patch.parentId = chapter.id;
          patch.position = this.takePosition(index, chapter.id);
        }
        await this.repo.updateBookNode(reg.nodeId, patch, tx as never);
        await this.repo.deleteMappingsForNode(reg.nodeId, tx as never);
        for (const [mi, nodeId] of mappingNodeIds.entries()) {
          await this.repo.insertMapping({ bookNodeId: reg.nodeId, curriculumNodeId: nodeId, learningOutcomeId: null, position: mi + 1 }, tx as never);
        }
        await this.repo.updateBookRecord(reg.id, {
          bookId: book.id, nodeId: reg.nodeId, contentHash: hash, source: record.source,
        }, tx as never);
      });
      updated += 1;
      mappingsWritten += mappingNodeIds.length;
    }
    return {
      datasetKey: def.key,
      bookId: book.id,
      subjectId: subject.id,
      totalRecords: file.records.length,
      created, updated, skipped, mappingsWritten,
    };
  }

  /** Tìm-tạo node chương (chủ đề) của một bản ghi trong cây sách; chương là node gốc, position = số thứ tự chương trong sách. */
  private async ensureChapter(index: TreeIndex, bookId: string, record: BookRecord): Promise<BookNodeRow> {
    const key = `${record.volume}|${record.chapter}`;
    const existing = index.chapterByKey.get(key);
    if (existing) return existing;
    const chapter = await this.repo.insertBookNode({
      bookId, parentId: null, title: record.chapter, kind: 'chapter',
      volume: record.volume, lessonNumber: null, position: record.chapterNumber,
    });
    index.chapterByKey.set(key, chapter);
    return chapter;
  }

  /** Cấp position tiếp theo dưới một node cha trong lượt nạp (giữ thứ tự dataset). */
  private takePosition(index: TreeIndex, parentId: string | null): number {
    const key = parentId ?? '';
    const position = index.nextPosByParent.get(key) ?? 1;
    index.nextPosByParent.set(key, position + 1);
    return position;
  }

  // --- đọc cây sách -----------------------------------------------------------------

  /** Liệt kê sách (lọc theo môn khi có); cổng đọc như danh sách môn của K0a. */
  async listBooks(actorId: string, subjectId?: string, forCourseId?: string, kind?: string): Promise<BookRow[]> {
    if (subjectId) {
      const subject = await this.subjectOr404(subjectId);
      await this.assertCanRead(actorId, subject.contextId, forCourseId);
      return this.repo.listBooks(subject.id, kind);
    }
    const sys = await this.contexts.ensureSystemContext();
    await this.evaluator.requireCapability(actorId, CURRICULUM_VIEW, sys.id);
    return this.repo.listBooks(undefined, kind);
  }

  /** Cây đầy đủ của một cuốn sách: chương → bài, mỗi bài kèm ánh xạ và YCCĐ suy qua ánh xạ. */
  async getBookTree(actorId: string, bookId: string, forCourseId?: string): Promise<BookTreeView> {
    const { book, subject } = await this.bookChainOr404(bookId);
    if (subject) {
      await this.assertCanRead(actorId, subject.contextId, forCourseId);
    } else {
      const sys = await this.contexts.ensureSystemContext();
      await this.evaluator.requireCapability(actorId, CURRICULUM_VIEW, sys.id);
    }
    return this.buildTree(book, subject);
  }

  /**
   * Truy nguồn chiều sách → câu: các câu hỏi ghi nguồn gốc từ cuốn
   * sách này (cặp truy vết source_kind='book'/source_ref). Cổng đọc
   * như cây sách. Đây là bề mặt NỘI BỘ phía giáo viên/quản trị —
   * trường nguồn sách không bao giờ lộ ở bề mặt học viên (quy tắc
   * bản quyền ở schema question).
   */
  async listBookQuestions(actorId: string, bookId: string) {
    const { book, subject } = await this.bookChainOr404(bookId);
    if (subject) {
      await this.assertCanRead(actorId, subject.contextId);
    } else {
      const sys = await this.contexts.ensureSystemContext();
      await this.evaluator.requireCapability(actorId, CURRICULUM_VIEW, sys.id);
    }
    return this.repo.listQuestionsByBookSource(book.id);
  }

  /**
   * Đơn vị khung SGK cho cơ chế nạp khung vào khoá: mỗi chương là một
   * đơn vị (thành section), các bài trong chương là mục, YCCĐ của mỗi
   * bài suy qua ánh xạ tại thời điểm gọi. Provider tin cậy cổng
   * `course:update` tại khoá đích do Courses kiểm trước (như K0a) —
   * hàm này không đòi thêm quyền.
   */
  async getBookFrameUnits(_actorId: string, bookId: string): Promise<{
    chapterNodeId: string; title: string;
    items: { lessonNodeId: string; title: string; outcomes: { outcomeId: string; content: string }[] }[];
  }[]> {
    const { book, subject } = await this.bookChainOr404(bookId);
    const tree = await this.buildTree(book, subject);
    return tree.chapters.map((chapter) => ({
      chapterNodeId: chapter.id,
      title: chapter.title,
      items: chapter.lessons.map((lesson) => ({
        lessonNodeId: lesson.id,
        title: lesson.title,
        outcomes: lesson.outcomes,
      })),
    }));
  }

  /** Dựng cây sách kèm ánh xạ + YCCĐ đã phân giải cho từng bài. */
  private async buildTree(book: BookRow, subject: SubjectRow | null): Promise<BookTreeView> {
    const nodes = await this.repo.listBookNodes(book.id);
    const chapters = nodes.filter((n) => n.kind === 'chapter');
    const lessons = nodes.filter((n) => n.kind === 'lesson');
    const mappings = await this.repo.listMappingsForNodes(lessons.map((l) => l.id));
    // Truy vết mã bản ghi chương trình: node chương trình → mã bản ghi (theo mọi dataset chương trình đã nạp của môn này).
    const programRecords = subject ? await this.curriculumRepo.listProgramRecordsBySubject(subject.id) : [];
    const recordIdByNodeId = new Map(programRecords.map((r) => [r.nodeId, r.recordId]));
    const registryByNodeId = new Map((await this.repo.listBookRecordsByBook(book.id)).map((r) => [r.nodeId, r.recordId]));
    // YCCĐ của các node chương trình được ánh xạ + tựa của chúng.
    const mappedNodeIds = [...new Set(mappings.map((m) => m.curriculumNodeId).filter((x): x is string => x !== null))];
    const outcomes = await this.curriculumRepo.listOutcomesForNodes(mappedNodeIds);
    const outcomesByNode = new Map<string, { outcomeId: string; content: string }[]>();
    for (const o of outcomes) {
      const list = outcomesByNode.get(o.nodeId) ?? [];
      list.push({ outcomeId: o.id, content: o.content });
      outcomesByNode.set(o.nodeId, list);
    }
    const nodeTitleById = new Map<string, string>();
    for (const nodeId of mappedNodeIds) {
      const node = await this.curriculumRepo.getNode(nodeId);
      if (node) nodeTitleById.set(nodeId, node.title);
    }
    const outcomeContentById = new Map(outcomes.map((o) => [o.id, o.content]));
    for (const m of mappings) {
      if (m.learningOutcomeId && !outcomeContentById.has(m.learningOutcomeId)) {
        const o = await this.curriculumRepo.getOutcome(m.learningOutcomeId);
        if (o) outcomeContentById.set(o.id, o.content);
      }
    }

    const lessonView = (lesson: BookNodeRow): BookLessonView => {
      const own = mappings.filter((m) => m.bookNodeId === lesson.id);
      const seen = new Set<string>();
      const resolved: { outcomeId: string; content: string }[] = [];
      for (const m of own) {
        const candidates = m.curriculumNodeId
          ? (outcomesByNode.get(m.curriculumNodeId) ?? [])
          : (m.learningOutcomeId ? [{ outcomeId: m.learningOutcomeId, content: outcomeContentById.get(m.learningOutcomeId) ?? '' }] : []);
        for (const c of candidates) {
          if (c.content === '' || seen.has(c.outcomeId)) continue;
          seen.add(c.outcomeId);
          resolved.push(c);
        }
      }
      return {
        id: lesson.id,
        title: lesson.title,
        volume: lesson.volume,
        lessonNumber: lesson.lessonNumber,
        position: lesson.position,
        recordId: registryByNodeId.get(lesson.id) ?? null,
        mappings: own.map((m) => ({
          curriculumNodeId: m.curriculumNodeId,
          learningOutcomeId: m.learningOutcomeId,
          programRecordId: m.curriculumNodeId ? (recordIdByNodeId.get(m.curriculumNodeId) ?? null) : null,
          targetTitle: m.curriculumNodeId
            ? (nodeTitleById.get(m.curriculumNodeId) ?? null)
            : (m.learningOutcomeId ? (outcomeContentById.get(m.learningOutcomeId) ?? null) : null),
        })),
        outcomes: resolved,
      };
    };

    return {
      book: book,
      subject: subject ? { id: subject.id, name: subject.name, slug: subject.slug } : null,
      chapters: chapters.map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        volume: chapter.volume,
        position: chapter.position,
        lessons: lessons.filter((l) => l.parentId === chapter.id).map(lessonView),
      })),
    };
  }

  // --- helpers -----------------------------------------------------------------------

  private async subjectOr404(id: string): Promise<SubjectRow> {
    const row = await this.curriculumRepo.getSubject(id);
    if (!row) {
      throw new NotFoundException({ message: `Subject ${id} was not found`, code: 'curriculum.subject_not_found' });
    }
    return row;
  }

  private async bookChainOr404(id: string): Promise<{ book: BookRow; subject: SubjectRow | null }> {
    const book = await this.repo.getBook(id);
    if (!book) {
      throw new NotFoundException({ message: `Book ${id} was not found`, code: 'book.not_found' });
    }
    // Môn trên sách chỉ là metadata mô tả — sách không gắn môn thì không có chuỗi môn để truy.
    const subject = book.subjectId ? await this.subjectOr404(book.subjectId) : null;
    return { book, subject };
  }

  /** Cổng đọc dùng chung: curriculum:view tại context của môn, hoặc course:update tại khoá đích khi kèm forCourseId (như CurriculumService). */
  private async assertCanRead(actorId: string, subjectContextId: string, forCourseId?: string): Promise<void> {
    if (await this.evaluator.hasCapability(actorId, CURRICULUM_VIEW, subjectContextId)) return;
    if (forCourseId) {
      const courseCtxId = await this.courses.courseContextId(forCourseId).catch(() => undefined);
      if (courseCtxId && (await this.evaluator.hasCapability(actorId, COURSE_UPDATE, courseCtxId))) return;
    }
    await this.evaluator.requireCapability(actorId, CURRICULUM_VIEW, subjectContextId);
  }
}

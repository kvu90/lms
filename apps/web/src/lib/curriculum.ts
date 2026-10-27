import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiJson } from '#lib/api';
import { queryKeys } from './query-keys';

/**
 * Kiểu + lời gọi API dùng chung cho chương trình GDPT 2018 (K0a):
 * trang quản trị chương trình, khối chọn khung khi tạo khoá và panel
 * nạp khung trong quản trị khoá cùng đọc một hình dạng cây.
 * Chương trình quốc gia neo ở context hệ thống (contextLevel 10) —
 * cùng cách khối Chương trình trong editor câu hỏi đang đọc.
 *
 * Phần cuối module là tầng TanStack Query (F-01 của rà soát #133)
 * bọc đúng các lời gọi ở đây: các trang đọc chương trình qua hook với
 * khoá theo (context/khoá) — ngữ cảnh khoá là một phần của khoá vì
 * cùng một môn có thể đọc được hay bị 403 tuỳ khoá đang neo quyền.
 */

export interface CurriculumSubject {
  id: string;
  contextId: string;
  name: string;
  slug: string;
  position: number;
}

export interface Curriculum {
  id: string;
  subjectId: string;
  grade: number;
}

export interface CurriculumOutcome {
  id: string;
  content: string;
  position: number;
  sourceKind: string;
  sourceRef: string | null;
  derivedFromId: string | null;
}

export interface CurriculumTreeNode {
  id: string;
  curriculumId: string;
  parentId: string | null;
  title: string;
  kind: string;
  position: number;
  durationPeriods: number | null;
  durationPercent: number | null;
  outcomes: CurriculumOutcome[];
  children: CurriculumTreeNode[];
}

export interface CurriculumTree {
  curriculum: Curriculum;
  subject: CurriculumSubject;
  nodes: CurriculumTreeNode[];
}

/** Id của context hệ thống (nơi neo cây chương trình quốc gia). */
export async function fetchSystemContextId(): Promise<string | null> {
  const contexts = await apiJson<{ id: string; contextLevel: number }[]>('/api/v1/access/contexts');
  return contexts.find((c) => c.contextLevel === 10)?.id ?? null;
}

/**
 * Môn học trong context hệ thống. Kèm `forCourseId` (bề mặt chọn khung
 * trong quản trị khoá): API còn chấp nhận nhánh course:update tại chính
 * khoá đó cho giáo viên cấp khoá không có curriculum:view hệ thống.
 */
export async function fetchSubjects(contextId: string, forCourseId?: string): Promise<CurriculumSubject[]> {
  const frame = forCourseId ? `&forCourseId=${forCourseId}` : '';
  return apiJson<CurriculumSubject[]>(`/api/v1/curriculum/subjects?contextId=${contextId}${frame}`);
}

/** Các chương trình (theo khối) của một môn. */
export async function fetchCurricula(subjectId: string, forCourseId?: string): Promise<Curriculum[]> {
  const frame = forCourseId ? `&forCourseId=${forCourseId}` : '';
  return apiJson<Curriculum[]>(`/api/v1/curriculum/curricula?subjectId=${subjectId}${frame}`);
}

/** Cây nội dung trọn vẹn của một chương trình. */
export async function fetchTree(curriculumId: string, forCourseId?: string): Promise<CurriculumTree> {
  const frame = forCourseId ? `?forCourseId=${forCourseId}` : '';
  return apiJson<CurriculumTree>(`/api/v1/curriculum/curricula/${curriculumId}/tree${frame}`);
}

/** Tuỳ chọn truy vấn môn chương trình trong context hệ thống kèm ngữ cảnh khoá. */
export function curriculumSubjectsScopedQueryOptions(contextId: string, forCourseId?: string) {
  return queryOptions({
    queryKey: queryKeys.curriculumSubjectsScoped(contextId, forCourseId ?? null),
    queryFn: () => fetchSubjects(contextId, forCourseId),
  });
}

/**
 * Hook đọc môn chương trình cho các bề mặt xem/nạp khung: chưa có
 * context hệ thống thì chưa gọi API (trang tự suy trạng thái rỗng).
 * Lỗi (kể cả 403 thiếu quyền đọc) nổi lên query để trang xử lý.
 */
export function useCurriculumSubjectsScoped(contextId: string | null, forCourseId?: string) {
  return useQuery({
    ...curriculumSubjectsScopedQueryOptions(contextId ?? '', forCourseId),
    enabled: contextId !== null,
  });
}

/** Tuỳ chọn truy vấn các chương trình của một môn kèm ngữ cảnh khoá. */
export function curriculumCurriculaScopedQueryOptions(subjectId: string, forCourseId?: string) {
  return queryOptions({
    queryKey: queryKeys.curriculumCurriculaScoped(subjectId, forCourseId ?? null),
    queryFn: () => fetchCurricula(subjectId, forCourseId),
  });
}

/** Hook đọc các chương trình (theo khối) của môn đang chọn; chưa chọn môn thì chưa gọi API. */
export function useCurriculumCurriculaScoped(subjectId: string, forCourseId?: string) {
  return useQuery({
    ...curriculumCurriculaScopedQueryOptions(subjectId, forCourseId),
    enabled: subjectId !== '',
  });
}

/** Tuỳ chọn truy vấn cây chương trình kèm ngữ cảnh khoá. */
export function curriculumTreeScopedQueryOptions(curriculumId: string, forCourseId?: string) {
  return queryOptions({
    queryKey: queryKeys.curriculumTreeScoped(curriculumId, forCourseId ?? null),
    queryFn: () => fetchTree(curriculumId, forCourseId),
  });
}

/** Hook đọc cây chương trình của chương trình đang chọn; chưa chọn thì chưa gọi API. */
export function useCurriculumTreeScoped(curriculumId: string, forCourseId?: string) {
  return useQuery({
    ...curriculumTreeScopedQueryOptions(curriculumId, forCourseId),
    enabled: curriculumId !== '',
  });
}

/** Tuỳ chọn truy vấn đơn vị khung chọn được của cặp (môn, khối) kèm ngữ cảnh khoá. */
export function curriculumFrameUnitsQueryOptions(subjectId: string, grade: number, forCourseId?: string) {
  return queryOptions({
    queryKey: queryKeys.curriculumFrameUnits(subjectId, grade, forCourseId ?? null),
    queryFn: () => fetchFrameUnitsFor(subjectId, grade, forCourseId),
  });
}

/**
 * Hook đọc đơn vị khung cho các bộ chọn khung (wizard tạo khoá, panel
 * nạp khung): chưa đủ (môn, khối) thì chưa gọi API và coi như chưa có
 * khung nào để chọn.
 */
export function useCurriculumFrameUnits(subjectId: string, grade: number | null, forCourseId?: string) {
  return useQuery({
    ...curriculumFrameUnitsQueryOptions(subjectId, grade ?? 0, forCourseId),
    enabled: subjectId !== '' && grade !== null,
  });
}

/** Một đơn vị khung chọn được khi nạp khung vào khoá: node không phải `lesson` + số YCCĐ trong subtree. */
export interface FrameUnit {
  nodeId: string;
  title: string;
  kind: string;
  depth: number;
  outcomeCount: number;
  /**
   * YCCĐ của các bài (lesson) mà đơn vị này là tổ tiên-không-phải-lesson
   * gần nhất — để bề mặt chọn khung trình bày theo mẫu Bộ (Nội dung |
   * Yêu cầu cần đạt) mà không nhân bản một YCCĐ lên nhiều đơn vị tổ tiên.
   */
  outcomeTexts: { lesson: string; texts: string[] }[];
}

function countOutcomes(node: CurriculumTreeNode): number {
  return node.outcomes.length + node.children.reduce((n, c) => n + countOutcomes(c), 0);
}

/** Làm phẳng cây thành danh sách đơn vị khung theo thứ tự duyệt cây (cha trước con). */
export function flattenFrameUnits(nodes: CurriculumTreeNode[], depth = 0, out: FrameUnit[] = []): FrameUnit[] {
  for (const node of nodes) {
    let unit: FrameUnit | null = null;
    if (node.kind !== 'lesson') {
      unit = {
        nodeId: node.id, title: node.title, kind: node.kind, depth,
        outcomeCount: countOutcomes(node), outcomeTexts: [],
      };
      out.push(unit);
    }
    collectFrameUnits(node, depth, out, unit);
  }
  return out;
}

function collectFrameUnits(
  node: CurriculumTreeNode,
  depth: number,
  out: FrameUnit[],
  currentUnit: FrameUnit | null,
): void {
  for (const child of node.children) {
    if (child.kind === 'lesson') {
      if (currentUnit && child.outcomes.length > 0) {
        currentUnit.outcomeTexts.push({ lesson: child.title, texts: child.outcomes.map((o) => o.content) });
      }
      collectFrameUnits(child, depth + 1, out, currentUnit);
      continue;
    }
    const unit: FrameUnit = {
      nodeId: child.id, title: child.title, kind: child.kind, depth: depth + 1,
      outcomeCount: countOutcomes(child), outcomeTexts: [],
    };
    out.push(unit);
    collectFrameUnits(child, depth + 1, out, unit);
  }
}

/**
 * Đơn vị khung của cặp (môn, khối): không có chương trình cho khối đó
 * thì trả curriculumId null + danh sách rỗng (khoá vẫn tạo/nạp bình
 * thường, chỉ là chưa có khung để chọn).
 */
export async function fetchFrameUnitsFor(
  subjectId: string,
  grade: number,
  forCourseId?: string,
): Promise<{ curriculumId: string | null; units: FrameUnit[] }> {
  const curricula = await fetchCurricula(subjectId, forCourseId);
  const curriculum = curricula.find((c) => c.grade === grade);
  if (!curriculum) return { curriculumId: null, units: [] };
  const tree = await fetchTree(curriculum.id, forCourseId);
  return { curriculumId: curriculum.id, units: flattenFrameUnits(tree.nodes) };
}

// --- Tầng SGK "Kết nối tri thức với cuộc sống" (K0b) ---------------------------

/** Trạng thái nạp của một dataset SGK trong manifest phía máy chủ. */
export interface BookDatasetStatus {
  datasetKey: string;
  subjectName: string;
  slug: string;
  bookTitle: string;
  grade: number;
  totalRecords: number;
  importedRecords: number;
  mappedRecords: number;
  bookId: string | null;
  subjectId: string | null;
  lastImportedAt: string | null;
}

/** Một cuốn SGK đã nạp. */
export interface Book {
  id: string;
  kind: string;
  title: string;
  subjectId: string | null;
  grade: number | null;
  series: string | null;
  author: string | null;
  publisher: string | null;
  publishedYear: number | null;
  isbn: string | null;
  attributionPublic: boolean;
  position: number;
}

/** Một đích ánh xạ của một bài SGK (mã bản ghi chương trình để truy vết). */
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

/** Cây đầy đủ của một cuốn SGK: chủ đề → bài. */
export interface BookTree {
  book: Book;
  subject: { id: string; name: string; slug: string } | null;
  chapters: {
    id: string;
    title: string;
    volume: number | null;
    position: number;
    lessons: BookLessonView[];
  }[];
}

/** Trạng thái nạp của mọi dataset SGK (bề mặt quản trị — cần curriculum:view hệ thống). */
export async function fetchBookDatasetStatus(): Promise<BookDatasetStatus[]> {
  return apiJson<BookDatasetStatus[]>('/api/v1/books/dataset-import');
}

/** Danh sách SGK đã nạp; kèm subjectId lọc theo môn, forCourseId mở nhánh chọn khung cho khoá. */
export async function fetchBooks(subjectId?: string, forCourseId?: string): Promise<Book[]> {
  const params = new URLSearchParams();
  if (subjectId) params.set('subjectId', subjectId);
  if (forCourseId) params.set('forCourseId', forCourseId);
  const query = params.toString();
  return apiJson<Book[]>(`/api/v1/books${query ? `?${query}` : ''}`);
}

/** Cây sách đầy đủ của một cuốn SGK. */
export async function fetchBookTree(bookId: string, forCourseId?: string): Promise<BookTree> {
  const frame = forCourseId ? `?forCourseId=${forCourseId}` : '';
  return apiJson<BookTree>(`/api/v1/books/${bookId}/tree${frame}`);
}

/** Một đơn vị khung SGK chọn được: một chủ đề + số bài + số YCCĐ suy qua ánh xạ của cả chủ đề. */
export interface BookFrameChapter {
  nodeId: string;
  title: string;
  lessonCount: number;
  outcomeCount: number;
}

/**
 * Đơn vị khung SGK của cặp (môn, khối): không có cuốn sách nào cho
 * khối đó thì trả bookId null + danh sách rỗng.
 */
export async function fetchBookFrameChaptersFor(
  subjectId: string,
  grade: number,
  forCourseId?: string,
): Promise<{ bookId: string | null; chapters: BookFrameChapter[] }> {
  const books = await fetchBooks(subjectId, forCourseId);
  const book = books.find((b) => b.grade === grade);
  if (!book) return { bookId: null, chapters: [] };
  const tree = await fetchBookTree(book.id, forCourseId);
  return {
    bookId: book.id,
    chapters: tree.chapters.map((chapter) => {
      const outcomeIds = new Set<string>();
      for (const lesson of chapter.lessons) {
        for (const outcome of lesson.outcomes) outcomeIds.add(outcome.outcomeId);
      }
      return {
        nodeId: chapter.id,
        title: chapter.title,
        lessonCount: chapter.lessons.length,
        outcomeCount: outcomeIds.size,
      };
    }),
  };
}

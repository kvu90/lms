import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
 * `contextId` vắng thì không kèm tham số — API mặc định về context hệ
 * thống (điểm nghẽn D-3 của issue #233: trang /curriculum không còn
 * bắt buộc đọc được `/access/contexts` mới xem được chương trình).
 */
export async function fetchSubjects(contextId?: string, forCourseId?: string): Promise<CurriculumSubject[]> {
  const params = new URLSearchParams();
  if (contextId) params.set('contextId', contextId);
  if (forCourseId) params.set('forCourseId', forCourseId);
  const query = params.toString();
  return apiJson<CurriculumSubject[]>(`/api/v1/curriculum/subjects${query ? `?${query}` : ''}`);
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
 * context hệ thống VÀ chưa có khoá thì chưa gọi API (trang tự suy
 * trạng thái rỗng); có khoá thì gọi ngay cả khi chưa đọc được context
 * hệ thống — API mặc định về hệ thống và mở nhánh theo khoá (trang
 * /curriculum không còn tắc vì 403 ở `/access/contexts`).
 * Lỗi (kể cả 403 thiếu quyền đọc) nổi lên query để trang xử lý.
 * `enabled` cho phép trang chờ thêm điều kiện riêng (ví dụ danh sách
 * khoá neo quyền xem phải về trước).
 */
export function useCurriculumSubjectsScoped(contextId: string | null, forCourseId?: string, enabled = true) {
  return useQuery({
    ...curriculumSubjectsScopedQueryOptions(contextId ?? '', forCourseId),
    enabled: enabled && (contextId !== null || forCourseId !== undefined),
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
export function useCurriculumCurriculaScoped(subjectId: string, forCourseId?: string, enabled = true) {
  return useQuery({
    ...curriculumCurriculaScopedQueryOptions(subjectId, forCourseId),
    enabled: enabled && subjectId !== '',
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
export function useCurriculumTreeScoped(curriculumId: string, forCourseId?: string, enabled = true) {
  return useQuery({
    ...curriculumTreeScopedQueryOptions(curriculumId, forCourseId),
    enabled: enabled && curriculumId !== '',
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

// --- Tầng quản trị chương trình (F-01 của rà soát #133) -----------------------
//
// Trang quản trị chương trình + các màn riêng (môn, chương trình,
// node, YCCĐ, cây) đọc/ghi qua các hook dưới đây. Mọi đột biến làm
// mới đúng cụm khoá bị ảnh hưởng: danh sách môn/cây theo tiền tố có
// phạm vi, trạng thái dataset và danh sách sách theo khoá của chúng.

/** Trạng thái nạp của một dataset chương trình chuẩn trong manifest phía máy chủ. */
export interface ProgramDatasetStatus {
  datasetKey: string;
  subjectName: string;
  slug: string;
  grades: number[];
  totalRecords: number;
  importedRecords: number;
  subjectId: string | null;
  lastImportedAt: string | null;
}

/** Trạng thái các dataset chương trình chuẩn (GET /curriculum/program-import). */
export async function fetchProgramDatasetStatus(): Promise<ProgramDatasetStatus[]> {
  return apiJson<ProgramDatasetStatus[]>('/api/v1/curriculum/program-import');
}

/** Tuỳ chọn truy vấn trạng thái dataset chương trình chuẩn. */
export function programDatasetStatusQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.programDatasetStatus,
    queryFn: () => fetchProgramDatasetStatus(),
  });
}

/** Hook đọc trạng thái dataset chương trình cho trang quản trị. */
export function useProgramDatasetStatus() {
  return useQuery(programDatasetStatusQueryOptions());
}

/** Tuỳ chọn truy vấn trạng thái dataset SGK (GET /books/dataset-import). */
export function bookDatasetStatusQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.bookDatasetStatus,
    queryFn: () => fetchBookDatasetStatus(),
  });
}

/** Hook đọc trạng thái dataset SGK cho trang quản trị. */
export function useBookDatasetStatus() {
  return useQuery(bookDatasetStatusQueryOptions());
}

/** Tuỳ chọn truy vấn danh sách SGK đã nạp (GET /books). */
export function booksQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.books,
    queryFn: () => fetchBooks(),
  });
}

/** Hook đọc danh sách SGK cho trang quản trị. */
export function useBooks() {
  return useQuery(booksQueryOptions());
}

/** Tuỳ chọn truy vấn cây của một cuốn SGK (GET /books/:id/tree). */
export function bookTreeQueryOptions(bookId: string) {
  return queryOptions({
    queryKey: queryKeys.bookTree(bookId),
    queryFn: () => fetchBookTree(bookId),
  });
}

/** Hook đọc cây sách — chỉ tải khi bề mặt cần (mở một cuốn sách). */
export function useBookTree(bookId: string, enabled: boolean) {
  return useQuery({ ...bookTreeQueryOptions(bookId), enabled });
}

/** Tuỳ chọn truy vấn một môn theo id (GET /curriculum/subjects/:id). */
export function curriculumSubjectRowQueryOptions(subjectId: string) {
  return queryOptions({
    queryKey: queryKeys.curriculumSubjectRow(subjectId),
    queryFn: () => apiJson<CurriculumSubject>(`/api/v1/curriculum/subjects/${subjectId}`),
  });
}

/** Hook đọc một môn cho màn sửa môn; lỗi tải nổi lên query (màn giữ trạng thái đang tải như trước). */
export function useCurriculumSubjectRow(subjectId: string | undefined) {
  return useQuery({
    ...curriculumSubjectRowQueryOptions(subjectId ?? ''),
    enabled: subjectId !== undefined,
  });
}

/** Tuỳ chọn truy vấn một chương trình theo id (GET /curriculum/curricula/:id). */
export function curriculumRowQueryOptions(curriculumId: string) {
  return queryOptions({
    queryKey: queryKeys.curriculumRow(curriculumId),
    queryFn: () => apiJson<Curriculum>(`/api/v1/curriculum/curricula/${curriculumId}`),
  });
}

/** Hook đọc một chương trình cho màn sửa chương trình. */
export function useCurriculumRow(curriculumId: string | undefined) {
  return useQuery({
    ...curriculumRowQueryOptions(curriculumId ?? ''),
    enabled: curriculumId !== undefined,
  });
}

/** Một node chương trình theo hình dạng các màn node/YCCĐ tiêu thụ (GET /curriculum/nodes/:id). */
export interface CurriculumNodeRow {
  id: string;
  curriculumId: string;
  parentId: string | null;
  title: string;
  kind: string;
  position: number;
  durationPeriods: number | null;
  durationPercent: number | null;
}

/** Tuỳ chọn truy vấn một node theo id. */
export function curriculumNodeQueryOptions(nodeId: string) {
  return queryOptions({
    queryKey: queryKeys.curriculumNode(nodeId),
    queryFn: () => apiJson<CurriculumNodeRow>(`/api/v1/curriculum/nodes/${nodeId}`),
  });
}

/** Hook đọc một node cho các màn sửa node và tạo/sửa YCCĐ. */
export function useCurriculumNode(nodeId: string | undefined) {
  return useQuery({
    ...curriculumNodeQueryOptions(nodeId ?? ''),
    enabled: nodeId !== undefined,
  });
}

/** Một YCCĐ theo hình dạng màn sửa YCCĐ tiêu thụ (GET /curriculum/outcomes/:id). */
export interface CurriculumOutcomeRow {
  id: string;
  nodeId: string;
  content: string;
  position: number;
  sourceKind: string;
  sourceRef: string | null;
  derivedFromId: string | null;
}

/** Tuỳ chọn truy vấn một YCCĐ theo id. */
export function curriculumOutcomeQueryOptions(outcomeId: string) {
  return queryOptions({
    queryKey: queryKeys.curriculumOutcome(outcomeId),
    queryFn: () => apiJson<CurriculumOutcomeRow>(`/api/v1/curriculum/outcomes/${outcomeId}`),
  });
}

/** Hook đọc một YCCĐ cho màn sửa YCCĐ. */
export function useCurriculumOutcome(outcomeId: string | undefined) {
  return useQuery({
    ...curriculumOutcomeQueryOptions(outcomeId ?? ''),
    enabled: outcomeId !== undefined,
  });
}

/** Tiền tố khoá của mọi danh sách môn theo ngữ cảnh (để làm mới sau đột biến quản trị). */
const SUBJECTS_SCOPED_PREFIX = ['curriculum', 'subjects', 'scoped'] as const;
/** Tiền tố khoá của mọi danh sách chương trình theo môn (để làm mới sau đột biến quản trị). */
const CURRICULA_SCOPED_PREFIX = ['curriculum', 'curricula', 'scoped'] as const;
/** Tiền tố khoá của mọi cây chương trình (để làm mới sau đột biến quản trị). */
const TREE_SCOPED_PREFIX = ['curriculum', 'tree', 'scoped'] as const;

/** Kết quả một lượt đồng bộ dataset chương trình (POST /curriculum/program-import). */
export interface ProgramImportResult {
  created: number;
  updated: number;
  skipped: number;
  outcomesWritten: number;
  totalRecords: number;
  orphanedNodes: number;
  retiredOutcomes: number;
  changeCounts: { textChanged: number; added: number; removed: number; moved: number; revived: number; shiftSuspected: number };
  changes: {
    recordId: string;
    position: number;
    kind: 'text-changed' | 'added' | 'removed' | 'moved' | 'revived';
    oldText?: string;
    newText?: string;
    shiftSuspected?: boolean;
    identicalTextAmbiguous?: boolean;
    linkedQuestions?: number;
    linkedBookMappings?: number;
  }[];
  changesOmitted: number;
}

/**
 * Đột biến đồng bộ một dataset chương trình chuẩn vào cây (POST
 * /curriculum/program-import, idempotent phía API) — thành công thì
 * làm mới trạng thái dataset, danh sách môn và mọi cây.
 */
export function useImportProgramDataset() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (datasetKey: string) =>
      apiJson<ProgramImportResult>('/api/v1/curriculum/program-import', {
        method: 'POST',
        body: JSON.stringify({ datasetKey }),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.programDatasetStatus });
      void client.invalidateQueries({ queryKey: SUBJECTS_SCOPED_PREFIX });
      void client.invalidateQueries({ queryKey: TREE_SCOPED_PREFIX });
    },
  });
}

/** Kết quả một lượt đồng bộ dataset SGK (POST /books/dataset-import). */
export interface BookImportResult {
  created: number;
  updated: number;
  skipped: number;
  mappingsWritten: number;
  totalRecords: number;
}

/**
 * Đột biến đồng bộ một dataset SGK vào cây sách + ánh xạ (POST
 * /books/dataset-import, idempotent phía API) — thành công thì làm
 * mới trạng thái dataset sách và danh sách sách.
 */
export function useImportBookDataset() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (datasetKey: string) =>
      apiJson<BookImportResult>('/api/v1/books/dataset-import', {
        method: 'POST',
        body: JSON.stringify({ datasetKey }),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.bookDatasetStatus });
      void client.invalidateQueries({ queryKey: queryKeys.books });
      void client.invalidateQueries({ queryKey: ['books'] });
    },
  });
}

/** Đột biến xoá một môn (DELETE /curriculum/subjects/:id, cascade toàn bộ chương trình của môn). */
export function useDeleteCurriculumSubject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (subjectId: string) =>
      apiJson(`/api/v1/curriculum/subjects/${subjectId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: SUBJECTS_SCOPED_PREFIX });
      void client.invalidateQueries({ queryKey: queryKeys.curriculumSubjects });
    },
  });
}

/** Đột biến xoá một chương trình (DELETE /curriculum/curricula/:id, cascade cây node + YCCĐ của khối đó). */
export function useDeleteCurriculumRow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (curriculumId: string) =>
      apiJson(`/api/v1/curriculum/curricula/${curriculumId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: CURRICULA_SCOPED_PREFIX });
      void client.invalidateQueries({ queryKey: ['curriculum', 'curricula'] });
    },
  });
}

/**
 * Đột biến tạo môn mới (POST /curriculum/subjects): môn neo ở context
 * hệ thống nên trước hết tra id context đó qua tầng contexts — giữ
 * nguyên hai bước như bản thủ công của form môn.
 */
export function useCreateCurriculumSubject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; slug: string; position: number }) => {
      const contextId = await fetchSystemContextId();
      if (!contextId) throw new Error('no system context');
      return apiJson<CurriculumSubject>('/api/v1/curriculum/subjects', {
        method: 'POST',
        body: JSON.stringify({ contextId, ...body }),
      });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: SUBJECTS_SCOPED_PREFIX });
      void client.invalidateQueries({ queryKey: queryKeys.curriculumSubjects });
    },
  });
}

/** Đột biến sửa môn (PATCH /curriculum/subjects/:id). */
export function useUpdateCurriculumSubject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ subjectId, body }: { subjectId: string; body: { name: string; slug: string; position: number } }) =>
      apiJson<CurriculumSubject>(`/api/v1/curriculum/subjects/${subjectId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: (_data, vars) => {
      void client.invalidateQueries({ queryKey: SUBJECTS_SCOPED_PREFIX });
      void client.invalidateQueries({ queryKey: queryKeys.curriculumSubjects });
      void client.invalidateQueries({ queryKey: queryKeys.curriculumSubjectRow(vars.subjectId) });
    },
  });
}

/** Đột biến tạo chương trình cho một môn (POST /curriculum/curricula). */
export function useCreateCurriculumRow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { subjectId: string | undefined; grade: number }) =>
      apiJson<Curriculum>('/api/v1/curriculum/curricula', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: CURRICULA_SCOPED_PREFIX });
      void client.invalidateQueries({ queryKey: ['curriculum', 'curricula'] });
    },
  });
}

/** Đột biến sửa khối của một chương trình (PATCH /curriculum/curricula/:id). */
export function useUpdateCurriculumRow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ curriculumId, grade }: { curriculumId: string; grade: number }) =>
      apiJson<Curriculum>(`/api/v1/curriculum/curricula/${curriculumId}`, {
        method: 'PATCH',
        body: JSON.stringify({ grade }),
      }),
    onSuccess: (_data, vars) => {
      void client.invalidateQueries({ queryKey: CURRICULA_SCOPED_PREFIX });
      void client.invalidateQueries({ queryKey: ['curriculum', 'curricula'] });
      void client.invalidateQueries({ queryKey: queryKeys.curriculumRow(vars.curriculumId) });
    },
  });
}

/** Thân ghi của một node chương trình (tạo/sửa dùng chung một hình dạng). */
export interface CurriculumNodePayload {
  title: string;
  kind: string;
  parentId: string | null;
  position: number;
  durationPeriods: number | null;
  durationPercent: number | null;
}

/** Đột biến tạo node (POST /curriculum/nodes) — thành công thì làm mới cây chứa node. */
export function useCreateCurriculumNode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ curriculumId, payload }: { curriculumId: string; payload: CurriculumNodePayload }) =>
      apiJson<CurriculumNodeRow>('/api/v1/curriculum/nodes', {
        method: 'POST',
        body: JSON.stringify({ curriculumId, ...payload }),
      }),
    onSuccess: (_data, vars) => {
      void client.invalidateQueries({
        queryKey: queryKeys.curriculumTreeScoped(vars.curriculumId, null),
      });
      void client.invalidateQueries({ queryKey: ['curriculum', 'tree'] });
    },
  });
}

/** Đột biến sửa node (PATCH /curriculum/nodes/:id) — thành công thì làm mới cây chứa node và chính node. */
export function useUpdateCurriculumNode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, payload }: { nodeId: string; payload: CurriculumNodePayload }) =>
      apiJson<CurriculumNodeRow>(`/api/v1/curriculum/nodes/${nodeId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: (data, vars) => {
      void client.invalidateQueries({
        queryKey: queryKeys.curriculumTreeScoped(data.curriculumId, null),
      });
      void client.invalidateQueries({ queryKey: ['curriculum', 'tree'] });
      void client.invalidateQueries({ queryKey: queryKeys.curriculumNode(vars.nodeId) });
    },
  });
}

/** Đột biến xoá node (DELETE /curriculum/nodes/:id) ở trang cây — thành công thì làm mới cây đó. */
export function useDeleteCurriculumNode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (nodeId: string) => apiJson(`/api/v1/curriculum/nodes/${nodeId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: TREE_SCOPED_PREFIX });
      void client.invalidateQueries({ queryKey: ['curriculum', 'tree'] });
    },
  });
}

/** Thân ghi của một YCCĐ (tạo/sửa dùng chung một hình dạng). */
export interface CurriculumOutcomePayload {
  content: string;
  position: number;
  sourceKind: string;
  sourceRef: string | null;
  derivedFromId: string | null;
}

/** Đột biến tạo YCCĐ cho một node (POST /curriculum/outcomes) — YCCĐ hiện trong cây nên làm mới mọi cây. */
export function useCreateCurriculumOutcome() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, payload }: { nodeId: string; payload: CurriculumOutcomePayload }) =>
      apiJson<CurriculumOutcomeRow>('/api/v1/curriculum/outcomes', {
        method: 'POST',
        body: JSON.stringify({ nodeId, ...payload }),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: TREE_SCOPED_PREFIX });
      void client.invalidateQueries({ queryKey: ['curriculum', 'tree'] });
    },
  });
}

/** Đột biến sửa YCCĐ (PATCH /curriculum/outcomes/:id). */
export function useUpdateCurriculumOutcome() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ outcomeId, payload }: { outcomeId: string; payload: CurriculumOutcomePayload }) =>
      apiJson<CurriculumOutcomeRow>(`/api/v1/curriculum/outcomes/${outcomeId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: (_data, vars) => {
      void client.invalidateQueries({ queryKey: TREE_SCOPED_PREFIX });
      void client.invalidateQueries({ queryKey: ['curriculum', 'tree'] });
      void client.invalidateQueries({ queryKey: queryKeys.curriculumOutcome(vars.outcomeId) });
    },
  });
}

/** Đột biến xoá YCCĐ (DELETE /curriculum/outcomes/:id) ở trang cây — thành công thì làm mới mọi cây. */
export function useDeleteCurriculumOutcome() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (outcomeId: string) =>
      apiJson(`/api/v1/curriculum/outcomes/${outcomeId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: TREE_SCOPED_PREFIX });
      void client.invalidateQueries({ queryKey: ['curriculum', 'tree'] });
    },
  });
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

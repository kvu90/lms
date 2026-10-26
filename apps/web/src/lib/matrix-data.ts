import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, apiJson } from './api';
import { queryKeys } from './query-keys';

/**
 * Tầng dữ liệu màn ma trận (tạo/sửa) trong ngân hàng ma trận (F-01
 * đợt 1, rà soát #133): options dùng chung cho hook của trang và
 * clientLoader của route module (prefetch cùng khoá).
 */

export interface SubjectLite {
  id: string;
  name: string;
}
export interface CurriculumLite {
  id: string;
  subjectId: string;
  grade: number;
}
export interface BankLite {
  id: string;
  scope: string;
}
export interface CellLite {
  id: string;
  curriculumNodeId: string;
  cognitiveLevel: string;
  qtype: string;
  questionCount: number;
  cellScore: number;
}
export interface MatrixLite {
  id: string;
  name: string;
  subjectId: string;
  curriculumId: string;
  bankId: string | null;
  status: string;
  isTemplate: boolean;
  version: number;
  presetKind: string;
  levelSet: string;
  totalScore: number;
  cells: CellLite[];
}
export interface AvailabilityLite {
  sufficient: boolean;
  cells: { cellId: string; required: number; available: number; deficit: number }[];
}

/** Một YCCĐ thuộc ĐVK trong bản đặc tả suy ra (cột "Yêu cầu cần đạt"). */
export interface SpecificationOutcomeLite {
  outcomeId: string;
  content: string;
  sourceKind: string;
  sourceRef: string | null;
  programContent: string | null;
  derivedContent: string | null;
}

/** Một ô ma trận trong bản đặc tả suy ra. */
export interface SpecificationCellLite {
  cellId: string;
  cognitiveLevel: string;
  qtype: string;
  questionCount: number;
  cellScore: number;
  minutes: number | null;
  slotNumbers: number[] | null;
  drawNote: string | null;
}

/**
 * View model bản đặc tả (SPEC-1, issue #233): bảng SUY RA từ các ô của
 * ma trận — ô neo ĐVK × mức × dạng; cột YCCĐ lấy từ các YCCĐ thuộc ĐVK
 * của ô (ô KHÔNG neo YCCĐ). Cùng hình dạng API dùng cho export xlsx/docx.
 */
export interface MatrixSpecificationLite {
  matrix: { id: string; name: string; totalScore: number; levelSet: string };
  subject: { id: string; name: string };
  curriculum: { id: string; grade: number };
  purpose: string;
  topics: {
    topicId: string | null;
    topicTitle: string;
    nodes: {
      nodeId: string;
      nodeTitle: string;
      outcomes: SpecificationOutcomeLite[];
      cells: SpecificationCellLite[];
    }[];
  }[];
  totals: { totalQuestions: number; totalScore: number };
}

/** Một nút cây chương trình (cùng hình dạng CurriculumTreeNode của trang câu hỏi). */
export interface MatrixTreeNode {
  id: string;
  title: string;
  outcomes: { id: string; content: string }[];
  children: MatrixTreeNode[];
}

/** Tải một endpoint độc lập: lỗi thì trả null (giữ nhịp probe thủ công trước đây). */
async function probe<T>(path: string): Promise<T | null> {
  try {
    return await apiJson<T>(path);
  } catch {
    return null;
  }
}

export function matrixBanksQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.questionBanksByKind('matrix'),
    queryFn: () => apiJson<BankLite[]>('/api/v1/question-banks?kind=matrix'),
  });
}

/** Danh sách bank ma trận của người dùng; chỉ tải khi `enabled` (đã rõ quyền). */
export function useMatrixBanks(enabled: boolean) {
  return useQuery({ ...matrixBanksQueryOptions(), enabled });
}

export function curriculumSubjectsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.curriculumSubjects,
    queryFn: () => apiJson<SubjectLite[]>('/api/v1/curriculum/subjects'),
  });
}

/** Danh sách môn học chương trình; chỉ tải khi `enabled`. */
export function useCurriculumSubjects(enabled: boolean) {
  return useQuery({ ...curriculumSubjectsQueryOptions(), enabled });
}

export function curriculaBySubjectQueryOptions(subjectId: string) {
  return queryOptions({
    queryKey: queryKeys.curriculaBySubject(subjectId),
    queryFn: () => apiJson<CurriculumLite[]>(`/api/v1/curriculum/curricula?subjectId=${subjectId}`),
  });
}

/** Các chương trình của môn đang chọn; chưa chọn môn thì query tắt. */
export function useCurriculaBySubject(subjectId: string) {
  return useQuery({
    ...curriculaBySubjectQueryOptions(subjectId),
    enabled: !!subjectId,
  });
}

export function matrixDetailQueryOptions(matrixId: string) {
  return queryOptions({
    queryKey: queryKeys.matrixDetail(matrixId),
    queryFn: () => apiJson<MatrixLite>(`/api/v1/exam-matrices/${matrixId}`),
  });
}

/** Chi tiết ma trận; chỉ tải khi `enabled` và có `matrixId`. */
export function useMatrixDetail(matrixId: string | undefined, enabled: boolean) {
  return useQuery({
    ...matrixDetailQueryOptions(matrixId ?? ''),
    enabled: enabled && !!matrixId,
  });
}

export function curriculumTreeQueryOptions(curriculumId: string) {
  return queryOptions({
    queryKey: queryKeys.curriculumTree(curriculumId),
    queryFn: async () => (await probe<MatrixTreeNode[]>(`/api/v1/curriculum/curricula/${curriculumId}/tree`)) ?? [],
  });
}

/** Cây chương trình của ma trận đang sửa (để lấy danh sách ĐVK cho bộ chọn ô); lỗi tải → cây rỗng như trước. */
export function useCurriculumTree(curriculumId: string | undefined, enabled: boolean) {
  return useQuery({
    ...curriculumTreeQueryOptions(curriculumId ?? ''),
    enabled: enabled && !!curriculumId,
  });
}

export function matrixAvailabilityQueryOptions(matrixId: string) {
  return queryOptions({
    queryKey: queryKeys.matrixAvailability(matrixId),
    queryFn: () => probe<AvailabilityLite>(`/api/v1/exam-matrices/${matrixId}/availability`),
  });
}

/** Khả dụng kho câu theo ô; lỗi tải → null như trước. */
export function useMatrixAvailability(matrixId: string | undefined, enabled: boolean) {
  return useQuery({
    ...matrixAvailabilityQueryOptions(matrixId ?? ''),
    enabled: enabled && !!matrixId,
  });
}

export function matrixSpecificationQueryOptions(matrixId: string) {
  return queryOptions({
    queryKey: queryKeys.matrixSpecification(matrixId),
    queryFn: () => apiJson<MatrixSpecificationLite>(`/api/v1/exam-matrices/${matrixId}/specification`),
  });
}

/** Bản đặc tả suy ra của ma trận; chỉ tải khi `enabled` (giáo viên đã mở mục đặc tả ở trang sửa ma trận). */
export function useMatrixSpecification(matrixId: string | undefined, enabled: boolean) {
  return useQuery({
    ...matrixSpecificationQueryOptions(matrixId ?? ''),
    enabled: enabled && !!matrixId,
  });
}

/**
 * Xuất bản đặc tả ra file (xlsx/docx) qua endpoint export sẵn có và tải
 * về máy người dùng; tên file lấy đúng từ Content-Disposition của
 * server, lỗi HTTP thì ném lỗi để bề mặt gọi báo theo khuôn chung.
 */
export async function downloadMatrixSpecification(matrixId: string, format: 'xlsx' | 'docx'): Promise<void> {
  const res = await apiFetch(`/api/v1/exam-matrices/${matrixId}/specification/export?format=${format}`);
  if (!res.ok) throw new Error(String(res.status));
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `ban-dac-ta-${matrixId.slice(0, 8)}.${format}`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Lưu thông tin chung của ma trận: xong thì invalidate chi tiết để trang nạp bản mới (thay loadMatrix thủ công). */
export function useUpdateMatrix() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      matrixId: string;
      body: { name: string; status: string; isTemplate: boolean; totalScore: number };
    }) =>
      apiJson(`/api/v1/exam-matrices/${vars.matrixId}`, {
        method: 'PATCH',
        body: JSON.stringify(vars.body),
      }),
    onSuccess: (_data, vars) =>
      queryClient.invalidateQueries({ queryKey: queryKeys.matrixDetail(vars.matrixId) }),
  });
}

/** Thêm một ô vào ma trận: xong thì invalidate chi tiết như trên. */
export function useAddMatrixCell() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      matrixId: string;
      body: {
        curriculumNodeId: string;
        cognitiveLevel: string;
        qtype: string;
        questionCount: number;
        cellScore: number;
      };
    }) =>
      apiJson(`/api/v1/exam-matrices/${vars.matrixId}/cells`, {
        method: 'POST',
        body: JSON.stringify(vars.body),
      }),
    onSuccess: (_data, vars) =>
      queryClient.invalidateQueries({ queryKey: queryKeys.matrixDetail(vars.matrixId) }),
  });
}

/** Xoá một ô khỏi ma trận: xong thì invalidate chi tiết như trên. */
export function useDeleteMatrixCell() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { matrixId: string; cellId: string }) =>
      apiJson(`/api/v1/exam-matrices/${vars.matrixId}/cells/${vars.cellId}`, { method: 'DELETE' }),
    onSuccess: (_data, vars) =>
      queryClient.invalidateQueries({ queryKey: queryKeys.matrixDetail(vars.matrixId) }),
  });
}

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, apiJson } from './api';
import { queryKeys } from './query-keys';

/**
 * Tầng dữ liệu màn ma trận (tạo/sửa) trong ngân hàng ma trận (F-01
 * đợt 1, rà soát #133): options dùng chung cho hook của trang và
 * clientLoader của route module (prefetch cùng khoá).
 *
 * Flow tổng thể của module: trang gọi các hook ở đây → hook dựng
 * queryOptions với khoá từ `lib/query-keys.ts` → TanStack Query gọi
 * `apiJson`/`apiFetch` (lib/api) tới API → dữ liệu trả về được cache
 * theo khoá; các mutation (lưu ma trận, thêm/xoá ô) thành công thì
 * invalidate đúng khoá chi tiết + khoá bản đặc tả để mọi bề mặt đang
 * mở nạp lại trạng thái mới.
 *
 * Phần bản đặc tả (SPEC-1, issue #233): đặc tả là bảng SUY RA ở phía
 * API từ các ô của ma trận — module này chỉ ĐỌC view model đặc tả
 * (`useMatrixSpecification`, tải lười khi giáo viên mở mục đặc tả ở
 * trang sửa) và XUẤT file (`downloadMatrixSpecification` gọi endpoint
 * export sẵn có rồi kích hoạt tải xuống ở trình duyệt); không có
 * đường ghi/sửa đặc tả nào ở phía client.
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

/**
 * Một YCCĐ thuộc ĐVK trong bản đặc tả suy ra (cột "Yêu cầu cần đạt").
 *
 * Bất biến theo mô hình #249: YCCĐ nằm ở cấp NODE (ĐVK) chứ không nằm
 * trong ô — mọi ô của cùng một node dùng chung danh sách YCCĐ này.
 * `programContent` là nguyên văn chương trình (với YCCĐ derived là
 * nguyên văn của YCCĐ gốc), `derivedContent` là bản tách mức của tổ
 * chuyên môn (null khi YCCĐ không phải bản derived); khi hiển thị,
 * ưu tiên `programContent`, thiếu mới rơi xuống `content`.
 */
export interface SpecificationOutcomeLite {
  outcomeId: string;
  content: string;
  sourceKind: string;
  sourceRef: string | null;
  programContent: string | null;
  derivedContent: string | null;
  /**
   * Vị trí của dòng trong bản ghi chương trình và mã YCCĐ vị trí
   * `<recordId>.<position 2 số>` — cả hai do BACKEND tính (một nguồn
   * sự thật cho vị trí, issue #161); web chỉ hiển thị, không tự suy.
   * Với derived là vị trí/mã của dòng gốc; null khi node không thuộc
   * bản ghi dataset nào.
   */
  position: number | null;
  code: string | null;
}

/**
 * Một ô ma trận trong bản đặc tả suy ra.
 *
 * `slotNumbers`/`drawNote` chỉ có khi đặc tả được dựng theo một lần
 * ghim đề cụ thể (pinId); đặc tả theo ma trận thuần (bề mặt SPEC-1)
 * luôn nhận null ở hai trường này. `questionCount` của ô Đúng–Sai là
 * số CHÙM — khi trình bày phải nhân 4 như bản xuất (xem trang ma trận).
 */
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

/**
 * Options truy vấn bản đặc tả của một ma trận — dùng chung cho hook
 * của trang sửa ma trận (clientLoader không prefetch khoá này vì đặc
 * tả chỉ tải lười khi giáo viên mở mục đặc tả).
 *
 * @param matrixId - Id của ma trận cần lấy bản đặc tả.
 * @returns Query options với khoá `queryKeys.matrixSpecification` và
 * hàm tải gọi `GET /exam-matrices/:id/specification`.
 */
export function matrixSpecificationQueryOptions(matrixId: string) {
  return queryOptions({
    queryKey: queryKeys.matrixSpecification(matrixId),
    queryFn: () => apiJson<MatrixSpecificationLite>(`/api/v1/exam-matrices/${matrixId}/specification`),
  });
}

/**
 * Hook đọc bản đặc tả SUY RA của ma trận đang sửa.
 *
 * Flow: trang bật `enabled` khi giáo viên bấm "Xem bản đặc tả" →
 * TanStack Query mới phát request (trước đó không tốn lượt tải) →
 * kết quả cache theo ma trận; các mutation đổi ô invalidate khoá
 * này nên đặc tả đang mở tự nạp lại sau khi thêm/xoá ô.
 *
 * @param matrixId - Id của ma trận; undefined khi trang chưa nạp xong.
 * @param enabled - Cờ bật/tắt tải từ trang (quyền đã rõ + đã mở mục).
 * @returns Kết quả truy vấn TanStack chứa view model đặc tả.
 */
export function useMatrixSpecification(matrixId: string | undefined, enabled: boolean) {
  return useQuery({
    ...matrixSpecificationQueryOptions(matrixId ?? ''),
    enabled: enabled && !!matrixId,
  });
}

/**
 * Xuất bản đặc tả ra file (xlsx/docx) và tải về máy người dùng.
 *
 * Flow các bước: (1) gọi endpoint export sẵn có của API bằng
 * `apiFetch` (giữ nguyên Response để đọc header); (2) HTTP không ok
 * thì ném lỗi ngay — bề mặt gọi bắt lỗi và báo theo khuôn chung,
 * không tải file rác; (3) đọc blob, trích tên file từ header
 * `Content-Disposition` để giữ ĐÚNG tên server trả (dạng
 * `ban-dac-ta-<8 ký tự đầu của id ma trận>.<đuôi>`), header thiếu/sai
 * dạng mới rơi xuống tên dự phòng dựng cùng quy ước đó; (4) tạo URL
 * đối tượng tạm + thẻ neo ẩn để kích hoạt tải xuống của trình duyệt,
 * xong thu hồi URL ngay để không rò bộ nhớ.
 *
 * Side-effect: phát một request GET và kích hoạt một lượt tải file
 * của trình duyệt; không đổi trạng thái nào phía server/client.
 *
 * @param matrixId - Id của ma trận cần xuất bản đặc tả.
 * @param format - Định dạng file: 'xlsx' (Excel) hoặc 'docx' (Word).
 * @returns Promise hoàn tất sau khi lượt tải đã được kích hoạt.
 */
export async function downloadMatrixSpecification(matrixId: string, format: 'xlsx' | 'docx'): Promise<void> {
  const res = await apiFetch(`/api/v1/exam-matrices/${matrixId}/specification/export?format=${format}`);
  if (!res.ok) throw new Error(String(res.status));
  const blob = await res.blob();
  // Tên file ưu tiên lấy nguyên từ header của server (nguồn sự thật về
  // tên bản xuất); chỉ khi header vắng/sai dạng mới tự dựng tên dự
  // phòng theo cùng quy ước để lượt tải vẫn chạy được.
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
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.matrixDetail(vars.matrixId) });
      // Tên/tổng điểm của ma trận cũng nằm trong view model đặc tả —
      // lưu thông tin chung xong thì đặc tả đang mở phải nạp lại theo.
      void queryClient.invalidateQueries({ queryKey: queryKeys.matrixSpecification(vars.matrixId) });
    },
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
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.matrixDetail(vars.matrixId) });
      // Đặc tả là bảng SUY RA từ các ô: ô đổi thì đặc tả phải nạp lại.
      void queryClient.invalidateQueries({ queryKey: queryKeys.matrixSpecification(vars.matrixId) });
    },
  });
}

/** Xoá một ô khỏi ma trận: xong thì invalidate chi tiết như trên. */
export function useDeleteMatrixCell() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { matrixId: string; cellId: string }) =>
      apiJson(`/api/v1/exam-matrices/${vars.matrixId}/cells/${vars.cellId}`, { method: 'DELETE' }),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.matrixDetail(vars.matrixId) });
      // Như thêm ô: đặc tả suy ra từ tập ô nên xoá ô cũng phải nạp lại.
      void queryClient.invalidateQueries({ queryKey: queryKeys.matrixSpecification(vars.matrixId) });
    },
  });
}

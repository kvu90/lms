import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson } from './api';
import { queryClient } from './query-client';
import { queryKeys } from './query-keys';

/**
 * Tầng dữ liệu TanStack Query cho màn soạn đề (F-01 của rà soát
 * #133): chi tiết đề + các lần ghim của đề đọc qua khoá của nhà máy
 * `queryKeys`, `clientLoader` của hai route (tạo mới không có gì để
 * nạp trước; sửa nạp trước chi tiết + lần ghim) prefetch đúng khoá.
 * Các thao tác ghi — tạo đề, sửa metadata, thay slots, đổi câu cùng
 * ô — qua `useMutation`; riêng đổi câu cùng ô: đáp ứng là view đề mới
 * được đặt thẳng vào cache chi tiết để form khởi tạo lại từ view mới
 * như nhịp thủ công trước đây. Việc xoá cache danh sách ngân hàng ở
 * điểm lưu trước khi quay về danh sách do trang tự làm qua
 * `clearQuestionBankListCache` (cùng tiền lệ màn soạn câu hỏi).
 */

/** Một slot của đề như API exam-papers trả về (đã ghim version câu). */
export interface PaperSlotView {
  position: number;
  section: string;
  questionId: string;
  questionName: string | null;
  qtype: string | null;
  pinnedVersionNumber: number | null;
  /** Số version ready mới nhất của câu trong ngân hàng (null khi chưa có bản ready). */
  latestReadyVersionNumber: number | null;
  /** Huy hiệu "có bản ready mới" (issue #254): slot đang ghim version cũ hơn bản ready mới nhất của câu. */
  hasNewerVersion: boolean;
  maxMark: number;
  clusterId: string | null;
  /** Ô ma trận nguồn (EB-2) — có ở đề sinh từ ma trận; neo swap-cùng-ô. */
  matrixCellId: string | null;
}

/** Một lần GHIM của đề vào một khoá + các mã đề của lần ghim (GET /exams/:id/pins). */
export interface PinViewLite {
  id: string;
  courseId: string;
  courseName: string;
  versionNumber: number;
  name: string | null;
  variantCount: number;
  variantCodes: string[];
  createdAt: string;
}

/** Chi tiết một đề (GET /exam-papers/:id). */
export interface PaperView {
  paper: { id: string; bankId: string; kind: string; status: string; latestVersion: number; derivedFromPaperId: string | null };
  version: {
    id: string; version: number; name: string;
    subjectId: string | null; grade: number | null; examKind: string | null;
    totalScore: number; durationMinutes: number | null;
    matrixId: string | null; matrixVersion: number | null;
  };
  slots: PaperSlotView[];
  /**
   * Cờ quyền của người xem tại bank của đề (API trả cùng bộ
   * `ExamCapabilitiesView` với phía ngân hàng): `edit` — được sửa
   * chính đề này; `deploy` — được ghim đề vào khoá (cổng
   * `exam:deploy` tại bank), là căn cứ hiện form ghim trong màn sửa.
   */
  capabilities: { edit: boolean; deploy: boolean };
}

/** Một dòng kết quả khám phá ngân hàng câu hỏi (GET /questions/discovery) như màn soạn đề tiêu thụ. */
export interface DiscoveryItemLite {
  questionId: string;
  name: string;
  qtype: string;
  bankName: string;
}

/**
 * Tuỳ chọn truy vấn khám phá câu hỏi theo tham số đã chốt khi bấm
 * tìm — dùng chung khoá nhà máy `questionDiscovery` với trang ngân
 * hàng (cùng endpoint, cùng chuỗi tham số thì cùng một cache).
 */
export function examQuestionDiscoveryQueryOptions(params: string) {
  return queryOptions({
    queryKey: queryKeys.questionDiscovery(params),
    queryFn: () => apiJson<DiscoveryItemLite[]>(`/api/v1/questions/discovery?${params}`),
  });
}

/** Tuỳ chọn truy vấn chi tiết đề (GET /exams/:id). */
export function examPaperQueryOptions(paperId: string) {
  return queryOptions({
    queryKey: queryKeys.examPaperDetail(paperId),
    queryFn: () => apiJson<PaperView>(`/api/v1/exams/${paperId}`),
  });
}

/** Hook đọc chi tiết đề cho màn sửa; màn tạo mới không tải chi tiết. */
export function useExamPaper(paperId: string | undefined, enabled: boolean) {
  return useQuery({
    ...examPaperQueryOptions(paperId ?? ''),
    enabled: enabled && !!paperId,
  });
}

/** Tuỳ chọn truy vấn các lần ghim của đề (GET /exams/:id/pins). */
export function examPaperPinsQueryOptions(paperId: string) {
  return queryOptions({
    queryKey: queryKeys.examPaperPins(paperId),
    queryFn: async (): Promise<PinViewLite[]> => {
      // Nhịp thủ công: tải lần ghim hỏng thì coi như chưa có lần ghim
      // nào (khu vực in đề chỉ ẩn đi, không chặn việc soạn đề).
      try {
        return await apiJson<PinViewLite[]>(`/api/v1/exams/${paperId}/pins`);
      } catch {
        return [];
      }
    },
  });
}

/** Hook đọc các lần ghim của đề cho màn sửa. */
export function useExamPaperPins(paperId: string | undefined, enabled: boolean) {
  return useQuery({
    ...examPaperPinsQueryOptions(paperId ?? ''),
    enabled: enabled && !!paperId,
  });
}

/** Thân tạo đề mới trong một bank đề (POST /exams/banks/:bankId/exams). */
export interface CreateExamPaperBody {
  name: string;
  examKind: string | null;
  grade: number | null;
  durationMinutes: number | null;
  totalScore: number;
  slots: { questionId: string; maxMark: number; section?: string }[];
}

/** Đột biến tạo đề mới trong bank — đáp ứng là view đề vừa tạo. */
export function useCreateExamPaper() {
  return useMutation({
    mutationFn: ({ bankId, body }: { bankId: string; body: CreateExamPaperBody }) =>
      apiJson<PaperView>(`/api/v1/exams/banks/${bankId}/exams`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}

/** Thân sửa metadata của đề (PATCH /exams/:id) — server tạo paper version mới. */
export interface UpdateExamPaperMetaBody {
  name: string;
  examKind: string | null;
  grade: number | null;
  durationMinutes: number | null;
  totalScore: number;
}

/** Đột biến sửa metadata của đề — đáp ứng là view đề sau khi sửa. */
export function useUpdateExamPaperMeta() {
  return useMutation({
    mutationFn: ({ paperId, body }: { paperId: string; body: UpdateExamPaperMetaBody }) =>
      apiJson<PaperView>(`/api/v1/exams/${paperId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
  });
}

/** Đột biến thay toàn bộ slots của đề (PUT /exams/:id/slots) — đáp ứng là view đề sau khi thay. */
export function useReplaceExamPaperSlots() {
  return useMutation({
    mutationFn: ({
      paperId,
      slots,
    }: {
      paperId: string;
      slots: { questionId: string; maxMark: number; section?: string }[];
    }) =>
      apiJson<PaperView>(`/api/v1/exams/${paperId}/slots`, {
        method: 'PUT',
        body: JSON.stringify({ slots }),
      }),
  });
}

/**
 * Đột biến đổi câu của một slot sang câu khác CÙNG Ô ma trận (POST
 * /exams/:id/swap; server gác pool của ô nguồn): đáp ứng là view đề
 * mới — đặt thẳng vào cache chi tiết để form soạn khởi tạo lại từ
 * view mới (vị trí đổi câu được trang tự gỡ sau khi gọi).
 */
export function useSwapExamPaperSlot() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ paperId, position, questionId }: { paperId: string; position: number; questionId: string }) =>
      apiJson<PaperView>(`/api/v1/exams/${paperId}/swap`, {
        method: 'POST',
        body: JSON.stringify({ position, questionId }),
      }),
    onSuccess: (view, vars) => {
      client.setQueryData(queryKeys.examPaperDetail(vars.paperId), view);
    },
  });
}

/** clientLoader (F-01, #133): nạp trước chi tiết đề + các lần ghim đúng khoá màn sửa sẽ đọc. */
export async function examPaperEditPageClientLoader(paperId: string) {
  await Promise.all([
    queryClient.prefetchQuery(examPaperQueryOptions(paperId)),
    queryClient.prefetchQuery(examPaperPinsQueryOptions(paperId)),
  ]);
  return null;
}

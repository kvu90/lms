import { queryOptions, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { queryClient } from '#lib/query-client';
import { queryKeys as sharedQueryKeys } from '#lib/query-keys';
import {
  createExamPaper,
  fetchExamPaper,
  fetchExamPaperPins,
  fetchExamQuestionDiscovery,
  replaceExamPaperSlots,
  swapExamPaperSlot,
  updateExamPaperMeta,
} from '../api/exam-paper';
import type { CreateExamPaperBody, UpdateExamPaperMetaBody } from '../types/exam-paper';
import { queryKeys } from './keys';

/**
 * Tầng dữ liệu TanStack Query cho màn soạn đề (F-01 của rà soát
 * #133): chi tiết đề + các lần ghim của đề đọc qua khoá riêng của
 * feature, `clientLoader` của hai route (tạo mới không có gì để
 * nạp trước; sửa nạp trước chi tiết + lần ghim) prefetch đúng khoá.
 * Các thao tác ghi — tạo đề, sửa metadata, thay slots, đổi câu cùng
 * ô — qua `useMutation`; tạo/sửa/thay slots làm mới cache chi tiết +
 * lần ghim khi thành công; riêng đổi câu cùng ô: đáp ứng là view đề mới
 * được đặt thẳng vào cache chi tiết để form khởi tạo lại từ view mới
 * như nhịp thủ công trước đây. Việc xoá cache danh sách ngân hàng ở
 * điểm lưu trước khi quay về danh sách do trang tự làm qua
 * `clearQuestionBankListCache` (cùng tiền lệ màn soạn câu hỏi).
 * Lời gọi API thuần nằm ở tầng `api/` của feature; khoá khám phá
 * câu hỏi `questionDiscovery` là khoá dùng chung ở factory tập
 * trung (cùng endpoint, cùng chuỗi tham số thì cùng một cache với
 * trang ngân hàng).
 */

/**
 * Tuỳ chọn truy vấn khám phá câu hỏi theo tham số đã chốt khi bấm
 * tìm — dùng chung khoá nhà máy `questionDiscovery` với trang ngân
 * hàng (cùng endpoint, cùng chuỗi tham số thì cùng một cache).
 */
export function examQuestionDiscoveryQueryOptions(params: string) {
  return queryOptions({
    queryKey: sharedQueryKeys.questionDiscovery(params),
    queryFn: () => fetchExamQuestionDiscovery(params),
  });
}

/** Tuỳ chọn truy vấn chi tiết đề (GET /exams/:id). */
export function examPaperQueryOptions(paperId: string) {
  return queryOptions({
    queryKey: queryKeys.examPaperDetail(paperId),
    queryFn: () => fetchExamPaper(paperId),
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
    queryFn: () => fetchExamPaperPins(paperId),
  });
}

/** Hook đọc các lần ghim của đề cho màn sửa. */
export function useExamPaperPins(paperId: string | undefined, enabled: boolean) {
  return useQuery({
    ...examPaperPinsQueryOptions(paperId ?? ''),
    enabled: enabled && !!paperId,
  });
}

/**
 * Làm mới cache chi tiết + các lần ghim của một đề sau một thao tác
 * ghi thành công: các bề mặt khác đọc cùng hai khoá (và lần quay lại
 * màn soạn trong cửa sổ staleTime) không thấy bản cũ sau khi lưu.
 */
function invalidateExamPaper(client: QueryClient, paperId: string) {
  void client.invalidateQueries({ queryKey: queryKeys.examPaperDetail(paperId) });
  void client.invalidateQueries({ queryKey: queryKeys.examPaperPins(paperId) });
}

/** Đột biến tạo đề mới trong bank — đáp ứng là view đề vừa tạo. */
export function useCreateExamPaper() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ bankId, body }: { bankId: string; body: CreateExamPaperBody }) =>
      createExamPaper(bankId, body),
    onSuccess: (view) => invalidateExamPaper(client, view.paper.id),
  });
}

/** Đột biến sửa metadata của đề — đáp ứng là view đề sau khi sửa. */
export function useUpdateExamPaperMeta() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ paperId, body }: { paperId: string; body: UpdateExamPaperMetaBody }) =>
      updateExamPaperMeta(paperId, body),
    onSuccess: (_view, vars) => invalidateExamPaper(client, vars.paperId),
  });
}

/** Đột biến thay toàn bộ slots của đề (PUT /exams/:id/slots) — đáp ứng là view đề sau khi thay. */
export function useReplaceExamPaperSlots() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      paperId,
      slots,
    }: {
      paperId: string;
      slots: { questionId: string; maxMark: number; section?: string }[];
    }) => replaceExamPaperSlots(paperId, slots),
    onSuccess: (_view, vars) => invalidateExamPaper(client, vars.paperId),
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
      swapExamPaperSlot(paperId, position, questionId),
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

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PaperBatch, PaperScan } from '@lms/contracts';
import { apiJson } from './api';
import { queryClient } from './query-client';
import { queryKeys } from './query-keys';

/**
 * Tầng dữ liệu TanStack Query cho trang chấm bài giấy (CAM-0, F-01
 * của rà soát #133): hai danh sách của trang — lô in và phiếu đã quét
 * của một lần ghim — đọc qua khoá của nhà máy `queryKeys`, `clientLoader`
 * của route nạp trước cả hai; mọi thao tác ghi (tạo lô, gán lô/gán
 * định danh, quyết câu mơ hồ, ghi điểm, xoá phiếu) qua `useMutation`
 * và làm mới CẢ HAI danh sách, đúng nhịp tải lại thủ công trước đây
 * (một thao tác đổi một phiếu có thể làm đổi cả hàng chờ của lô).
 *
 * Hai luồng không thuộc tầng này và giữ nguyên dạng mệnh lệnh ở trang:
 * tải ảnh phiếu lên (FormData nhiều file, đáp ứng theo từng ảnh) và
 * tải PDF phiếu (blob) — cùng bản chất với các helper tải file/xuất
 * file ở các module dữ liệu khác.
 */

/** Tuỳ chọn truy vấn danh sách lô in của lần ghim (GET /exam-batches?pinId=). */
export function paperBatchesQueryOptions(pinId: string) {
  return queryOptions({
    queryKey: queryKeys.examBatches(pinId),
    queryFn: () => apiJson<PaperBatch[]>(`/api/v1/exam-batches?pinId=${pinId}`),
  });
}

/** Hook đọc danh sách lô in cho trang chấm bài giấy. */
export function usePaperBatches(pinId: string) {
  return useQuery(paperBatchesQueryOptions(pinId));
}

/** Tuỳ chọn truy vấn danh sách phiếu đã quét của lần ghim (GET /exam-scans?pinId=). */
export function paperScansQueryOptions(pinId: string) {
  return queryOptions({
    queryKey: queryKeys.examScans(pinId),
    queryFn: () => apiJson<PaperScan[]>(`/api/v1/exam-scans?pinId=${pinId}`),
  });
}

/** Hook đọc danh sách phiếu đã quét cho trang chấm bài giấy. */
export function usePaperScans(pinId: string) {
  return useQuery(paperScansQueryOptions(pinId));
}

/** Làm mới cả hai danh sách của trang sau một thao tác ghi thành công. */
function useInvalidatePaperLists(pinId: string) {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: queryKeys.examBatches(pinId) });
    void client.invalidateQueries({ queryKey: queryKeys.examScans(pinId) });
  };
}

/**
 * Đột biến tạo lô in (POST /exam-batches?pinId=): thân gửi chỉ mang
 * các trường người dùng đã nhập (mã biến thể và mã đề 4 số là tuỳ
 * chọn). Đáp ứng là lô vừa tạo để trang chọn ngay lô đó.
 */
export function useCreatePaperBatch(pinId: string) {
  const invalidate = useInvalidatePaperLists(pinId);
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiJson<PaperBatch>(`/api/v1/exam-batches?pinId=${pinId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: invalidate,
  });
}

/** Đột biến gán định danh học viên cho một phiếu (POST /exam-scans/:id/assign-identity). */
export function useAssignScanIdentity(pinId: string) {
  const invalidate = useInvalidatePaperLists(pinId);
  return useMutation({
    mutationFn: ({ scanId, studentId }: { scanId: string; studentId: string }) =>
      apiJson(`/api/v1/exam-scans/${scanId}/assign-identity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId }),
      }),
    onSuccess: invalidate,
  });
}

/** Đột biến gán lô in cho một phiếu (POST /exam-scans/:id/assign-batch). */
export function useAssignScanBatch(pinId: string) {
  const invalidate = useInvalidatePaperLists(pinId);
  return useMutation({
    mutationFn: ({ scanId, batchId }: { scanId: string; batchId: string }) =>
      apiJson(`/api/v1/exam-scans/${scanId}/assign-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId }),
      }),
    onSuccess: invalidate,
  });
}

/**
 * Đột biến quyết các câu mơ hồ của một phiếu (POST
 * /exam-scans/:id/resolve-readings): mỗi câu mơ hồ hoặc một lựa chọn
 * đơn (`chosen`), hoặc quyết theo từng ý của câu Đúng–Sai chùm
 * (`pairChoices`) — hình dạng do trang dựng theo loại câu của slot.
 */
export function useResolveScanReadings(pinId: string) {
  const invalidate = useInvalidatePaperLists(pinId);
  return useMutation({
    mutationFn: ({ scanId, readings }: { scanId: string; readings: unknown[] }) =>
      apiJson(`/api/v1/exam-scans/${scanId}/resolve-readings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ readings }),
      }),
    onSuccess: invalidate,
  });
}

/**
 * Đột biến ghi điểm một phiếu thành attempt thi giấy (POST
 * /exam-scans/:id/record): đáp ứng mang `sumGrades` để trang hiện
 * tổng điểm vừa ghi cạnh phiếu ở hàng đã ghi.
 */
export function useRecordScan(pinId: string) {
  const invalidate = useInvalidatePaperLists(pinId);
  return useMutation({
    mutationFn: (scanId: string) =>
      apiJson<PaperScan & { sumGrades: number }>(`/api/v1/exam-scans/${scanId}/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    onSuccess: invalidate,
  });
}

/** Đột biến xoá một phiếu (DELETE /exam-scans/:id). */
export function useDeleteScan(pinId: string) {
  const invalidate = useInvalidatePaperLists(pinId);
  return useMutation({
    mutationFn: (scanId: string) => apiJson(`/api/v1/exam-scans/${scanId}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

/** clientLoader (F-01, #133): nạp trước cả hai danh sách đúng khoá trang chấm bài giấy sẽ đọc. */
export async function paperPageClientLoader(pinId: string) {
  await Promise.all([
    queryClient.prefetchQuery(paperBatchesQueryOptions(pinId)),
    queryClient.prefetchQuery(paperScansQueryOptions(pinId)),
  ]);
  return null;
}

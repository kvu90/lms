import type { PaperBatch, PaperScan } from '@lms/contracts';
import { apiJson } from '#lib/api';

/**
 * Tầng gọi API thuần của trang chấm bài giấy thuộc feature
 * quizzes: chỉ chứa các hàm gọi HTTP, không phụ thuộc React hay
 * React Query. Tầng `queries/` của feature bọc các hàm này thành
 * queryOptions và đột biến. Tách từ module dữ liệu phẳng
 * `src/lib/paper-data.ts` khi tổ chức lại apps/web theo mô hình
 * features/ (issue #500).
 */

/**
 * Đọc danh sách lô in của lần ghim (GET /exam-batches?pinId=).
 *
 * @param pinId - Định danh lần ghim.
 * @returns Danh sách lô in.
 */
export function fetchPaperBatches(pinId: string) {
  return apiJson<PaperBatch[]>(`/api/v1/exam-batches?pinId=${pinId}`);
}

/**
 * Đọc danh sách phiếu đã quét của lần ghim (GET /exam-scans?pinId=).
 *
 * @param pinId - Định danh lần ghim.
 * @returns Danh sách phiếu đã quét.
 */
export function fetchPaperScans(pinId: string) {
  return apiJson<PaperScan[]>(`/api/v1/exam-scans?pinId=${pinId}`);
}

/**
 * Tạo lô in (POST /exam-batches?pinId=): thân gửi chỉ mang các
 * trường người dùng đã nhập.
 *
 * @param pinId - Định danh lần ghim.
 * @param body - Thân tạo lô.
 * @returns Lô vừa tạo.
 */
export function createPaperBatch(pinId: string, body: Record<string, unknown>) {
  return apiJson<PaperBatch>(`/api/v1/exam-batches?pinId=${pinId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Gán định danh học viên cho một phiếu (POST /exam-scans/:id/assign-identity).
 *
 * @param scanId - Định danh phiếu.
 * @param studentId - Định danh học viên.
 * @returns Đáp ứng của API.
 */
export function assignScanIdentity(scanId: string, studentId: string) {
  return apiJson(`/api/v1/exam-scans/${scanId}/assign-identity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentId }),
  });
}

/**
 * Gán lô in cho một phiếu (POST /exam-scans/:id/assign-batch).
 *
 * @param scanId - Định danh phiếu.
 * @param batchId - Định danh lô in.
 * @returns Đáp ứng của API.
 */
export function assignScanBatch(scanId: string, batchId: string) {
  return apiJson(`/api/v1/exam-scans/${scanId}/assign-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batchId }),
  });
}

/**
 * Quyết các câu mơ hồ của một phiếu (POST /exam-scans/:id/resolve-readings).
 *
 * @param scanId - Định danh phiếu.
 * @param readings - Các quyết đọc do trang dựng theo loại câu của slot.
 * @returns Đáp ứng của API.
 */
export function resolveScanReadings(scanId: string, readings: unknown[]) {
  return apiJson(`/api/v1/exam-scans/${scanId}/resolve-readings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ readings }),
  });
}

/**
 * Ghi điểm một phiếu thành attempt thi giấy (POST /exam-scans/:id/record).
 *
 * @param scanId - Định danh phiếu.
 * @returns Phiếu kèm tổng điểm vừa ghi.
 */
export function recordScan(scanId: string) {
  return apiJson<PaperScan & { sumGrades: number }>(`/api/v1/exam-scans/${scanId}/record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/**
 * Xoá một phiếu (DELETE /exam-scans/:id).
 *
 * @param scanId - Định danh phiếu.
 * @returns Đáp ứng của API.
 */
export function deleteScan(scanId: string) {
  return apiJson(`/api/v1/exam-scans/${scanId}`, { method: 'DELETE' });
}

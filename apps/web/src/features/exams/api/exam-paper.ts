import { apiJson } from '#lib/api';
import type {
  CreateExamPaperBody,
  DiscoveryItemLite,
  PaperView,
  PinViewLite,
  UpdateExamPaperMetaBody,
} from '../types/exam-paper';

/**
 * Tầng gọi API thuần của màn soạn đề thuộc feature exams: chỉ
 * chứa các hàm gọi HTTP, không phụ thuộc React hay React Query.
 * Tầng `queries/` của feature bọc các hàm này thành queryOptions,
 * hook và đột biến. Tách từ module dữ liệu phẳng
 * `src/lib/exam-paper-data.ts` khi tổ chức lại apps/web theo mô
 * hình features/ (issue #500).
 */

/**
 * Khám phá ngân hàng câu hỏi theo chuỗi tham số đã chốt khi bấm
 * tìm (GET /questions/discovery).
 *
 * @param params - Chuỗi tham số truy vấn.
 * @returns Danh sách dòng khám phá.
 */
export function fetchExamQuestionDiscovery(params: string) {
  return apiJson<DiscoveryItemLite[]>(`/api/v1/questions/discovery?${params}`);
}

/**
 * Đọc chi tiết đề (GET /exams/:id).
 *
 * @param paperId - Định danh đề.
 * @returns Chi tiết đề.
 */
export function fetchExamPaper(paperId: string) {
  return apiJson<PaperView>(`/api/v1/exams/${paperId}`);
}

/**
 * Đọc các lần ghim của đề (GET /exams/:id/pins). Nhịp thủ công:
 * tải lần ghim hỏng thì coi như chưa có lần ghim nào (khu vực in
 * đề chỉ ẩn đi, không chặn việc soạn đề).
 *
 * @param paperId - Định danh đề.
 * @returns Danh sách lần ghim (rỗng khi lỗi tải).
 */
export async function fetchExamPaperPins(paperId: string): Promise<PinViewLite[]> {
  try {
    return await apiJson<PinViewLite[]>(`/api/v1/exams/${paperId}/pins`);
  } catch {
    return [];
  }
}

/**
 * Tạo đề mới trong một bank đề (POST /exams/banks/:bankId/exams).
 *
 * @param bankId - Định danh bank đề.
 * @param body - Thân tạo đề.
 * @returns View đề vừa tạo.
 */
export function createExamPaper(bankId: string, body: CreateExamPaperBody) {
  return apiJson<PaperView>(`/api/v1/exams/banks/${bankId}/exams`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Sửa metadata của đề (PATCH /exams/:id) — server tạo paper version mới.
 *
 * @param paperId - Định danh đề.
 * @param body - Thân sửa metadata.
 * @returns View đề sau khi sửa.
 */
export function updateExamPaperMeta(paperId: string, body: UpdateExamPaperMetaBody) {
  return apiJson<PaperView>(`/api/v1/exams/${paperId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/**
 * Thay toàn bộ slots của đề (PUT /exams/:id/slots).
 *
 * @param paperId - Định danh đề.
 * @param slots - Danh sách slot mới.
 * @returns View đề sau khi thay.
 */
export function replaceExamPaperSlots(
  paperId: string,
  slots: { questionId: string; maxMark: number; section?: string }[],
) {
  return apiJson<PaperView>(`/api/v1/exams/${paperId}/slots`, {
    method: 'PUT',
    body: JSON.stringify({ slots }),
  });
}

/**
 * Đổi câu của một slot sang câu khác CÙNG Ô ma trận (POST /exams/:id/swap).
 *
 * @param paperId - Định danh đề.
 * @param position - Vị trí slot.
 * @param questionId - Định danh câu mới.
 * @returns View đề mới.
 */
export function swapExamPaperSlot(paperId: string, position: number, questionId: string) {
  return apiJson<PaperView>(`/api/v1/exams/${paperId}/swap`, {
    method: 'POST',
    body: JSON.stringify({ position, questionId }),
  });
}

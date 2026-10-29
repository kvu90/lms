import { apiJson } from '#lib/api';
import type {
  LibraryFilters,
  LibraryItem,
  LibraryItemInput,
  LibrarySpace,
  ReviewChecklist,
} from '../types/content-bank';

/**
 * Tầng gọi API thuần của Kho học liệu thuộc feature content-bank:
 * chỉ chứa các hàm gọi HTTP, không phụ thuộc React hay React
 * Query. Tầng `queries/` của feature bọc các hàm này thành
 * queryOptions và đột biến. Tách từ module phẳng
 * `src/lib/content-bank.ts` khi tổ chức lại apps/web theo mô
 * hình features/ (issue #500).
 */

/**
 * Đọc các không gian kho học liệu (GET /contentbank/spaces).
 *
 * @returns Danh sách không gian.
 */
export function fetchSpaces(): Promise<LibrarySpace[]> {
  return apiJson<LibrarySpace[]>('/api/v1/contentbank/spaces');
}

/**
 * Đọc học liệu theo bộ lọc (GET /contentbank).
 *
 * @param filters - Bộ lọc (mọi trường đều tuỳ chọn).
 * @returns Danh sách học liệu.
 */
export function fetchItems(filters: LibraryFilters = {}): Promise<LibraryItem[]> {
  const params = new URLSearchParams();
  if (filters.scope) params.set('scope', filters.scope);
  if (filters.spaceId) params.set('spaceId', filters.spaceId);
  if (filters.subjectId) params.set('subjectId', filters.subjectId);
  if (filters.grade) params.set('grade', String(filters.grade));
  if (filters.level) params.set('level', filters.level);
  if (filters.resourceType) params.set('resourceType', filters.resourceType);
  if (filters.reviewStatus) params.set('reviewStatus', filters.reviewStatus);
  const qs = params.toString();
  return apiJson<LibraryItem[]>(`/api/v1/contentbank${qs ? `?${qs}` : ''}`);
}

/**
 * Đọc chi tiết một học liệu (GET /contentbank/:id).
 *
 * @param id - Định danh học liệu.
 * @returns Chi tiết học liệu.
 */
export function fetchItem(id: string): Promise<LibraryItem> {
  return apiJson<LibraryItem>(`/api/v1/contentbank/${id}`);
}

/**
 * Tạo một học liệu mới (POST /contentbank).
 *
 * @param input - Thân tạo.
 * @returns Học liệu vừa tạo.
 */
export function createItem(input: LibraryItemInput): Promise<LibraryItem> {
  return apiJson<LibraryItem>('/api/v1/contentbank', { method: 'POST', body: JSON.stringify(input) });
}

/**
 * Sửa một học liệu (PATCH /contentbank/:id).
 *
 * @param id - Định danh học liệu.
 * @param input - Thân sửa (một phần).
 * @returns Học liệu sau khi sửa.
 */
export function updateItem(id: string, input: Partial<LibraryItemInput>): Promise<LibraryItem> {
  return apiJson<LibraryItem>(`/api/v1/contentbank/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

/**
 * Xoá một học liệu (DELETE /contentbank/:id).
 *
 * @param id - Định danh học liệu.
 * @returns Cờ đã xoá.
 */
export function deleteItem(id: string): Promise<{ deleted: boolean }> {
  return apiJson<{ deleted: boolean }>(`/api/v1/contentbank/${id}`, { method: 'DELETE' });
}

/**
 * Gửi duyệt một học liệu (POST /contentbank/:id/submit).
 *
 * @param id - Định danh học liệu.
 * @returns Học liệu sau khi gửi.
 */
export function submitItem(id: string): Promise<LibraryItem> {
  return apiJson<LibraryItem>(`/api/v1/contentbank/${id}/submit`, { method: 'POST' });
}

/**
 * Duyệt/từ chối một học liệu đang chờ (POST /contentbank/:id/review).
 *
 * @param id - Định danh học liệu.
 * @param decision - Quyết định duyệt.
 * @param note - Ghi chú (khi có).
 * @param checklist - Checklist duyệt (khi có).
 * @returns Học liệu sau khi duyệt.
 */
export function reviewItem(id: string, decision: 'approved' | 'rejected', note?: string, checklist?: ReviewChecklist): Promise<LibraryItem> {
  return apiJson<LibraryItem>(`/api/v1/contentbank/${id}/review`, {
    method: 'POST',
    body: JSON.stringify({ decision, ...(note ? { note } : {}), ...(checklist ? { checklist } : {}) }),
  });
}

/**
 * Cắm một học liệu vào một section của khoá bằng bản sao (POST /contentbank/:id/insert).
 *
 * @param id - Định danh học liệu.
 * @param courseId - Định danh khoá.
 * @param sectionId - Định danh section.
 * @returns Mã module vừa cắm và file kèm theo (khi có).
 */
export function insertItem(id: string, courseId: string, sectionId: string): Promise<{ cmId: string; fileId: string | null }> {
  return apiJson<{ cmId: string; fileId: string | null }>(`/api/v1/contentbank/${id}/insert`, {
    method: 'POST',
    body: JSON.stringify({ courseId, sectionId }),
  });
}

/**
 * Tải tệp lên cho một học liệu (POST /contentbank/:id/file, base64).
 *
 * @param id - Định danh học liệu.
 * @param fileName - Tên tệp.
 * @param contentBase64 - Nội dung base64 thuần.
 * @param mimeType - Loại MIME (khi có).
 * @returns Học liệu sau khi gắn tệp.
 */
export function uploadItemFile(id: string, fileName: string, contentBase64: string, mimeType?: string): Promise<LibraryItem> {
  return apiJson<LibraryItem>(`/api/v1/contentbank/${id}/file`, {
    method: 'POST',
    body: JSON.stringify({ fileName, contentBase64, ...(mimeType ? { mimeType } : {}) }),
  });
}

/**
 * Đọc URL tải tệp đã ký của một học liệu (GET /contentbank/:id/file-url).
 *
 * @param id - Định danh học liệu.
 * @returns URL đã ký và mốc hết hạn.
 */
export function fetchItemFileUrl(id: string): Promise<{ url: string; expiresAt: number }> {
  return apiJson<{ url: string; expiresAt: number }>(`/api/v1/contentbank/${id}/file-url`);
}

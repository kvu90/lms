import type { UserListResponse, UserProfile } from '@lms/contracts';
import { apiJson } from '#lib/api';
import type { NewUserDraft, UpdateUserDraft } from '../types/admin-users';

/**
 * Tầng gọi API thuần của cụm quản trị người dùng thuộc feature
 * admin: chỉ chứa các hàm gọi HTTP, không phụ thuộc React hay React
 * Query. Tầng `queries/` của feature bọc các hàm này thành
 * queryOptions, hook và đột biến. Tách từ module dữ liệu phẳng
 * `src/lib/admin-users-data.ts` khi tổ chức lại apps/web theo mô
 * hình features/ (issue #500).
 */

/**
 * Đọc danh sách người dùng theo (trang, cỡ trang, từ khoá) — server
 * cắt trang và lọc (GET /users).
 *
 * @param page - Số trang (bắt đầu từ 1).
 * @param pageSize - Số dòng mỗi trang.
 * @param search - Từ khoá tìm kiếm.
 * @returns Trang danh sách người dùng kèm tổng số dòng.
 */
export function fetchAdminUsers(page: number, pageSize: number, search: string) {
  return apiJson<UserListResponse>(
    `/api/v1/users?search=${encodeURIComponent(search)}&page=${page}&pageSize=${pageSize}`,
  );
}

/**
 * Đọc hồ sơ một người dùng (GET /users/:id) cho màn sửa.
 *
 * @param userId - Định danh người dùng.
 * @returns Hồ sơ người dùng.
 */
export function fetchAdminUser(userId: string) {
  return apiJson<UserProfile>(`/api/v1/users/${userId}`);
}

/**
 * Khoá hoặc mở khoá một người dùng (POST /users/:id/suspend|reactivate).
 *
 * @param input - Định danh người dùng và trạng thái khoá muốn đặt.
 * @returns Đáp ứng của API.
 */
export function toggleUserSuspended(input: { id: string; suspended: boolean }) {
  return apiJson(`/api/v1/users/${input.id}/${input.suspended ? 'suspend' : 'reactivate'}`, {
    method: 'POST',
  });
}

/**
 * Xoá mềm một người dùng (DELETE /users/:id).
 *
 * @param id - Định danh người dùng.
 * @returns Đáp ứng của API.
 */
export function deleteAdminUser(id: string) {
  return apiJson(`/api/v1/users/${id}`, { method: 'DELETE' });
}

/**
 * Tạo người dùng mới (POST /users).
 *
 * @param draft - Thân tạo người dùng.
 * @returns Đáp ứng của API.
 */
export function createAdminUser(draft: NewUserDraft) {
  return apiJson('/api/v1/users', { method: 'POST', body: JSON.stringify(draft) });
}

/**
 * Sửa người dùng (PATCH /users/:id).
 *
 * @param input - Định danh người dùng và thân sửa.
 * @returns Đáp ứng của API.
 */
export function updateAdminUser(input: { userId: string; draft: UpdateUserDraft }) {
  return apiJson(`/api/v1/users/${input.userId}`, {
    method: 'PATCH',
    body: JSON.stringify(input.draft),
  });
}

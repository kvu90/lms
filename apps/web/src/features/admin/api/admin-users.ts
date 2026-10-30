import type { UserListResponse, UserListSortBy, UserListStatus, UserProfile } from '@lms/contracts';
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
  return fetchAdminUsersList({ page, pageSize, search });
}

/**
 * Tham số liệt kê người dùng đầy đủ theo hợp đồng truy vấn của đợt 1:
 * lọc trạng thái, sắp xếp và phân trang đều chạy phía server; tham số
 * tuỳ chọn vắng mặt được bỏ khỏi chuỗi truy vấn để server giữ hành vi
 * mặc định vốn có của nó (ẩn tài khoản đã xoá, thứ tự theo id).
 */
export interface ListAdminUsersParams {
  /** Số trang (bắt đầu từ 1). */
  page: number;
  /** Số dòng mỗi trang (server chặn trần 100). */
  pageSize: number;
  /** Từ khoá tìm kiếm; bỏ qua khi rỗng. */
  search?: string;
  /** Nhóm trạng thái cần lấy; bỏ qua thì server chỉ trả tài khoản chưa xoá. */
  status?: UserListStatus;
  /** Trường sắp xếp theo hợp đồng (`name`/`createdAt`/`lastLogin`); bỏ qua thì server giữ thứ tự theo id. */
  sortBy?: UserListSortBy;
  /** Chiều sắp xếp; chỉ có hiệu lực khi có `sortBy`. */
  sortDirection?: 'asc' | 'desc';
}

/**
 * Đọc một trang danh sách người dùng theo hợp đồng truy vấn đầy đủ
 * (GET /users) — lọc trạng thái, sắp xếp, tìm kiếm và cắt trang đều
 * do server thực hiện.
 *
 * @param params - Bộ lọc, sắp xếp và phân trang của trang cần đọc.
 * @returns Trang danh sách người dùng kèm tổng số dòng khớp bộ lọc.
 */
export function fetchAdminUsersList(params: ListAdminUsersParams) {
  const query = new URLSearchParams();
  if (params.search) query.set('search', params.search);
  if (params.status) query.set('status', params.status);
  if (params.sortBy) query.set('sortBy', params.sortBy);
  if (params.sortBy && params.sortDirection) query.set('sortDirection', params.sortDirection);
  query.set('page', String(params.page));
  query.set('pageSize', String(params.pageSize));
  return apiJson<UserListResponse>(`/api/v1/users?${query.toString()}`);
}

/** Cỡ trang của lượt quét toàn bộ cho đường lọc theo vai trò — đúng trần server của hợp đồng danh sách. */
const ALL_USERS_PAGE_SIZE = 100;

/**
 * Đọc TOÀN BỘ người dùng khớp bộ lọc/sắp xếp (GET /users, quét lần
 * lượt các trang ở cỡ trần 100). Chỉ dùng cho đường lọc theo vai trò
 * ở ngữ cảnh hệ thống: hợp đồng danh sách không có tham số vai trò,
 * nên trang lấy đủ tập người dùng đã lọc/sắp xếp phía server rồi giao
 * với tập người giữ vai (cũng do server lọc qua endpoint gán vai) —
 * mọi phép lọc vẫn chạy phía server, phía client chỉ giao hai tập
 * định danh và cắt trang để hiển thị.
 *
 * @param params - Bộ lọc và sắp xếp (không gồm phân trang hiển thị).
 * @returns Toàn bộ người dùng khớp, giữ đúng thứ tự server đã sắp.
 */
export async function fetchAllAdminUsers(params: Omit<ListAdminUsersParams, 'page' | 'pageSize'>) {
  const users: UserProfile[] = [];
  let page = 1;
  let total = Number.POSITIVE_INFINITY;
  while (users.length < total) {
    const result = await fetchAdminUsersList({ ...params, page, pageSize: ALL_USERS_PAGE_SIZE });
    users.push(...result.users);
    total = result.total;
    if (result.users.length === 0) break;
    page += 1;
  }
  return { users, total };
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

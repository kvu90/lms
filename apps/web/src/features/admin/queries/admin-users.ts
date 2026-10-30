import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryClient } from '#lib/query-client';
import { queryKeys as sharedQueryKeys } from '#lib/query-keys';
import {
  createAdminUser,
  deleteAdminUser,
  fetchAdminUser,
  fetchAdminUsers,
  fetchAdminUsersList,
  fetchAllAdminUsers,
  toggleUserSuspended,
  updateAdminUser,
  type ListAdminUsersParams,
} from '../api/admin-users';
import type { NewUserDraft, UpdateUserDraft } from '../types/admin-users';
import { queryKeys } from './keys';

/**
 * Tầng dữ liệu của cụm quản trị người dùng (F-01 của rà soát #133):
 * danh sách do server phân trang/tìm kiếm (trang giữ trạng thái
 * search + pagination, dữ liệu qua truy vấn có keepPreviousData ở
 * phía trang), hồ sơ một người dùng cho màn sửa, và các thao tác ghi
 * — mọi đột biến đều làm mới gốc khoá danh sách để bảng nạp lại đúng
 * trang hiện tại, như bản trang tự vô hiệu hoá trước đây.
 * Lời gọi API thuần nằm ở tầng `api/` của feature; khoá truy vấn
 * riêng của admin nằm ở `keys.ts` cùng tầng này, riêng khoá danh
 * sách phân trang `adminUsers` dùng chung nên ở lại factory tập
 * trung `src/lib/query-keys.ts`.
 */

/** Tuỳ chọn truy vấn danh sách người dùng theo (trang, cỡ trang, từ khoá) — server cắt trang và lọc. */
export function adminUsersQueryOptions(page: number, pageSize: number, search: string) {
  return queryOptions({
    queryKey: sharedQueryKeys.adminUsers(page, pageSize, search),
    queryFn: () => fetchAdminUsers(page, pageSize, search),
  });
}

/**
 * Tuỳ chọn truy vấn một trang danh sách người dùng theo hợp đồng đầy
 * đủ của đợt 1 (lọc trạng thái + sắp xếp + trần cỡ trang) — trang
 * danh sách dùng tuỳ chọn này; các bề mặt khác vẫn dùng
 * `adminUsersQueryOptions` gọn ở trên.
 */
export function adminUsersListQueryOptions(params: ListAdminUsersParams) {
  return queryOptions({
    queryKey: queryKeys.adminUsersList(params),
    queryFn: () => fetchAdminUsersList(params),
  });
}

/**
 * Tuỳ chọn truy vấn toàn bộ tập người dùng khớp bộ lọc/sắp xếp —
 * chỉ bật ở đường lọc theo vai trò ở ngữ cảnh hệ thống, nơi trang
 * giao tập này với tập người giữ vai rồi tự cắt trang hiển thị.
 */
export function adminUsersAllQueryOptions(params: Omit<ListAdminUsersParams, 'page' | 'pageSize'>) {
  return queryOptions({
    queryKey: queryKeys.adminUsersAll(params),
    queryFn: () => fetchAllAdminUsers(params),
  });
}

/**
 * Tuỳ chọn truy vấn số đếm của một nhóm trạng thái cho thẻ thống kê:
 * đọc đúng một dòng (cỡ trang 1) và lấy tổng server công bố theo bộ
 * lọc trạng thái của đợt 1 — số đếm là số thật của server, không suy
 * từ trang đang hiển thị.
 */
export function adminUserStatQueryOptions(status: 'active' | 'suspended' | 'deleted') {
  return queryOptions({
    queryKey: queryKeys.adminUserStat(status),
    queryFn: () => fetchAdminUsersList({ page: 1, pageSize: 1, status }),
  });
}

/** Tuỳ chọn truy vấn hồ sơ một người dùng (GET /users/:id) cho màn sửa. */
export function adminUserDetailQueryOptions(userId: string) {
  return queryOptions({
    queryKey: queryKeys.adminUserDetail(userId),
    queryFn: () => fetchAdminUser(userId),
  });
}

/** Hook đọc hồ sơ một người dùng cho màn sửa (chỉ bật khi có id). */
export function useAdminUserDetail(userId: string | undefined) {
  return useQuery({
    ...adminUserDetailQueryOptions(userId ?? ''),
    enabled: userId !== undefined && userId !== '',
  });
}

/** Đột biến khoá/mở khoá một người dùng (POST /users/:id/suspend|reactivate). */
export function useToggleUserSuspended() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; suspended: boolean }) => toggleUserSuspended(input),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.adminUsersRoot }),
  });
}

/** Đột biến xoá mềm một người dùng (DELETE /users/:id). */
export function useDeleteAdminUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteAdminUser(id),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.adminUsersRoot }),
  });
}

/** Đột biến tạo người dùng mới (POST /users). */
export function useCreateAdminUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (draft: NewUserDraft) => createAdminUser(draft),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.adminUsersRoot }),
  });
}

/** Đột biến sửa người dùng (PATCH /users/:id) — làm mới danh sách và chính hồ sơ đó. */
export function useUpdateAdminUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; draft: UpdateUserDraft }) => updateAdminUser(input),
    onSuccess: (_data, vars) => {
      void client.invalidateQueries({ queryKey: queryKeys.adminUsersRoot });
      void client.invalidateQueries({ queryKey: queryKeys.adminUserDetail(vars.userId) });
    },
  });
}

/**
 * Nạp trước cho route danh sách người dùng: trang đầu ở trạng thái
 * đầu của trang (cỡ trang mặc định 10, không tìm kiếm, không lọc,
 * không sắp xếp) — đúng khoá truy vấn trang dùng ở lần render đầu.
 */
export async function adminUsersPageClientLoader() {
  await queryClient
    .ensureQueryData(adminUsersListQueryOptions({ page: 1, pageSize: 10 }))
    .catch(() => undefined);
  return null;
}

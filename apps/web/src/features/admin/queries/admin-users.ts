import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryClient } from '#lib/query-client';
import { queryKeys as sharedQueryKeys } from '#lib/query-keys';
import {
  createAdminUser,
  deleteAdminUser,
  fetchAdminUser,
  fetchAdminUsers,
  toggleUserSuspended,
  updateAdminUser,
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
 * Nạp trước cho route danh sách người dùng: trang đầu với cỡ trang
 * mặc định và từ khoá rỗng — đúng trạng thái đầu của trang.
 */
export async function adminUsersPageClientLoader() {
  await queryClient.ensureQueryData(adminUsersQueryOptions(1, 20, '')).catch(() => undefined);
  return null;
}

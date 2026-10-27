import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UserListResponse, UserProfile } from '@lms/contracts';
import { apiJson } from './api';
import { queryClient } from './query-client';
import { queryKeys } from './query-keys';

/**
 * Tầng dữ liệu của cụm quản trị người dùng (F-01 của rà soát #133):
 * danh sách do server phân trang/tìm kiếm (trang giữ trạng thái
 * search + pagination, dữ liệu qua truy vấn có keepPreviousData ở
 * phía trang), hồ sơ một người dùng cho màn sửa, và các thao tác ghi
 * — mọi đột biến đều làm mới gốc khoá danh sách để bảng nạp lại đúng
 * trang hiện tại, như bản trang tự vô hiệu hoá trước đây.
 */

/** Tuỳ chọn truy vấn danh sách người dùng theo (trang, cỡ trang, từ khoá) — server cắt trang và lọc. */
export function adminUsersQueryOptions(page: number, pageSize: number, search: string) {
  return queryOptions({
    queryKey: queryKeys.adminUsers(page, pageSize, search),
    queryFn: () =>
      apiJson<UserListResponse>(
        `/api/v1/users?search=${encodeURIComponent(search)}&page=${page}&pageSize=${pageSize}`,
      ),
  });
}

/** Tuỳ chọn truy vấn hồ sơ một người dùng (GET /users/:id) cho màn sửa. */
export function adminUserDetailQueryOptions(userId: string) {
  return queryOptions({
    queryKey: queryKeys.adminUserDetail(userId),
    queryFn: () => apiJson<UserProfile>(`/api/v1/users/${userId}`),
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
    mutationFn: ({ id, suspended }: { id: string; suspended: boolean }) =>
      apiJson(`/api/v1/users/${id}/${suspended ? 'suspend' : 'reactivate'}`, { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.adminUsersRoot }),
  });
}

/** Đột biến xoá mềm một người dùng (DELETE /users/:id). */
export function useDeleteAdminUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiJson(`/api/v1/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.adminUsersRoot }),
  });
}

/** Thân tạo người dùng mới (POST /users). */
export interface NewUserDraft {
  username: string;
  email: string;
  password: string;
}

/** Đột biến tạo người dùng mới (POST /users). */
export function useCreateAdminUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (draft: NewUserDraft) =>
      apiJson('/api/v1/users', { method: 'POST', body: JSON.stringify(draft) }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.adminUsersRoot }),
  });
}

/** Thân sửa người dùng (PATCH /users/:id — mật khẩu chỉ gửi khi có nhập, để trống nghĩa là không đổi). */
export interface UpdateUserDraft {
  email: string;
  firstName: string;
  lastName: string;
  password?: string;
}

/** Đột biến sửa người dùng (PATCH /users/:id) — làm mới danh sách và chính hồ sơ đó. */
export function useUpdateAdminUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, draft }: { userId: string; draft: UpdateUserDraft }) =>
      apiJson(`/api/v1/users/${userId}`, { method: 'PATCH', body: JSON.stringify(draft) }),
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

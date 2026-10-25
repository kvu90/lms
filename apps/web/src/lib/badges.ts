import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson } from './api';
import { queryKeys } from './query-keys';

/** Huy hiệu (BadgeRow ở tầng API) như các bề mặt hiển thị cần. */
export interface BadgeView {
  id: string;
  name: string;
  description: string;
  type: number;
  courseId: string | null;
  status: number;
}

/** Bản ghi đã cấp (IssuedRow ở tầng API): bằng chứng bất biến của một lần cấp. */
export interface IssuedView {
  id: string;
  badgeId: string;
  userId: string;
  uniqueHash: string;
  dateIssued: string;
  dateExpire: string | null;
  revoked: boolean;
}

/**
 * Một dòng của GET /badges/mine: bản ghi đã cấp kèm chính huy hiệu lồng
 * bên trong (badges.service listMyBadges trả `IssuedRow & { badge }`).
 */
export interface MyBadgeView extends IssuedView {
  badge?: BadgeView;
}

/** Toàn bộ huy hiệu (GET /badges). */
export function useAllBadges() {
  return useQuery({
    queryKey: queryKeys.badgesAll,
    queryFn: () => apiJson<BadgeView[]>('/api/v1/badges'),
  });
}

/** Huy hiệu đã cấp cho chính người dùng (GET /badges/mine). */
export function useMyBadges() {
  return useQuery({
    queryKey: queryKeys.myBadges,
    queryFn: () => apiJson<MyBadgeView[]>('/api/v1/badges/mine'),
  });
}

/** Danh sách đã cấp của một huy hiệu — chỉ tải khi badge được chọn xem. */
export function useBadgeIssued(badgeId: string | null) {
  return useQuery({
    queryKey: queryKeys.badgeIssued(badgeId ?? ''),
    queryFn: () => apiJson<IssuedView[]>(`/api/v1/badges/${badgeId}/issued`),
    enabled: badgeId !== null,
  });
}

/** Làm mới mọi truy vấn huy hiệu (danh sách, của tôi, đã cấp) sau một đột biến. */
function useInvalidateBadges() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.badges });
}

/** Tạo một site badge mới (POST /badges). */
export function useCreateBadge() {
  const invalidate = useInvalidateBadges();
  return useMutation({
    mutationFn: (name: string) =>
      apiJson('/api/v1/badges', { method: 'POST', body: JSON.stringify({ name, type: 1 }) }),
    onSuccess: invalidate,
  });
}

/** Đặt tiêu chí hoàn thành khoá học cho một badge (PUT /badges/:id/criteria). */
export function useSetBadgeCriteria() {
  const invalidate = useInvalidateBadges();
  return useMutation({
    mutationFn: (input: { badgeId: string; courseId: string }) =>
      apiJson(`/api/v1/badges/${input.badgeId}/criteria`, {
        method: 'PUT',
        body: JSON.stringify({
          method: 1,
          criteria: [{ criteriaType: 'coursecompletion', params: { courseId: input.courseId } }],
        }),
      }),
    onSuccess: invalidate,
  });
}

/** Đổi trạng thái một badge (POST /badges/:id/status) — kích hoạt dùng { status: 1 }. */
export function useSetBadgeStatus() {
  const invalidate = useInvalidateBadges();
  return useMutation({
    mutationFn: (input: { badgeId: string; status: number }) =>
      apiJson(`/api/v1/badges/${input.badgeId}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: input.status }),
      }),
    onSuccess: invalidate,
  });
}

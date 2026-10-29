import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys as sharedQueryKeys } from '#lib/query-keys';
import {
  createBadge, fetchAllBadges, fetchBadgeIssued, fetchMyBadges, setBadgeCriteria, setBadgeStatus,
} from '../api/badges';
import { queryKeys } from './keys';

/**
 * Tầng dữ liệu TanStack Query của trang huy hiệu thuộc feature
 * badges: các hook đọc/ghi bọc tầng `../api/badges` (tách khỏi
 * module phẳng `src/lib/badges.ts` khi tổ chức lại apps/web
 * theo mô hình features/, issue #500).
 */

/** Toàn bộ huy hiệu (GET /badges). */
export function useAllBadges() {
  return useQuery({
    queryKey: queryKeys.badgesAll,
    queryFn: () => fetchAllBadges(),
  });
}

/** Huy hiệu đã cấp cho chính người dùng (GET /badges/mine). */
export function useMyBadges() {
  return useQuery({
    queryKey: sharedQueryKeys.myBadges,
    queryFn: () => fetchMyBadges(),
  });
}

/** Danh sách đã cấp của một huy hiệu — chỉ tải khi badge được chọn xem. */
export function useBadgeIssued(badgeId: string | null) {
  return useQuery({
    queryKey: queryKeys.badgeIssued(badgeId ?? ''),
    queryFn: () => fetchBadgeIssued(badgeId ?? ''),
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
    mutationFn: (name: string) => createBadge(name),
    onSuccess: invalidate,
  });
}

/** Đặt tiêu chí hoàn thành khoá học cho một badge (PUT /badges/:id/criteria). */
export function useSetBadgeCriteria() {
  const invalidate = useInvalidateBadges();
  return useMutation({
    mutationFn: (input: { badgeId: string; courseId: string }) => setBadgeCriteria(input.badgeId, input.courseId),
    onSuccess: invalidate,
  });
}

/** Đổi trạng thái một badge (POST /badges/:id/status) — kích hoạt dùng { status: 1 }. */
export function useSetBadgeStatus() {
  const invalidate = useInvalidateBadges();
  return useMutation({
    mutationFn: (input: { badgeId: string; status: number }) => setBadgeStatus(input.badgeId, input.status),
    onSuccess: invalidate,
  });
}

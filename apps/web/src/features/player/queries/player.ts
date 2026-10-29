import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchPlayerView, markPlayerModuleLearned } from '../api/player';
import { queryKeys } from './keys';

/**
 * Tầng dữ liệu trang học/player (F-01 đợt 1, rà soát #133): options
 * dùng chung cho hook của trang và clientLoader của route module.
 * queryFn giữ semantics probe: lỗi tải → null, trang hiển thị lỗi
 * tải như trước thay vì ném ra error boundary.
 * Lời gọi API thuần nằm ở tầng `api/` của feature; khoá truy vấn
 * riêng của player nằm ở `keys.ts` cùng tầng này.
 */

/**
 * Tuỳ chọn truy vấn dữ liệu player của một module.
 *
 * @param courseId - Định danh khoá.
 * @param cmId - Định danh module.
 * @returns Tuỳ chọn truy vấn dữ liệu player.
 */
export function playerViewQueryOptions(courseId: string, cmId: string) {
  return queryOptions({
    queryKey: queryKeys.playerView(courseId, cmId),
    queryFn: () => fetchPlayerView(courseId, cmId),
  });
}

/** Đọc dữ liệu player; thiếu `courseId`/`cmId` thì query tắt. */
export function usePlayerView(courseId: string | undefined, cmId: string | undefined) {
  return useQuery({
    ...playerViewQueryOptions(courseId ?? '', cmId ?? ''),
    enabled: !!courseId && !!cmId,
  });
}

/**
 * Đột biến "Đánh dấu đã học" cho mục hoàn thành thủ công (hai bước
 * probe + POST nằm ở tầng api). Thành công thì làm mới view của
 * player để trạng thái hoàn thành cập nhật.
 */
export function useMarkPlayerModuleLearned(courseId: string | undefined, cmId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => markPlayerModuleLearned(courseId, cmId),
    onSuccess: () => {
      if (courseId && cmId) {
        void client.invalidateQueries({ queryKey: queryKeys.playerView(courseId, cmId) });
      }
    },
  });
}

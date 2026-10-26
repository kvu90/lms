import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { queryKeys } from './query-keys';

/** Payload của sự kiện `unread-count` trên stream SSE — cùng hình dạng với đáp ứng REST GET /notifications/unread-count. */
const unreadCountEventSchema = z.object({ unread: z.number().int().nonnegative() });

const STREAM_URL = '/api/v1/notifications/unread-count/stream';

/**
 * Giữ số thông báo chưa đọc thời gian thực bằng SSE (Server-Sent
 * Events), thay cho polling định kỳ:
 *
 * - Số hiển thị ban đầu vẫn lấy từ truy vấn REST unread-count (nơi gắn
 *   hook lo phần đó); hook này chỉ ĐẨY số mới vào đúng cache key
 *   `notificationUnreadCount` mỗi khi server phát sự kiện — snapshot
 *   đầu stream và mọi thay đổi về sau (thông báo mới, đã đọc, đọc tất
 *   cả) đều đi qua đây.
 * - Từ cutover phiên cookie (issue #7, GĐ2): EventSource chạy cùng
 *   nguồn nên trình duyệt TỰ gửi cookie phiên kèm request — không
 *   còn gắn access token qua query nữa (ngoại lệ token-trong-query
 *   phía API dành cho route stream bị gỡ ở GĐ5 cùng đợt này).
 * - Kết nối rớt: EventSource tự nối lại (mỗi lần nối server gửi lại
 *   snapshot hiện tại). Kết nối bị server đóng hẳn (readyState
 *   CLOSED — phiên đã hết/huỷ) thì dừng lặng lẽ: giữ số gần nhất,
 *   không toast, không vỡ giao diện; tầng phiên sẽ đưa người dùng về
 *   trang đăng nhập qua resolve phiên như mọi bề mặt khác.
 * - Unmount (đăng xuất/rời khung đã đăng nhập) thì đóng stream.
 */
export function useNotificationUnreadStream(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const source = new EventSource(STREAM_URL);
    source.addEventListener('unread-count', (event) => {
      try {
        const parsed = unreadCountEventSchema.safeParse(JSON.parse((event as MessageEvent<string>).data));
        if (parsed.success) {
          queryClient.setQueryData(queryKeys.notificationUnreadCount, { unread: parsed.data.unread });
        }
      } catch {
        // Sự kiện lỗi định dạng: bỏ qua, giữ số gần nhất.
      }
    });
    return () => {
      source.close();
    };
  }, [queryClient]);
}

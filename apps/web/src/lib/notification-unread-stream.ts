import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { refreshTokens, tokenStore } from './api';
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
 * - EventSource không gắn được header Authorization nên access token
 *   đi qua query `access_token` — phía API chỉ chấp nhận cách này cho
 *   riêng route stream (xem JWT strategy của backend).
 * - Kết nối rớt: EventSource tự nối lại (mỗi lần nối server gửi lại
 *   snapshot hiện tại). Nếu server từ chối kết nối (readyState CLOSED —
 *   thường vì access token hết hạn 15 phút), hook làm mới token một
 *   lần rồi dựng lại stream bằng token mới. Mọi lỗi đều lặng lẽ: giữ
 *   số gần nhất, không toast, không vỡ giao diện.
 * - Unmount (đăng xuất/rời khung đã đăng nhập) thì đóng stream.
 */
export function useNotificationUnreadStream(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let source: EventSource | null = null;
    let stopped = false;
    let rebuilding = false;

    const connect = (): void => {
      const access = tokenStore.access;
      if (!access || stopped) return;
      source = new EventSource(`${STREAM_URL}?access_token=${encodeURIComponent(access)}`);
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
      source.onerror = () => {
        if (stopped || rebuilding || !source || source.readyState !== EventSource.CLOSED) return;
        rebuilding = true;
        source.close();
        void refreshTokens().then((ok) => {
          rebuilding = false;
          if (ok && !stopped) connect();
        });
      };
    };

    connect();
    return () => {
      stopped = true;
      source?.close();
    };
  }, [queryClient]);
}

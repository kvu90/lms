import { createAdapter } from '@socket.io/redis-adapter';
import type { RealtimeEmitter, RealtimeRemoteSocket } from '@lms/messaging';
import Redis from 'ioredis';
import { Server } from 'socket.io';

/** Namespace của gateway nhắn tin phía API — nơi phát phải gắn đúng namespace này. */
export const MESSAGING_NAMESPACE = '/messaging';

/**
 * Cài đặt cổng phát realtime {@link RealtimeEmitter} cho consumer
 * phân phối ở worker (issue #521).
 *
 * Cơ chế: một Socket.IO `Server` KHÔNG gắn HTTP listener (không bao
 * giờ nhận kết nối client) nhưng gắn cùng `@socket.io/redis-adapter`
 * mà tiến trình API đang dùng cho gateway. Adapter là backplane
 * chung: phát vào room từ server này được adapter chuyển qua Redis
 * tới đúng tiến trình API đang giữ socket của client, và các thao
 * tác cần liệt kê socket trong room (`fetchSockets`, `leave` từ xa)
 * cũng đi qua giao thức yêu cầu/phản hồi của chính adapter đó.
 *
 * Vì sao không dùng `@socket.io/redis-emitter` (gói emitter độc lập
 * chính thức cho "phát từ tiến trình khác"): bản 5.1.0 của gói đó
 * không có `fetchSockets` — kiểm chứng trên định nghĩa kiểu đã cài —
 * trong khi luật phân phối bắt buộc rà soát room tại thời điểm phát
 * (liệt kê socket trong room, đọc `data.userId`, đẩy socket của
 * người không còn là thành viên ra khỏi room; kỷ luật F1). Server
 * không-listener + adapter dùng đúng bộ API server mà phía API vẫn
 * dùng, nên hành vi hai phía đối xứng.
 */
export interface MessagingRealtimeEmitterHandle {
  emitter: RealtimeEmitter;
  /** Đóng server Socket.IO và hai connection Redis của adapter khi tiến trình tắt. */
  close(): Promise<void>;
}

/** Dựng cổng phát realtime trên `REDIS_URL` của worker. */
export function createMessagingRealtimeEmitter(redisUrl: string, redisOptions: Record<string, unknown> = {}): MessagingRealtimeEmitterHandle {
  const pub = new Redis(redisUrl, { maxRetriesPerRequest: null, ...redisOptions });
  const sub = pub.duplicate();
  const server = new Server();
  server.adapter(createAdapter(pub, sub) as never);
  const namespace = server.of(MESSAGING_NAMESPACE);
  const emitter: RealtimeEmitter = {
    emitToRoom: (room, event, payload) => {
      namespace.to(room).emit(event, payload);
    },
    fetchSocketsInRoom: async (room): Promise<RealtimeRemoteSocket[]> => {
      const sockets = await namespace.in(room).fetchSockets();
      return sockets.map((socket) => ({
        data: socket.data as { userId?: unknown },
        leave: (target: string) => socket.leave(target),
      }));
    },
  };
  return {
    emitter,
    close: async () => {
      // Server không gắn HTTP listener nên không giữ tài nguyên
      // mạng nào phải đóng (gọi `close()` của Socket.IO trên server
      // chưa từng lắng nghe còn lỗi vì không có http server/engine
      // để đóng — kiểm chứng khi chạy spec tích hợp của issue này).
      // Tài nguyên thật là hai connection Redis của adapter: đóng
      // chúng là adapter ngừng hẳn.
      await Promise.allSettled([pub.quit(), sub.quit()]);
    },
  };
}

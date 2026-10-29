import { createAdapter } from '@socket.io/redis-adapter';
import type { RealtimeEmitter, RealtimeRemoteSocket } from '@lms/messaging';
import Redis from 'ioredis';
import { Server } from 'socket.io';

/** Namespace của gateway nhắn tin phía API — nơi phát phải gắn đúng namespace này. */
export const MESSAGING_NAMESPACE = '/messaging';

/**
 * Trần chờ xác nhận publish của một lượt phát (mili giây). Một lần
 * publish lên Redis cùng máy/cùng mạng nội bộ được xác nhận trong
 * vài mili giây; trần 10 giây đủ xa để không biến dao động tải
 * thành lỗi giả, và đủ gần để một connection publish đã chết (lệnh
 * bị xếp vào hàng đợi offline của ioredis và không bao giờ được trả
 * lời) bị biến thành lỗi phân phối trong cùng lượt thử của job,
 * thay vì treo job tới khi BullMQ hết hạn khoá.
 */
const PUBLISH_CONFIRM_TIMEOUT_MS = 10_000;

/**
 * Chờ một lần publish của adapter được Redis xác nhận.
 *
 * Publish bị Redis từ chối (ví dụ connection bị tước quyền PUBLISH
 * bằng ACL, hoặc lỗi connection có kết luận) thì promise gốc reject
 * và lỗi đó được ném nguyên vẹn. Publish không kết luận trong trần
 * {@link PUBLISH_CONFIRM_TIMEOUT_MS} thì bị coi là lỗi phân phối:
 * ném lỗi trần chờ để caller dừng lượt phân phối (không ghi dấu,
 * BullMQ thử lại).
 *
 * @param publish - Promise mà `pubClient.publish(...)` của adapter trả về cho đúng lượt phát đó.
 */
async function confirmBroadcastPublish(publish: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      publish,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Redis publish of a realtime broadcast was not confirmed within ${PUBLISH_CONFIRM_TIMEOUT_MS}ms`));
        }, PUBLISH_CONFIRM_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

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
 *
 * Xác nhận publish (điểm khép của lượt sửa sau đối chiếu PR #543):
 * `broadcast()` của adapter 8.3.0 gọi `pubClient.publish(...)` rồi
 * BỎ QUA promise trả về — không chờ, không bắt lỗi (kiểm chứng trên
 * mã nguồn của bản đã cài) — và API `emit()` của Server không có
 * tay nắm nào để chờ lần publish đó. Hệ quả trước khi sửa: lỗi ở
 * chân publish (connection publish bị Redis từ chối, hoặc đứt trong
 * khi các connection Redis khác còn sống) chỉ nổi lên thành promise
 * rejection không ai bắt, tầng phân phối không hề biết, processor
 * vẫn ghi dấu đã-phân-phối và sự kiện mất lặng lẽ, vĩnh viễn (dấu
 * chặn phát lại, relay chỉ quét dòng chưa đóng dấu).
 *
 * Cổng này sở hữu chính connection publish của adapter nên khép
 * điểm đó tại đúng connection đó: một lớp bọc pass-through trên
 * `pub.publish` ghi lại promise của mọi publish phát ra trong "cửa
 * sổ" của một lượt `emit()`. Đường `emit()` → `adapter.broadcast()`
 * → `pubClient.publish(...)` chạy ĐỒNG BỘ tới tận lệnh publish, và
 * JavaScript đơn luồng nên trong cửa sổ đồng bộ đó không publish
 * nào khác chen vào được — cửa sổ bắt đúng publish của lượt phát,
 * không bắt publish của các thao tác khác của adapter (yêu cầu/phản
 * hồi của `fetchSockets` chạy bất đồng bộ, ngoài cửa sổ). Sau khi
 * `emit()` trả về, `emitToRoom` CHỜ mọi publish đã bắt được được
 * Redis xác nhận (có trần chờ {@link PUBLISH_CONFIRM_TIMEOUT_MS})
 * rồi mới resolve; publish lỗi hoặc treo quá trần thì `emitToRoom`
 * ném lỗi, tầng phân phối ném tiếp lên processor, dấu không được
 * ghi và BullMQ thử lại job — đúng bất biến processor đã ghi.
 *
 * Biên của xác nhận: nó xác nhận Redis đã NHẬN publish trên
 * connection publish của worker. Pub/Sub không lưu trữ — một publish
 * được xác nhận nhưng rơi vào lúc không tiến trình API nào đang
 * subscribe thì vẫn mất theo đúng ngữ nghĩa Pub/Sub vốn có của
 * backplane này, không đổi bởi lượt sửa này. Publish bị trần chờ
 * cắt nhưng sau đó mới được Redis nhận (connection hồi phục muộn)
 * có thể vẫn tới phía API SAU khi job đã bị thử lại: trùng phát ở
 * biên này vô hại vì client chống trùng theo id/seq của tin, cùng
 * tính chất at-least-once mà processor đã ghi cho biên tiến trình
 * chết giữa lượt phân phối.
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
  // Lớp bọc pass-through trên connection publish (xem khối TSDoc của
  // handle ở trên): ghi lại promise của các publish phát ra trong
  // cửa sổ đồng bộ của một lượt `emit()` vào `broadcastPublishes`;
  // ngoài cửa sổ (`null`) thì chỉ chuyển tiếp, không ghi gì.
  let broadcastPublishes: Promise<number>[] | null = null;
  const publishThroughAdapter = pub.publish.bind(pub);
  pub.publish = (channel: string, message: string | Buffer) => {
    const publish = publishThroughAdapter(channel, message);
    broadcastPublishes?.push(publish);
    return publish;
  };
  const server = new Server();
  server.adapter(createAdapter(pub, sub) as never);
  const namespace = server.of(MESSAGING_NAMESPACE);
  const emitter: RealtimeEmitter = {
    emitToRoom: async (room, event, payload) => {
      const publishes: Promise<number>[] = [];
      broadcastPublishes = publishes;
      try {
        namespace.to(room).emit(event, payload);
      } finally {
        broadcastPublishes = null;
      }
      await Promise.all(publishes.map((publish) => confirmBroadcastPublish(publish)));
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

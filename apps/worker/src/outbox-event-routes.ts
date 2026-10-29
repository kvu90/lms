import type { Queue } from 'bullmq';

/**
 * Bảng định tuyến phát job của relay outbox duy nhất (xem
 * `outbox-relay.scheduler.ts`): ánh xạ MỘT loại sự kiện outbox sang tên
 * hàng đợi BullMQ mà relay đẩy job vào khi phát sự kiện đó cho phía
 * tiêu thụ.
 *
 * Flow tổng thể của cơ chế outbox:
 * - Phía API ghi dòng sự kiện vào bảng `outbox_events` trong cùng
 *   transaction với thay đổi nghiệp vụ (transactional outbox).
 * - Relay duy nhất ở tiến trình worker (chạy theo lịch) đọc các dòng
 *   chưa có dấu `publishedAt`, phát từng dòng cho phía tiêu thụ rồi
 *   mới đóng dấu và phản chiếu dòng đã phát vào `event_log`.
 * - "Phát cho phía tiêu thụ" với loại sự kiện đã có consumer trên
 *   hàng đợi ở worker là đẩy MỘT job BullMQ: tên job là chính loại
 *   sự kiện, `jobId` là id của dòng outbox (khoá chống trùng của
 *   BullMQ — phát lại cùng một dòng không tạo job thứ hai), dữ liệu
 *   job là toàn bộ dòng outbox đã chuẩn hoá (xem
 *   {@link OutboxEventJobData}).
 *
 * Hai ngữ nghĩa đã chốt cho bảng này và cho relay:
 * - `publishedAt` là thời điểm relay đã phát sự kiện cho phía tiêu
 *   thụ, KHÔNG phải dấu hoàn thành xử lý. Relay không chờ bất kỳ
 *   consumer hay handler nào xử lý xong mới đóng dấu; mỗi consumer
 *   tự theo dõi tiến độ xử lý của mình (consumer trên hàng đợi theo
 *   cơ chế job của BullMQ, consumer polling còn sót ở phía API theo
 *   watermark `seq` riêng như hiện nay). Không consumer nào được dựa
 *   vào `publishedAt` để kết luận một sự kiện đã được xử lý xong.
 * - Relay ở worker không chờ handler nằm trong tiến trình API hoàn
 *   tất. Một loại sự kiện chỉ vào bảng này khi consumer của nó đã
 *   được chuyển sang hàng đợi ở worker. Loại sự kiện chưa có mặt ở
 *   đây thì CHƯA thuộc phạm vi phát job của relay: relay vẫn đóng
 *   dấu và phản chiếu `event_log` cho các dòng đó như đường
 *   production hiện hành (phía tiêu thụ của chúng vẫn là các
 *   consumer polling đọc trực tiếp bảng outbox theo watermark
 *   `seq`), và đường polling của các consumer đó giữ nguyên cho tới
 *   issue chuyển consumer tương ứng.
 *
 * Cách mở rộng khi chuyển một consumer sang worker: thêm một dòng
 * `'<loại sự kiện>': '<tên hàng đợi>'` vào bảng này và đăng ký
 * processor cho hàng đợi đó. `worker.module.ts` tự suy ra danh sách
 * hàng đợi cần đăng ký và bản đồ hàng đợi cấp cho relay từ chính
 * bảng này, nên không còn nơi nào khác phải sửa để nối đường phát.
 *
 * Tại thời điểm dựng bảng, chưa consumer nào của đợt chuyển đổi
 * hoàn tất nên bảng rỗng có chủ đích: cơ chế phát job, ngữ nghĩa
 * đóng dấu và test đặc trưng hoá ghim cả hai đã sẵn sàng làm nền
 * cho từng issue chuyển consumer.
 */
export const OUTBOX_EVENT_QUEUE_ROUTES: OutboxEventQueueRoutes = {};

/** Bảng định tuyến phát job: khoá là loại sự kiện, giá trị là tên hàng đợi BullMQ. */
export type OutboxEventQueueRoutes = Readonly<Record<string, string>>;

/**
 * Khoá tiêm (injection token) của bảng định tuyến cấp cho relay.
 * `worker.module.ts` cấp chính {@link OUTBOX_EVENT_QUEUE_ROUTES} cho
 * khoá này; test đặc trưng hoá cấp bảng thử riêng để ghim hành vi
 * định tuyến mà không đụng bảng production.
 */
export const OUTBOX_EVENT_ROUTES = 'OUTBOX_EVENT_ROUTES';

/**
 * Khoá tiêm (injection token) của bản đồ hàng đợi dùng cho relay:
 * khoá là tên hàng đợi, giá trị là thực thể `Queue` của BullMQ đã
 * đăng ký trong `worker.module.ts` theo {@link OUTBOX_EVENT_QUEUE_ROUTES}.
 */
export const OUTBOX_EVENT_QUEUES = 'OUTBOX_EVENT_QUEUES';

/** Bản đồ hàng đợi cấp cho relay outbox, tra theo tên hàng đợi. */
export type OutboxEventQueues = ReadonlyMap<string, Queue>;

/**
 * Dữ liệu của MỘT job phát từ MỘT dòng outbox: mang đủ định danh và
 * nội dung của dòng để consumer trên hàng đợi xử lý mà không phải
 * đọc lại bảng outbox, đồng thời truy vết được về đúng dòng gốc.
 *
 * - `outboxId`: id của dòng outbox — đồng thời là `jobId` của job.
 * - `seq`: mốc thứ tự toàn cục của dòng trong bảng outbox.
 * - `aggregate` / `type`: phân hệ và loại sự kiện như đã ghi ở dòng.
 * - `payload`: nội dung sự kiện nguyên văn như đã ghi ở dòng (relay
 *   không biến đổi payload).
 * - `tenantId`: tenant của ngữ cảnh phát sinh sự kiện (có thể null).
 * - `occurredAt`: thời điểm phát sinh sự kiện, dạng chuỗi ISO 8601
 *   (dữ liệu job đi qua Redis nên chỉ giữ dạng JSON hoá được).
 */
export interface OutboxEventJobData {
  outboxId: string;
  seq: number;
  aggregate: string;
  type: string;
  payload: Record<string, unknown> | null;
  tenantId: string | null;
  occurredAt: string;
}

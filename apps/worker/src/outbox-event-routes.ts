import type { Queue } from 'bullmq';

/**
 * Bảng định tuyến phát job của relay outbox duy nhất (xem
 * `outbox-relay.scheduler.ts`): ánh xạ MỘT loại sự kiện outbox sang
 * DANH SÁCH hàng đợi BullMQ mà relay đẩy job vào khi phát sự kiện đó
 * cho các phía tiêu thụ — một sự kiện có thể có NHIỀU handler ở
 * worker, mỗi hàng đợi trong danh sách nhận đúng một job.
 *
 * Flow tổng thể của cơ chế outbox:
 * - Phía API ghi dòng sự kiện vào bảng `outbox_events` trong cùng
 *   transaction với thay đổi nghiệp vụ (transactional outbox).
 * - Relay duy nhất ở tiến trình worker (chạy theo lịch) đọc các dòng
 *   chưa có dấu `publishedAt`, phát từng dòng cho phía tiêu thụ rồi
 *   mới đóng dấu và phản chiếu dòng đã phát vào `event_log`.
 * - "Phát cho phía tiêu thụ" với loại sự kiện đã có consumer trên
 *   hàng đợi ở worker là đẩy MỘT job BullMQ VÀO TỪNG hàng đợi đích:
 *   tên job là chính loại sự kiện, `jobId` là id của dòng outbox
 *   (`jobId` là khoá theo TỪNG hàng đợi nên cùng một id dùng lại ở
 *   mọi đích là an toàn), dữ liệu job là toàn bộ dòng outbox đã
 *   chuẩn hoá (xem {@link OutboxEventJobData}). `jobId` là khoá
 *   chống trùng của BullMQ NHƯNG chỉ trong cửa sổ hàng đợi còn lưu
 *   giữ job: phát lại cùng một dòng trong lúc job của nó còn được
 *   lưu giữ (theo chính sách `removeOnComplete` / `removeOnFail`
 *   hiện hành ở `worker.module.ts`) thì BullMQ trả lại job đã có
 *   thay vì tạo job thứ hai; job đã bị dọn khỏi hàng đợi thì lần
 *   phát lại tạo job MỚI cho cùng một dòng. Ngoài cửa sổ đó, hàng
 *   rào chống tác dụng phụ lần hai không nằm ở `jobId` mà ở tính
 *   idempotent của processor theo `outboxId` (xem ngữ nghĩa chống
 *   trùng hai lớp ở dưới).
 *
 * Ba ngữ nghĩa đã chốt cho bảng này và cho relay:
 * - `publishedAt` là thời điểm relay đã phát sự kiện cho phía tiêu
 *   thụ, KHÔNG phải dấu hoàn thành xử lý. Relay không chờ bất kỳ
 *   consumer hay handler nào xử lý xong mới đóng dấu; mỗi consumer
 *   tự theo dõi tiến độ xử lý của mình (consumer trên hàng đợi theo
 *   cơ chế job của BullMQ và dấu chống trùng riêng theo `outboxId`,
 *   consumer polling còn sót ở phía API theo watermark `seq` riêng
 *   như hiện nay). Không consumer nào được dựa vào `publishedAt` để
 *   kết luận một sự kiện đã được xử lý xong.
 * - Đóng dấu chỉ sau khi phát thành công tới MỌI đích: một dòng có
 *   nhiều hàng đợi đích chỉ được đóng dấu `publishedAt` khi job đã
 *   vào đủ mọi hàng đợi. Lỗi ở BẤT KỲ đích nào thì dòng giữ nguyên
 *   chưa đóng dấu và được phát lại ở nhịp relay sau — các đích đã
 *   nhận job ở lượt phát dở chống trùng theo `jobId` trong cửa sổ
 *   lưu giữ (và theo `outboxId` ở processor ngoài cửa sổ đó) nên
 *   mỗi đích vẫn đúng một lần xử lý hiệu lực cho dòng đó.
 * - Relay ở worker không chờ handler nằm trong tiến trình API hoàn
 *   tất. Một loại sự kiện chỉ vào bảng này khi consumer của nó đã
 *   được chuyển sang hàng đợi ở worker. Loại sự kiện chưa có mặt ở
 *   đây thì CHƯA thuộc phạm vi phát job của relay: relay vẫn đóng
 *   dấu và phản chiếu `event_log` cho các dòng đó như đường
 *   production hiện hành (phía tiêu thụ của chúng vẫn là các
 *   consumer polling đọc trực tiếp bảng outbox theo watermark
 *   `seq`), và đường polling của các consumer đó giữ nguyên cho tới
 *   issue chuyển consumer tương ứng.
 * - Chống trùng hai lớp, phân vai rõ ràng: cam kết của cơ chế này
 *   là at-least-once (`publishedAt` là dấu đã phát, không phải dấu
 *   hoàn thành xử lý). Lớp thứ nhất là `jobId` bằng id dòng outbox,
 *   chỉ có hiệu lực trong cửa sổ lưu giữ của hàng đợi như mô tả ở
 *   trên. Lớp thứ hai — và là hàng rào chính ngoài cửa sổ đó — là
 *   processor của hàng đợi được định tuyến: processor PHẢI
 *   idempotent theo `outboxId`, tức xử lý lại cùng một sự kiện
 *   (cùng `outboxId`) không gây tác dụng phụ lần hai. Mọi issue
 *   thêm dòng định tuyến vào bảng này đều phải dựng processor đạt
 *   tính chất đó và kiểm chứng bằng test mô phỏng phát lại.
 *
 * Cách mở rộng khi chuyển một consumer sang worker: thêm một dòng
 * `'<loại sự kiện>': ['<tên hàng đợi>']` vào bảng này và đăng ký
 * processor cho hàng đợi đó; sự kiện đã có đích sẵn thì THÊM hàng
 * đợi của consumer mới vào danh sách của nó (không dựng định tuyến
 * cạnh tranh). `worker.module.ts` tự suy ra danh sách hàng đợi cần
 * đăng ký và bản đồ hàng đợi cấp cho relay từ chính bảng này, nên
 * không còn nơi nào khác phải sửa để nối đường phát.
 *
 * Các loại đã vào bảng:
 * - Sự kiện mail auth (`auth_mail_requested`) trỏ về hàng đợi
 *   `auth-mail` — consumer đầu tiên của đợt chuyển đổi (issue #517,
 *   processor `AuthMailProcessor`).
 * - Hai loại sự kiện digest phụ huynh (`guardian_digest_due`,
 *   `guardian_overdue_alert`) trỏ về hàng đợi `guardian-digest-events`
 *   — consumer của chúng đã chuyển sang worker (issue #518, processor
 *   `GuardianDigestEventsProcessor`, handler
 *   `GuardianDigestHandlerService`).
 * - Sáu loại sự kiện messaging (xem `MESSAGING_DISTRIBUTED_EVENT_TYPES`
 *   của `@lms/messaging`) trỏ về hàng đợi `messaging-realtime` —
 *   consumer phân phối realtime đã chuyển sang worker (processor
 *   `MessagingRealtimeProcessor`, luật phân phối ở package
 *   `@lms/messaging`). Riêng `message_sent` còn một consumer nữa ở
 *   phía worker là notification-events (issue #520): phía nào nối
 *   đường sau sẽ thêm hàng đợi của consumer đó vào danh sách đích
 *   của `message_sent`, theo đúng ngữ nghĩa fan-out ở trên.
 * Mọi loại sự kiện còn lại của đợt chuyển đổi chưa có mặt ở đây cho
 * tới khi consumer tương ứng chuyển xong, đúng ngữ nghĩa ở trên.
 */
export const OUTBOX_EVENT_QUEUE_ROUTES: OutboxEventQueueRoutes = {
  // Mail auth (issue #517): processor `AuthMailProcessor` trên hàng
  // đợi `auth-mail` dựng nội dung bằng template dùng chung ở
  // `@lms/contracts` và gửi qua transport Resend phía worker.
  auth_mail_requested: ['auth-mail'],
  // Digest phụ huynh (issue #518): processor
  // `GuardianDigestEventsProcessor` trên hàng đợi
  // `guardian-digest-events`.
  guardian_digest_due: ['guardian-digest-events'],
  guardian_overdue_alert: ['guardian-digest-events'],
  message_sent: ['messaging-realtime'],
  message_conversation_read: ['messaging-realtime'],
  message_deleted: ['messaging-realtime'],
  message_recalled: ['messaging-realtime'],
  message_removed: ['messaging-realtime'],
  message_deleted_for_me: ['messaging-realtime'],
};

/**
 * Bảng định tuyến phát job: khoá là loại sự kiện, giá trị là DANH
 * SÁCH tên hàng đợi BullMQ đích của sự kiện đó (mỗi đích một handler).
 */
export type OutboxEventQueueRoutes = Readonly<Record<string, readonly string[]>>;

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

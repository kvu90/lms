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
 *   hàng đợi ở worker là đẩy job BullMQ vào MỌI hàng đợi đích của
 *   loại đó: tên job là chính loại sự kiện, `jobId` là id của dòng
 *   outbox, dữ liệu job là toàn bộ dòng outbox đã chuẩn hoá (xem
 *   {@link OutboxEventJobData}).
 *   `jobId` là khoá chống trùng của BullMQ NHƯNG chỉ trong cửa sổ
 *   hàng đợi còn lưu giữ job: phát lại cùng một dòng trong lúc job
 *   của nó còn được lưu giữ (theo chính sách `removeOnComplete` /
 *   `removeOnFail` hiện hành ở `worker.module.ts`) thì BullMQ trả
 *   lại job đã có thay vì tạo job thứ hai; job đã bị dọn khỏi hàng
 *   đợi thì lần phát lại tạo job MỚI cho cùng một dòng. Ngoài cửa
 *   sổ đó, hàng rào chống tác dụng phụ lần hai không nằm ở `jobId`
 *   mà ở tính idempotent của processor theo `outboxId` (xem ngữ
 *   nghĩa thứ ba ở dưới).
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
 * `'<loại sự kiện>': '<tên hàng đợi>'` vào bảng này và đăng ký
 * processor cho hàng đợi đó. `worker.module.ts` tự suy ra danh sách
 * hàng đợi cần đăng ký và bản đồ hàng đợi cấp cho relay từ chính
 * bảng này, nên không còn nơi nào khác phải sửa để nối đường phát.
 *
 * Fan-out một-nhiều: giá trị của một dòng có thể là MỘT tên hàng
 * đợi hoặc một DANH SÁCH tên hàng đợi khi loại sự kiện có nhiều
 * consumer trên hàng đợi. Relay phát job tới mọi đích trong danh
 * sách và chỉ đóng dấu `publishedAt` sau khi MỌI đích đã nhận job
 * thành công — lỗi ở bất kỳ đích nào thì dòng chưa được đóng dấu
 * và được phát lại ở nhịp sau (đích đã nhận không sinh job trùng
 * trong cửa sổ lưu giữ nhờ `jobId` bằng id dòng outbox; ngoài cửa
 * sổ đó, hàng rào chống tác dụng phụ lần hai là tính idempotent
 * theo `outboxId` của processor ở đích đó). Các consumer của cùng
 * một loại sự kiện vẫn độc lập hoàn toàn: relay không chờ consumer
 * nào xử lý, các consumer không chờ nhau, mỗi consumer tự theo
 * dõi phần xử lý của mình.
 *
 * Các loại đã vào bảng:
 * - Sự kiện mail auth (`auth_mail_requested`) trỏ về hàng đợi
 *   `auth-mail` — consumer đầu tiên của đợt chuyển đổi (issue
 *   #517, processor `AuthMailProcessor`).
 * - Hai loại sự kiện digest phụ huynh (`guardian_digest_due`,
 *   `guardian_overdue_alert`) trỏ về hàng đợi
 *   `guardian-digest-events` — consumer của chúng đã chuyển sang
 *   worker (issue #518, processor `GuardianDigestEventsProcessor`,
 *   handler `GuardianDigestHandlerService`).
 * - Mười loại sự kiện thông báo nghiệp vụ (điểm, hoàn thành khoá,
 *   hết hạn ghi danh, tin nhắn, hạn nộp, vòng đời bài tập/đề) trỏ
 *   về hàng đợi `notification-events` — consumer của chúng đã
 *   chuyển sang worker ở issue con #520 của #491 (processor
 *   `NotificationEventsProcessor`, handler
 *   `NotificationEventsHandlerService`).
 * - Sáu loại sự kiện messaging (xem
 *   `MESSAGING_DISTRIBUTED_EVENT_TYPES` của `@lms/messaging`) trỏ
 *   về hàng đợi `messaging-realtime` — consumer phân phối
 *   realtime đã chuyển sang worker ở issue con #521 của #491
 *   (processor `MessagingRealtimeProcessor`, luật phân phối ở
 *   package `@lms/messaging`). Riêng `message_sent` có HAI
 *   consumer ở worker — phân phối realtime và thông báo sự
 *   kiện — nên dòng của nó là danh sách hai đích
 *   `['messaging-realtime', 'notification-events']` theo đúng cơ
 *   chế fan-out ở trên.
 * - Hai loại sự kiện thành viên cohort (`cohort_member_added`,
 *   `cohort_member_removed`) trỏ về hàng đợi `cohort-sync-events`
 *   — consumer của chúng đã chuyển sang worker ở issue con #528
 *   của #519 (processor `CohortSyncEventsProcessor`, host bề mặt
 *   dùng chung `CohortSyncService`). Processor này không mang
 *   watermark riêng: tính idempotent hai tầng theo quyết định chốt
 *   của issue đó (chống trùng job của relay theo id dòng + guard
 *   theo trạng thái hiện tại của `cohort_members` trong bề mặt),
 *   ghim bằng test mô phỏng phát lại.
 *
 * Mọi loại sự kiện còn lại của đợt chuyển đổi chưa có mặt ở đây
 * cho tới khi consumer tương ứng chuyển xong, đúng ngữ nghĩa ở
 * trên.
 */
export const OUTBOX_EVENT_QUEUE_ROUTES: OutboxEventQueueRoutes = {
  // Mail auth (issue #517): processor `AuthMailProcessor` trên hàng
  // đợi `auth-mail` dựng nội dung bằng template dùng chung ở
  // `@lms/contracts` và gửi qua transport Resend phía worker.
  auth_mail_requested: 'auth-mail',
  // Digest phụ huynh (issue #518): processor
  // `GuardianDigestEventsProcessor` trên hàng đợi
  // `guardian-digest-events`.
  guardian_digest_due: 'guardian-digest-events',
  guardian_overdue_alert: 'guardian-digest-events',
  // Thông báo sự kiện (issue con #520 của #491): processor
  // `NotificationEventsProcessor` trên hàng đợi `notification-events`.
  grade_updated: 'notification-events',
  course_completed: 'notification-events',
  enrol_expiry_warning: 'notification-events',
  activity_due_reminder: 'notification-events',
  assignment_created: 'notification-events',
  assignment_submitted: 'notification-events',
  assignment_returned: 'notification-events',
  exam_pinned: 'notification-events',
  quiz_attempt_finished: 'notification-events',
  // Đồng bộ cohort (issue con #528 của #519, đợt tách #491):
  // processor `CohortSyncEventsProcessor` trên hàng đợi
  // `cohort-sync-events`, gọi bề mặt vật chất hoá cohort dùng chung
  // của issue con #527 qua host `CohortSyncService`.
  cohort_member_added: 'cohort-sync-events',
  cohort_member_removed: 'cohort-sync-events',
  // Phân phối realtime messaging (issue con #521 của #491):
  // processor `MessagingRealtimeProcessor` trên hàng đợi
  // `messaging-realtime`, luật phân phối ở `@lms/messaging`.
  // `message_sent` còn consumer thông báo ở khối trên nên là
  // danh sách hai đích (fan-out) — không dựng dòng riêng cạnh
  // tranh cho cùng một loại sự kiện.
  message_sent: ['messaging-realtime', 'notification-events'],
  message_conversation_read: 'messaging-realtime',
  message_deleted: 'messaging-realtime',
  message_recalled: 'messaging-realtime',
  message_removed: 'messaging-realtime',
  message_deleted_for_me: 'messaging-realtime',
};

/**
 * Bảng định tuyến phát job: khoá là loại sự kiện; giá trị là tên
 * hàng đợi BullMQ duy nhất của loại đó, hoặc danh sách tên hàng
 * đợi khi loại sự kiện có nhiều consumer trên hàng đợi (fan-out
 * một-nhiều — xem ghi chú ở {@link OUTBOX_EVENT_QUEUE_ROUTES}).
 */
export type OutboxEventQueueRoutes = Readonly<Record<string, string | readonly string[]>>;

/**
 * Mọi tên hàng đợi đích của một dòng định tuyến, chuẩn hoá về
 * dạng danh sách: một đích thì danh sách có đúng một phần tử.
 *
 * @param route Giá trị của dòng định tuyến (một tên hoặc danh sách).
 * @returns Danh sách tên hàng đợi đích theo đúng thứ tự khai báo.
 */
export function queueNamesOfRoute(route: string | readonly string[]): readonly string[] {
  return typeof route === 'string' ? [route] : route;
}

/**
 * Mọi tên hàng đợi có mặt trong một bảng định tuyến (khử trùng lặp,
 * giữ thứ tự xuất hiện đầu tiên) — nguồn suy ra danh sách hàng đợi
 * cần đăng ký của `worker.module.ts`.
 *
 * @param routes Bảng định tuyến cần quét.
 * @returns Danh sách tên hàng đợi phân biệt của cả bảng.
 */
export function allQueueNamesOfRoutes(routes: OutboxEventQueueRoutes): string[] {
  const names: string[] = [];
  for (const route of Object.values(routes)) {
    for (const name of queueNamesOfRoute(route)) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

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

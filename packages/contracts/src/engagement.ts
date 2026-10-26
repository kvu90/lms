import { z } from 'zod';
import { uuidIdSchema } from './ids.js';

/** Communication & Engagement contracts — shared shapes between api, worker-facing payloads and web. */

/* ---- Messaging ---- */

/**
 * Tóm tắt TRÍCH DẪN của một tin gốc (lát M3, issue #229): server dựng
 * sẵn theo quyền của TỪNG người nhận để client hiện khối trích dẫn
 * trong bong bóng mà không phải gọi thêm. `excerpt` là nội dung rút
 * gọn của tin gốc; khi tin gốc không còn hiển thị được với người nhận
 * (đã xoá mềm / đã thu hồi / đã xoá cứng / chính người nhận đã
 * xoá-phía-mình) thì `unavailable = true` và `excerpt` rỗng — client
 * hiện "tin gốc đã bị xoá", TUYỆT ĐỐI không lộ nội dung qua khối này.
 * `seq` của tin gốc là neo để client tải cửa sổ quanh vị trí tin gốc
 * khi nó chưa nằm trong danh sách đang hiện.
 */
export const messageQuoteSchema = z.object({
  id: uuidIdSchema,
  seq: z.number().int(),
  userIdFrom: uuidIdSchema,
  excerpt: z.string(),
  unavailable: z.boolean(),
});
export type MessageQuote = z.infer<typeof messageQuoteSchema>;

export const messageSchema = z.object({
  id: uuidIdSchema,
  conversationId: uuidIdSchema,
  userIdFrom: uuidIdSchema,
  subject: z.string(),
  fullMessage: z.string(),
  createdAt: z.string(),
  /** Số thứ tự đơn điệu trong conversation — mốc đồng bộ/phân trang của client (không dựa vào id). */
  seq: z.number().int(),
  /** Khoá chống trùng do client sinh khi gửi lạc quan; null với tin gửi không kèm khoá. */
  clientMessageId: z.string().nullable(),
  /**
   * Dấu vết xoá mềm (Lớp B, issue #33): null khi tin còn nguyên. Tin đã
   * xoá chỉ xuất hiện trong các cửa sổ truy vết có thẩm quyền — phía
   * học sinh không bao giờ nhận được tin có hai trường này khác null
   * qua các đường đọc thường.
   */
  deletedAt: z.string().nullable(),
  deletedBy: uuidIdSchema.nullable(),
  /**
   * Dấu vết THU HỒI (vòng đời tin nhắn theo vai, issue #33): tác giả
   * thu hồi tin cho mọi người trong cửa sổ cấu hình site — từ thời
   * điểm này nội dung bị vô hiệu với mọi thành viên thường (đường đọc
   * thường trả nội dung rỗng kèm hai trường này để client hiện dòng
   * "tin nhắn đã được thu hồi"); chỉ đường truy vết có thẩm quyền
   * mới còn thấy nội dung gốc. null khi tin chưa từng bị thu hồi.
   */
  recalledAt: z.string().nullable(),
  recalledBy: uuidIdSchema.nullable(),
  /**
   * Trả lời trích dẫn (lát M3, issue #229): id của tin gốc được trích
   * dẫn; null khi tin không trả lời tin nào (hoặc tin gốc đã bị xoá
   * cứng — khoá ngoại set null). Khối tóm tắt trích dẫn ở `replyTo`.
   */
  replyToMessageId: uuidIdSchema.nullable(),
  /** Tóm tắt trích dẫn dựng ở server theo quyền của người nhận; null khi tin không trích dẫn tin nào. */
  replyTo: messageQuoteSchema.nullable(),
});
export type LmsMessage = z.infer<typeof messageSchema>;

export const conversationSchema = z.object({
  id: uuidIdSchema,
  type: z.number().int(), // 1 individual, 2 group
  name: z.string().nullable(),
  members: z.array(uuidIdSchema),
  /**
   * Phân loại cấu trúc của conversation (lát MSG-T1, issue #33 —
   * thiết kế cấu trúc nhắn tin chốt 11:36 ngày 26/10/2026): cặp
   * `component` + `itemType` cho biết conversation gắn với thực thể
   * nào — `core_course`/`course` = chat cấp khoá, `core_group`/
   * `groups` = chat nhóm con trong khoá, `core_class`/`class` = chat
   * cấp lớp (có từ MSG-T2); cả ba đều null với hội thoại cá nhân 1–1
   * và nhóm tự do. `itemId` là id của thực thể gắn (khoá/nhóm/lớp).
   * Client phân loại hội thoại bằng ba trường này, TUYỆT ĐỐI không
   * đoán theo tên hiển thị.
   */
  component: z.string().nullable(),
  itemType: z.string().nullable(),
  itemId: uuidIdSchema.nullable(),
});
export type Conversation = z.infer<typeof conversationSchema>;

/**
 * Vai của CHÍNH người gọi tại một nút của cây nhóm (lát MSG-T1):
 * `teaching` = chủ lớp hoặc staff phụ trách dạy của lớp/khoá;
 * `learning` = đang học (thành viên roster lớp / ghi danh hiệu lực);
 * `staff` = có quan hệ công tác khác (đồng GV không thuộc diện phụ
 * trách dạy, thành viên nhóm có vai quản trị). Nhóm tự do chỉ dùng
 * `staff` (người tạo/quản trị) và `learning` (thành viên thường).
 */
export const conversationTreeRoleSchema = z.enum(['teaching', 'learning', 'staff']);
export type ConversationTreeRole = z.infer<typeof conversationTreeRoleSchema>;

/**
 * Một nút lá của cây nhóm: phần DÙNG CHUNG cho nút nhóm con và nút
 * nhóm tự do (lát MSG-T1). `conversationId` null = chat của nút CHƯA
 * được ensure (bấm vào nút mới ensure ở các lát sau) và khi đó
 * `unread` luôn 0; đã ensure thì `unread` là số chưa đọc của chính
 * người gọi trên conversation đó (tôn trọng luật ẩn bề mặt khi chặn
 * như mọi đường đọc — đếm tại server).
 */
export const conversationTreeLeafSchema = z.object({
  name: z.string(),
  myRole: conversationTreeRoleSchema,
  conversationId: uuidIdSchema.nullable(),
  unread: z.number().int().nonnegative(),
});
export type ConversationTreeLeaf = z.infer<typeof conversationTreeLeafSchema>;

/** Nút NHÓM CON trong một khoá (itemType 'groups') của cây nhóm. */
export const conversationTreeGroupSchema = conversationTreeLeafSchema.extend({
  groupId: uuidIdSchema,
});
export type ConversationTreeGroup = z.infer<typeof conversationTreeGroupSchema>;

/** Nút NHÓM TỰ DO (conversation type 2 không gắn cấu trúc) của cây nhóm. */
export const conversationTreeFreeGroupSchema = conversationTreeLeafSchema.extend({
  conversationId: uuidIdSchema,
});
export type ConversationTreeFreeGroup = z.infer<typeof conversationTreeFreeGroupSchema>;

/**
 * Nút KHOÁ HỌC của cây nhóm (lát MSG-T1): nút tự thân là chat cấp
 * khoá (`conversationId`/`unread` của conversation itemType
 * 'course'); `groups` là các nhóm con của khoá mà người gọi thuộc về.
 */
export const conversationTreeCourseSchema = conversationTreeLeafSchema.extend({
  courseId: uuidIdSchema,
  groups: z.array(conversationTreeGroupSchema),
});
export type ConversationTreeCourse = z.infer<typeof conversationTreeCourseSchema>;

/**
 * Nút LỚP của cây nhóm (lát MSG-T1): nút tự thân là chat cấp lớp
 * (`conversationId`/`unread` của conversation itemType 'class' —
 * chat lớp có từ MSG-T2 nên ở lát này conversationId luôn null và
 * `unread` của nút lớp là TỔNG chưa đọc của chính nút lớp cộng các
 * nút con (khoá + nhóm con trong lớp), để nhìn lướt là biết lớp nào
 * đang có tin); `courses` là các khoá NẰM TRONG lớp mà người gọi
 * thuộc về theo đúng quan hệ lớp–khoá (lớp là cha của khoá).
 */
export const conversationTreeClassSchema = conversationTreeLeafSchema.extend({
  classId: uuidIdSchema,
  courses: z.array(conversationTreeCourseSchema),
});
export type ConversationTreeClass = z.infer<typeof conversationTreeClassSchema>;

/**
 * CÂY NHÓM của chính người gọi (lát MSG-T1, GET /messages/group-tree):
 * dựng hoàn toàn ở server từ classes + enrol + conversations — client
 * KHÔNG tự ghép từ danh sách hội thoại phẳng. `classes` là các lớp
 * tôi có quan hệ (chủ lớp / staff / roster), mỗi lớp kèm các khoá
 * trong lớp mà tôi thuộc về; `coursesOutsideClasses` là các khoá tôi
 * thuộc về mà lớp chứa chúng tôi KHÔNG có quan hệ trực tiếp (vẫn neo
 * theo quan hệ lớp–khoá ở course ngoài — không nhân bản thành nút
 * "khoá ngoài lớp" tách rời khỏi lớp của nó khi tôi có lớp đó ở
 * `classes`); `freeGroups` là các nhóm tự do tôi là thành viên.
 */
export const conversationGroupTreeSchema = z.object({
  classes: z.array(conversationTreeClassSchema),
  coursesOutsideClasses: z.array(conversationTreeCourseSchema),
  freeGroups: z.array(conversationTreeFreeGroupSchema),
});
export type ConversationGroupTree = z.infer<typeof conversationGroupTreeSchema>;

export const notificationSchema = z.object({
  id: uuidIdSchema,
  userIdTo: uuidIdSchema,
  subject: z.string(),
  fullMessage: z.string(),
  eventType: z.string(),
  timeRead: z.string().nullable(),
  createdAt: z.string(),
});
export type LmsNotification = z.infer<typeof notificationSchema>;

/** Tần suất gửi email của một loại thông báo (mô hình tuỳ chọn v2, NB-2 issue #174). */
export const emailFrequencySchema = z.enum(['immediate', 'daily', 'off']);
export type EmailFrequency = z.infer<typeof emailFrequencySchema>;

/**
 * Một dòng tuỳ chọn notification v2 mà API trả về
 * (MessagingService.getPreferences): MỘT dòng cho mỗi provider — trục
 * loggedin/loggedoff của mô hình cũ đã bỏ. Nhãn + mô tả vi/en lấy từ
 * registry ở API (nguồn sự thật duy nhất; web không tự chế bảng nhãn).
 * `emailFrequency` là null khi provider không có kênh email;
 * `emailAvailable` cho biết kênh email đã gửi thật hay chưa (false cho
 * tới khi SMTP nối ở NB-5 — cài đặt vẫn lưu và áp dụng khi kênh mở).
 * Kênh push không xuất hiện ở đây: chưa có app native nên ẩn hẳn khỏi
 * trang cài đặt, chỉ còn trong registry provider.
 */
export const notificationPreferenceSchema = z.object({
  provider: z.string(),
  component: z.string(),
  /** Phân loại 3 nhóm của provider (hồ sơ chuẩn thông báo D.1): học tập / lớp & mọi người / hệ thống. */
  group: z.enum(['learning', 'people', 'system']),
  label: z.object({ vi: z.string(), en: z.string() }),
  description: z.object({ vi: z.string(), en: z.string() }),
  /** Loại chỉ giáo viên mới nhận được — web gắn nhãn theo vai. */
  teacherOnly: z.boolean(),
  /** Loại bắt buộc (chính sách P2): kênh trong-app không tắt được. */
  mandatoryInApp: z.boolean(),
  popupEnabled: z.boolean(),
  emailFrequency: emailFrequencySchema.nullable(),
  emailAvailable: z.boolean(),
});
export type NotificationPreference = z.infer<typeof notificationPreferenceSchema>;

/* ---- Trung tâm thông báo v2 (lát N2, issue #51) ---- */

/** Ba nhóm thông báo theo hồ sơ chuẩn thông báo D.1: học tập / lớp & mọi người / hệ thống. */
export const notificationGroupNameSchema = z.enum(['learning', 'people', 'system']);
export type NotificationGroupName = z.infer<typeof notificationGroupNameSchema>;

/** Một thông báo đầy đủ như API danh sách phẳng của trung tâm v2 trả về. */
export const notificationItemSchema = z.object({
  id: uuidIdSchema,
  userIdFrom: uuidIdSchema.nullable(),
  userIdTo: uuidIdSchema,
  subject: z.string(),
  fullMessage: z.string(),
  smallMessage: z.string(),
  component: z.string(),
  eventType: z.string(),
  contextUrl: z.string().nullable(),
  contextUrlName: z.string().nullable(),
  timeRead: z.string().nullable(),
  createdAt: z.string(),
});
export type NotificationItem = z.infer<typeof notificationItemSchema>;

/**
 * Một dòng GỘP của trung tâm thông báo: khoá gộp là (loại × nguồn ×
 * ngày) — loại = `eventType`, nguồn = `contextUrl` (null khi thông báo
 * không có ngữ cảnh đích, khi đó gộp theo component), ngày = ngày lịch
 * Asia/Saigon dạng `YYYY-MM-DD`. `latest` là mục mới nhất đại diện cho
 * cả dòng; `count`/`unreadCount` đếm trên toàn bộ các mục trong dòng.
 */
export const notificationGroupSchema = z.object({
  eventType: z.string(),
  component: z.string(),
  group: notificationGroupNameSchema,
  contextUrl: z.string().nullable(),
  day: z.string(),
  count: z.number().int(),
  unreadCount: z.number().int(),
  latest: z.object({
    id: uuidIdSchema,
    subject: z.string(),
    smallMessage: z.string(),
    contextUrlName: z.string().nullable(),
    createdAt: z.string(),
    timeRead: z.string().nullable(),
  }),
});
export type NotificationGroup = z.infer<typeof notificationGroupSchema>;

/** Trang kết quả phân trang con trỏ: `nextCursor` null khi đã hết. */
export const notificationGroupPageSchema = z.object({
  items: z.array(notificationGroupSchema),
  nextCursor: z.string().nullable(),
});
export type NotificationGroupPage = z.infer<typeof notificationGroupPageSchema>;

export const notificationItemPageSchema = z.object({
  items: z.array(notificationItemSchema),
  nextCursor: z.string().nullable(),
});
export type NotificationItemPage = z.infer<typeof notificationItemPageSchema>;

/** Query danh sách GỘP: lọc theo nhóm, chỉ chưa đọc, con trỏ keyset mờ (client không tự dựng). */
export const listNotificationGroupsQuerySchema = z.object({
  group: notificationGroupNameSchema.optional(),
  unreadOnly: z.boolean().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type ListNotificationGroupsQuery = z.infer<typeof listNotificationGroupsQuerySchema>;

/**
 * Query danh sách PHẲNG: bộ lọc (eventType + contextUrl + day) mở chi
 * tiết đúng một dòng gộp; `contextUrl` là chuỗi rỗng '' nghĩa là nguồn
 * KHÔNG có contextUrl (phân biệt với việc không truyền = không lọc).
 */
export const listNotificationItemsQuerySchema = z.object({
  eventType: z.string().min(1).optional(),
  contextUrl: z.string().optional(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  group: notificationGroupNameSchema.optional(),
  unreadOnly: z.boolean().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type ListNotificationItemsQuery = z.infer<typeof listNotificationItemsQuerySchema>;

/** Body đánh dấu đã đọc hàng loạt theo khoá gộp (loại × nguồn × ngày). */
export const readNotificationGroupSchema = z.object({
  eventType: z.string().min(1),
  contextUrl: z.string().nullable().optional(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type ReadNotificationGroup = z.infer<typeof readNotificationGroupSchema>;

/* ---- Calendar ---- */

export const CALENDAR_EVENT_TYPES = ['site', 'category', 'course', 'group', 'user'] as const;
export const calendarEventSchema = z.object({
  id: uuidIdSchema,
  name: z.string(),
  eventType: z.enum(CALENDAR_EVENT_TYPES),
  timeStart: z.string(),
  timeDuration: z.number().int(),
  repeatId: uuidIdSchema,
  isException: z.boolean(),
});
export type CalendarEvent = z.infer<typeof calendarEventSchema>;

/* ---- Badges ---- */

export const badgeSchema = z.object({
  id: uuidIdSchema,
  name: z.string(),
  type: z.number().int(), // 1 site, 2 course
  status: z.number().int(), // 0 inactive, 1 active, 2 retired, 3 archived, 4 disabled
});
export type Badge = z.infer<typeof badgeSchema>;

export const issuedBadgeSchema = z.object({
  id: uuidIdSchema,
  badgeId: uuidIdSchema,
  userId: uuidIdSchema,
  uniqueHash: z.string(),
  dateIssued: z.string(),
  dateExpire: z.string().nullable(),
  revoked: z.boolean(),
});
export type IssuedBadge = z.infer<typeof issuedBadgeSchema>;

/* ---- Competencies ---- */

export const PLAN_STATUSES = [0, 1, 2, 3, 4] as const; // draft, active, waitingforreview, inreview, complete
export const learningPlanSchema = z.object({
  id: uuidIdSchema,
  name: z.string(),
  userId: uuidIdSchema,
  templateId: uuidIdSchema.nullable(),
  status: z.number().int(),
});
export type LearningPlan = z.infer<typeof learningPlanSchema>;

export const userCompetencySchema = z.object({
  id: uuidIdSchema,
  userId: uuidIdSchema,
  competencyId: uuidIdSchema,
  grade: z.number().int().nullable(),
  proficiency: z.boolean().nullable(),
  status: z.number().int(), // review: 0 none, 1 waiting, 2 inreview
});
export type UserCompetency = z.infer<typeof userCompetencySchema>;

/* ---- Social ---- */

export const tagSchema = z.object({
  id: uuidIdSchema,
  name: z.string(),
  ordering: z.number().int(),
});
export type Tag = z.infer<typeof tagSchema>;

export const commentSchema = z.object({
  id: uuidIdSchema,
  userId: uuidIdSchema,
  content: z.string(),
  contextId: uuidIdSchema,
});
export type LmsComment = z.infer<typeof commentSchema>;

export const ratingAggregateSchema = z.object({
  count: z.number().int(),
  average: z.number(),
  sum: z.number(),
  min: z.number().nullable(),
  max: z.number().nullable(),
});
export type RatingAggregate = z.infer<typeof ratingAggregateSchema>;


export const noteSchema = z.object({
  id: uuidIdSchema,
  userId: uuidIdSchema, // subject user
  courseId: uuidIdSchema,
  createdBy: uuidIdSchema,
  content: z.string(),
  publishState: z.enum(['draft', 'public', 'site']),
});
export type Note = z.infer<typeof noteSchema>;

/* ---- Request payload schemas (Zod — nguồn sự thật duy nhất; xem ADR Zod-only) ---- */

/** Payload tạo cuộc hội thoại: type 1 = cá nhân, 2 = nhóm. */
export const createConversationSchema = z.strictObject({
  type: z.number().int().optional(),
  memberIds: z.array(uuidIdSchema),
  name: z.string().optional(),
});
export type CreateConversation = z.infer<typeof createConversationSchema>;

/** Payload tạo conversation gắn với một course group (component core_group). */
export const createGroupConversationSchema = z.strictObject({
  groupId: uuidIdSchema,
  name: z.string().optional(),
});
export type CreateGroupConversation = z.infer<typeof createGroupConversationSchema>;

/**
 * Trần độ dài một tin nhắn theo MẶC ĐỊNH của chính sách đã chốt (issue
 * #33, điểm P2; lát M2 issue #212): 10.000 ký tự người dùng thấy. Giá
 * trị hiệu lực thật nằm ở site-config `core/messagingmaxmessagelength`
 * (quản trị đổi được, server là nguồn sự thật duy nhất khi gửi); hằng
 * này chỉ là mặc định dùng chung để registry site-config và bộ soạn
 * tin trên web không lệch nhau ở giá trị gốc.
 */
export const MESSAGING_MAX_MESSAGE_LENGTH_DEFAULT = 10000;

/** Payload gửi tin nhắn vào một cuộc hội thoại. */
export const sendMessageSchema = z.strictObject({
  text: z.string().min(1),
  subject: z.string().optional(),
  /**
   * Khoá chống trùng do client sinh cho mỗi lần soạn một tin (gửi lạc
   * quan + thử lại khi mạng chập): server gặp lại cùng khoá trong cùng
   * conversation của cùng người gửi thì trả chính tin đã lưu, không tạo
   * tin thứ hai.
   */
  clientMessageId: z.string().min(1).max(128).optional(),
  /**
   * Trả lời trích dẫn một tin cụ thể (lát M3, issue #229): id của tin
   * GỐC trong ĐÚNG conversation đang gửi — server kiểm ở tầng service
   * (tin không thuộc conversation này → 400, không lộ tồn tại). Phần
   * trích dẫn KHÔNG tính vào trần độ dài của nội dung tin.
   */
  replyToMessageId: uuidIdSchema.optional(),
});
export type SendMessage = z.infer<typeof sendMessageSchema>;

/**
 * Query phân trang cursor cho danh sách tin của một conversation: lấy
 * các tin TRƯỚC `beforeSeq` (tải lịch sử cũ) hoặc SAU `afterSeq` (đồng
 * bộ phần thiếu sau khi nối lại). Tầng server ép kiểu từ query string
 * bằng schema server riêng (xem dto phía api) — ở contracts chỉ khai
 * hình dạng số học.
 */
export const listMessagesQuerySchema = z.strictObject({
  beforeSeq: z.number().int().positive().optional(),
  afterSeq: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;

/**
 * Tìm nội dung tin TRONG MỘT conversation (lát M4, issue #237): chỉ
 * tồn tại bên trong bề mặt nhắn tin — nội dung tin KHÔNG được index
 * vào search toàn cục của hệ (chốt ở hồ sơ rà soát hoàn thiện nhắn
 * tin). `q` là chuỗi con khớp không phân biệt hoa thường; tầng service
 * cắt khoảng trắng hai đầu và từ chối truy vấn rỗng bằng 400 xác định.
 */
export const searchMessagesQuerySchema = z.strictObject({
  q: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(50).optional(),
});
export type SearchMessagesQuery = z.infer<typeof searchMessagesQuerySchema>;

/**
 * Một kết quả tìm tin trong conversation (lát M4): `excerpt` là đoạn
 * nội dung quanh chỗ khớp do server rút gọn — kết quả CHỈ chứa tin
 * còn hiển thị được với chính người tìm theo luật bề mặt đọc (đã xoá
 * mềm/thu hồi/ẩn-phía-mình/phía bị chặn không bao giờ xuất hiện, kể
 * cả qua excerpt). `seq` + `id` là neo để client nhảy tới đúng tin
 * bằng cơ chế cửa sổ quanh seq của lát M3.
 */
export const messageSearchResultSchema = z.object({
  id: uuidIdSchema,
  conversationId: uuidIdSchema,
  userIdFrom: uuidIdSchema,
  seq: z.number().int(),
  excerpt: z.string(),
  createdAt: z.string(),
});
export type MessageSearchResult = z.infer<typeof messageSearchResultSchema>;

/**
 * Bật/tắt chat của một conversation (Lớp B, issue #33): nhóm lớp mặc
 * định chat hai chiều; giáo viên phụ trách (hoặc người tạo nhóm tự do,
 * hoặc quản trị viên) tắt được — học sinh dừng gửi, người có thẩm quyền
 * quản lý vẫn gửi được đường thông báo.
 */
export const updateConversationSchema = z.strictObject({
  enabled: z.boolean(),
});
export type UpdateConversation = z.infer<typeof updateConversationSchema>;

/**
 * Query danh sách conversation của tôi (lát M5, issue #240): mặc định
 * chỉ các conversation CHƯA lưu trữ; `archived: true` = xem riêng mục
 * đã lưu trữ.
 */
export const listConversationsQuerySchema = z.strictObject({
  archived: z.boolean().optional(),
});
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

/**
 * Đặt trạng thái cá nhân của CHÍNH THÀNH VIÊN trên một conversation
 * (lát M5, issue #240): ba cờ độc lập — ghim, lưu trữ, tắt tiếng. Chỉ
 * các trường có mặt mới bị đổi; trường vắng giữ nguyên trạng thái cũ.
 * Trạng thái là của từng thành viên, không ảnh hưởng phía còn lại.
 */
export const updateConversationStateSchema = z.strictObject({
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  muted: z.boolean().optional(),
});
export type UpdateConversationState = z.infer<typeof updateConversationStateSchema>;

/** Trạng thái cá nhân của người xem trên một conversation (lát M5) — hình dạng API trả về. */
export const conversationMemberStateSchema = z.object({
  conversationId: uuidIdSchema,
  pinned: z.boolean(),
  pinnedAt: z.string().nullable(),
  archived: z.boolean(),
  archivedAt: z.string().nullable(),
  muted: z.boolean(),
});
export type ConversationMemberState = z.infer<typeof conversationMemberStateSchema>;

/** Báo cáo một conversation (Lớp B, issue #33): lý do là tuỳ chọn. */
export const reportConversationSchema = z.strictObject({
  reason: z.string().max(1000).optional(),
});
export type ReportConversation = z.infer<typeof reportConversationSchema>;

/** Đổi trạng thái xử lý của một báo cáo conversation (Lớp B, issue #33). */
export const updateReportStatusSchema = z.strictObject({
  status: z.enum(['open', 'resolved', 'dismissed']),
});
export type UpdateReportStatus = z.infer<typeof updateReportStatusSchema>;

/**
 * Xoá CỨNG một tin bởi người kiểm duyệt (vòng đời tin nhắn theo vai,
 * issue #33): chỉ người có capability `moderation:manage` trong phạm
 * vi của conversation, không giới hạn thời gian, và LÝ DO LÀ BẮT
 * BUỘC — mọi lần xoá cứng đều ghi một dòng moderator_action kèm lý
 * do này trước khi dòng tin bị xoá vật lý.
 */
export const hardDeleteMessageSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
});
export type HardDeleteMessage = z.infer<typeof hardDeleteMessageSchema>;

/**
 * Gỡ HÀNG LOẠT nhiều tin bởi người kiểm duyệt: cùng luật thẩm quyền
 * và lý do bắt buộc như xoá cứng một tin; trần 100 tin mỗi lượt để
 * một yêu cầu không khoá bảng quá lâu — cần gỡ nhiều hơn thì chia
 * lượt. Toàn bộ danh sách được kiểm tra thẩm quyền TRƯỚC: một tin
 * ngoài phạm vi là cả yêu cầu bị từ chối, không gỡ một phần.
 */
export const bulkRemoveMessagesSchema = z.strictObject({
  messageIds: z.array(uuidIdSchema).min(1).max(100),
  reason: z.string().trim().min(1).max(500),
});
export type BulkRemoveMessages = z.infer<typeof bulkRemoveMessagesSchema>;

/**
 * Tóm tắt hiển thị của một user, trả kèm trong các response danh sách
 * của messaging để client hiện TÊN thay cho UUID thô.
 */
export const personSummarySchema = z.strictObject({
  userId: uuidIdSchema,
  displayName: z.string(),
  username: z.string(),
});
export type PersonSummary = z.infer<typeof personSummarySchema>;

/** Trạng thái quan hệ của một người so với người xem. */
export const contactRelationshipSchema = z.enum([
  'contact',
  'pending_incoming',
  'pending_outgoing',
  'blocked',
  'none',
]);
export type ContactRelationship = z.infer<typeof contactRelationshipSchema>;

/**
 * Vai trò của một thành viên trong danh sách khoá (roster): `teacher`
 * khi có gán vai trò staff (theo archetype) tại context khoá, còn lại
 * là `student` (ghi danh hoặc gán vai trò học viên).
 */
export const courseRosterRoleSchema = z.enum(['teacher', 'student']);
export type CourseRosterRole = z.infer<typeof courseRosterRoleSchema>;

/**
 * Một dòng của danh sách thành viên khoá (mô hình khám phá bạn bè đã
 * chốt lại của issue #33: bỏ hẳn tìm người theo tên — vào khoá mình
 * thuộc về, xem thành viên, bấm kết bạn tại dòng). Người có quan hệ
 * chặn với người xem (cả hai chiều) bị giấu khỏi danh sách nên trạng
 * thái `blocked` không xuất hiện trong thực tế. `canDirectMessage`:
 * người xem là giáo viên của khoá và thành viên đang ghi danh hiệu
 * lực → nhắn riêng trực tiếp không cần kết bạn (ngoại lệ chốt bổ
 * sung 25/10/2026 trên issue #33); web hiện nút "Nhắn tin" tại dòng
 * theo cờ này, cổng API vẫn tự kiểm lại quan hệ ở mỗi lần mở/gửi.
 */
export const courseRosterMemberSchema = personSummarySchema.extend({
  role: courseRosterRoleSchema,
  relationship: contactRelationshipSchema,
  canDirectMessage: z.boolean(),
});
export type CourseRosterMember = z.infer<typeof courseRosterMemberSchema>;

/** Một khoá mà người dùng thuộc về (ghi danh hoặc gán vai tại context khoá) — đầu vào của luồng tìm bạn theo khoá. */
export const messagingCourseSchema = z.strictObject({
  courseId: uuidIdSchema,
  fullName: z.string(),
  shortName: z.string(),
});
export type MessagingCourse = z.infer<typeof messagingCourseSchema>;

/**
 * Query phân trang cho danh sách thành viên khoá: roster có thể rất
 * đông (khoá 50.000 thành viên trả hết là ~6,3 MB JSON — số đo của đội
 * kiểm tra độc lập trên issue #33) nên PHÂN TRANG CON TRỎ là bắt buộc,
 * không có chế độ lấy hết. Con trỏ là chuỗi mờ (opaque) do server phát
 * hành, neo theo khoá sắp xếp (displayName, username, id) của dòng
 * cuối trang trước; trần mỗi trang 100 (phân trang OFFSET sâu đã đo
 * là chậm hơn hẳn nên không dùng).
 */
export const listCourseRosterQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(512).optional(),
});
export type ListCourseRosterQuery = z.infer<typeof listCourseRosterQuerySchema>;

/* ---- Sự kiện realtime của messaging (Socket.IO, namespace /messaging) ---- */

/** Tên sự kiện trên kênh realtime — một nguồn sự thật cho cả api và web. */
export const MESSAGING_SOCKET_EVENTS = {
  /** Server → client: có tin mới trong một conversation của người nhận. */
  newMessage: 'message.new',
  /** Server → client: conversation đổi (tin cuối + số chưa đọc của chính user này). */
  conversationUpdated: 'conversation.updated',
  /** Server → client: một thành viên đã đọc tới mốc lastReadSeq. */
  messageRead: 'message.read',
  /** Server → client: một tin đã bị xoá mềm — client gỡ tin khỏi khung (payload không kèm nội dung). */
  messageDeleted: 'message.deleted',
  /**
   * Server → client: cache DANH SÁCH conversation của người nhận đã
   * cũ — client PHẢI tải lại danh sách (tin cuối/số chưa đọc không
   * còn tin được sau một lần xoá/thu hồi/xoá cứng). Phát kèm mọi sự
   * kiện xoá của vòng đời tin nhắn theo vai (issue #33).
   */
  conversationInvalidate: 'conversation.invalidate',
  /** Hai chiều: một thành viên đang nhập trong conversation. */
  typing: 'typing',
  /** Server → client: trạng thái trực tuyến của một user thay đổi. */
  presenceChanged: 'presence.changed',
  /** Client → server: xin các tin còn thiếu theo mốc seq của từng conversation; kết quả trả qua ack. */
  sync: 'sync',
  /** Client → server: xin vào room của một conversation (server kiểm tra tư cách thành viên). */
  joinConversation: 'conversation.join',
  /** Client → server: rời room của một conversation. */
  leaveConversation: 'conversation.leave',
} as const;

/** Tin mới được phân phối qua consumer của outbox `message_sent`. */
export interface RealtimeNewMessagePayload {
  conversationId: string;
  message: LmsMessage;
}

/** Cập nhật cho danh sách conversation của TỪNG user (số chưa đọc là của user nhận sự kiện). */
export interface RealtimeConversationUpdatedPayload {
  conversationId: string;
  message: LmsMessage;
  unreadCount: number;
}

export interface RealtimeMessageReadPayload {
  conversationId: string;
  userId: string;
  lastReadSeq: number;
}

/**
 * Một tin bị xoá mềm (Lớp B, issue #33), phân phối qua consumer của
 * outbox `message_deleted`. Payload CHỈ mang định danh + người xoá —
 * không kèm nội dung: phía học sinh phải gỡ tin và không được nhận lại
 * nội dung qua kênh realtime.
 */
export interface RealtimeMessageDeletedPayload {
  conversationId: string;
  messageId: string;
  seq: number;
  deletedBy: string;
}

/**
 * Danh sách conversation của người nhận sự kiện này phải được tải
 * lại từ đầu (vô hiệu cache): phát sau các thao tác xoá/thu hồi/xoá
 * cứng làm tin cuối hoặc số chưa đọc thay đổi theo cách mà một bản
 * `conversation.updated` đơn lẻ không diễn tả hết được (ví dụ tin
 * cuối bị xoá cứng — không còn "tin cuối mới" để gửi kèm).
 */
export interface RealtimeConversationInvalidatePayload {
  conversationId: string;
}

export interface RealtimeTypingPayload {
  conversationId: string;
  userId: string;
}

export interface RealtimePresencePayload {
  userId: string;
  online: boolean;
}

/** Payload client gửi khi nối lại: conversationId → seq cao nhất đã thấy. */
export type MessagingSyncRequest = Record<string, number>;

/** Kết quả đồng bộ: conversationId → các tin còn thiếu, tăng dần theo seq. */
export type MessagingSyncResult = Record<string, LmsMessage[]>;

/** Payload đặt tuỳ chọn kênh nhận cho một message provider. */
/**
 * Đặt tuỳ chọn v2 cho MỘT provider: ít nhất một trong hai trường phải
 * có mặt (API kiểm tra thêm và trả 400 `messaging.preference_empty`).
 * Tắt popup của loại bắt buộc bị API từ chối 400
 * `messaging.preference_mandatory`.
 */
export const setNotificationPreferenceSchema = z.strictObject({
  provider: z.string().min(1),
  popupEnabled: z.boolean().optional(),
  emailFrequency: emailFrequencySchema.optional(),
});
export type SetNotificationPreference = z.infer<typeof setNotificationPreferenceSchema>;

/**
 * Chế độ ghi đè thông báo theo khoá học (NB-4, issue #174): 'all' =
 * nhận như mặc định toàn cục; 'mute' = tắt tiếng khoá — các thông báo
 * thường của khoá đó không được sinh ở bất kỳ kênh nào. Chính sách P3
 * đã chốt: điểm mới và sắp hết hạn ghi danh của khoá bị mute VẪN tới;
 * hai loại bắt buộc P2 cũng không bị ghi đè theo khoá chặn.
 */
export const notificationCourseOverrideModeSchema = z.enum(['all', 'mute']);
export type NotificationCourseOverrideMode = z.infer<typeof notificationCourseOverrideModeSchema>;

/**
 * Một dòng ghi đè theo khoá mà API trả về (GET
 * /messages/preferences/courses): mọi khoá người dùng thuộc về, kèm
 * chế độ hiệu lực — 'all' khi chưa từng đặt ghi đè cho khoá đó.
 */
export const notificationCourseOverrideSchema = z.object({
  courseId: uuidIdSchema,
  courseName: z.string(),
  mode: notificationCourseOverrideModeSchema,
});
export type NotificationCourseOverride = z.infer<typeof notificationCourseOverrideSchema>;

/** Đặt ghi đè cho đúng một khoá (PUT /messages/preferences/courses). */
export const setNotificationCourseOverrideSchema = z.strictObject({
  courseId: uuidIdSchema,
  mode: notificationCourseOverrideModeSchema,
});
export type SetNotificationCourseOverride = z.infer<typeof setNotificationCourseOverrideSchema>;

/** Payload phát thông báo hệ thống tới một người dùng. */
export const notifyUserSchema = z.strictObject({
  userId: uuidIdSchema,
  provider: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
  contextUrl: z.string().optional(),
});
export type NotifyUser = z.infer<typeof notifyUserSchema>;

/** Quy tắc lặp của sự kiện lịch (chỉ nhận các tần suất hệ thống hỗ trợ). */
export const calendarRepeatSchema = z.strictObject({
  freq: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'daily', 'weekly', 'monthly']),
  count: z.number().int().optional(),
  until: z.string().optional(),
});
export type CalendarRepeat = z.infer<typeof calendarRepeatSchema>;

/** Payload tạo sự kiện lịch theo loại phạm vi (site/category/course/group/user). */
export const createCalendarEventSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().optional(),
  eventType: z.enum(['site', 'category', 'course', 'group', 'user']),
  courseId: uuidIdSchema.optional(),
  groupId: uuidIdSchema.optional(),
  categoryId: uuidIdSchema.optional(),
  timeStart: z.string(),
  timeDuration: z.number().int().optional(),
  location: z.string().optional(),
  repeat: calendarRepeatSchema.optional(),
});
export type CreateCalendarEvent = z.infer<typeof createCalendarEventSchema>;

/** Payload tạo ngoại lệ (exception) cho một sự kiện lặp. */
export const createCalendarExceptionSchema = z.strictObject({
  name: z.string().optional(),
  timeStart: z.string(),
  description: z.string().optional(),
});
export type CreateCalendarException = z.infer<typeof createCalendarExceptionSchema>;

/** Payload tạo đăng ký lịch ngoài (subscription) từ URL hoặc dữ liệu ICS. */
export const createCalendarSubscriptionSchema = z.strictObject({
  name: z.string().min(1),
  url: z.string().optional(),
  icsData: z.string().optional(),
  eventType: z.enum(['site', 'category', 'course', 'group', 'user']).optional(),
  courseId: uuidIdSchema.optional(),
  categoryId: uuidIdSchema.optional(),
  pollInterval: z.number().int().optional(),
});
export type CreateCalendarSubscription = z.infer<typeof createCalendarSubscriptionSchema>;

/** Payload đặt nhắc nhở trước sự kiện (số phút). */
export const calendarRemindSchema = z.strictObject({
  minutesBefore: z.number().int(),
});
export type CalendarRemind = z.infer<typeof calendarRemindSchema>;

/** Payload tạo huy hiệu (badge): type 1 = site, 2 = course. */
export const createBadgeSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.number().int().optional(),
  courseId: uuidIdSchema.optional(),
  issuerName: z.string().optional(),
  issuerUrl: z.string().optional(),
  issuerContact: z.string().optional(),
  expireDate: z.string().optional(),
  expirePeriod: z.number().int().optional(),
  version: z.string().optional(),
});
export type CreateBadge = z.infer<typeof createBadgeSchema>;

/** Payload sửa huy hiệu (mọi trường đều tuỳ chọn). */
export const updateBadgeSchema = z.strictObject({
  name: z.string().optional(),
  description: z.string().optional(),
  issuerName: z.string().optional(),
  expirePeriod: z.number().int().optional(),
});
export type UpdateBadge = z.infer<typeof updateBadgeSchema>;

/** Payload đổi trạng thái vòng đời của huy hiệu. */
export const setBadgeStatusSchema = z.strictObject({
  status: z.number().int(),
});
export type SetBadgeStatus = z.infer<typeof setBadgeStatusSchema>;

/**
 * Tham số của từng loại lá tiêu chí cấp huy hiệu (discriminated theo
 * `criteriaType` ở schema lá bên dưới):
 * - `coursecompletion`: `{ courseId, byDate? }` — hoàn thành khoá học; khi có
 *   `byDate` (ISO datetime) thì thời điểm hoàn thành phải ≤ ngày đó mới tính
 *   (Moodle: tham số by-date của tiêu chí hoàn thành khoá học).
 * - `activitycompletion`: `{ cmId }` — hoàn thành hoạt động.
 * - `competency`: `{ competencyId }` — đạt proficiency của năng lực.
 * - `badge`: `{ badgeId }` — đã được cấp huy hiệu khác.
 * - `manual`: `{ roleId? }` — cấp tay bởi người giữ vai trò (tuỳ chọn).
 * - `cohort`: `{ cohortId }` hoặc `{ cohortIds }` — thuộc cohort chỉ định
 *   (dạng mảng: phải thuộc TẤT CẢ cohort liệt kê).
 * - `profile`: `{ field, value? }` — trường hồ sơ chuẩn (firstName, lastName,
 *   email, username…) hoặc custom field theo shortName đạt điều kiện: có
 *   `value` thì giá trị phải bằng đúng; không có `value` thì trường phải
 *   được điền (khác rỗng).
 */
export const badgeCriteriaParamsSchema = z.union([
  z.strictObject({ courseId: uuidIdSchema, byDate: z.iso.datetime({ offset: true }).optional() }),
  z.strictObject({ cmId: uuidIdSchema }),
  z.strictObject({ competencyId: uuidIdSchema }),
  z.strictObject({ badgeId: uuidIdSchema }),
  z.strictObject({ roleId: uuidIdSchema.optional() }),
  z.strictObject({ cohortId: uuidIdSchema }),
  z.strictObject({ cohortIds: z.array(uuidIdSchema).min(1) }),
  z.strictObject({ field: z.string().min(1), value: z.string().optional() }),
]);
export type BadgeCriteriaParams = z.infer<typeof badgeCriteriaParamsSchema>;

/** Các loại lá tiêu chí huy hiệu được hỗ trợ (khớp LEAF_TYPES phía API). */
export const badgeCriteriaLeafTypes = [
  'coursecompletion', 'activitycompletion', 'competency', 'badge', 'manual', 'cohort', 'profile',
] as const;

/** Một lá tiêu chí cấp huy hiệu: loại tiêu chí + bộ tham số riêng của loại đó. */
export const badgeCriteriaLeafSchema = z.strictObject({
  criteriaType: z.enum(badgeCriteriaLeafTypes),
  params: badgeCriteriaParamsSchema.optional(),
  description: z.string().optional(),
});
export type BadgeCriteriaLeaf = z.infer<typeof badgeCriteriaLeafSchema>;

/** Payload đặt bộ tiêu chí cấp huy hiệu: method 1 = TẤT CẢ (ALL), 2 = BẤT KỲ (ANY). */
export const setBadgeCriteriaSchema = z.strictObject({
  method: z.number().int(),
  criteria: z.array(badgeCriteriaLeafSchema),
});
export type SetBadgeCriteria = z.infer<typeof setBadgeCriteriaSchema>;

/** Payload mang một userId (cấp tay / đánh giá huy hiệu cho một người dùng). */
export const badgeUserSchema = z.strictObject({
  userId: uuidIdSchema,
});
export type BadgeUser = z.infer<typeof badgeUserSchema>;

/** Thang đánh giá của một competency framework: danh sách mức + các mức được coi là đạt (proficient). */
export const competencyScaleSchema = z.strictObject({
  values: z.array(z.string()),
  proficient: z.array(z.number().int()),
});
export type CompetencyScale = z.infer<typeof competencyScaleSchema>;

/** Payload tạo competency framework kèm thang đánh giá. */
export const createCompetencyFrameworkSchema = z.strictObject({
  shortName: z.string().min(1),
  idNumber: z.string().optional(),
  description: z.string().optional(),
  scale: competencyScaleSchema,
  visible: z.boolean().optional(),
});
export type CreateCompetencyFramework = z.infer<typeof createCompetencyFrameworkSchema>;

/** Payload tạo competency trong một framework. */
export const createCompetencySchema = z.strictObject({
  shortName: z.string().min(1),
  idNumber: z.string().optional(),
  description: z.string().optional(),
  parentId: uuidIdSchema.optional(),
});
export type CreateCompetency = z.infer<typeof createCompetencySchema>;

/** Payload liên kết competency với một course module kèm kết quả áp dụng (rule outcome). */
export const linkCompetencySchema = z.strictObject({
  competencyId: uuidIdSchema,
  ruleOutcome: z.string(),
});
export type LinkCompetency = z.infer<typeof linkCompetencySchema>;

/** Payload tạo mẫu kế hoạch học tập (learning plan template). */
export const createLearningPlanTemplateSchema = z.strictObject({
  shortName: z.string().min(1),
  description: z.string().optional(),
  dueDate: z.string().optional(),
});
export type CreateLearningPlanTemplate = z.infer<typeof createLearningPlanTemplateSchema>;

/** Payload gắn một competency vào template. */
export const addTemplateCompetencySchema = z.strictObject({
  competencyId: uuidIdSchema,
});
export type AddTemplateCompetency = z.infer<typeof addTemplateCompetencySchema>;

/** Payload gắn một cohort vào template (sinh plan cho cả cohort ở tầng nghiệp vụ). */
export const addTemplateCohortSchema = z.strictObject({
  cohortId: uuidIdSchema,
});
export type AddTemplateCohort = z.infer<typeof addTemplateCohortSchema>;

/** Payload tạo kế hoạch học tập (từ template hoặc tự do). */
export const createLearningPlanSchema = z.strictObject({
  userId: uuidIdSchema.optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  templateId: uuidIdSchema.optional(),
});
export type CreateLearningPlan = z.infer<typeof createLearningPlanSchema>;

/** Payload nộp bằng chứng (evidence) cho một competency. */
export const addCompetencyEvidenceSchema = z.strictObject({
  userId: uuidIdSchema,
  competencyId: uuidIdSchema,
  planId: uuidIdSchema.optional(),
  courseId: uuidIdSchema.optional(),
  description: z.string().min(1),
  url: z.string().optional(),
  grade: z.number().int().optional(),
  note: z.string().optional(),
  sendForReview: z.boolean().optional(),
});
export type AddCompetencyEvidence = z.infer<typeof addCompetencyEvidenceSchema>;

/** Payload chấm mức đạt cho competency của một người dùng. */
export const gradeUserCompetencySchema = z.strictObject({
  userId: uuidIdSchema,
  competencyId: uuidIdSchema,
  planId: uuidIdSchema.optional(),
  courseId: uuidIdSchema.optional(),
  grade: z.number().int(),
  note: z.string().optional(),
});
export type GradeUserCompetency = z.infer<typeof gradeUserCompetencySchema>;

/** Payload quyết định khi duyệt (review) competency: mức đạt + ghi chú. */
export const competencyReviewDecisionSchema = z.strictObject({
  grade: z.number().int().optional(),
  note: z.string().optional(),
});
export type CompetencyReviewDecision = z.infer<typeof competencyReviewDecisionSchema>;

/** Payload chỉ mang ghi chú (dùng cho các thao tác duyệt/chuyển trạng thái kèm nhận xét). */
export const competencyNoteSchema = z.strictObject({
  note: z.string().optional(),
});
export type CompetencyNote = z.infer<typeof competencyNoteSchema>;

/** Payload chỉ mang một giá trị số (dùng cho thao tác đặt giá trị đơn lẻ). */
export const numericValueSchema = z.strictObject({
  value: z.number().optional(),
});
export type NumericValue = z.infer<typeof numericValueSchema>;

/**
 * Kết quả áp dụng khi rule của competency cha thỏa (Moodle `competency.ruleoutcome`):
 * `complete` = cha tự đạt proficiency, `attach-evidence` = chỉ ghi evidence, `nothing` = không làm gì.
 */
export const competencyRuleOutcomeSchema = z.enum(['complete', 'attach-evidence', 'nothing']);
export type CompetencyRuleOutcome = z.infer<typeof competencyRuleOutcomeSchema>;

/** Một dòng điểm của rule points: competency con đóng góp `points` điểm khi đạt proficiency; `required` = bắt buộc đạt. */
export const competencyRulePointsEntrySchema = z.strictObject({
  competencyId: uuidIdSchema,
  points: z.number().int().min(0),
  required: z.boolean(),
});
export type CompetencyRulePointsEntry = z.infer<typeof competencyRulePointsEntrySchema>;

/**
 * Payload đặt rule points cho một competency cha (Moodle `competency_rule_points`):
 * cha thỏa rule khi mọi con `required` đều đạt proficiency VÀ tổng điểm các con đã đạt
 * >= `pointsRequired`. Tính hợp lệ sâu (con phải là con trực tiếp, không trùng, tổng điểm
 * phải với tới ngưỡng) do tầng nghiệp vụ kiểm tra.
 */
export const setCompetencyRuleSchema = z.strictObject({
  outcome: competencyRuleOutcomeSchema,
  pointsRequired: z.number().int().min(1),
  entries: z.array(competencyRulePointsEntrySchema).min(1),
});
export type SetCompetencyRule = z.infer<typeof setCompetencyRuleSchema>;

/** Một dòng điểm của rule points trong tài liệu export: tham chiếu con bằng `competencyKey` nội bộ của file. */
export const frameworkExportRuleEntrySchema = z.strictObject({
  competencyKey: z.string().min(1),
  points: z.number().int().min(0),
  required: z.boolean(),
});
export type FrameworkExportRuleEntry = z.infer<typeof frameworkExportRuleEntrySchema>;

/** Rule points của một competency trong tài liệu export framework. */
export const frameworkExportRuleSchema = z.strictObject({
  outcome: competencyRuleOutcomeSchema,
  pointsRequired: z.number().int().min(1),
  entries: z.array(frameworkExportRuleEntrySchema).min(1),
});
export type FrameworkExportRule = z.infer<typeof frameworkExportRuleSchema>;

/** Một competency trong tài liệu export framework: `key` là khóa nội bộ của file (id nguồn), KHÔNG phải id sẽ dùng khi import. */
export const frameworkExportCompetencySchema = z.strictObject({
  key: z.string().min(1),
  shortName: z.string().min(1),
  idNumber: z.string(),
  description: z.string(),
  parentKey: z.string().min(1).nullable(),
  sortOrder: z.number().int(),
  rule: frameworkExportRuleSchema.nullable(),
});
export type FrameworkExportCompetency = z.infer<typeof frameworkExportCompetencySchema>;

/**
 * Tài liệu export/import của một competency framework (định dạng của chính hệ thống):
 * cây competency + scale + taxonomies. Import luôn tạo framework MỚI với id mới toàn bộ;
 * `key`/`parentKey`/`competencyKey` chỉ để nối cấu trúc bên trong file.
 */
export const frameworkExportSchema = z.strictObject({
  format: z.literal('lms-competency-framework'),
  version: z.literal(1),
  framework: z.strictObject({
    shortName: z.string().min(1),
    idNumber: z.string(),
    description: z.string(),
    visible: z.boolean(),
    taxonomies: z.string(),
    scale: competencyScaleSchema,
  }),
  competencies: z.array(frameworkExportCompetencySchema),
});
export type FrameworkExport = z.infer<typeof frameworkExportSchema>;

/** Payload đặt toàn bộ thẻ (tags) cho một item. */
export const setItemTagsSchema = z.strictObject({
  component: z.string(),
  itemType: z.string(),
  itemId: uuidIdSchema,
  contextId: uuidIdSchema,
  tags: z.array(z.string()),
});
export type SetItemTags = z.infer<typeof setItemTagsSchema>;

/** Payload thêm một thẻ cho một item. */
export const addItemTagSchema = z.strictObject({
  component: z.string(),
  itemType: z.string(),
  itemId: uuidIdSchema,
  contextId: uuidIdSchema,
  tag: z.string().min(1),
});
export type AddItemTag = z.infer<typeof addItemTagSchema>;

/** Payload thêm bình luận vào một item trong một context. */
export const addCommentSchema = z.strictObject({
  contextId: uuidIdSchema,
  component: z.string(),
  commentArea: z.string(),
  itemId: uuidIdSchema,
  content: z.string().min(1),
});
export type AddComment = z.infer<typeof addCommentSchema>;

/** Payload chấm điểm (rating) cho một item theo một thang (scale). */
export const rateItemSchema = z.strictObject({
  contextId: uuidIdSchema,
  component: z.string(),
  ratingArea: z.string(),
  itemId: uuidIdSchema,
  scaleId: z.number().int(),
  rating: z.number().int(),
});
export type RateItem = z.infer<typeof rateItemSchema>;


/** Payload tạo ghi chú (note) về một người dùng: publishState draft | public | site. */
export const createNoteSchema = z.strictObject({
  userId: uuidIdSchema,
  courseId: uuidIdSchema.optional(),
  content: z.string().min(1),
  publishState: z.enum(['draft', 'public', 'site']).optional(),
  groupId: uuidIdSchema.optional(),
});
export type CreateNote = z.infer<typeof createNoteSchema>;

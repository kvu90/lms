/**
 * Sổ đăng ký provider thông báo + các hằng số/hàm luật dùng chung của
 * module messaging (NB-7, issue #174: tách khỏi messaging.service.ts để
 * registry site-config và các tầng khác đọc được danh sách provider mà
 * không kéo theo MessagingService — tránh import vòng). MessagingService
 * vẫn là nơi phát (notify) và re-export toàn bộ các symbol ở đây để các
 * điểm import cũ không đổi.
 */

/** Delivery channels are PORTS. 'popup' (in-app) is the only real channel. */
export const MESSAGE_CHANNELS = ['popup', 'email', 'push'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];
export type LoginState = 'loggedin' | 'loggedoff';

/**
 * Phân loại 3 nhóm cho trang cài đặt thông báo (hồ sơ chuẩn thông báo
 * 2026-10-24, mục D.1): Học tập / Lớp & mọi người / Hệ thống. Nhãn hiển
 * thị + mô tả từng loại nằm ngay trong registry provider (NB-2).
 */
export type MessageProviderGroup = 'learning' | 'people' | 'system';

/** Tần suất gửi email của một loại thông báo (mô hình tuỳ chọn v2, NB-2). */
export type EmailFrequency = 'immediate' | 'daily' | 'off';

/**
 * Phía người nhận của một loại thông báo theo VAI + CONTEXT (lát phân
 * chia tuỳ chọn theo vai trò, việc nối tiếp của issue #288):
 *
 * - `'student'` — người nhận là HỌC SINH/người học trong một context
 *   học tập (người có điểm thay đổi, người được giao bài, người ghi
 *   danh sắp hết hạn…).
 * - `'staff'` — người nhận là NHÂN SỰ/GIÁO VIÊN trong vai trò phụ
 *   trách (nhân sự khoá nhận bản gộp bài nộp, người duyệt năng lực…).
 * - `'guardian'` — người nhận là PHỤ HUYNH qua liên kết giám hộ đang
 *   hiệu lực (digest/ cảnh báo quá hạn của con).
 * - `'admin'` — người nhận gồm QUẢN TRỊ VIÊN CẤP SITE trong vai trò
 *   quản trị (đồng nhận báo cáo hội thoại cùng nhân sự khoá…).
 * - `'all'` — MỌI VAI đều có thể là người nhận (tin nhắn mới, yêu cầu
 *   kết bạn, nhắc lịch của chính mình, thông báo quản trị gửi đích
 *   danh cho một user bất kỳ…).
 *
 * Giá trị của từng provider được chốt bằng TRUY VẾT điểm phát thật
 * (`notify()` ở consumer sự kiện + các service gọi trực tiếp +
 * processor phía worker): ai là user nhận ở điểm phát thì audience là
 * vai đó — KHÔNG suy đoán theo tên loại. Bảng truy vết đầy đủ nằm ở
 * comment bàn giao của lát này trên issue #288.
 */
export type NotificationAudience = 'student' | 'staff' | 'guardian' | 'admin' | 'all';

export interface MessageProviderDefinition {
  name: string;
  component: string;
  channels: MessageChannel[];
  group: MessageProviderGroup;
  /**
   * Nhãn + mô tả 1 dòng vi/en (NB-2, issue #174): registry ở API là
   * nguồn sự thật DUY NHẤT — trang cài đặt web hiển thị nguyên văn,
   * không tự chế bảng nhãn, nên không còn khoá thô nào trên trang.
   */
  label: { vi: string; en: string };
  description: { vi: string; en: string };
  /**
   * Phía người nhận theo vai + context (xem `NotificationAudience`):
   * nguồn sự thật SỚM NHẤT của tầng phân chia tuỳ chọn — GET
   * /messages/preferences chỉ trả provider mà user có ÍT NHẤT một
   * context thuộc audience, và PUT bị server từ chối (403) với
   * provider ngoài audience. Trường này THAY HẲN cờ `teacherOnly` cũ
   * trong định nghĩa registry: trước đây cờ đó chỉ gắn nhãn hiển thị
   * cho đúng 2 loại mà không lọc gì, nên giáo viên thuần vẫn thấy cả
   * loại chỉ học sinh/phụ huynh nhận. `teacherOnly` trong
   * `NotificationPreferenceView` từ nay là giá trị SUY RA từ audience
   * (xem `isTeacherOnlyProvider`), không còn là cờ khai riêng.
   */
  audience: NotificationAudience[];
  /**
   * Loại bắt buộc theo chính sách P2 (issue #174): kênh trong-app
   * KHÔNG tắt được (API từ chối khi đặt tắt + notify() luôn phát);
   * kênh ngoài vẫn là quyền cá nhân tuyệt đối.
   */
  mandatoryInApp?: boolean;
}

/**
 * Message providers are registered IN CODE (like Moodle's db/messages.php).
 * Each provider produces NOTIFICATIONS (system messages) — never confused
 * with user-to-user messages, which live in conversations (report §2#12).
 *
 * LUẬT SỐNG THẬT (lát N1, issue #49): một provider chỉ được đăng ký ở
 * đây khi đã có nơi phát thật vào `notify()` — provider chưa nối dây
 * thì KHÔNG đăng ký, để trang cài đặt không bao giờ hiện công tắc giả.
 * Ba provider từng "treo" đã được nối dây qua NotificationEventsConsumer
 * (sự kiện outbox grade_updated / course_completed / enrol_expiry_warning);
 * `message_new` cũng qua consumer đó (sự kiện message_sent, gộp theo
 * conversation khi còn chưa đọc).
 */
export const MESSAGE_PROVIDERS: MessageProviderDefinition[] = [
  {
    // Người nhận truy vết: consumer sự kiện grade_updated phát cho
    // chính học sinh có điểm thay đổi (payload.userId) — chỉ phía học.
    name: 'grade_updated', component: 'core_grades', channels: ['popup', 'email'], group: 'learning', audience: ['student'],
    label: { vi: 'Điểm số thay đổi', en: 'Grade updated' },
    description: { vi: 'Khi một mục điểm của bạn được chấm hoặc cập nhật.', en: 'When one of your grade items is graded or updated.' },
  },
  {
    // Người nhận truy vết: người hoàn thành khoá (payload.userId của
    // sự kiện hoàn thành) — phía học sinh.
    name: 'course_completed', component: 'core_completion', channels: ['popup'], group: 'learning', audience: ['student'],
    label: { vi: 'Hoàn thành khoá học', en: 'Course completed' },
    description: { vi: 'Khi bạn hoàn thành một khoá học.', en: 'When you complete a course.' },
  },
  {
    // Chính sách P2 (issue #174): sắp hết hạn ghi danh là một trong
    // hai loại bắt buộc — trong-app không tắt được. Người nhận truy
    // vết: người ghi danh sắp hết hạn (processor enrol-expiry phía
    // worker phát sự kiện cho học sinh) — phía học sinh.
    name: 'enrol_expiry_warning', component: 'core_enrol', channels: ['popup', 'email'], group: 'learning', mandatoryInApp: true, audience: ['student'],
    label: { vi: 'Sắp hết hạn ghi danh', en: 'Enrolment expiring soon' },
    description: { vi: 'Khi thời hạn ghi danh khoá học của bạn sắp hết.', en: 'When your course enrolment is about to expire.' },
  },
  {
    // Người nhận truy vết: người vừa được ghi danh (EnrolService phát
    // cho userId vừa ghi danh khi instance bật cờ chào mừng).
    name: 'enrol_welcome', component: 'core_enrol', channels: ['popup', 'email'], group: 'learning', audience: ['student'],
    label: { vi: 'Chào mừng ghi danh', en: 'Enrolment welcome' },
    description: { vi: 'Khi bạn được ghi danh vào một khoá học mới.', en: 'When you are enrolled in a new course.' },
  },
  // Nhắc hạn nộp tự động 24 giờ (lát N5, issue #50): worker quét hạn
  // nộp phát sự kiện outbox activity_due_reminder, consumer biến thành
  // thông báo — bật mặc định (quyết định đã chốt trong issue #50).
  {
    // Người nhận truy vết: học sinh đang ghi danh có hoạt động sắp
    // đến hạn (sự kiện mang userId của học sinh, cả bài tập lẫn đề ghim).
    name: 'activity_due_soon', component: 'core_course', channels: ['popup', 'email'], group: 'learning', audience: ['student'],
    label: { vi: 'Hoạt động sắp đến hạn', en: 'Activity due soon' },
    description: { vi: 'Nhắc trước 24 giờ khi bài tập hoặc bài kiểm tra sắp đến hạn nộp.', en: 'A reminder 24 hours before an assignment or quiz is due.' },
  },
  // Vòng đời Bài tập + Quiz hai chiều (NB-1, issue #174): consumer sự
  // kiện assignment_created/submitted/returned + quiz_created/
  // quiz_attempt_finished biến thành thông báo — assignment_assigned/
  // assignment_returned/quiz_available cho HỌC SINH (bài mới giao, bài
  // được trả, quiz mới mở), assignment_submitted cho cả hai phía (học
  // sinh nhận xác nhận đã nộp; giáo viên nhận bản GỘP theo bài tập —
  // chính sách P5), quiz_attempt_finished cho GIÁO VIÊN khi lượt làm
  // kết thúc ở trạng thái cần chấm tay (gộp theo quiz như P5).
  {
    name: 'assignment_assigned', component: 'mod_assign', channels: ['popup', 'email'], group: 'learning', audience: ['student'],
    label: { vi: 'Bài tập mới', en: 'New assignment' },
    description: { vi: 'Khi giáo viên giao một bài tập mới trong khoá của bạn.', en: 'When a teacher assigns new work in your course.' },
  },
  {
    // Hai phía thật (xem khối comment vòng đời ở trên): học sinh nhận
    // biên nhận đã nộp, nhân sự khoá nhận bản gộp P5.
    name: 'assignment_submitted', component: 'mod_assign', channels: ['popup', 'email'], group: 'learning', audience: ['student', 'staff'],
    label: { vi: 'Bài nộp', en: 'Submission' },
    description: { vi: 'Xác nhận khi bạn nộp bài; giáo viên nhận bản gộp số bài chờ chấm theo bài tập.', en: 'Your submission receipt; teachers get the grouped pending count per assignment.' },
  },
  {
    name: 'assignment_returned', component: 'mod_assign', channels: ['popup', 'email'], group: 'learning', audience: ['student'],
    label: { vi: 'Bài đã được trả', en: 'Assignment returned' },
    description: { vi: 'Khi giáo viên trả bài kèm lời phê cho bạn.', en: 'When a teacher returns your work with feedback.' },
  },
  {
    name: 'quiz_available', component: 'mod_quiz', channels: ['popup', 'email'], group: 'learning', audience: ['student'],
    label: { vi: 'Bài kiểm tra mới', en: 'New quiz' },
    description: { vi: 'Khi một bài kiểm tra mới được mở trong khoá của bạn.', en: 'When a new quiz opens in your course.' },
  },
  {
    name: 'quiz_attempt_finished', component: 'mod_quiz', channels: ['popup', 'email'], group: 'learning', audience: ['staff'],
    label: { vi: 'Lượt làm bài cần chấm', en: 'Attempt needs grading' },
    description: { vi: 'Khi học sinh kết thúc lượt làm bài có câu cần chấm tay.', en: 'When a student finishes an attempt that needs manual grading.' },
  },
  // Digest phụ huynh (PH-2, issue #159): worker quét cửa sổ phát sự
  // kiện guardian_digest_due, GuardianDigestConsumer (module Guardians)
  // tổng hợp dữ liệu ĐÃ CÔNG BỐ rồi gọi notify() — nội dung chỉ là số
  // lượng mục + link sâu, kênh ngoài dùng bản tối thiểu hoá, tuyệt đối
  // không điểm số (luật kênh ngoài của notify + research phụ huynh).
  {
    // Người nhận truy vết: notify(guardianId) — phụ huynh của liên kết
    // giám hộ đang hiệu lực, không phải học sinh cũng không phải GV.
    name: 'guardian_digest', component: 'core_guardian', channels: ['popup', 'email'], group: 'learning', audience: ['guardian'],
    label: { vi: 'Tổng hợp cho phụ huynh', en: 'Guardian digest' },
    description: { vi: 'Bản tổng hợp tiến độ học tập gửi cho phụ huynh theo lịch.', en: 'The scheduled learning-progress digest for guardians.' },
  },
  // Đẩy riêng quá hạn ≥7 ngày cho phụ huynh (PH-2, research mục
  // 5.3.6): đúng một lần cho từng (phụ huynh, con, hoạt động), dedupe
  // bền ở guardian_digests phía worker.
  {
    name: 'guardian_overdue_alert', component: 'core_guardian', channels: ['popup', 'email'], group: 'learning', audience: ['guardian'],
    label: { vi: 'Cảnh báo quá hạn cho phụ huynh', en: 'Guardian overdue alert' },
    description: { vi: 'Khi con bạn có hoạt động quá hạn từ 7 ngày trở lên.', en: 'When your child has an activity overdue by 7 days or more.' },
  },
  {
    // Người nhận truy vết: user được cấp huy hiệu — issueBadge không
    // gác vai người nhận (tiêu chí tự động hoặc cấp tay cho bất kỳ
    // user nào) nên audience là mọi vai.
    name: 'badge_awarded', component: 'core_badges', channels: ['popup', 'email', 'push'], group: 'people', audience: ['all'],
    label: { vi: 'Huy hiệu mới', en: 'New badge' },
    description: { vi: 'Khi bạn được trao một huy hiệu.', en: 'When you are awarded a badge.' },
  },
  {
    // Người nhận truy vết: người duyệt được chỉ định của kế hoạch
    // (plan.reviewerId) — phía nhân sự giữ vai trò duyệt năng lực
    // (mọi thao tác duyệt đều qua capability duyệt ở context hệ thống).
    name: 'competency_review_requested', component: 'core_competency', channels: ['popup', 'email'], group: 'people', audience: ['staff'],
    label: { vi: 'Yêu cầu duyệt năng lực', en: 'Competency review requested' },
    description: { vi: 'Khi có người yêu cầu bạn duyệt bằng chứng năng lực.', en: 'When someone asks you to review competency evidence.' },
  },
  // Lớp B (issue #33): yêu cầu kết bạn mới — phía nhận được thông báo qua pipeline sẵn có.
  {
    // Người nhận truy vết: người được gửi yêu cầu kết bạn — mọi vai
    // đều có thể nhận (quan hệ liên hệ không phân vai).
    name: 'contact_request', component: 'core_message', channels: ['popup', 'email'], group: 'people', audience: ['all'],
    label: { vi: 'Yêu cầu kết bạn', en: 'Contact request' },
    description: { vi: 'Khi có người gửi yêu cầu kết bạn cho bạn.', en: 'When someone sends you a contact request.' },
  },
  // Lớp B (issue #33): một conversation bị báo cáo — giáo viên phụ trách + quản trị viên nhận được.
  {
    // Người nhận truy vết (reportConversation): site admin ∪ nhân sự
    // phụ trách khoá, trừ chính người báo cáo — cờ teacherOnly cũ nói
    // thiếu vế admin, audience ghi đủ cả hai phía.
    name: 'conversation_reported', component: 'core_message', channels: ['popup', 'email'], group: 'people', audience: ['staff', 'admin'],
    label: { vi: 'Hội thoại bị báo cáo', en: 'Conversation reported' },
    description: { vi: 'Khi một hội thoại trong khoá bạn phụ trách bị báo cáo.', en: 'When a conversation in a course you teach is reported.' },
  },
  // Tin nhắn mới (issue #49): consumer sự kiện message_sent tạo thông báo
  // tóm tắt theo conversation — nội dung tin KHÔNG bao giờ nằm trong thông báo.
  {
    // Người nhận truy vết: mọi thành viên hội thoại trừ người gửi —
    // mọi vai đều có thể là thành viên hội thoại.
    name: 'message_new', component: 'core_message', channels: ['popup', 'email'], group: 'people', audience: ['all'],
    label: { vi: 'Tin nhắn mới', en: 'New message' },
    description: { vi: 'Khi bạn nhận được tin nhắn mới (nội dung tin không nằm trong thông báo).', en: 'When you receive a new message (the message text is never included).' },
  },
  {
    // Người nhận truy vết: chủ sự kiện lịch (processor phía worker
    // phát cho chính user sở hữu sự kiện đã đặt nhắc) — mọi vai đều
    // có lịch cá nhân nên audience là mọi vai.
    name: 'calendar_reminder', component: 'core_calendar', channels: ['popup', 'email'], group: 'system', audience: ['all'],
    label: { vi: 'Nhắc sự kiện lịch', en: 'Calendar reminder' },
    description: { vi: 'Nhắc trước các sự kiện lịch bạn đã đặt.', en: 'Reminders for calendar events you created.' },
  },
  {
    // Người nhận truy vết: người TẠO lịch báo cáo (schedule.createdBy)
    // — tạo lịch phải giữ capability reportbuilder:manage ở context
    // hệ thống, tức phía nhân sự quản trị/quản lý, kèm vế admin.
    name: 'report_scheduled', component: 'core_reportbuilder', channels: ['popup', 'email'], group: 'system', audience: ['staff', 'admin'],
    label: { vi: 'Báo cáo định kỳ', en: 'Scheduled report' },
    description: { vi: 'Khi báo cáo định kỳ của bạn đã chạy xong.', en: 'When one of your scheduled reports has finished.' },
  },
  {
    // Chính sách P2 (issue #174): loại thứ hai bắt buộc — thông báo
    // quản trị/an toàn. Nơi phát thật là POST /notifications/send
    // (sendSystemNotification, chỉ site admin): trước NB-2 admin phải
    // mượn tên provider khác để gửi thông báo chính thức; nay có
    // provider riêng đúng nghĩa và bị khoá trong-app theo P2.
    // Người nhận truy vết: sendSystemNotification phát cho user đích
    // danh BẤT KỲ theo DTO của admin — mọi vai đều có thể nhận.
    name: 'admin_announcement', component: 'core_admin', channels: ['popup', 'email'], group: 'system', mandatoryInApp: true, audience: ['all'],
    label: { vi: 'Thông báo quản trị & an toàn', en: 'Administrative & safety notices' },
    description: { vi: 'Thông báo chính thức từ quản trị hệ thống, gồm cả cảnh báo an toàn tài khoản.', en: 'Official notices from system administrators, including account-safety alerts.' },
  },
];

export function providerByName(name: string): MessageProviderDefinition | undefined {
  return MESSAGE_PROVIDERS.find((p) => p.name === name);
}

/**
 * Provider có thuộc bề mặt tuỳ chọn của một user hay không, theo tập
 * CONTEXT VAI mà user thật sự có (MessagingService tính từ cơ chế vai
 * sẵn có: gán vai archetype, ghi danh hiệu lực, liên kết giám hộ hiệu
 * lực, cờ site admin). Luật khớp:
 *
 * - audience chứa `'all'` → thuộc bề mặt của mọi user (đã qua cổng
 *   bề mặt đầy đủ của NB-7).
 * - còn lại: thuộc bề mặt khi audience GIAO với tập context của user
 *   (giáo viên thuần không có context học sinh → không thấy loại chỉ
 *   học sinh nhận; người vừa dạy vừa học có cả hai context → thấy cả
 *   hai phía; site admin được tính là có mọi context — xem
 *   `MessagingService.resolvePreferenceAudiences`).
 *
 * @param provider - Định nghĩa provider trong registry.
 * @param audiences - Tập context vai thật của user.
 * @returns true khi provider phải hiện trong danh sách tuỳ chọn của user.
 */
export function providerVisibleToAudiences(
  provider: MessageProviderDefinition,
  audiences: ReadonlySet<NotificationAudience>,
): boolean {
  return provider.audience.some((a) => a === 'all' || audiences.has(a));
}

/**
 * Giá trị `teacherOnly` của `NotificationPreferenceView`, SUY RA từ
 * audience (nguồn sự thật duy nhất là `audience` trong registry):
 * đúng khi phía người nhận chỉ gồm nhân sự và/hoặc admin và có nhân
 * sự — tức loại này không học sinh, không phụ huynh, không mọi-vai
 * nào nhận được. Trang cài đặt dùng cờ suy ra này để gắn nhãn "chỉ
 * giáo viên" như trước; KHÔNG khai cờ riêng trong registry nữa.
 *
 * @param provider - Định nghĩa provider trong registry.
 * @returns true khi provider chỉ phía nhân sự/quản trị mới nhận.
 */
export function isTeacherOnlyProvider(provider: MessageProviderDefinition): boolean {
  return provider.audience.includes('staff')
    && provider.audience.every((a) => a === 'staff' || a === 'admin');
}

/** Các eventType thuộc một nhóm hiển thị (suy từ sổ đăng ký provider). */
export function eventTypesOfGroup(group: MessageProviderGroup): string[] {
  return MESSAGE_PROVIDERS.filter((p) => p.group === group).map((p) => p.name);
}

/** Nhóm hiển thị của một eventType; loại không có trong sổ đăng ký (dữ liệu cũ) xếp vào nhóm hệ thống. */
export function groupOfEventType(eventType: string): MessageProviderGroup {
  return providerByName(eventType)?.group ?? 'system';
}

/** Preference key stored in user_preferences: provider × channel × login state (mô hình CŨ — chỉ còn để suy giá trị tương đương và cho kênh push). */
export function preferenceName(provider: string, channel: MessageChannel, state: LoginState): string {
  return `message_provider_${provider}_${channel}_${state}`;
}

/**
 * Khoá tuỳ chọn v2 (NB-2, issue #174): một khoá cho popup ('1'/'0')
 * và một khoá cho tần suất email ('immediate'/'daily'/'off') theo
 * provider — KHÔNG còn trục loggedin/loggedoff. Khoá cũ không bị
 * đụng: khi chưa có khoá v2, giá trị hiệu lực được SUY từ khoá cũ
 * (hàng loggedin trước, loggedoff sau) ở hậu trường.
 */
export function preferenceNameV2(provider: string, kind: 'popup' | 'email'): string {
  return `message_provider_${provider}_${kind}_v2`;
}

/**
 * Khoá ghi đè theo khoá học (NB-4, issue #174 — hình dạng khoá do hồ
 * sơ rà soát chốt): `notif.course.<courseId>` mang 'all' | 'mute', lưu
 * cấu trúc ngay trong user_preferences như mọi tuỳ chọn khác (không
 * bảng riêng, không đổi baseline). Chưa đặt = 'all'.
 */
export function coursePreferenceName(courseId: string): string {
  return `notif.course.${courseId}`;
}

/** Chế độ ghi đè theo khoá: 'all' = nhận như mặc định toàn cục, 'mute' = tắt tiếng khoá đó. */
export type NotificationCourseOverrideMode = 'all' | 'mute';

/** Một dòng ghi đè theo khoá của một user (hình dạng hợp đồng ở @lms/contracts). */
export interface NotificationCourseOverrideView {
  courseId: string;
  courseName: string;
  mode: NotificationCourseOverrideMode;
}

/**
 * Các loại KHÔNG bao giờ bị ghi đè theo khoá chặn:
 *  - Chính sách P3 (đã chốt trên issue #174): tắt tiếng một khoá vẫn
 *    chừa ĐIỂM MỚI (`grade_updated`) và SẮP HẾT HẠN GHI DANH
 *    (`enrol_expiry_warning`) của chính khoá đó — mute là để bớt ồn,
 *    không phải để mất dấu học tập của chính mình.
 *  - Hai loại bắt buộc P2 (`mandatoryInApp` trong registry): luật
 *    toàn cục thắng ghi đè theo khoá — ghi đè không được phá chúng ở
 *    kênh trong-app (và ở đây là mọi kênh, vì chặn theo khoá áp trước
 *    khi xét kênh).
 */
const COURSE_MUTE_EXEMPT_PROVIDERS = new Set(['grade_updated', 'enrol_expiry_warning']);

export function isExemptFromCourseMute(provider: MessageProviderDefinition): boolean {
  return provider.mandatoryInApp === true || COURSE_MUTE_EXEMPT_PROVIDERS.has(provider.name);
}

/**
 * Kênh email đã gửi thật hay chưa: false cho tới khi SMTP nối ở NB-5
 * (issue #174). Trang cài đặt đọc cờ này từ API để ghi chú trung thực
 * "chưa khả dụng — cài đặt sẽ áp dụng khi kênh mở" thay vì công tắc
 * trần như kênh thật; tuỳ chọn vẫn lưu và có hiệu lực chặn ngay.
 */
export const EMAIL_CHANNEL_AVAILABLE = false;

/** Tần suất email mặc định theo nhóm (chính sách P1: học tập = tổng hợp ngày, tin nhắn = ngay). */
export function defaultEmailFrequency(group: MessageProviderGroup): EmailFrequency {
  return group === 'learning' ? 'daily' : 'immediate';
}

/** Một dòng tuỳ chọn v2 của một provider cho một user (hình dạng hợp đồng ở @lms/contracts). */
export interface NotificationPreferenceView {
  provider: string;
  component: string;
  group: MessageProviderGroup;
  label: { vi: string; en: string };
  description: { vi: string; en: string };
  /**
   * Nhãn theo vai cho trang cài đặt: giá trị SUY RA từ `audience`
   * của registry qua `isTeacherOnlyProvider` — không phải cờ khai
   * độc lập (cờ cũ trong registry đã bỏ hẳn khi thêm audience).
   */
  teacherOnly: boolean;
  mandatoryInApp: boolean;
  popupEnabled: boolean;
  emailFrequency: EmailFrequency | null;
  emailAvailable: boolean;
  /**
   * Chính sách phát của admin ở cấp site (NB-7): false = admin đã tắt
   * loại này cho toàn site — `notify()` bỏ qua bất kể tuỳ chọn cá
   * nhân; trang Cài đặt thông báo đọc trường này để hiển thị khoá
   * "Admin đã tắt ở cấp site" thay vì để người dùng bật vô ích.
   */
  siteEnabled: boolean;
}

export interface NotifyResult {
  provider: string;
  userId: string;
  notificationId: string | null;
  channels: Record<string, string>;
  skipped?: 'suspended' | 'unknown-provider' | 'course-mute' | 'admin-disabled';
}

/** Component site-config giữ CHÍNH SÁCH PHÁT theo loại thông báo (NB-7, issue #174). */
export const NOTIFICATION_POLICY_COMPONENT = 'notifications';

/** Tên setting chính sách của một provider trong site-config: `provider_<tên>_enabled` (boolean, mặc định true). */
export function notificationPolicySettingName(providerName: string): string {
  return `provider_${providerName}_enabled`;
}

/** Các loại bắt buộc (P2) — chính sách admin ở cấp site cũng KHÔNG tắt được các loại này. */
export const MANDATORY_NOTIFICATION_PROVIDERS: readonly string[] =
  MESSAGE_PROVIDERS.filter((p) => p.mandatoryInApp === true).map((p) => p.name);

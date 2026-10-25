import {
  MESSAGE_PROVIDERS,
  NOTIFICATION_POLICY_COMPONENT,
  notificationPolicySettingName,
} from '../messaging/notification-providers';

/**
 * Registry khai báo các setting mà quản trị có thể đổi qua giao diện/API
 * (tương đương cây admin settings của Moodle). Mỗi setting có kiểu và giá
 * trị mặc định trong code; giá trị quản trị lưu trong cơ sở dữ liệu chỉ là
 * lớp ghi đè lên mặc định — xoá ghi đè là trở về mặc định, đúng phân tầng
 * cấu hình của blueprint (mặc định code < giá trị admin lưu DB).
 */
export type SiteSettingType = 'string' | 'number' | 'boolean' | 'enum';

/** Tầng được phép đổi một setting (TENANT-0, #168): platform = chỉ platform; tenant = tenant ghi đè được qua TenantConfigService; both = cả hai. */
export type SiteSettingScope = 'platform' | 'tenant' | 'both';

export interface SiteSettingDefinition {
  /** `core` cho cấu hình site (bảng `config`); tên plugin/component khác lưu ở `plugin_config`. */
  component: string;
  name: string;
  type: SiteSettingType;
  /** Danh sách giá trị cho phép khi type = 'enum'. */
  options?: readonly string[];
  defaultValue: string | number | boolean;
  scope: SiteSettingScope;
}

/** Danh sách setting đã đăng ký — thêm setting mới là thêm một dòng ở đây kèm giá trị mặc định. */
export const SITE_SETTINGS: readonly SiteSettingDefinition[] = [
  { component: 'core', name: 'fullname', type: 'string', defaultValue: 'LMS', scope: 'both' },
  { component: 'core', name: 'lang', type: 'enum', options: ['vi', 'en'], defaultValue: 'vi', scope: 'both' },
  { component: 'core', name: 'timezone', type: 'string', defaultValue: 'Asia/Saigon', scope: 'both' },
  { component: 'core', name: 'sitepolicy', type: 'string', defaultValue: '', scope: 'platform' },
  // Tương đương `messagingallusers` của Moodle: false = chỉ nhắn tin cho
  // contact hoặc người học cùng khoá; true = mọi người dùng nhắn cho nhau.
  { component: 'core', name: 'messagingallusers', type: 'boolean', defaultValue: false, scope: 'platform' },
  // Cửa sổ THU HỒI tin nhắn (vòng đời tin nhắn theo vai, issue #33),
  // đơn vị PHÚT tính từ lúc gửi: trong cửa sổ, tác giả thu hồi được
  // tin cho mọi người; ngoài cửa sổ chỉ còn xoá phía mình và đường
  // kiểm duyệt. 0 = tắt hẳn thu hồi. Mặc định 15 phút theo chuẩn các
  // app nhắn tin phổ biến.
  { component: 'core', name: 'messagingrecallwindowminutes', type: 'number', defaultValue: 15, scope: 'both' },
  // Chặn lạm dụng đường gửi tin (lát M2, issue #212; chính sách P2 đã
  // chốt ở issue #33): trần độ dài một tin tính theo KÝ TỰ NGƯỜI DÙNG
  // THẤY (grapheme, không đếm byte) — vượt trần bị từ chối 400
  // `messaging.message_too_long`; 0 = tắt trần. Giá trị mặc định phải
  // khớp MESSAGING_MAX_MESSAGE_LENGTH_DEFAULT ở @lms/contracts.
  { component: 'core', name: 'messagingmaxmessagelength', type: 'number', defaultValue: 10000, scope: 'both' },
  // Throttle gửi tin theo từng người dùng bằng Redis (cùng lát M2):
  // cửa sổ bùng phát (burst) mặc định 20 tin / 10 giây + trần duy trì
  // 60 tin / phút (tức ~1 tin/giây) — mức theo khuyến nghị của hồ sơ
  // rà soát hoàn thiện nhắn tin, đủ rộng để không vướng sử dụng thật.
  // Vượt một trong hai trần → 429 `messaging.rate_limited`. Đặt trần
  // tương ứng về 0 = tắt cửa sổ đó.
  { component: 'core', name: 'messagingsendburstlimit', type: 'number', defaultValue: 20, scope: 'platform' },
  { component: 'core', name: 'messagingsendburstwindowseconds', type: 'number', defaultValue: 10, scope: 'platform' },
  { component: 'core', name: 'messagingsendperminutelimit', type: 'number', defaultValue: 60, scope: 'platform' },
  { component: 'badges', name: 'enabled', type: 'boolean', defaultValue: true, scope: 'both' },
  // Cấp duyệt thứ hai (ban giám hiệu) cho BỘ HỒ SƠ đề định kỳ (EB-3,
  // issue #165): true = sau cấp tổ trưởng, bộ hồ sơ phải qua thêm mốc
  // duyệt BGH mới hiệu lực; false = một cấp duyệt là đủ. Căn cứ hồ sơ
  // ngân hàng đề F.2: không có văn bản cấp Bộ bắt buộc cấp duyệt này
  // nên mặc định TẮT, trường tự bật theo quy chế nội bộ.
  // ⚠️ ĐIỂM SEAM TẠM (chờ research multi-tenant, issue #166): công tắc
  // đang nằm ở tầng site-config TOÀN CỤC và chỉ được đọc qua đúng một
  // điểm trong ExamDossiersService (boardApprovalRequired). Vị trí
  // cấu hình thật (theo tenant/bank) chốt sau research #166 — khi đó
  // chỉ dời điểm đọc này, KHÔNG đổi máy trạng thái bộ hồ sơ. EB-3
  // không xây UI/API cấu hình riêng cho công tắc này.
  // TENANT-0 (#168): đích cuối của công tắc là cấu hình THEO TENANT
  // (mỗi trường một quy chế) nên scope = 'both' — tenant admin ghi đè
  // được qua TenantConfigService; điểm đọc hiện tại của EB-3 vẫn ở
  // tầng platform (SiteConfigService) và sẽ dời sang
  // TenantConfigService.getEffectiveValue ở lát tenant hoá bề mặt đề.
  { component: 'exam', name: 'requireboardapproval', type: 'boolean', defaultValue: false, scope: 'both' },
  // Chấm bài giấy bằng camera (CAM-0, issue #112): ngưỡng quyết định hai
  // tầng của OMR — mật độ mực chuẩn hoá 0..1 của một ô; ô trên
  // omrfilldensity = đã tô, dưới omrblankdensity = trống, ở giữa là MƠ
  // HỒ (hàng chờ giáo viên, không tự quyết); omrminmargin là chênh mật
  // độ tối thiểu giữa ô đậm nhất và ô nhì để ô thắng được coi là chắc
  // chắn. paperscanretentionmonths là số tháng giữ ảnh gốc phiếu quét
  // (mặc định theo đề xuất research: hết năm học + 1 học kỳ ≈ 18 tháng;
  // mốc xoá được vật hoá vào từng phiếu lúc tải lên).
  // TENANT-0 (#168, đóng gói lại lên main 3aee4454): 4 setting CAM-0
  // thêm ở main chưa có scope trong khi SiteSettingDefinition bắt
  // buộc scope — gán 'platform' để giữ nguyên hành vi cũ (một giá trị
  // toàn cục do platform đặt, tenant đọc qua fallback platform; bề
  // mặt tenant từ chối ghi đè). Không chọn 'both' để khỏi mở thêm
  // quyền ghi đè theo tenant ngoài phạm vi đóng gói.
  { component: 'mod_quiz', name: 'omrfilldensity', type: 'number', defaultValue: 0.42, scope: 'platform' },
  { component: 'mod_quiz', name: 'omrblankdensity', type: 'number', defaultValue: 0.16, scope: 'platform' },
  { component: 'mod_quiz', name: 'omrminmargin', type: 'number', defaultValue: 0.1, scope: 'platform' },
  { component: 'mod_quiz', name: 'paperscanretentionmonths', type: 'number', defaultValue: 18, scope: 'platform' },
  // Chính sách phát thông báo theo loại ở cấp site (NB-7, issue #174 —
  // quyết của Lão gia 23:09 ngày 25/10/2026: "loại sự kiện nào thì gửi
  // thông báo" là cài đặt của ADMIN): MỘT khoá boolean cho MỖI provider
  // trong registry thông báo, sinh tự động từ MESSAGE_PROVIDERS để không
  // bao giờ lệch sổ — provider mới đăng ký là có ngay khoá chính sách.
  // Mặc định true (bật) = giữ nguyên hành vi trước NB-7. scope platform:
  // chính sách site, tenant không ghi đè. notify() (API) và hàm luật của
  // worker đọc các khoá này TRƯỚC tuỳ chọn người dùng; hai loại bắt
  // buộc P2 (mandatoryInApp) bị SiteConfigService chặn không cho đặt
  // false — admin cũng không tắt được.
  ...MESSAGE_PROVIDERS.map((provider) => ({
    component: NOTIFICATION_POLICY_COMPONENT,
    name: notificationPolicySettingName(provider.name),
    type: 'boolean' as const,
    defaultValue: true,
    scope: 'platform' as const,
  })),
];

/**
 * Tìm định nghĩa của một setting theo component + name; undefined nếu
 * setting chưa được đăng ký (API từ chối ghi vào khoá lạ).
 */
export function findSiteSetting(component: string, name: string): SiteSettingDefinition | undefined {
  return SITE_SETTINGS.find((s) => s.component === component && s.name === name);
}

/**
 * Kiểm chứng một giá trị ứng viên theo kiểu đã đăng ký; trả về thông điệp
 * lỗi ngắn (tiếng Anh nội bộ, mã lỗi do service gắn) hoặc null nếu hợp lệ.
 */
export function validateSiteSettingValue(def: SiteSettingDefinition, value: unknown): string | null {
  switch (def.type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : 'expected a boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'expected a finite number';
    case 'string':
      return typeof value === 'string' && value.length <= 1000 ? null : 'expected a string of at most 1000 characters';
    case 'enum':
      return typeof value === 'string' && (def.options ?? []).includes(value)
        ? null
        : `expected one of: ${(def.options ?? []).join(', ')}`;
  }
}

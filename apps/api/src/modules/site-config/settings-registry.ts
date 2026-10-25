/**
 * Registry khai báo các setting mà quản trị có thể đổi qua giao diện/API
 * (tương đương cây admin settings của Moodle). Mỗi setting có kiểu và giá
 * trị mặc định trong code; giá trị quản trị lưu trong cơ sở dữ liệu chỉ là
 * lớp ghi đè lên mặc định — xoá ghi đè là trở về mặc định, đúng phân tầng
 * cấu hình của blueprint (mặc định code < giá trị admin lưu DB).
 */
export type SiteSettingType = 'string' | 'number' | 'boolean' | 'enum';

export interface SiteSettingDefinition {
  /** `core` cho cấu hình site (bảng `config`); tên plugin/component khác lưu ở `plugin_config`. */
  component: string;
  name: string;
  type: SiteSettingType;
  /** Danh sách giá trị cho phép khi type = 'enum'. */
  options?: readonly string[];
  defaultValue: string | number | boolean;
}

/** Danh sách setting đã đăng ký — thêm setting mới là thêm một dòng ở đây kèm giá trị mặc định. */
export const SITE_SETTINGS: readonly SiteSettingDefinition[] = [
  { component: 'core', name: 'fullname', type: 'string', defaultValue: 'LMS' },
  { component: 'core', name: 'lang', type: 'enum', options: ['vi', 'en'], defaultValue: 'vi' },
  { component: 'core', name: 'timezone', type: 'string', defaultValue: 'Asia/Saigon' },
  { component: 'core', name: 'sitepolicy', type: 'string', defaultValue: '' },
  // Tương đương `messagingallusers` của Moodle: false = chỉ nhắn tin cho
  // contact hoặc người học cùng khoá; true = mọi người dùng nhắn cho nhau.
  { component: 'core', name: 'messagingallusers', type: 'boolean', defaultValue: false },
  // Cửa sổ THU HỒI tin nhắn (vòng đời tin nhắn theo vai, issue #33),
  // đơn vị PHÚT tính từ lúc gửi: trong cửa sổ, tác giả thu hồi được
  // tin cho mọi người; ngoài cửa sổ chỉ còn xoá phía mình và đường
  // kiểm duyệt. 0 = tắt hẳn thu hồi. Mặc định 15 phút theo chuẩn các
  // app nhắn tin phổ biến.
  { component: 'core', name: 'messagingrecallwindowminutes', type: 'number', defaultValue: 15 },
  { component: 'badges', name: 'enabled', type: 'boolean', defaultValue: true },
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
  { component: 'exam', name: 'requireboardapproval', type: 'boolean', defaultValue: false },
  // Chấm bài giấy bằng camera (CAM-0, issue #112): ngưỡng quyết định hai
  // tầng của OMR — mật độ mực chuẩn hoá 0..1 của một ô; ô trên
  // omrfilldensity = đã tô, dưới omrblankdensity = trống, ở giữa là MƠ
  // HỒ (hàng chờ giáo viên, không tự quyết); omrminmargin là chênh mật
  // độ tối thiểu giữa ô đậm nhất và ô nhì để ô thắng được coi là chắc
  // chắn. paperscanretentionmonths là số tháng giữ ảnh gốc phiếu quét
  // (mặc định theo đề xuất research: hết năm học + 1 học kỳ ≈ 18 tháng;
  // mốc xoá được vật hoá vào từng phiếu lúc tải lên).
  { component: 'mod_quiz', name: 'omrfilldensity', type: 'number', defaultValue: 0.42 },
  { component: 'mod_quiz', name: 'omrblankdensity', type: 'number', defaultValue: 0.16 },
  { component: 'mod_quiz', name: 'omrminmargin', type: 'number', defaultValue: 0.1 },
  { component: 'mod_quiz', name: 'paperscanretentionmonths', type: 'number', defaultValue: 18 },
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

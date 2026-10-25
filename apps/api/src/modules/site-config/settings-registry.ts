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

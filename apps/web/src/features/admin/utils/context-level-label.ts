/**
 * Nhãn cấp ngữ cảnh dạng chữ cho bảng người dùng kèm vai trò (issue
 * #569): mỗi gán vai chỉ bày tên vai kèm nhãn cấp của ngữ cảnh, không
 * bày mã định danh hay đường dẫn ngữ cảnh — mã và đường dẫn là chi
 * tiết kỹ thuật nội bộ, không phải thông tin nghiệp vụ của quản trị
 * viên. Bảng ánh xạ dưới đây là toàn bộ cấp ngữ cảnh của hệ (10 hệ
 * thống, 20 trung tâm, 30 người dùng, 40 danh mục khoá, 45 lớp, 50
 * khoá học, 70 module, 80 block); cấp lạ ngoài bảng thì lùi về nhãn
 * "Cấp <số>" — vẫn là cấp, không phải mã định danh hay đường dẫn.
 *
 * Hàm này chỉ trả về khoá i18n để nơi gọi tự dịch (giữ đúng quy ước
 * của feature: chuỗi hiển thị luôn qua `t()` của namespace `app`).
 */

/** Ánh xạ cấp ngữ cảnh sang khoá i18n của nhãn chữ tương ứng. */
const CONTEXT_LEVEL_LABEL_KEYS: Record<number, string> = {
  10: 'contextLevelSystem',
  20: 'contextLevelTenant',
  30: 'contextLevelUser',
  40: 'contextLevelCourseCategory',
  45: 'contextLevelClass',
  50: 'contextLevelCourse',
  70: 'contextLevelModule',
  80: 'contextLevelBlock',
};

/**
 * Khoá i18n của nhãn cấp ngữ cảnh dạng chữ.
 *
 * @param level - Cấp ngữ cảnh dạng số của dòng gán.
 * @returns Khoá nhãn đã biết, hoặc khoá nhãn cấp chung khi cấp lạ.
 */
export function contextLevelLabelKey(level: number): string {
  return CONTEXT_LEVEL_LABEL_KEYS[level] ?? 'contextLevelUnknown';
}

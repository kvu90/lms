/**
 * Tầng adapter nhãn ngữ cảnh của feature admin: biến các dòng ngữ
 * cảnh của API (`ContextRow` — chỉ có cấp số, định danh thực thể và
 * đường dẫn cây, KHÔNG có tên hiển thị) thành nhãn dạng chữ đọc được
 * cho mọi bề mặt vai trò & quyền.
 *
 * Vấn đề adapter này giải quyết: đáp ứng `GET /access/contexts`
 * không mang tên của thực thể mà ngữ cảnh trỏ tới (tên khoá học, tên
 * lớp…), nên trước đây các ô chọn và cột ngữ cảnh bày thẳng chuỗi kỹ
 * thuật "cấp <số> · thực thể <id> · /<đường dẫn>" — chuỗi đó không
 * phải thông tin nghiệp vụ của quản trị viên. Adapter suy nhãn từ
 * CẤP của ngữ cảnh (10 hệ thống, 20 trung tâm, 30 người dùng, 40
 * danh mục khoá, 45 lớp, 50 khoá học, 70 module, 80 block) — cấp là
 * dữ kiện nghiệp vụ thật, đọc được bằng chữ.
 *
 * Giới hạn đã biết của adapter (việc của đợt nối backend): nhiều ngữ
 * cảnh cùng cấp (ví dụ nhiều khoá học) thì nhãn cấp trùng nhau; để
 * các lựa chọn trong ô chọn vẫn phân biệt được mà không lộ định danh
 * kỹ thuật, adapter đánh số thứ tự trong cùng cấp theo thứ tự cây
 * ("Khoá học 2", "Khoá học 3"…; ngữ cảnh đầu tiên của cấp giữ nhãn
 * trần). Tên thật của từng thực thể chỉ có khi backend bổ sung tên
 * vào đáp ứng ngữ cảnh — khi đó adapter này là nơi duy nhất cần đổi,
 * các bề mặt gọi qua đây không đổi.
 *
 * Module này thuần hàm, không phụ thuộc React: hàm trả về KHOÁ i18n
 * hoặc nhãn đã lắp, nơi gọi tự dịch bằng `t()` của namespace `app`
 * theo quy ước của feature (chuỗi hiển thị luôn qua i18n).
 */
import type { ContextRow } from '#lib/access';

/** Ánh xạ cấp ngữ cảnh sang khoá i18n của nhãn cấp dạng chữ. */
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
 * @param level - Cấp ngữ cảnh dạng số (của dòng gán hoặc dòng ngữ cảnh).
 * @returns Khoá nhãn của cấp đã biết, hoặc khoá nhãn cấp chung khi cấp lạ.
 */
export function contextLevelLabelKey(level: number): string {
  return CONTEXT_LEVEL_LABEL_KEYS[level] ?? 'contextLevelUnknown';
}

/**
 * Nhãn hiển thị của một ngữ cảnh trong ô chọn: nhãn cấp dạng chữ đã
 * dịch, kèm số thứ tự trong cùng cấp khi cấp đó có nhiều ngữ cảnh —
 * tuyệt đối không chứa định danh, đường dẫn hay chuỗi kỹ thuật.
 *
 * @param contexts - Toàn bộ cây ngữ cảnh đang hiển thị trong ô chọn.
 * @param context - Ngữ cảnh cần lấy nhãn.
 * @param translate - Hàm dịch i18n của nơi gọi (namespace `app`).
 * @returns Nhãn dạng chữ đọc được của ngữ cảnh.
 */
export function contextOptionLabel(
  contexts: ContextRow[],
  context: ContextRow,
  translate: (key: string, options?: Record<string, unknown>) => string,
): string {
  const base = translate(contextLevelLabelKey(context.contextLevel), {
    level: context.contextLevel,
  });
  const sameLevel = contexts.filter((ctx) => ctx.contextLevel === context.contextLevel);
  if (sameLevel.length <= 1) return base;
  const ordinal = sameLevel.findIndex((ctx) => ctx.id === context.id);
  if (ordinal <= 0) return base;
  return `${base} ${ordinal + 1}`;
}

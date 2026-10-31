/**
 * Phân giải địa chỉ request thành slug của trung tâm (issue #582).
 *
 * Quy ước địa chỉ của hệ: mỗi trung tâm có một tên miền con riêng
 * mang slug của chính trung tâm đó trong sổ đăng ký control plane —
 * nhãn đầu tiên của host (ví dụ `trung-tam-a.he-thong.example` →
 * `trung-tam-a`). Địa chỉ được thiết kế hướng tên miền ngay từ mô
 * hình kiến trúc đích (tên miền con trước, tên miền riêng sau), nên
 * tầng ứng dụng chỉ cần đọc host của request là biết request thuộc
 * trung tâm nào, không cần một bảng ánh xạ địa chỉ riêng.
 *
 * File này chỉ chứa hàm thuần trích nhãn ứng viên: host không mang
 * địa chỉ trung tâm (host gốc, localhost, địa chỉ IP) trả `null` và
 * request đi đúng đường hiện tại; nhãn ứng viên có thật sự là một
 * trung tâm đã đăng ký hay không do bộ phân giải của khung định
 * tuyến quyết từ sổ đăng ký (nguồn sự thật duy nhất) — hàm này
 * không tự đoán.
 */

/** Hình dạng hợp lệ của một nhãn tên miền con mang slug: chữ thường, số và dấu gạch ngang, tối đa 63 ký tự như một nhãn DNS. */
export const SPACE_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Trích slug ứng viên của trung tâm từ header `Host` của request.
 *
 * Các bước: bỏ cổng (`:port`) nếu có, hạ về chữ thường (tên miền
 * không phân biệt hoa thường), tách theo dấu chấm; chỉ khi host có
 * từ ba nhãn trở lên (nhãn trung tâm + tên miền gốc ít nhất hai
 * nhãn) và nhãn đầu tiên đúng hình dạng slug thì nhãn đó là ứng
 * viên. Mọi trường hợp còn lại — host gốc hai nhãn, `localhost`,
 * địa chỉ IP, host trống/không hợp lệ — trả `null`: request không
 * mang địa chỉ trung tâm nào.
 *
 * @param host - Giá trị header `Host` của request (có thể kèm cổng).
 * @returns Slug ứng viên của trung tâm, hoặc `null` khi địa chỉ
 *   không mang trung tâm.
 */
export function extractSpaceSlugFromHost(host: string | undefined | null): string | null {
  if (!host) return null;
  const hostname = host.trim().toLowerCase().split(':')[0] ?? '';
  if (!hostname) return null;
  const labels = hostname.split('.');
  if (labels.length < 3) return null;
  const candidate = labels[0] ?? '';
  if (!SPACE_LABEL_PATTERN.test(candidate)) return null;
  // Địa chỉ IP dạng bốn nhãn số không phải tên miền con của trung
  // tâm nào: nhãn đầu toàn số thì không coi là slug ứng viên.
  if (/^\d+$/.test(candidate) && labels.every((label) => /^\d+$/.test(label))) return null;
  return candidate;
}

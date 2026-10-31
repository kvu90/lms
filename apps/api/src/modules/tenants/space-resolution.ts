import type { SpaceDatabaseService } from '../../db/routing/space-database.service';
import {
  SpaceRoutingError,
  type ResolvedSpaceConnection,
} from '../../db/routing/space-connection-resolver';

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

/**
 * Kết quả phân giải một địa chỉ thuộc trung tâm ở kho riêng: slug
 * của trung tâm và định danh đăng ký của nó trong sổ control plane
 * (giá trị claim `centre_id` của phiên thuộc trung tâm đó).
 */
export interface DedicatedSpace {
  slug: string;
  spaceId: string;
}

/**
 * Phân giải địa chỉ request thành không gian ở KHO RIÊNG, hoặc
 * `null` khi request không thuộc trung tâm kho riêng nào.
 *
 * Các trường hợp trả `null` (đường kho chung giữ nguyên hành vi):
 * địa chỉ không mang trung tâm, slug chưa đăng ký trong sổ, tầng
 * định tuyến chưa cấu hình, hoặc trung tâm ở chế độ kho chung.
 * Mọi lỗi phân giải còn lại (bí mật/role của kho riêng lệch sổ)
 * là lỗi cấu hình vận hành nên ném ra nguyên trạng, fail-closed,
 * thay vì im lặng coi request là đường kho chung.
 *
 * @param spaceDb - Khung định tuyến (chỉ cần `resolveTarget`; hàm
 *   này không mở pool, chỉ đọc sổ đăng ký qua đệm của khung).
 * @param host - Giá trị header `Host` của request (có thể kèm cổng).
 */
export async function resolveDedicatedSpace(
  spaceDb: Pick<SpaceDatabaseService, 'resolveTarget'>,
  host: string | string[] | undefined,
): Promise<DedicatedSpace | null> {
  const header = Array.isArray(host) ? host[0] : host;
  const slug = extractSpaceSlugFromHost(header);
  if (!slug) return null;
  let target: ResolvedSpaceConnection;
  try {
    target = await spaceDb.resolveTarget(slug);
  } catch (err) {
    if (
      err instanceof SpaceRoutingError &&
      (err.code === 'space_routing.space_not_found' || err.code === 'space_routing.not_configured')
    ) {
      return null;
    }
    throw err;
  }
  if (target.mode !== 'dedicated') return null;
  return { slug, spaceId: target.spaceId };
}

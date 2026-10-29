import type { Capability } from '@lms/contracts';

/**
 * Kiểu dữ liệu của hộp thoại ma trận vai trò thuộc feature admin.
 *
 * Ma trận chỉ trình bày các ghi đè đã lưu tại ngữ cảnh đang chọn, không
 * trình bày quyền hiệu lực sau kế thừa: một năng lực vắng mặt trong bản
 * nháp nghĩa là đang ở trạng thái kế thừa (INHERIT = 0) tại ngữ cảnh
 * đó, và khi lưu, endpoint thay toàn bộ chỉ nhận các ghi đè khác kế
 * thừa — phần tử vắng mặt trong tập gửi lên trở về kế thừa.
 */

/** Bản nháp ma trận: tên năng lực → giá trị quyền bốn trạng thái. */
export type RoleMatrixDraft = Record<string, number>;

/** Một nhóm năng lực trong ma trận, gom theo resource. */
export interface CapabilityGroup {
  /** Tiền tố trước dấu `:` của tên năng lực (ví dụ `course`). */
  resource: string;
  /** Các năng lực thật của nhóm, xếp theo tên. */
  capabilities: Capability[];
}

/**
 * Tách resource từ tên năng lực dạng `resource:verb`.
 *
 * @param name - Tên năng lực đầy đủ.
 * @returns Tiền tố trước dấu `:`; tên không có dấu `:` thì chính nó.
 */
export function resourceOfCapability(name: string): string {
  const index = name.indexOf(':');
  return index === -1 ? name : name.slice(0, index);
}

/**
 * Gom danh mục năng lực phẳng thành các nhóm theo resource, mỗi nhóm
 * xếp theo tên năng lực.
 *
 * @param capabilities - Danh mục phẳng từ `GET /access/capabilities`.
 * @returns Các nhóm xếp theo tên resource.
 */
export function groupCapabilitiesByResource(capabilities: Capability[]): CapabilityGroup[] {
  const byResource = new Map<string, Capability[]>();
  for (const capability of capabilities) {
    const resource = resourceOfCapability(capability.name);
    const group = byResource.get(resource);
    if (group) group.push(capability);
    else byResource.set(resource, [capability]);
  }
  return [...byResource.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([resource, group]) => ({
      resource,
      capabilities: [...group].sort((left, right) => left.name.localeCompare(right.name)),
    }));
}

/**
 * Động từ của một năng lực: phần sau dấu `:` (ví dụ `view` của
 * `course:view`); tên không có dấu `:` thì chính nó.
 */
export function verbOfCapability(name: string): string {
  const index = name.indexOf(':');
  return index === -1 ? name : name.slice(index + 1);
}

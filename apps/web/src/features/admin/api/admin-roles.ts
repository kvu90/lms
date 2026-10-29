import type { CreateRole, ReplaceRoleCapabilities, Role, UpdateRole } from '@lms/contracts';
import { apiJson } from '#lib/api';

/**
 * Tầng gọi API thuần của bề mặt quản trị vai trò thuộc feature admin:
 * chỉ chứa các hàm gọi HTTP, không phụ thuộc React hay React Query.
 * Tầng `queries/` của feature bọc các hàm này thành đột biến. Các
 * thao tác đọc (danh sách vai kèm tổng hợp, danh mục capability, cây
 * context, ma trận đã lưu) nằm ở tầng dùng chung `src/lib/access.ts`
 * vì nhiều feature cùng dùng; riêng bốn thao tác ghi của đợt 2 đặt ở
 * đây để hộp thoại ma trận không gọi thẳng client dùng chung.
 */

/**
 * Tạo vai trò mới (POST /access/roles) — vai mới bắt đầu với 0 ghi đè.
 *
 * @param draft - Tên, `shortName` bắt buộc duy nhất và mô tả tuỳ chọn.
 * @returns Vai trò vừa tạo.
 */
export function createRole(draft: CreateRole) {
  return apiJson<Role>('/api/v1/access/roles', { method: 'POST', body: JSON.stringify(draft) });
}

/**
 * Cập nhật tên/mô tả của vai trò (PATCH /access/roles/:id) — `shortName`
 * và `archetype` không đổi được qua endpoint này.
 *
 * @param input - Định danh vai trò và trường muốn đổi.
 * @returns Vai trò sau khi cập nhật.
 */
export function updateRole(input: { roleId: string; draft: UpdateRole }) {
  return apiJson<Role>(`/api/v1/access/roles/${input.roleId}`, {
    method: 'PATCH',
    body: JSON.stringify(input.draft),
  });
}

/**
 * Lưu ma trận thay toàn bộ cho một vai tại đúng một ngữ cảnh
 * (PUT /access/roles/:id/capabilities) — nguyên tử: sau khi áp dụng
 * thành công, tập ghi đè của vai tại ngữ cảnh đó bằng đúng tập gửi
 * lên; phần tử vắng mặt trở về kế thừa.
 *
 * @param input - Định danh vai trò, ngữ cảnh và tập ghi đè khác kế thừa.
 * @returns Các ghi đè đã lưu.
 */
export function replaceRoleCapabilities(input: { roleId: string; payload: ReplaceRoleCapabilities }) {
  return apiJson<{ capability: string; permission: number }[]>(`/api/v1/access/roles/${input.roleId}/capabilities`, {
    method: 'PUT',
    body: JSON.stringify(input.payload),
  });
}

/**
 * Xoá vai trò (DELETE /access/roles/:id) — backend từ chối vai dựng
 * sẵn (có `archetype`) và vai còn người giữ, với mã lỗi riêng cho từng
 * trường hợp; tầng hiển thị dịch mã lỗi thành thông báo cho người dùng.
 *
 * @param roleId - Định danh vai trò cần xoá.
 */
export function deleteRole(roleId: string) {
  return apiJson<{ deleted: boolean }>(`/api/v1/access/roles/${roleId}`, { method: 'DELETE' });
}

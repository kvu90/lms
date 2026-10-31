import type {
  AssignRole,
  AssignmentListResponse,
  CapabilityMatrixResponse,
  CreateRole,
  OverrideCapability,
  ReplaceRoleCapabilities,
  Role,
  UpdateRole,
  UserListStatus,
  UserWithAssignmentsListResponse,
} from '@lms/contracts';
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

/**
 * Tham số liệt kê dòng gán vai của đợt 3 — mọi lọc, tìm và phân trang
 * của bảng đều đi qua các tham số server này, không lọc phía client
 * trên tập đã tải toàn bộ. Bộ lọc/lượt tìm rỗng được bỏ khỏi chuỗi
 * truy vấn để backend hiểu là không lọc theo tiêu chí đó.
 */
export interface ListAssignmentsParams {
  /** Chỉ giữ dòng của người dùng này; bỏ qua thì không lọc theo người dùng. */
  userId?: string;
  /** Chỉ giữ dòng của vai trò này; bỏ qua thì không lọc theo vai trò. */
  roleId?: string;
  /** Chỉ giữ dòng tại ngữ cảnh này; bỏ qua thì không lọc theo ngữ cảnh. */
  contextId?: string;
  /** Từ khoá khớp tên hoặc email người dùng; bỏ qua khi rỗng. */
  search?: string;
  /** Số trang (bắt đầu từ 1). */
  page: number;
  /** Số dòng mỗi trang. */
  pageSize: number;
}

/**
 * Liệt kê dòng gán vai đã phân trang phía server
 * (GET /access/assignments) — phản hồi kèm tổng số dòng khớp bộ lọc để
 * bảng tính số trang; mỗi dòng đã ghép sẵn tên và email người dùng.
 *
 * @param params - Bộ lọc, từ khoá và phân trang của trang hiện tại.
 * @returns Trang dòng gán kèm tổng số dòng khớp.
 */
export function listAssignments(params: ListAssignmentsParams) {
  const query = new URLSearchParams();
  if (params.userId) query.set('userId', params.userId);
  if (params.roleId) query.set('roleId', params.roleId);
  if (params.contextId) query.set('contextId', params.contextId);
  if (params.search) query.set('search', params.search);
  query.set('page', String(params.page));
  query.set('pageSize', String(params.pageSize));
  return apiJson<AssignmentListResponse>(`/api/v1/access/assignments?${query.toString()}`);
}

/** Cỡ trang của lượt quét toàn bộ tập người giữ vai — khớp trần phía server của danh sách gán vai. */
const ALL_ASSIGNMENTS_PAGE_SIZE = 100;

/**
 * Đọc tập định danh người dùng đang giữ một vai trò tại một ngữ cảnh
 * (GET /access/assignments lọc theo vai trò + ngữ cảnh, quét lần lượt
 * các trang ở cỡ 100 cho tới khi đủ tổng server công bố). Phục vụ bộ
 * lọc theo vai trò của trang danh sách người dùng: phép lọc chạy phía
 * server trên endpoint gán vai, trang người dùng giao tập định danh
 * này với tập người dùng đã lọc/sắp xếp phía server của chính nó.
 *
 * @param roleId - Vai trò cần lọc.
 * @param contextId - Ngữ cảnh của vai trò (bộ lọc vai trò của trang người dùng luôn là ngữ cảnh hệ thống).
 * @returns Tập định danh người dùng giữ vai trò tại ngữ cảnh đó.
 */
export async function fetchRoleHolderUserIds(roleId: string, contextId: string) {
  const userIds = new Set<string>();
  let page = 1;
  let total = Number.POSITIVE_INFINITY;
  let fetched = 0;
  while (fetched < total) {
    const result = await listAssignments({ roleId, contextId, page, pageSize: ALL_ASSIGNMENTS_PAGE_SIZE });
    for (const row of result.assignments) userIds.add(row.userId);
    fetched += result.assignments.length;
    total = result.total;
    if (result.assignments.length === 0) break;
    page += 1;
  }
  return userIds;
}

/**
 * Gán một vai trò cho một người dùng tại một ngữ cảnh
 * (POST /access/assignments) — backend giữ nguyên các chốt chặn: gán
 * trùng cùng nguồn là no-op lặng, gán vai giảng dạy trúng chốt gói số
 * chỗ hoặc chốt tách vai bị từ chối với mã lỗi riêng; tầng hiển thị
 * dịch mã lỗi thành lý do, không báo thành công giả.
 *
 * @param input - Bộ ba người dùng × vai trò × ngữ cảnh cần gán.
 */
export function createAssignment(input: AssignRole) {
  return apiJson('/api/v1/access/assignments', { method: 'POST', body: JSON.stringify(input) });
}

/**
 * Gỡ một dòng gán (DELETE /access/assignments/:id) — dòng do ghi danh
 * quản lý (`component = 'enrol'`) bị backend từ chối với mã
 * `access.assignment_enrol_managed`; tầng hiển thị phân biệt dòng này
 * ngay trên bảng và dịch mã lỗi khi gặp trường hợp đua dữ kiện.
 *
 * @param assignmentId - Định danh dòng gán cần gỡ.
 */
export function deleteAssignment(assignmentId: string) {
  return apiJson<{ deleted: boolean }>(`/api/v1/access/assignments/${assignmentId}`, { method: 'DELETE' });
}

/**
 * Đọc ma trận quyền toàn trang tại một ngữ cảnh
 * (GET /access/capability-matrix?contextId=…): mọi vai trò kèm số
 * người giữ phân biệt và đúng các ghi đè ĐÃ LƯU tại ngữ cảnh đó —
 * năng lực vắng mặt trong đáp ứng nghĩa là đang ở trạng thái kế thừa
 * tại ngữ cảnh này. Trang Quyền độc lập dùng đáp ứng này làm nền cho
 * bảng ma trận và thẻ đếm ô Cho phép.
 *
 * @param contextId - Định danh ngữ cảnh cần đọc ma trận.
 * @returns Đáp ứng ma trận của ngữ cảnh.
 */
export function fetchCapabilityMatrix(contextId: string) {
  const query = new URLSearchParams({ contextId });
  return apiJson<CapabilityMatrixResponse>(`/api/v1/access/capability-matrix?${query.toString()}`);
}

/**
 * Đặt ghi đè quyền cho đúng một ô (POST /access/overrides): thân gồm
 * vai trò + năng lực + ngữ cảnh + giá trị bốn trạng thái; đặt giá trị
 * kế thừa (0) thì backend xoá dòng ghi đè của ô. Trang Quyền độc lập
 * gọi hàm này cho từng lần đổi ô — không có đường lưu toàn trang.
 *
 * @param input - Bộ bốn vai trò × năng lực × ngữ cảnh × giá trị.
 */
export function setCapabilityOverride(input: OverrideCapability) {
  return apiJson<{ updated: boolean }>('/api/v1/access/overrides', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Tham số của danh sách người dùng kèm gán vai — mọi trường đều tuỳ chọn trừ phân trang. */
export interface ListUsersWithAssignmentsParams {
  /** Từ khoá tìm theo tên đăng nhập, họ tên hoặc email (server khớp mờ). */
  search?: string;
  /** Chỉ lấy người dùng đang giữ vai trò này ở bất kỳ ngữ cảnh nào. */
  roleId?: string;
  /** Nhóm trạng thái tài khoản; vắng mặt thì server chỉ trả người dùng chưa xoá. */
  status?: UserListStatus;
  /** Trang bắt đầu từ 1. */
  page: number;
  /** Cỡ trang, tối đa 100 theo hợp đồng. */
  pageSize: number;
}

/**
 * Đọc một trang người dùng kèm toàn bộ gán vai của từng người
 * (GET /access/users-with-assignments): một người dùng đúng một phần
 * tử, `total` đếm người dùng khớp (không đếm dòng gán), thứ tự ổn
 * định theo định danh người dùng tăng dần. Bảng người dùng kèm vai
 * trò trên trang vai trò đọc qua hàm này — không tự ghép danh sách
 * người dùng với danh sách gán ở client.
 *
 * @param params - Bộ lọc/tìm/phân trang của bảng.
 * @returns Trang người dùng kèm gán vai và tổng số người dùng khớp.
 */
export function listUsersWithAssignments(params: ListUsersWithAssignmentsParams) {
  const query = new URLSearchParams();
  if (params.search) query.set('search', params.search);
  if (params.roleId) query.set('roleId', params.roleId);
  if (params.status) query.set('status', params.status);
  query.set('page', String(params.page));
  query.set('pageSize', String(params.pageSize));
  return apiJson<UserWithAssignmentsListResponse>(
    `/api/v1/access/users-with-assignments?${query.toString()}`,
  );
}

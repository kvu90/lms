import type {
  AssignRole,
  AssignmentListResponse,
  CreateRole,
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

/**
 * Tham số liệt kê người dùng kèm gán vai của bảng trang vai trò — mọi
 * lọc, tìm và phân trang của bảng đều đi qua các tham số server này,
 * không lọc phía client trên tập đã tải toàn bộ. Đơn vị phân trang ở
 * đây là NGƯỜI DÙNG (mỗi người đúng một dòng), khác danh sách gán vai
 * phân trang theo từng dòng gán; `total` vì thế đếm người dùng khớp
 * bộ lọc. Bộ lọc/lượt tìm rỗng được bỏ khỏi chuỗi truy vấn để backend
 * hiểu là không lọc theo tiêu chí đó.
 */
export interface ListUsersWithAssignmentsParams {
  /** Chỉ giữ người dùng có ít nhất một dòng gán với vai này; mảng gán trả về vẫn đủ mọi vai của người đó. */
  roleId?: string;
  /** Nhóm trạng thái tài khoản (`active`/`suspended`/`deleted`); bỏ qua thì chỉ lấy tài khoản chưa xoá. */
  status?: UserListStatus;
  /** Từ khoá khớp tên, email, tên đăng nhập hoặc họ tên đầy đủ; bỏ qua khi rỗng. */
  search?: string;
  /** Số trang (bắt đầu từ 1). */
  page: number;
  /** Số người mỗi trang. */
  pageSize: number;
}

/**
 * Liệt kê người dùng kèm toàn bộ gán vai đã phân trang phía server
 * (GET /access/users-with-assignments) — nguồn dữ kiện duy nhất của
 * bảng người dùng trên trang vai trò; mỗi người mang đủ dòng gán của
 * mình kèm tên vai và cấp ngữ cảnh nên bảng không cần gọi thêm.
 *
 * @param params - Bộ lọc, từ khoá và phân trang của trang hiện tại.
 * @returns Trang người dùng kèm gán vai và tổng số người dùng khớp.
 */
export function listUsersWithAssignments(params: ListUsersWithAssignmentsParams) {
  const query = new URLSearchParams();
  if (params.roleId) query.set('roleId', params.roleId);
  if (params.status) query.set('status', params.status);
  if (params.search) query.set('search', params.search);
  query.set('page', String(params.page));
  query.set('pageSize', String(params.pageSize));
  return apiJson<UserWithAssignmentsListResponse>(`/api/v1/access/users-with-assignments?${query.toString()}`);
}

/**
 * Tìm đúng một người dùng kèm gán vai qua endpoint gộp — phục vụ chế
 * độ lọc theo người dùng của bảng trang vai trò khi URL mang tham số
 * `userId` (đường liên kết từ cột Vai trò của trang danh sách người
 * dùng). Endpoint gộp không có tham số lọc theo định danh người dùng
 * nên lượt này quét lần lượt các trang ở cỡ trần 100 cho tới khi gặp
 * người cần tìm hoặc hết tổng server công bố; chỉ đọc từ đúng endpoint
 * gộp này, không ghép danh sách người dùng và danh sách gán riêng lẻ.
 * Lượt tra cứu chạy hai vòng theo nhóm trạng thái tài khoản: vòng mặc
 * định (không truyền `status`) theo ngữ nghĩa của endpoint chỉ thấy
 * tài khoản chưa xoá, nên không gặp thì quét thêm đúng một vòng với
 * `status: 'deleted'` — trang danh sách người dùng vẫn bày liên kết
 * vai trò cho dòng tài khoản đã xoá, và tài khoản đã xoá vẫn có thể
 * còn giữ gán vai cần rà soát; chỉ khi cả hai vòng đều không gặp mới
 * kết luận không tìm thấy. Ca phổ biến (người chưa xoá) không phát
 * sinh thêm lượt gọi nào. Quy mô quản trị nền tảng nhỏ (hàng chục
 * người dùng) nên lượt quét này chỉ là vài lần gọi trong trường hợp
 * xấu nhất.
 *
 * @param userId - Định danh người dùng cần tìm.
 * @returns Dòng người dùng kèm gán vai, hoặc null khi không tìm thấy trong cả hai nhóm trạng thái.
 */
export async function fetchUserWithAssignmentsById(userId: string) {
  const found = await scanUsersWithAssignmentsById(userId);
  if (found) return found;
  return scanUsersWithAssignmentsById(userId, 'deleted');
}

/**
 * Một vòng quét của lượt tra cứu theo người dùng: quét lần lượt các
 * trang ở cỡ trần 100 của endpoint gộp trong đúng một nhóm trạng thái
 * tài khoản cho tới khi gặp người cần tìm hoặc hết tổng server công
 * bố của nhóm đó.
 *
 * @param userId - Định danh người dùng cần tìm.
 * @param status - Nhóm trạng thái của vòng quét; bỏ qua thì quét nhóm chưa xoá theo mặc định của endpoint.
 * @returns Dòng người dùng kèm gán vai, hoặc null khi vòng quét không gặp.
 */
async function scanUsersWithAssignmentsById(userId: string, status?: UserListStatus) {
  let page = 1;
  let total = Number.POSITIVE_INFINITY;
  let fetched = 0;
  while (fetched < total) {
    const result = await listUsersWithAssignments({ status, page, pageSize: 100 });
    const found = result.users.find((user) => user.id === userId);
    if (found) return found;
    fetched += result.users.length;
    total = result.total;
    if (result.users.length === 0) break;
    page += 1;
  }
  return null;
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

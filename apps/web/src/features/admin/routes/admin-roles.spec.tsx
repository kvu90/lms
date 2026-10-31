import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { AdminRolesPage } from './admin-roles';

/**
 * Spec đợt 2 cho trang vai trò: lưới thẻ dựng từ dữ kiện tổng hợp của
 * đợt 1 (đúng một lần gọi danh sách), hộp thoại thêm/sửa kèm ma trận
 * bốn trạng thái lưu bằng một lần gọi thay toàn bộ, và hộp thoại xác
 * nhận xoá hiển thị đúng lý do backend chặn. Kèm cổng chặn lưu ở chế
 * độ sửa khi ma trận chưa tải xong hoặc tải lỗi (lưu sớm sẽ xoá lặng
 * ghi đè đã lưu), và ca xoá thành công dùng vai trò thường đúng luật
 * backend thay vì vai dựng sẵn.
 *
 * Spec đợt 3 (bảng gán vai, #547) thay thế form gán rời rạc cũ bằng
 * bảng + hộp thoại gán: mọi lọc/tìm/phân trang đều gửi tham số lên
 * server, gán/gỡ đi qua hộp thoại với đúng lý do của các chốt chặn.
 * Lượt sửa theo phân xử của PR #553: kẹp trang hiện tại theo tổng mới
 * nhất sau mỗi lần dữ liệu về (không kẹt ở trang rỗng sau gỡ), và bộ
 * chọn người dùng tải thêm từng đợt 20 khi kết quả khớp vượt quá 20.
 * Hai kiểm chứng F-01 cũ vẫn giữ: ba danh sách (vai / capability /
 * context) là ba query TanStack, và đột biến gán vai làm mới các truy
 * vấn access sau POST — nay kiểm chứng qua hộp thoại gán của đợt 3.
 * Cổng "trang đã tải" của các test đợt 2 đổi từ tên vai sang nút thẻ
 * thêm vai, vì tên vai giờ xuất hiện cả ở lưới thẻ lẫn các dòng bảng
 * đợt 3 nên không còn duy nhất cho findByText.
 *
 * Lượt căn chỉnh trình bày khớp bản demo mẫu (issue #555) đổi các bề
 * mặt sau và spec này ghim trạng thái mới: thẻ thêm vai là một thẻ đầy
 * đủ (tiêu đề + mô tả + nút trong thẻ); mặt thẻ vai không còn tên ngắn
 * và dòng nguyên mẫu, ba con số Đọc/Ghi/Tổng thành dải nền xám số lớn
 * với nhãn dưới số; hộp thoại vai có đúng một nút Huỷ, thêm nút × và
 * dòng mô tả phụ theo chế độ; trang không còn khối tiêu đề phía trên
 * lưới; thanh lọc của bảng co thành một hàng; chân bảng hiện khoảng
 * dòng kèm cụm nút luôn bày.
 *
 * Lượt dựng lại theo demo (issue #597) ghim trạng thái mới: hộp thoại
 * vai/gán/gỡ/xoá dựng trên component Dialog thật của `@lms/ui` (nút ×
 * của component mang nhãn truy cập "Close"); nhãn ngữ cảnh ở mọi bề
 * mặt là tên cấp dạng chữ qua adapter (Hệ thống / Trung tâm) — chuỗi
 * kỹ thuật "cấp · thực thể · đường dẫn" không còn xuất hiện; lưới thẻ
 * theo số đo mẫu (khe 20px, dải số nền xám nhạt số 14px nhãn 10px,
 * thẻ thêm căn giữa với nút outline); thanh lọc của bảng gán đúng hai
 * hàng; chân bảng là cụm phân trang riêng của feature (nút 36px);
 * trang có thêm bảng người dùng kèm vai trò đọc từ endpoint gộp — vì
 * trang nay có HAI bảng và hai nút "Gán vai trò", các test của bảng
 * gán giới hạn truy vấn trong đúng thẻ bảng của nó.
 *
 * Vòng sửa theo phán quyết điều phối (PR #601): ba đột biến vai trò
 * (tạo/đổi tên/xoá) làm mới bảng người dùng kèm vai trò ngay trên
 * cùng trang (đổi tên làm mới thêm ma trận toàn trang — kiểm chứng
 * ở queries/admin-roles.spec.ts); hai gán cùng vai ở hai ngữ cảnh
 * cùng cấp phân biệt bằng nhãn số thứ tự trong cấp ở cột bảng, hộp
 * thoại quản lý và xác nhận gỡ; tải thêm người dùng dừng ở trần 100
 * của API kèm gợi ý thu hẹp từ khoá thay vì gửi pageSize vượt trần.
 *
 * Vòng sửa 3 theo phán quyết 6539398880 (hình dạng demo, dữ kiện
 * thật): ma trận trong hộp thoại thành bảng checkbox — mỗi ô là một
 * năng lực thật, tích = Cho phép, trống = Kế thừa; chọn nhanh bốn
 * trạng thái thay bằng chọn theo cấp (toàn cục + theo nhóm resource)
 * chỉ thao tác trên các ô sửa được; ô đang mang Ngăn chặn đã lưu
 * (course:view ở ngữ cảnh hệ thống trong fixture) bị khoá kèm huy
 * hiệu và giữ nguyên giá trị trong tập thay toàn bộ khi lưu.
 *
 * Vòng sửa theo phán quyết 6540064754 trên PR #601 (bổ sung bằng
 * chứng kiểm thử cho riêng đường hộp thoại): một ca ghim cả hai
 * giá trị khoá Ngăn chặn và Cấm hẳn cùng tồn tại trong một ngữ
 * cảnh — chọn toàn cục cả hai chiều không đổi được ô khoá, tập
 * thay toàn bộ khi lưu giữ nguyên cả hai giá trị, và bỏ tích ô
 * đang Cho phép thì năng lực đó rời khỏi tập ghi đè ở lần lưu sau.
 *
 * Vòng sửa bố cục (PR #601): ma trận trong hộp thoại gom mỗi
 * resource thành đúng MỘT hàng như bảng mẫu — checkbox chọn theo
 * nhóm nằm ngay trên hàng của resource, cụm Đọc chứa checkbox
 * của các năng lực loại read và cụm Ghi chứa checkbox của các
 * năng lực loại write, mỗi checkbox kèm nhãn hành động của năng
 * lực. Mọi hành vi đã ghim ở các vòng trước (ô khoá kèm huy
 * hiệu, chọn theo cấp bỏ qua ô khoá, bảo toàn giá trị khoá khi
 * lưu) giữ nguyên phạm vi kiểm chứng.
 */
const ROLE_ID = '01900000-0000-7000-8000-0000000000b1';
const NEW_ROLE_ID = '01900000-0000-7000-8000-0000000000b2';
const SYSTEM_CONTEXT_ID = '01900000-0000-7000-8000-000000000010';
const TENANT_CONTEXT_ID = '01900000-0000-7000-8000-000000000020';
const USER_A_ID = '01900000-0000-7000-8000-0000000000a1';
const USER_B_ID = '01900000-0000-7000-8000-0000000000a2';
const USER_C_ID = '01900000-0000-7000-8000-0000000000a3';
const ASSIGN_A_ID = '01900000-0000-7000-8000-0000000000d1';
const ASSIGN_B_ID = '01900000-0000-7000-8000-0000000000d2';
const ASSIGN_C_ID = '01900000-0000-7000-8000-0000000000d3';
const COURSE_A_CONTEXT_ID = '01900000-0000-7000-8000-000000000050';
const COURSE_B_CONTEXT_ID = '01900000-0000-7000-8000-000000000051';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

interface StubOptions {
  /** DELETE /access/roles/:id trả về mã lỗi này thay vì thành công. */
  deleteErrorCode?: string;
  /** Cách truy vấn ma trận của vai đang sửa phản hồi: treo mãi, lỗi lần đầu rồi thành công, hoặc luôn lỗi. */
  matrixBehavior?: 'pending' | 'errorOnce' | 'errorAlways';
  /** Ghi đè archetype của vai trò duy nhất trong fixture (mặc định 'editingteacher'). */
  roleArchetype?: string | null;
  /** Ghi đè số người giữ của vai trò duy nhất trong fixture (mặc định 5). */
  roleUserCount?: number;
  /** POST /access/assignments trả về mã lỗi này thay vì thành công. */
  assignErrorCode?: string;
  /** DELETE /access/assignments/:id trả về mã lỗi này thay vì thành công. */
  unassignErrorCode?: string;
  /** Tổng số dòng gán fixture trả về (mặc định 2) — dùng để kiểm chứng số trang. */
  assignmentsTotal?: number;
  /** Dòng gán thường trỏ tới người dùng không còn tồn tại (tên/email null). */
  nullUserRow?: boolean;
  /** Bảng gán phân trang động: tạo đúng số dòng này, GET cắt theo trang/cỡ trang, DELETE trừ thật khỏi danh sách. */
  pagedAssignmentsTotal?: number;
  /** Danh sách người dùng phân trang động: tạo đúng số người này, GET lọc theo từ khoá rồi cắt theo trang/cỡ trang. */
  pagedUsersTotal?: number;
  /** Người đầu tiên giữ cùng vai ở hai khoá học (hai ngữ cảnh cùng cấp 50) để kiểm chứng nhãn phân biệt. */
  dualCourseAssignments?: boolean;
  /** Ma trận ngữ cảnh hệ thống chứa đồng thời một ô Ngăn chặn, một ô Cấm hẳn và một ô Cho phép để kiểm chứng bảo toàn hai giá trị khoá. */
  prohibitMatrix?: boolean;
}

function stubFetch(calls: RecordedCall[], options: StubOptions = {}) {
  let matrixCalls = 0;
  /** Danh sách dòng gán động cho ca phân trang (chỉ khi dùng pagedAssignmentsTotal). */
  let pagedRows: Array<Record<string, unknown>> | null =
    options.pagedAssignmentsTotal === undefined
      ? null
      : Array.from({ length: options.pagedAssignmentsTotal }, (_, i) => ({
          id: `01900000-0000-7000-8000-0000000000${String(i + 1).padStart(2, '0')}`,
          roleId: ROLE_ID,
          userId: `01900000-0000-7000-8000-0000000001${String(i + 1).padStart(2, '0')}`,
          contextId: SYSTEM_CONTEXT_ID,
          component: '',
          itemId: null,
          modifierId: null,
          updatedAt: '2026-10-01T00:00:00.000Z',
          userName: `Người dùng ${i + 1}`,
          userEmail: `nguoidung${i + 1}@example.com`,
        }));
  /** Danh sách người dùng động cho ca tải thêm (chỉ khi dùng pagedUsersTotal). */
  const pagedUsers: Array<Record<string, unknown>> | null =
    options.pagedUsersTotal === undefined
      ? null
      : Array.from({ length: options.pagedUsersTotal }, (_, i) => ({
          id: `01900000-0000-7000-8000-0000000002${String(i + 1).padStart(2, '0')}`,
          username: `nguoidung${i + 1}`,
          email: `nguoidung${i + 1}@example.com`,
          firstName: `Người ${i + 1}`,
          lastName: 'Dùng',
        }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/v1/access/roles' && method === 'GET')
        return respond([
          {
            id: ROLE_ID,
            name: 'Giáo viên',
            shortName: 'editingteacher',
            description: '',
            archetype: options.roleArchetype === undefined ? 'editingteacher' : options.roleArchetype,
            userCount: options.roleUserCount ?? 5,
            overrideCount: 3,
            readOverrideCount: 2,
            writeOverrideCount: 1,
            resourceCount: 2,
          },
        ]);
      if (url === '/api/v1/access/capabilities')
        return respond([
          {
            id: '01900000-0000-7000-8000-0000000000c1',
            name: 'course:view',
            capType: 'read',
            contextLevel: 50,
            component: 'core',
          },
          {
            id: '01900000-0000-7000-8000-0000000000c2',
            name: 'course:edit',
            capType: 'write',
            contextLevel: 50,
            component: 'core',
          },
          {
            id: '01900000-0000-7000-8000-0000000000c3',
            name: 'user:view',
            capType: 'read',
            contextLevel: 30,
            component: 'core',
          },
        ]);
      if (url === '/api/v1/access/contexts')
        return respond([
          { id: SYSTEM_CONTEXT_ID, contextLevel: 10, instanceId: '0', path: '/1' },
          { id: TENANT_CONTEXT_ID, contextLevel: 20, instanceId: '1', path: '/1/2' },
          ...(options.dualCourseAssignments
            ? [
                { id: COURSE_A_CONTEXT_ID, contextLevel: 50, instanceId: '10', path: '/1/10' },
                { id: COURSE_B_CONTEXT_ID, contextLevel: 50, instanceId: '11', path: '/1/11' },
              ]
            : []),
        ]);
      if (url.startsWith('/api/v1/access/assignments') && method === 'GET') {
        const query = new URLSearchParams(url.split('?')[1] ?? '');
        const page = Number(query.get('page') ?? 1);
        const pageSize = Number(query.get('pageSize') ?? 20);
        if (pagedRows !== null) {
          const start = (page - 1) * pageSize;
          return respond({
            assignments: pagedRows.slice(start, start + pageSize),
            total: pagedRows.length,
            page,
            pageSize,
          });
        }
        return respond({
          assignments: [
            {
              id: ASSIGN_A_ID,
              roleId: ROLE_ID,
              userId: USER_A_ID,
              contextId: SYSTEM_CONTEXT_ID,
              // Đường gán của quản trị mang component rỗng (xem roles.service.ts).
              component: '',
              itemId: null,
              modifierId: null,
              updatedAt: '2026-10-01T00:00:00.000Z',
              userName: options.nullUserRow ? null : 'An Nguyễn',
              userEmail: options.nullUserRow ? null : 'an@example.com',
            },
            {
              id: ASSIGN_B_ID,
              roleId: ROLE_ID,
              userId: USER_B_ID,
              contextId: TENANT_CONTEXT_ID,
              component: 'enrol',
              itemId: '01900000-0000-7000-8000-0000000000e1',
              modifierId: null,
              updatedAt: '2026-10-02T00:00:00.000Z',
              userName: 'Bình Trần',
              userEmail: 'binh@example.com',
            },
          ],
          total: options.assignmentsTotal ?? 2,
          page,
          pageSize,
        });
      }
      if (url.startsWith('/api/v1/access/users-with-assignments') && method === 'GET') {
        const query = new URLSearchParams(url.split('?')[1] ?? '');
        const page = Number(query.get('page') ?? 1);
        const pageSize = Number(query.get('pageSize') ?? 10);
        const search = (query.get('search') ?? '').toLowerCase();
        const roleId = query.get('roleId') ?? '';
        const status = query.get('status') ?? '';
        const allUsers = [
          {
            id: USER_A_ID,
            username: 'annguyen',
            firstName: 'An',
            lastName: 'Nguyễn',
            email: 'an@example.com',
            suspended: false,
            deleted: false,
            createdAt: '2026-10-01T00:00:00.000Z',
            assignments: options.dualCourseAssignments
              ? [
                  { id: ASSIGN_A_ID, roleId: ROLE_ID, roleName: 'Giáo viên', contextId: COURSE_A_CONTEXT_ID, contextLevel: 50, component: '' },
                  { id: ASSIGN_C_ID, roleId: ROLE_ID, roleName: 'Giáo viên', contextId: COURSE_B_CONTEXT_ID, contextLevel: 50, component: '' },
                ]
              : [
                  { id: ASSIGN_A_ID, roleId: ROLE_ID, roleName: 'Giáo viên', contextId: SYSTEM_CONTEXT_ID, contextLevel: 10, component: '' },
                ],
          },
          {
            id: USER_B_ID,
            username: 'binhtran',
            firstName: 'Bình',
            lastName: 'Trần',
            email: 'binh@example.com',
            suspended: false,
            deleted: false,
            createdAt: '2026-10-02T00:00:00.000Z',
            assignments: [
              { id: ASSIGN_B_ID, roleId: ROLE_ID, roleName: 'Giáo viên', contextId: TENANT_CONTEXT_ID, contextLevel: 20, component: 'enrol' },
            ],
          },
          {
            id: USER_C_ID,
            username: 'colan',
            firstName: 'Cô',
            lastName: 'Lan',
            email: 'co@example.com',
            suspended: true,
            deleted: false,
            createdAt: '2026-10-03T00:00:00.000Z',
            assignments: [],
          },
        ];
        const filtered = allUsers.filter((user) => {
          if (status === 'active' && (user.suspended || user.deleted)) return false;
          if (status === 'suspended' && !user.suspended) return false;
          if (status === 'deleted' && !user.deleted) return false;
          if (status === '' && user.deleted) return false;
          if (roleId !== '' && !user.assignments.some((a) => a.roleId === roleId)) return false;
          if (
            search !== '' &&
            !`${user.username} ${user.firstName} ${user.lastName} ${user.email}`.toLowerCase().includes(search)
          )
            return false;
          return true;
        });
        const start = (page - 1) * pageSize;
        return respond({
          users: filtered.slice(start, start + pageSize),
          total: filtered.length,
          page,
          pageSize,
        });
      }
      if (url.startsWith('/api/v1/users') && method === 'GET') {
        if (pagedUsers !== null) {
          const query = new URLSearchParams(url.split('?')[1] ?? '');
          const page = Number(query.get('page') ?? 1);
          const pageSize = Number(query.get('pageSize') ?? 20);
          const search = (query.get('search') ?? '').toLowerCase();
          const filtered =
            search === ''
              ? pagedUsers
              : pagedUsers.filter((u) => `${u.username} ${u.email}`.toLowerCase().includes(search));
          const start = (page - 1) * pageSize;
          return respond({ users: filtered.slice(start, start + pageSize), total: filtered.length, page, pageSize });
        }
        return respond({
          users: [
            {
              id: USER_A_ID,
              username: 'annguyen',
              email: 'an@example.com',
              firstName: 'An',
              lastName: 'Nguyễn',
            },
            { id: USER_C_ID, username: 'colan', email: 'co@example.com', firstName: 'Cô', lastName: 'Lan' },
          ],
          total: 2,
          page: 1,
          pageSize: 20,
        });
      }
      if (url === '/api/v1/access/assignments' && method === 'POST') {
        if (options.assignErrorCode)
          return respond(
            { type: 'about:blank', title: 'Không gán được vai trò', status: 400, code: options.assignErrorCode },
            400,
          );
        return respond({});
      }
      if (url.startsWith('/api/v1/access/assignments/') && method === 'DELETE') {
        if (pagedRows !== null) {
          const id = url.split('/').pop() ?? '';
          pagedRows = pagedRows.filter((r) => r.id !== id);
        }
        if (options.unassignErrorCode)
          return respond(
            { type: 'about:blank', title: 'Không gỡ được dòng gán', status: 400, code: options.unassignErrorCode },
            400,
          );
        return respond({ deleted: true });
      }
      if (url === `/api/v1/access/roles/${ROLE_ID}/capabilities` && method === 'GET') {
        if (options.matrixBehavior === 'pending') return new Promise<Response>(() => {});
        if (options.matrixBehavior === 'errorAlways')
          return respond({ type: 'about:blank', title: 'Lỗi tải ma trận', status: 500 }, 500);
        if (options.matrixBehavior === 'errorOnce') {
          matrixCalls += 1;
          if (matrixCalls === 1) return respond({ type: 'about:blank', title: 'Lỗi tải ma trận', status: 500 }, 500);
        }
        if (options.prohibitMatrix)
          return respond([
            { roleId: ROLE_ID, capability: 'course:view', contextId: SYSTEM_CONTEXT_ID, permission: -1 },
            { roleId: ROLE_ID, capability: 'course:edit', contextId: SYSTEM_CONTEXT_ID, permission: -1000 },
            { roleId: ROLE_ID, capability: 'user:view', contextId: SYSTEM_CONTEXT_ID, permission: 1 },
          ]);
        return respond([
          { roleId: ROLE_ID, capability: 'course:view', contextId: SYSTEM_CONTEXT_ID, permission: -1 },
          { roleId: ROLE_ID, capability: 'course:edit', contextId: TENANT_CONTEXT_ID, permission: 1 },
        ]);
      }
      if (url === '/api/v1/access/roles' && method === 'POST')
        return respond({
          id: NEW_ROLE_ID,
          name: 'Vai trò mới',
          shortName: 'newrole',
          description: '',
          archetype: null,
        });
      if (url === `/api/v1/access/roles/${ROLE_ID}` && method === 'PATCH') return respond({});
      if (url === `/api/v1/access/roles/${NEW_ROLE_ID}/capabilities` && method === 'PUT') return respond([]);
      if (url === `/api/v1/access/roles/${ROLE_ID}/capabilities` && method === 'PUT') return respond([]);
      if (url === `/api/v1/access/roles/${ROLE_ID}` && method === 'DELETE') {
        if (options.deleteErrorCode)
          return respond(
            { type: 'about:blank', title: 'Không xoá được vai trò', status: 400, code: options.deleteErrorCode },
            400,
          );
        return respond({ deleted: true });
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/admin/roles', element: <AdminRolesPage /> }], {
    initialEntries: ['/admin/roles'],
  });
  render(
    <TestProviders>
      <RouterProvider router={router} />
    </TestProviders>,
  );
}

/** Mở hộp thoại sửa của thẻ vai trò duy nhất trong stub qua menu ba chấm. */
async function openEditDialog() {
  await userEvent.click(screen.getByRole('button', { name: 'Thao tác với vai trò' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Sửa vai trò' }));
  await screen.findByRole('dialog', { name: 'Sửa vai trò' });
}

describe('Trang vai trò — lưới thẻ và hộp thoại ma trận (đợt 2, #546)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('tải vai, capability và context qua các query access và hiện thẻ với dữ kiện tổng hợp', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    await screen.findByRole('button', { name: 'Thêm vai trò mới' });
    expect(screen.getByText('5 người dùng')).toBeInTheDocument();
    // Dải số của thẻ vai: đúng ba con số thật với nhãn Đọc/Ghi/Tổng nằm
    // dưới số (khoanh vùng trong thẻ của vai duy nhất trong fixture).
    const roleCard = screen.getByRole('button', { name: 'Thao tác với vai trò' }).closest('[data-slot="card"]');
    expect(roleCard).not.toBeNull();
    const cardScope = within(roleCard as HTMLElement);
    expect(cardScope.getByText('Đọc')).toBeInTheDocument();
    expect(cardScope.getByText('Ghi')).toBeInTheDocument();
    expect(cardScope.getByText('Tổng')).toBeInTheDocument();
    // Số Đọc là 2, số Ghi là 1, số Tổng (resource) là 2.
    expect(cardScope.getAllByText('2')).toHaveLength(2);
    expect(cardScope.getByText('1')).toBeInTheDocument();
    // Mặt thẻ không còn tên ngắn (shortName) và dòng nguyên mẫu.
    expect(screen.queryByText(/editingteacher/)).not.toBeInTheDocument();
    expect(screen.queryByText(/nguyên mẫu/)).not.toBeInTheDocument();
    // Thẻ thêm vai là thẻ đầy đủ: tiêu đề, một dòng mô tả ngắn và nút trong thẻ.
    expect(screen.getByText('Thêm một vai trò, nếu vai trò đó chưa tồn tại.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Thêm vai trò mới' })).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/v1/access/roles')).toBe(true);
    expect(calls.some((c) => c.url === '/api/v1/access/capabilities')).toBe(true);
    expect(calls.some((c) => c.url === '/api/v1/access/contexts')).toBe(true);
  });

  it('tạo vai trò mới qua thẻ thêm rồi lưu ma trận bằng đúng một lần gọi thay toàn bộ', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    await screen.findByRole('button', { name: 'Thêm vai trò mới' });
    await userEvent.click(screen.getByRole('button', { name: 'Thêm vai trò mới' }));
    const dialog = await screen.findByRole('dialog', { name: 'Thêm vai trò mới' });
    await userEvent.type(within(dialog).getByLabelText('Tên vai trò'), 'Vai trò mới');
    await userEvent.type(within(dialog).getByLabelText('Tên ngắn (shortName)'), 'newrole');
    await userEvent.selectOptions(within(dialog).getByLabelText('Ngữ cảnh'), SYSTEM_CONTEXT_ID);
    // Chỉ một ô khác kế thừa: tích checkbox course:view thành Cho phép; các ô còn lại giữ Kế thừa nên không vào tập gửi lên.
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'course:view' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu vai trò' }));

    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/access/roles' && c.method === 'POST')).toBe(true));
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/access/roles/${NEW_ROLE_ID}/capabilities` && c.method === 'PUT'),
      ).toBe(true),
    );
    const put = calls.find((c) => c.url === `/api/v1/access/roles/${NEW_ROLE_ID}/capabilities`);
    expect(put?.body).toEqual({
      contextId: SYSTEM_CONTEXT_ID,
      overrides: [{ capability: 'course:view', permission: 1 }],
    });
    expect(calls.filter((c) => c.method === 'PUT').length).toBe(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('sửa vai trò: ô đang mang Ngăn chặn bị khoá kèm huy hiệu, chọn toàn cục không ghi đè được và giá trị giữ nguyên khi lưu', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    await screen.findByRole('button', { name: 'Thêm vai trò mới' });
    await openEditDialog();
    const dialog = screen.getByRole('dialog', { name: 'Sửa vai trò' });
    // Ngữ cảnh hệ thống mặc định: course:view đã lưu Ngăn chặn (−1) —
    // checkbox hiện trống, bị khoá và mang huy hiệu "Ngăn chặn".
    const lockedBox = await within(dialog).findByRole('checkbox', { name: 'course:view' });
    expect(lockedBox).toHaveAttribute('aria-disabled', 'true');
    expect(lockedBox).toHaveAttribute('aria-checked', 'false');
    expect(within(dialog).getByText('Ngăn chặn')).toBeInTheDocument();
    // Bố cục theo hàng resource: bảng ma trận chỉ gồm hàng tiêu đề
    // (có hai cụm cột Đọc/Ghi) + đúng một hàng cho course + một
    // hàng cho user — không còn hàng riêng cho từng năng lực.
    expect(within(dialog).getAllByRole('row')).toHaveLength(3);
    expect(within(dialog).getByText('Đọc')).toBeInTheDocument();
    expect(within(dialog).getByText('Ghi')).toBeInTheDocument();
    // Bấm vào ô khoá không đổi được trạng thái của nó.
    await userEvent.click(lockedBox);
    expect(within(dialog).getByRole('checkbox', { name: 'course:view' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    // Checkbox chọn toàn cục chỉ tính các ô sửa được: hai ô sửa được
    // đang tắt nên nó hiện trống (ô khoá không làm nó thành lưng chừng).
    const selectAll = within(dialog).getByRole('checkbox', { name: 'Chọn tất cả các quyền' });
    expect(selectAll).toHaveAttribute('aria-checked', 'false');
    // Chọn toàn cục bật hai ô sửa được, ô khoá vẫn nguyên trạng.
    await userEvent.click(selectAll);
    expect(within(dialog).getByRole('checkbox', { name: 'course:edit' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(dialog).getByRole('checkbox', { name: 'user:view' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(dialog).getByRole('checkbox', { name: 'course:view' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    // Lưu: tập thay toàn bộ vẫn mang nguyên Ngăn chặn của course:view
    // kèm hai ô vừa bật — không thao tác nào ở hộp thoại ghi đè lặng
    // giá trị chặn đã lưu.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu vai trò' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/access/roles/${ROLE_ID}/capabilities` && c.method === 'PUT')).toBe(
        true,
      ),
    );
    const put = calls.find((c) => c.url === `/api/v1/access/roles/${ROLE_ID}/capabilities` && c.method === 'PUT');
    expect(put?.body).toEqual({
      contextId: SYSTEM_CONTEXT_ID,
      overrides: [
        { capability: 'course:view', permission: -1 },
        { capability: 'course:edit', permission: 1 },
        { capability: 'user:view', permission: 1 },
      ],
    });
  });

  it('sửa vai trò: chọn toàn cục giữ nguyên cả Ngăn chặn lẫn Cấm hẳn khi lưu, bỏ tích ô Cho phép thì năng lực rời khỏi tập ghi đè', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { prohibitMatrix: true });
    renderPage();

    await screen.findByRole('button', { name: 'Thêm vai trò mới' });
    await openEditDialog();
    const dialog = screen.getByRole('dialog', { name: 'Sửa vai trò' });
    // Fixture của ngữ cảnh hệ thống mặc định: course:view đã lưu
    // Ngăn chặn (−1), course:edit đã lưu Cấm hẳn (−1000) — cả hai ô
    // đều khoá kèm huy hiệu; user:view đang Cho phép (1) là ô sửa
    // được duy nhất.
    const preventBox = await within(dialog).findByRole('checkbox', { name: 'course:view' });
    expect(preventBox).toHaveAttribute('aria-disabled', 'true');
    expect(preventBox).toHaveAttribute('aria-checked', 'false');
    const prohibitBox = within(dialog).getByRole('checkbox', { name: 'course:edit' });
    expect(prohibitBox).toHaveAttribute('aria-disabled', 'true');
    expect(prohibitBox).toHaveAttribute('aria-checked', 'false');
    expect(within(dialog).getByText('Ngăn chặn')).toBeInTheDocument();
    expect(within(dialog).getByText('Cấm hẳn')).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'user:view' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // Bấm thẳng vào ô Cấm hẳn cũng không đổi được trạng thái của nó.
    await userEvent.click(prohibitBox);
    expect(within(dialog).getByRole('checkbox', { name: 'course:edit' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    // Checkbox chọn toàn cục chỉ tính ô sửa được: user:view đang
    // bật nên nó hiện tích. Bỏ chọn toàn cục rồi chọn lại toàn cục
    // — cả hai chiều chỉ đổi ô sửa được, hai ô khoá giữ nguyên.
    const selectAll = within(dialog).getByRole('checkbox', { name: 'Chọn tất cả các quyền' });
    expect(selectAll).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(selectAll);
    expect(within(dialog).getByRole('checkbox', { name: 'user:view' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Chọn tất cả các quyền' }));
    expect(within(dialog).getByRole('checkbox', { name: 'user:view' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(dialog).getByRole('checkbox', { name: 'course:view' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(within(dialog).getByRole('checkbox', { name: 'course:view' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(within(dialog).getByRole('checkbox', { name: 'course:edit' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(within(dialog).getByRole('checkbox', { name: 'course:edit' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    // Lưu lần thứ nhất: tập thay toàn bộ giữ nguyên cả hai giá trị
    // khoá kèm ô Cho phép — chọn toàn cục không ghi đè lặng giá trị
    // chặn đã lưu ở bất kỳ chiều nào.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu vai trò' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/access/roles/${ROLE_ID}/capabilities` && c.method === 'PUT'),
      ).toBe(true),
    );
    const firstPut = calls.find(
      (c) => c.url === `/api/v1/access/roles/${ROLE_ID}/capabilities` && c.method === 'PUT',
    );
    expect(firstPut?.body).toEqual({
      contextId: SYSTEM_CONTEXT_ID,
      overrides: [
        { capability: 'course:view', permission: -1 },
        { capability: 'course:edit', permission: -1000 },
        { capability: 'user:view', permission: 1 },
      ],
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Mở lại hộp thoại, bỏ tích ô đang Cho phép rồi lưu lần thứ
    // hai: user:view về Kế thừa nên rời khỏi tập ghi đè, hai giá
    // trị khoá vẫn giữ nguyên trong thân PUT.
    await openEditDialog();
    const dialogAgain = screen.getByRole('dialog', { name: 'Sửa vai trò' });
    const allowedBox = await within(dialogAgain).findByRole('checkbox', { name: 'user:view' });
    expect(allowedBox).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(allowedBox);
    expect(within(dialogAgain).getByRole('checkbox', { name: 'user:view' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await userEvent.click(within(dialogAgain).getByRole('button', { name: 'Lưu vai trò' }));
    await waitFor(() =>
      expect(
        calls.filter((c) => c.url === `/api/v1/access/roles/${ROLE_ID}/capabilities` && c.method === 'PUT')
          .length,
      ).toBe(2),
    );
    const puts = calls.filter(
      (c) => c.url === `/api/v1/access/roles/${ROLE_ID}/capabilities` && c.method === 'PUT',
    );
    expect(puts[1]?.body).toEqual({
      contextId: SYSTEM_CONTEXT_ID,
      overrides: [
        { capability: 'course:view', permission: -1 },
        { capability: 'course:edit', permission: -1000 },
      ],
    });
  });

  it('sửa vai trò nạp đúng ghi đè của ngữ cảnh đang chọn và không lẫn sang ngữ cảnh khác', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    await screen.findByRole('button', { name: 'Thêm vai trò mới' });
    await openEditDialog();
    const dialog = screen.getByRole('dialog', { name: 'Sửa vai trò' });
    // Chờ ma trận ngữ cảnh hệ thống nạp xong: course:view khoá vì đang mang Ngăn chặn.
    await waitFor(() =>
      expect(within(dialog).getByRole('checkbox', { name: 'course:view' })).toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    // Chuyển sang ngữ cảnh trung tâm: course:view không có ghi đè ở đó nên về Kế thừa (trống, sửa được), course:edit giữ Cho phép (tích).
    await userEvent.selectOptions(within(dialog).getByLabelText('Ngữ cảnh'), TENANT_CONTEXT_ID);
    await waitFor(() =>
      expect(within(dialog).getByRole('checkbox', { name: 'course:view' })).toHaveAttribute(
        'aria-checked',
        'false',
      ),
    );
    expect(
      within(dialog).getByRole('checkbox', { name: 'course:view' }).getAttribute('aria-disabled'),
    ).not.toBe('true');
    expect(within(dialog).getByRole('checkbox', { name: 'course:edit' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // Tích course:view rồi lưu ở ngữ cảnh trung tâm: một PATCH tên/mô tả rồi đúng một PUT cho ngữ cảnh đó.
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'course:view' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu vai trò' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/access/roles/${ROLE_ID}/capabilities` && c.method === 'PUT')).toBe(
        true,
      ),
    );
    const put = calls.find((c) => c.url === `/api/v1/access/roles/${ROLE_ID}/capabilities` && c.method === 'PUT');
    // Thứ tự tập gửi lên theo thứ tự danh mục năng lực, không theo thứ tự dòng đã lưu.
    expect(put?.body).toEqual({
      contextId: TENANT_CONTEXT_ID,
      overrides: [
        { capability: 'course:view', permission: 1 },
        { capability: 'course:edit', permission: 1 },
      ],
    });
  });

  it('chọn tất cả toàn cục bật mọi ô sửa được rồi lưu qua một lần gọi thay toàn bộ', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    await screen.findByRole('button', { name: 'Thêm vai trò mới' });
    await userEvent.click(screen.getByRole('button', { name: 'Thêm vai trò mới' }));
    const dialog = await screen.findByRole('dialog', { name: 'Thêm vai trò mới' });
    await userEvent.type(within(dialog).getByLabelText('Tên vai trò'), 'Vai trò mới');
    await userEvent.type(within(dialog).getByLabelText('Tên ngắn (shortName)'), 'newrole');
    await userEvent.selectOptions(within(dialog).getByLabelText('Ngữ cảnh'), SYSTEM_CONTEXT_ID);
    const selectAll = within(dialog).getByRole('checkbox', { name: 'Chọn tất cả các quyền' });
    expect(selectAll).toHaveAttribute('aria-checked', 'false');
    // Tích một ô lẻ thì checkbox toàn cục chuyển sang trạng thái lưng chừng.
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'course:view' }));
    expect(selectAll).toHaveAttribute('aria-checked', 'mixed');
    // Bấm checkbox toàn cục thì mọi ô sửa được đều bật.
    await userEvent.click(selectAll);
    for (const name of ['course:view', 'course:edit', 'user:view']) {
      expect(within(dialog).getByRole('checkbox', { name })).toHaveAttribute('aria-checked', 'true');
    }
    expect(selectAll).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu vai trò' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/access/roles/${NEW_ROLE_ID}/capabilities` && c.method === 'PUT'),
      ).toBe(true),
    );
    const put = calls.find((c) => c.url === `/api/v1/access/roles/${NEW_ROLE_ID}/capabilities`);
    expect(put?.body).toEqual({
      contextId: SYSTEM_CONTEXT_ID,
      overrides: [
        { capability: 'course:view', permission: 1 },
        { capability: 'course:edit', permission: 1 },
        { capability: 'user:view', permission: 1 },
      ],
    });
  });

  it('chọn tất cả theo nhóm resource chỉ bật các năng lực trong cùng nhóm', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    await screen.findByRole('button', { name: 'Thêm vai trò mới' });
    await userEvent.click(screen.getByRole('button', { name: 'Thêm vai trò mới' }));
    const dialog = await screen.findByRole('dialog', { name: 'Thêm vai trò mới' });
    await userEvent.type(within(dialog).getByLabelText('Tên vai trò'), 'Vai trò mới');
    await userEvent.type(within(dialog).getByLabelText('Tên ngắn (shortName)'), 'newrole');
    await userEvent.selectOptions(within(dialog).getByLabelText('Ngữ cảnh'), SYSTEM_CONTEXT_ID);
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: 'Chọn tất cả quyền của nhóm course' }),
    );
    expect(within(dialog).getByRole('checkbox', { name: 'course:view' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(dialog).getByRole('checkbox', { name: 'course:edit' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(dialog).getByRole('checkbox', { name: 'user:view' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu vai trò' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/access/roles/${NEW_ROLE_ID}/capabilities` && c.method === 'PUT'),
      ).toBe(true),
    );
    const put = calls.find((c) => c.url === `/api/v1/access/roles/${NEW_ROLE_ID}/capabilities`);
    expect(put?.body).toEqual({
      contextId: SYSTEM_CONTEXT_ID,
      overrides: [
        { capability: 'course:view', permission: 1 },
        { capability: 'course:edit', permission: 1 },
      ],
    });
  });

  it('sửa vai trò khi ma trận chưa tải xong thì nút Lưu bị chặn và không phát sinh yêu cầu ghi', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { matrixBehavior: 'pending' });
    renderPage();

    await screen.findByRole('button', { name: 'Thêm vai trò mới' });
    await openEditDialog();
    const dialog = screen.getByRole('dialog', { name: 'Sửa vai trò' });
    // Ma trận vẫn đang tải nên chỉ hiện chữ tải, chưa có ô nào; nút Lưu bị chặn.
    expect(within(dialog).getByText('Đang tải…')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Lưu vai trò' })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu vai trò' }));
    expect(calls.some((c) => c.method === 'PUT' || c.method === 'PATCH')).toBe(false);
  });

  it('sửa vai trò khi tải ma trận lỗi thì hiện lỗi, chặn Lưu, và thử lại tải được ma trận', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { matrixBehavior: 'errorOnce' });
    renderPage();

    await screen.findByRole('button', { name: 'Thêm vai trò mới' });
    await openEditDialog();
    const dialog = screen.getByRole('dialog', { name: 'Sửa vai trò' });
    expect(
      await within(dialog).findByText('Không tải được ma trận quyền của vai trò. Thử tải lại trước khi lưu.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Lưu vai trò' })).toBeDisabled();
    expect(calls.some((c) => c.method === 'PUT' || c.method === 'PATCH')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Thử lại' }));
    // Sau thử lại, ma trận tải thành công: course:view đã lưu Ngăn chặn (−1) ở ngữ cảnh hệ thống nên checkbox bị khoá kèm huy hiệu.
    await waitFor(() =>
      expect(within(dialog).getByRole('checkbox', { name: 'course:view' })).toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    expect(within(dialog).getByText('Ngăn chặn')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Lưu vai trò' })).toBeEnabled();
  });

  it('xoá vai trò bị backend chặn thì hiển thị đúng lý do và giữ nguyên vai trò', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { deleteErrorCode: 'access.role_has_assignments' });
    renderPage();

    await screen.findByRole('button', { name: 'Thêm vai trò mới' });
    await userEvent.click(screen.getByRole('button', { name: 'Thao tác với vai trò' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Xoá vai trò' }));
    const dialog = await screen.findByRole('dialog', { name: 'Xoá vai trò' });
    expect(within(dialog).getByText(/Xoá vai trò “Giáo viên”/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xoá vai trò' }));
    await waitFor(() => expect(screen.getByText('Vai trò vẫn còn người giữ nên không xoá được.')).toBeInTheDocument());
    // Hộp thoại vẫn mở, vai trò vẫn trên lưới.
    expect(screen.getByRole('dialog', { name: 'Xoá vai trò' })).toBeInTheDocument();
    expect(screen.getByText('5 người dùng')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('xoá vai trò thường không còn người giữ thì thành công và hộp thoại đóng', async () => {
    // Fixture vai trò thường (không archetype, 0 người giữ): ca này trước
    // đây dùng vai dựng sẵn nên không kiểm chứng đúng trường hợp thật.
    stubFetch([], { roleArchetype: null, roleUserCount: 0 });
    renderPage();

    await screen.findByRole('button', { name: 'Thêm vai trò mới' });
    await userEvent.click(screen.getByRole('button', { name: 'Thao tác với vai trò' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Xoá vai trò' }));
    const dialog = await screen.findByRole('dialog', { name: 'Xoá vai trò' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xoá vai trò' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('hộp thoại vai trò có đúng một nút Huỷ, dòng mô tả phụ theo chế độ và nút × đóng được hộp thoại', async () => {
    stubFetch([]);
    renderPage();

    await screen.findByRole('button', { name: 'Thêm vai trò mới' });
    await userEvent.click(screen.getByRole('button', { name: 'Thêm vai trò mới' }));
    const createDialog = await screen.findByRole('dialog', { name: 'Thêm vai trò mới' });
    expect(within(createDialog).getByText('Tạo vai trò mới và cấu hình quyền của nó.')).toBeInTheDocument();
    // Chỉ đúng một nút Huỷ (ở hàng nút dưới cùng) — nút ở đầu hộp thoại đã thay bằng nút ×.
    expect(within(createDialog).getAllByRole('button', { name: 'Huỷ' })).toHaveLength(1);
    await userEvent.click(within(createDialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await openEditDialog();
    const editDialog = screen.getByRole('dialog', { name: 'Sửa vai trò' });
    expect(
      within(editDialog).getByText('Cập nhật tên vai trò và đặt quyền theo từng resource.'),
    ).toBeInTheDocument();
    expect(within(editDialog).getAllByRole('button', { name: 'Huỷ' })).toHaveLength(1);
    await userEvent.click(within(editDialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('Trang vai trò — bảng gán vai (đợt 3, #547)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  /**
   * Thẻ bảng gán vai để giới hạn truy vấn trong thẻ — trang còn bảng
   * người dùng kèm vai trò ở dưới với các điều khiển trùng tên.
   */
  function assignmentsCard(): HTMLElement {
    const card = screen.getByText('Người dùng và vai trò của họ').closest('[data-slot="card"]');
    if (!card) throw new Error('Không tìm thấy thẻ bảng gán vai');
    return card as HTMLElement;
  }

  /** Mở hộp thoại gán từ bảng gán và chọn người dùng annguyen trong danh sách tìm kiếm. */
  async function openAssignDialog() {
    await userEvent.click(within(assignmentsCard()).getByRole('button', { name: 'Gán vai trò' }));
    const dialog = await screen.findByRole('dialog', { name: 'Gán vai trò' });
    const userButton = await within(dialog).findByRole('button', { name: /annguyen/ });
    await userEvent.click(userButton);
    return dialog;
  }

  it('hiện đủ cột, dòng enrol-managed không có nút gỡ mà hiện lý do', async () => {
    stubFetch([]);
    renderPage();

    await screen.findByText('An Nguyễn');
    const table = within(assignmentsCard()).getByRole('table');
    // Tiêu đề cột đúng đặc tả, không có cột Plan/Billing.
    for (const header of ['Người dùng', 'Vai trò', 'Ngữ cảnh', 'Ngày gán', 'Thao tác']) {
      expect(within(table).getByText(header)).toBeInTheDocument();
    }
    expect(within(table).queryByText('Plan')).not.toBeInTheDocument();
    expect(within(table).queryByText('Billing')).not.toBeInTheDocument();
    // Cả hai dòng đều mang tên vai trò phân giải từ danh sách vai.
    expect(within(table).getAllByText('Giáo viên')).toHaveLength(2);
    // Nhãn ngữ cảnh là tên cấp dạng chữ qua adapter — không còn chuỗi
    // kỹ thuật cấp/thực thể/đường dẫn ở bất kỳ dòng nào của trang.
    expect(within(table).getByText('Hệ thống')).toBeInTheDocument();
    expect(within(table).getByText('Trung tâm')).toBeInTheDocument();
    expect(screen.queryByText(/thực thể/)).not.toBeInTheDocument();
    // Chỉ dòng thường có nút gỡ; dòng enrol-managed hiện lý do thay cho nút.
    expect(within(table).getAllByRole('button', { name: 'Gỡ gán' })).toHaveLength(1);
    expect(within(table).getByText('Không gỡ trực tiếp được — gỡ bằng cách rút ghi danh')).toBeInTheDocument();
    // Bảng không có nút Export/Import.
    expect(screen.queryByText(/Export/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Import/)).not.toBeInTheDocument();
  });

  it('lọc theo vai trò và ngữ cảnh, tìm kiếm, đổi cỡ trang và chuyển trang đều gửi tham số lên server', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { assignmentsTotal: 25 });
    renderPage();

    await screen.findByText('An Nguyễn');
    const card = within(assignmentsCard());
    const assignmentsCalls = () =>
      calls.filter((c) => c.url.startsWith('/api/v1/access/assignments') && c.method === 'GET');

    await userEvent.type(card.getByLabelText('Tìm người dùng'), 'An');
    await waitFor(() => expect(assignmentsCalls().some((c) => c.url.includes('search=An'))).toBe(true));

    await userEvent.selectOptions(card.getByLabelText('Lọc theo vai trò'), ROLE_ID);
    await waitFor(() => expect(assignmentsCalls().some((c) => c.url.includes(`roleId=${ROLE_ID}`))).toBe(true));

    await userEvent.selectOptions(card.getByLabelText('Lọc theo ngữ cảnh'), TENANT_CONTEXT_ID);
    await waitFor(() =>
      expect(assignmentsCalls().some((c) => c.url.includes(`contextId=${TENANT_CONTEXT_ID}`))).toBe(true),
    );

    await userEvent.selectOptions(card.getByLabelText('Số dòng mỗi trang'), '10');
    await waitFor(() => expect(assignmentsCalls().some((c) => c.url.includes('pageSize=10'))).toBe(true));
    // Tổng 25 dòng với cỡ trang 10 thành 3 trang: chân bảng hiện khoảng
    // dòng của trang 1 (stub trả 2 dòng mỗi trang bất kể cỡ trang).
    expect(card.getByText('Hiển thị 1–2 trong 25 dòng')).toBeInTheDocument();
    await userEvent.click(card.getByRole('button', { name: 'Sau' }));
    await waitFor(() => expect(assignmentsCalls().some((c) => c.url.includes('page=2'))).toBe(true));
    expect(card.getByText('Hiển thị 11–12 trong 25 dòng')).toBeInTheDocument();
  });

  it('gán vai qua hộp thoại POST đúng bộ ba và làm mới các truy vấn access', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    await screen.findByText('An Nguyễn');
    const roleLoadsBefore = calls.filter((c) => c.url === '/api/v1/access/roles' && c.method === 'GET').length;
    const dialog = await openAssignDialog();
    // Ngữ cảnh mặc định là ngữ cảnh hệ thống như form gán cũ.
    await waitFor(() =>
      expect((within(dialog).getByLabelText('Ngữ cảnh') as HTMLSelectElement).value).toBe(SYSTEM_CONTEXT_ID),
    );
    await userEvent.selectOptions(within(dialog).getByLabelText('Vai trò'), ROLE_ID);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gán vai trò' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/access/assignments' && c.method === 'POST')).toBe(true),
    );
    const post = calls.find((c) => c.url === '/api/v1/access/assignments' && c.method === 'POST');
    expect(post?.body).toEqual({ userId: USER_A_ID, roleId: ROLE_ID, contextId: SYSTEM_CONTEXT_ID });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Sau đột biến, truy vấn access được làm mới (danh sách vai tải lại).
    await waitFor(() =>
      expect(calls.filter((c) => c.url === '/api/v1/access/roles' && c.method === 'GET').length).toBeGreaterThan(
        roleLoadsBefore,
      ),
    );
  });

  it('gán trúng chốt gói số chỗ thì hiện đúng lý do và giữ hộp thoại mở', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { assignErrorCode: 'plan.tenant_slot_limit_reached' });
    renderPage();

    await screen.findByText('An Nguyễn');
    const dialog = await openAssignDialog();
    await userEvent.selectOptions(within(dialog).getByLabelText('Vai trò'), ROLE_ID);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gán vai trò' }));

    expect(
      await within(dialog).findByText(
        'Trung tâm đã chạm hạn mức gói nên không gán thêm vai trò giảng dạy được.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Gán vai trò' })).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/v1/access/assignments' && c.method === 'POST')).toBe(true);
  });

  it('gán trúng chốt tách vai thì hiện đúng lý do và giữ hộp thoại mở', async () => {
    stubFetch([], { assignErrorCode: 'access.role_context_conflict' });
    renderPage();

    await screen.findByText('An Nguyễn');
    const dialog = await openAssignDialog();
    await userEvent.selectOptions(within(dialog).getByLabelText('Vai trò'), ROLE_ID);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gán vai trò' }));

    expect(
      await within(dialog).findByText(
        'Người này đang là học viên đang hoạt động của khoá/lớp đó nên không nhận thêm vai trò giảng dạy tại đây.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Gán vai trò' })).toBeInTheDocument();
  });

  it('gỡ dòng gán sau xác nhận thì DELETE đúng id và bảng tải lại', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    await screen.findByText('An Nguyễn');
    const assignmentsBefore = calls.filter(
      (c) => c.url.startsWith('/api/v1/access/assignments') && c.method === 'GET',
    ).length;
    await userEvent.click(screen.getByRole('button', { name: 'Gỡ gán' }));
    const dialog = await screen.findByRole('dialog', { name: 'Gỡ gán vai trò' });
    expect(within(dialog).getByText(/Gỡ vai trò “Giáo viên” của An Nguyễn tại Hệ thống/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gỡ gán' }));

    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/access/assignments/${ASSIGN_A_ID}` && c.method === 'DELETE'),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(
        calls.filter((c) => c.url.startsWith('/api/v1/access/assignments') && c.method === 'GET').length,
      ).toBeGreaterThan(assignmentsBefore),
    );
  });

  it('gỡ bị backend từ chối bằng mã enrol-managed thì hiện đúng lý do và giữ hộp thoại mở', async () => {
    stubFetch([], { unassignErrorCode: 'access.assignment_enrol_managed' });
    renderPage();

    await screen.findByText('An Nguyễn');
    await userEvent.click(screen.getByRole('button', { name: 'Gỡ gán' }));
    const dialog = await screen.findByRole('dialog', { name: 'Gỡ gán vai trò' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gỡ gán' }));

    expect(
      await within(dialog).findByText('Không gỡ trực tiếp được — gỡ bằng cách rút ghi danh'),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Gỡ gán vai trò' })).toBeInTheDocument();
  });

  it('dòng trỏ tới người dùng không còn tồn tại hiện trạng thái thay cho tên', async () => {
    stubFetch([], { nullUserRow: true });
    renderPage();

    await screen.findByText('Người dùng không còn tồn tại');
    const table = within(assignmentsCard()).getByRole('table');
    expect(within(table).getByText('Người dùng không còn tồn tại')).toBeInTheDocument();
  });

  it('gỡ dòng duy nhất của trang cuối thì bảng tự về trang hợp lệ cuối cùng thay vì kẹt ở trang rỗng', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { pagedAssignmentsTotal: 21 });
    renderPage();

    await screen.findByText('Người dùng 1');
    const card = within(assignmentsCard());
    expect(card.getByText('Hiển thị 1–20 trong 21 dòng')).toBeInTheDocument();
    // Sang trang 2: chỉ còn dòng 21.
    await userEvent.click(card.getByRole('button', { name: 'Sau' }));
    await waitFor(() => expect(card.getByText('Hiển thị 21–21 trong 21 dòng')).toBeInTheDocument());
    expect(card.getByText('Người dùng 21')).toBeInTheDocument();
    // Gỡ dòng duy nhất của trang 2 rồi xác nhận.
    await userEvent.click(card.getByRole('button', { name: 'Gỡ gán' }));
    const dialog = await screen.findByRole('dialog', { name: 'Gỡ gán vai trò' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gỡ gán' }));
    // Tổng còn 20 dòng (1 trang): bảng tự về trang 1, không kẹt ở khoảng
    // dòng của trang 2; cụm phân trang vẫn hiện khi chỉ còn một trang.
    await waitFor(() => expect(card.getByText('Hiển thị 1–20 trong 20 dòng')).toBeInTheDocument());
    expect(card.getByText('Người dùng 1')).toBeInTheDocument();
    expect(card.queryByText('Hiển thị 21–21 trong 20 dòng')).not.toBeInTheDocument();
    expect(card.getByRole('button', { name: '1' })).toBeInTheDocument();
    expect(
      calls.some(
        (c) =>
          c.url === '/api/v1/access/assignments/01900000-0000-7000-8000-000000000021' && c.method === 'DELETE',
      ),
    ).toBe(true);
  });

  it('bộ chọn người dùng tải thêm được khi kết quả khớp vượt quá 20 người', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { pagedUsersTotal: 25 });
    renderPage();

    await screen.findByText('An Nguyễn');
    await userEvent.click(within(assignmentsCard()).getByRole('button', { name: 'Gán vai trò' }));
    const dialog = await screen.findByRole('dialog', { name: 'Gán vai trò' });
    // Đợt đầu chỉ tải 20 người: người thứ 21 chưa có, có nút tải thêm.
    await within(dialog).findByRole('button', { name: /nguoidung1@/ });
    expect(within(dialog).queryByRole('button', { name: /nguoidung21@/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Tải thêm người dùng' })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Tải thêm người dùng' }));
    // Sau tải thêm, người thứ 21 chọn được.
    await within(dialog).findByRole('button', { name: /nguoidung21@/ });
    expect(
      calls.some((c) => c.url.startsWith('/api/v1/users') && c.url.includes('pageSize=40')),
    ).toBe(true);
  });

  it('bảng có mô tả phụ dưới tiêu đề, thanh lọc đúng hai hàng và chân bảng hiện khoảng dòng ngay cả khi một trang', async () => {
    stubFetch([]);
    renderPage();

    await screen.findByText('An Nguyễn');
    const card = within(assignmentsCard());
    // Dòng mô tả phụ dưới tiêu đề bảng.
    expect(card.getByText('Mọi người dùng đang giữ vai trò và ngữ cảnh họ được gán.')).toBeInTheDocument();
    // Thanh lọc hai hàng: hàng 1 là hai ô chọn có nhãn phía trên, hàng
    // 2 là ô tìm kiếm mang bề rộng tối đa 288px như bảng mẫu. jsdom
    // không tính layout nên hành vi quan sát được ở đây là class bề
    // rộng trên đúng trường tìm kiếm và sự hiện diện của cả hai ô chọn.
    const searchField = card.getByLabelText('Tìm người dùng').closest('[data-slot="field"]');
    expect(searchField?.className).toContain('max-w-2xs');
    expect(card.getByLabelText('Lọc theo vai trò')).toBeInTheDocument();
    expect(card.getByLabelText('Lọc theo ngữ cảnh')).toBeInTheDocument();
    // Chân bảng: dòng khoảng dòng thay cho "Trang X / Y", và cụm nút
    // chuyển trang LUÔN hiện — dữ kiện chỉ có 1 trang nên các nút
    // Trước/Sau ở trạng thái tắt, nút số trang 1 vẫn bày.
    expect(card.getByText('Hiển thị 1–2 trong 2 dòng')).toBeInTheDocument();
    expect(card.queryByText('Trang 1 / 1')).not.toBeInTheDocument();
    expect(card.getByRole('button', { name: '1' })).toBeInTheDocument();
    expect(card.getByRole('button', { name: 'Sau' })).toBeDisabled();
    expect(card.getByRole('button', { name: 'Trước' })).toBeDisabled();
  });

  it('tải thêm người dùng dừng ở trần 100 và gợi ý thu hẹp từ khoá thay vì gửi pageSize vượt trần', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { pagedUsersTotal: 105 });
    renderPage();

    await screen.findByText('An Nguyễn');
    await userEvent.click(within(assignmentsCard()).getByRole('button', { name: 'Gán vai trò' }));
    const dialog = await screen.findByRole('dialog', { name: 'Gán vai trò' });
    // Bấm tải thêm 4 lần: 20 → 40 → 60 → 80 → 100.
    const loadMore = () => within(dialog).getByRole('button', { name: 'Tải thêm người dùng' });
    await userEvent.click(loadMore());
    await within(dialog).findByRole('button', { name: /nguoidung21@/ });
    await userEvent.click(loadMore());
    await within(dialog).findByRole('button', { name: /nguoidung41@/ });
    await userEvent.click(loadMore());
    await within(dialog).findByRole('button', { name: /nguoidung61@/ });
    await userEvent.click(loadMore());
    await within(dialog).findByRole('button', { name: /nguoidung100@/ });
    // Chạm trần 100 mà vẫn còn người chưa tải: nút tải thêm ẩn đi,
    // hiện gợi ý thu hẹp từ khoá thay vì cho bấm tiếp tới pageSize 120.
    expect(within(dialog).queryByRole('button', { name: 'Tải thêm người dùng' })).not.toBeInTheDocument();
    expect(
      within(dialog).getByText('Đã hiển thị tối đa 100 người — hãy thu hẹp từ khoá để tìm người còn lại.'),
    ).toBeInTheDocument();
    // Không lần gọi danh sách người dùng nào gửi pageSize vượt trần.
    const userCalls = calls.filter((c) => c.url.startsWith('/api/v1/users') && c.method === 'GET');
    expect(userCalls.length).toBeGreaterThan(0);
    for (const call of userCalls) {
      const pageSize = Number(new URLSearchParams(call.url.split('?')[1] ?? '').get('pageSize'));
      expect(pageSize).toBeLessThanOrEqual(100);
    }
  });
});

describe('Trang vai trò — bảng người dùng kèm vai trò', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  /** Thẻ bảng người dùng kèm vai trò để giới hạn truy vấn trong thẻ. */
  function usersCard(): HTMLElement {
    const card = screen.getByText('Tổng số người dùng kèm vai trò của họ').closest('[data-slot="card"]');
    if (!card) throw new Error('Không tìm thấy thẻ bảng người dùng kèm vai trò');
    return card as HTMLElement;
  }

  it('một người dùng một dòng kèm mọi gán và nhãn cấp dạng chữ, trạng thái dạng pill, không cột Plan/Billing và không Export/Import', async () => {
    stubFetch([]);
    renderPage();

    const card = within(usersCard());
    const table = await card.findByRole('table');
    // Ba người dùng fixture thành đúng ba dòng.
    expect(within(table).getByText('An Nguyễn')).toBeInTheDocument();
    expect(within(table).getByText('Bình Trần')).toBeInTheDocument();
    expect(within(table).getByText('Cô Lan')).toBeInTheDocument();
    // Cột vai trò bày gán kèm nhãn cấp dạng chữ; không chuỗi kỹ thuật.
    expect(within(table).getAllByText('Giáo viên')).toHaveLength(2);
    expect(within(table).getByText(/· Hệ thống/)).toBeInTheDocument();
    expect(within(table).getByText(/· Trung tâm/)).toBeInTheDocument();
    expect(screen.queryByText(/thực thể/)).not.toBeInTheDocument();
    // Trạng thái: hai người đang hoạt động, một người đã khoá.
    expect(within(table).getAllByText('Đang hoạt động')).toHaveLength(2);
    expect(within(table).getByText('Đã khoá')).toBeInTheDocument();
    // Không cột Plan/Billing, không nút Export/Import, không cột chọn hàng.
    expect(within(table).queryByText('Plan')).not.toBeInTheDocument();
    expect(within(table).queryByText('Billing')).not.toBeInTheDocument();
    expect(card.queryByText(/Export/)).not.toBeInTheDocument();
    expect(card.queryByText(/Import/)).not.toBeInTheDocument();
    expect(within(table).queryAllByRole('checkbox')).toHaveLength(0);
    // Bộ lọc chỉ có vai trò và trạng thái — không có ô chọn gói.
    expect(card.getByLabelText('Lọc theo vai trò')).toBeInTheDocument();
    expect(card.getByLabelText('Trạng thái')).toBeInTheDocument();
    expect(card.queryByLabelText(/Plan/)).not.toBeInTheDocument();
    // Chân bảng: khoảng dòng đếm NGƯỜI DÙNG (3), không đếm dòng gán.
    expect(card.getByText('Hiển thị 1 đến 3 trong 3 mục')).toBeInTheDocument();
    // Cỡ trang mặc định 10 và có đủ các lựa chọn 10/25/50/100.
    const pageSizeSelect = card.getByLabelText('Số người dùng mỗi trang') as HTMLSelectElement;
    expect(pageSizeSelect.value).toBe('10');
    expect([...pageSizeSelect.options].map((option) => option.value)).toEqual(['10', '25', '50', '100']);
  });

  it('lọc theo vai trò, trạng thái và tìm kiếm đều gửi tham số lên endpoint gộp', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    const card = within(usersCard());
    await card.findByText('An Nguyễn');
    const usersCalls = () =>
      calls.filter((c) => c.url.startsWith('/api/v1/access/users-with-assignments') && c.method === 'GET');

    await userEvent.type(card.getByLabelText('Tìm người dùng'), 'binh');
    await waitFor(() => expect(usersCalls().some((c) => c.url.includes('search=binh'))).toBe(true));
    await waitFor(() => expect(card.queryByText('An Nguyễn')).not.toBeInTheDocument());
    expect(card.getByText('Bình Trần')).toBeInTheDocument();

    await userEvent.selectOptions(card.getByLabelText('Trạng thái'), 'suspended');
    await waitFor(() => expect(usersCalls().some((c) => c.url.includes('status=suspended'))).toBe(true));

    await userEvent.selectOptions(card.getByLabelText('Lọc theo vai trò'), ROLE_ID);
    await waitFor(() => expect(usersCalls().some((c) => c.url.includes(`roleId=${ROLE_ID}`))).toBe(true));

    await userEvent.selectOptions(card.getByLabelText('Số người dùng mỗi trang'), '25');
    await waitFor(() => expect(usersCalls().some((c) => c.url.includes('pageSize=25'))).toBe(true));
  });

  it('hộp thoại quản lý của một dòng liệt kê gán kèm cấp dạng chữ, gán enrol không có nút gỡ mà hiện lý do', async () => {
    stubFetch([]);
    renderPage();

    const card = within(usersCard());
    const table = await card.findByRole('table');
    const manageButtons = within(table).getAllByRole('button', { name: 'Quản lý vai trò' });
    await userEvent.click(manageButtons[1]);
    const dialog = await screen.findByRole('dialog', { name: 'Vai trò của Bình Trần' });
    expect(within(dialog).getByText('Giáo viên')).toBeInTheDocument();
    expect(within(dialog).getByText('Trung tâm')).toBeInTheDocument();
    // Gán do ghi danh cấp: không nút gỡ, hiện thẳng lý do.
    expect(within(dialog).queryByRole('button', { name: 'Gỡ gán' })).not.toBeInTheDocument();
    expect(within(dialog).getByText('Không gỡ trực tiếp được — gỡ bằng cách rút ghi danh')).toBeInTheDocument();
  });

  it('gỡ gán tay từ hộp thoại quản lý thì DELETE đúng id; gán thêm mở hộp thoại gán với người dùng chọn sẵn', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    const card = within(usersCard());
    const table = await card.findByRole('table');
    const manageButtons = within(table).getAllByRole('button', { name: 'Quản lý vai trò' });
    await userEvent.click(manageButtons[0]);
    const manageDialog = await screen.findByRole('dialog', { name: 'Vai trò của An Nguyễn' });
    await userEvent.click(within(manageDialog).getByRole('button', { name: 'Gỡ gán' }));
    const confirmDialog = await screen.findByRole('dialog', { name: 'Gỡ gán vai trò' });
    await userEvent.click(within(confirmDialog).getByRole('button', { name: 'Gỡ gán' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/access/assignments/${ASSIGN_A_ID}` && c.method === 'DELETE'),
      ).toBe(true),
    );
    // Hộp thoại xác nhận đóng; hộp thoại quản lý vẫn mở trên cùng người.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Gỡ gán vai trò' })).not.toBeInTheDocument());
    const manageDialogAgain = screen.getByRole('dialog', { name: 'Vai trò của An Nguyễn' });
    // Bấm gán thêm trong hộp thoại quản lý: hộp thoại gán mở với người
    // dùng chọn sẵn (không còn ô tìm người dùng).
    await userEvent.click(within(manageDialogAgain).getByRole('button', { name: 'Gán thêm vai trò' }));
    const assignDialog = await screen.findByRole('dialog', { name: 'Gán vai trò' });
    expect(within(assignDialog).getByText('Người dùng được gán vai')).toBeInTheDocument();
    expect(within(assignDialog).getByText('annguyen')).toBeInTheDocument();
    expect(within(assignDialog).queryByLabelText('Tìm người dùng')).not.toBeInTheDocument();
  });

  it('đổi tên vai trò thì bảng người dùng kèm vai trò tải lại ngay mà không cần tải lại trang', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    const card = within(usersCard());
    await card.findByText('An Nguyễn');
    const usersCalls = () =>
      calls.filter((c) => c.url.startsWith('/api/v1/access/users-with-assignments') && c.method === 'GET');
    const usersBefore = usersCalls().length;
    // Mở hộp thoại sửa của thẻ vai, chờ ma trận nạp xong (ô course:view khoá vì đang mang Ngăn chặn đã lưu) rồi đổi tên và lưu.
    await userEvent.click(screen.getByRole('button', { name: 'Thao tác với vai trò' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Sửa vai trò' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sửa vai trò' });
    await waitFor(() =>
      expect(within(dialog).getByRole('checkbox', { name: 'course:view' })).toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    await userEvent.clear(within(dialog).getByLabelText('Tên vai trò'));
    await userEvent.type(within(dialog).getByLabelText('Tên vai trò'), 'Giáo viên mới');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu vai trò' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/access/roles/${ROLE_ID}` && c.method === 'PATCH')).toBe(true),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Đột biến đổi tên làm mới gốc bảng nên bảng tải lại sau PATCH.
    await waitFor(() => expect(usersCalls().length).toBeGreaterThan(usersBefore));
  });

  it('xoá vai trò thì bảng người dùng kèm vai trò tải lại ngay mà không cần tải lại trang', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { roleArchetype: null, roleUserCount: 0 });
    renderPage();

    const card = within(usersCard());
    await card.findByText('An Nguyễn');
    const usersCalls = () =>
      calls.filter((c) => c.url.startsWith('/api/v1/access/users-with-assignments') && c.method === 'GET');
    const usersBefore = usersCalls().length;
    await userEvent.click(screen.getByRole('button', { name: 'Thao tác với vai trò' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Xoá vai trò' }));
    const dialog = await screen.findByRole('dialog', { name: 'Xoá vai trò' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xoá vai trò' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/access/roles/${ROLE_ID}` && c.method === 'DELETE')).toBe(true),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Đột biến xoá làm mới gốc bảng nên bảng tải lại sau DELETE.
    await waitFor(() => expect(usersCalls().length).toBeGreaterThan(usersBefore));
  });

  it('tạo vai trò thì bảng người dùng kèm vai trò tải lại ngay mà không cần tải lại trang', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    const card = within(usersCard());
    await card.findByText('An Nguyễn');
    const usersCalls = () =>
      calls.filter((c) => c.url.startsWith('/api/v1/access/users-with-assignments') && c.method === 'GET');
    const usersBefore = usersCalls().length;
    await userEvent.click(screen.getByRole('button', { name: 'Thêm vai trò mới' }));
    const dialog = await screen.findByRole('dialog', { name: 'Thêm vai trò mới' });
    await userEvent.type(within(dialog).getByLabelText('Tên vai trò'), 'Vai trò mới');
    await userEvent.type(within(dialog).getByLabelText('Tên ngắn (shortName)'), 'newrole');
    await userEvent.selectOptions(within(dialog).getByLabelText('Ngữ cảnh'), SYSTEM_CONTEXT_ID);
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'course:view' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu vai trò' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/access/roles' && c.method === 'POST')).toBe(true),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Đột biến tạo làm mới gốc bảng nên bảng tải lại sau POST.
    await waitFor(() => expect(usersCalls().length).toBeGreaterThan(usersBefore));
  });

  it('hai gán cùng vai ở hai khoá học hiện nhãn phân biệt ở cột bảng', async () => {
    stubFetch([], { dualCourseAssignments: true });
    renderPage();

    const card = within(usersCard());
    const table = await card.findByRole('table');
    // Dòng của An có hai gán cùng vai nhưng khác khoá học: cột vai
    // trò bày hai nhãn khác nhau, không trùng hình, không lộ định danh.
    expect(within(table).getByText('· Khoá học')).toBeInTheDocument();
    expect(within(table).getByText('· Khoá học 2')).toBeInTheDocument();
    expect(screen.queryByText(/01900000/)).not.toBeInTheDocument();
  });

  it('hai gán cùng vai ở hai khoá học phân biệt được trong hộp thoại quản lý và xác nhận gỡ', async () => {
    stubFetch([], { dualCourseAssignments: true });
    renderPage();

    const card = within(usersCard());
    const table = await card.findByRole('table');
    const manageButtons = within(table).getAllByRole('button', { name: 'Quản lý vai trò' });
    await userEvent.click(manageButtons[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Vai trò của An Nguyễn' });
    // Hai dòng gán cùng tên vai nhưng nhãn ngữ cảnh phân biệt.
    expect(within(dialog).getAllByText('Giáo viên')).toHaveLength(2);
    expect(within(dialog).getByText('Khoá học')).toBeInTheDocument();
    expect(within(dialog).getByText('Khoá học 2')).toBeInTheDocument();
    // Bấm gỡ dòng thứ hai: hộp thoại xác nhận nêu đúng nhãn của dòng đó.
    const unassignButtons = within(dialog).getAllByRole('button', { name: 'Gỡ gán' });
    await userEvent.click(unassignButtons[1]);
    const confirmDialog = await screen.findByRole('dialog', { name: 'Gỡ gán vai trò' });
    expect(within(confirmDialog).getByText(/Khoá học 2/)).toBeInTheDocument();
  });
});

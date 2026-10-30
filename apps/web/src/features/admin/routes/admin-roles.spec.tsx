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
 * và dòng nguyên mẫu, ba con số Đọc/Ghi/Tổng thành dải nền xám với
 * nhãn dưới số; hộp thoại vai có đúng một nút Huỷ, thêm nút × và
 * dòng mô tả phụ theo chế độ; trang không còn khối tiêu đề phía trên
 * lưới; chân bảng hiện khoảng dòng kèm cụm nút luôn bày.
 *
 * Lượt dựng lại bảng theo người dùng (issue #569) thay bảng gán vai
 * đợt 3 bằng bảng một dòng một người dùng đọc từ endpoint gộp
 * users-with-assignments: cột Vai trò bày mọi gán kèm nhãn cấp ngữ
 * cảnh dạng chữ (không mã định danh, không đường dẫn), thanh công cụ
 * đúng hai hàng, hộp thoại quản lý vai trò theo dòng, và liên kết lọc
 * theo người dùng từ trang danh sách người dùng qua tham số `userId`.
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
  /** Bảng người dùng phân trang động: tạo đúng số người này, GET cắt theo trang/cỡ trang. */
  pagedTableUsersTotal?: number;
  /** Danh sách người dùng phân trang động: tạo đúng số người này, GET lọc theo từ khoá rồi cắt theo trang/cỡ trang. */
  pagedUsersTotal?: number;
}

function stubFetch(calls: RecordedCall[], options: StubOptions = {}) {
  let matrixCalls = 0;
  /** Danh sách người dùng động cho ca phân trang của bảng (chỉ khi dùng pagedTableUsersTotal). */
  const pagedTableUsers: Array<Record<string, unknown>> | null =
    options.pagedTableUsersTotal === undefined
      ? null
      : Array.from({ length: options.pagedTableUsersTotal }, (_, i) => ({
          id: `01900000-0000-7000-8000-0000000001${String(i + 1).padStart(2, '0')}`,
          username: `nguoidung${i + 1}`,
          email: `nguoidung${i + 1}@example.com`,
          firstName: `Người dùng`,
          lastName: `${i + 1}`,
          suspended: false,
          deleted: false,
          createdAt: '2022-01-14T00:00:00.000Z',
          assignments: [
            {
              id: `01900000-0000-7000-8000-0000000000${String(i + 1).padStart(2, '0')}`,
              roleId: ROLE_ID,
              roleName: 'Giáo viên',
              contextId: SYSTEM_CONTEXT_ID,
              contextLevel: 10,
              component: '',
            },
          ],
        }));
  /** Người dùng mặc định của bảng: An giữ hai vai ở hai cấp, Bình giữ một gán do ghi danh, Cô Lan bị khoá. */
  const defaultTableUsers: Array<Record<string, unknown>> = [
    {
      id: USER_A_ID,
      username: 'annguyen',
      email: 'an@example.com',
      firstName: 'An',
      lastName: 'Nguyễn',
      suspended: false,
      deleted: false,
      createdAt: '2022-01-14T00:00:00.000Z',
      assignments: [
        {
          id: ASSIGN_A_ID,
          roleId: ROLE_ID,
          roleName: 'Giáo viên',
          contextId: SYSTEM_CONTEXT_ID,
          contextLevel: 10,
          component: '',
        },
        {
          id: '01900000-0000-7000-8000-0000000000d3',
          roleId: ROLE_ID,
          roleName: 'Giáo viên',
          contextId: TENANT_CONTEXT_ID,
          contextLevel: 20,
          component: '',
        },
      ],
    },
    {
      id: USER_B_ID,
      username: 'binhtran',
      email: 'binh@example.com',
      firstName: 'Bình',
      lastName: 'Trần',
      suspended: false,
      deleted: false,
      createdAt: '2021-06-01T00:00:00.000Z',
      assignments: [
        {
          id: ASSIGN_B_ID,
          roleId: ROLE_ID,
          roleName: 'Giáo viên',
          contextId: '01900000-0000-7000-8000-000000000050',
          contextLevel: 50,
          component: 'enrol',
        },
      ],
    },
    {
      id: USER_C_ID,
      username: 'colan',
      email: 'co@example.com',
      firstName: 'Cô',
      lastName: 'Lan',
      suspended: true,
      deleted: false,
      createdAt: '2023-03-05T00:00:00.000Z',
      assignments: [
        {
          id: '01900000-0000-7000-8000-0000000000d4',
          roleId: ROLE_ID,
          roleName: 'Giáo viên',
          contextId: SYSTEM_CONTEXT_ID,
          contextLevel: 10,
          component: '',
        },
      ],
    },
  ];
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
        ]);
      if (url.startsWith('/api/v1/access/users-with-assignments') && method === 'GET') {
        const query = new URLSearchParams(url.split('?')[1] ?? '');
        const page = Number(query.get('page') ?? 1);
        const pageSize = Number(query.get('pageSize') ?? 10);
        const roleId = query.get('roleId') ?? '';
        const status = query.get('status') ?? '';
        const search = (query.get('search') ?? '').toLowerCase();
        // Lọc phía server như hợp đồng: vai trò là điều kiện tồn tại gán, trạng thái theo hai cờ, tìm kiếm theo tên/email/tên đăng nhập.
        const allUsers = pagedTableUsers ?? defaultTableUsers;
        const filtered = allUsers.filter((u) => {
          const assignments = u.assignments as Array<Record<string, unknown>>;
          if (roleId !== '' && !assignments.some((a) => a.roleId === roleId)) return false;
          if (status === 'active' && (u.suspended === true || u.deleted === true)) return false;
          if (status === 'suspended' && (u.suspended !== true || u.deleted === true)) return false;
          if (status === 'deleted' && u.deleted !== true) return false;
          if (status === '' && u.deleted === true) return false;
          if (search !== '') {
            const haystack = `${u.firstName} ${u.lastName} ${u.email} ${u.username}`.toLowerCase();
            if (!haystack.includes(search)) return false;
          }
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

function renderPage(entry = '/admin/roles') {
  const router = createMemoryRouter([{ path: '/admin/roles', element: <AdminRolesPage /> }], {
    initialEntries: [entry],
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
    // Chỉ một ô khác kế thừa: course:view thành Cho phép; các ô còn lại giữ Kế thừa nên không vào tập gửi lên.
    await userEvent.selectOptions(within(dialog).getByLabelText('course:view'), '1');
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

  it('sửa vai trò nạp đúng ghi đè của ngữ cảnh đang chọn và không lẫn sang ngữ cảnh khác', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    await screen.findByRole('button', { name: 'Thêm vai trò mới' });
    await openEditDialog();
    const dialog = screen.getByRole('dialog', { name: 'Sửa vai trò' });
    // Ngữ cảnh hệ thống mặc định: course:view đã lưu Ngăn chặn (−1).
    await waitFor(() => expect((within(dialog).getByLabelText('course:view') as HTMLSelectElement).value).toBe('-1'));
    // Chuyển sang ngữ cảnh trung tâm: course:view không có ghi đè ở đó nên về Kế thừa, course:edit giữ Cho phép.
    await userEvent.selectOptions(within(dialog).getByLabelText('Ngữ cảnh'), TENANT_CONTEXT_ID);
    await waitFor(() => expect((within(dialog).getByLabelText('course:view') as HTMLSelectElement).value).toBe('0'));
    expect((within(dialog).getByLabelText('course:edit') as HTMLSelectElement).value).toBe('1');
    // Lưu ở ngữ cảnh trung tâm: một PATCH tên/mô tả rồi đúng một PUT cho ngữ cảnh đó.
    await userEvent.selectOptions(within(dialog).getByLabelText('course:view'), '-1000');
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
        { capability: 'course:view', permission: -1000 },
        { capability: 'course:edit', permission: 1 },
      ],
    });
  });

  it('chọn nhanh toàn cục áp đúng trạng thái cho mọi ô rồi lưu qua một lần gọi thay toàn bộ', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    await screen.findByRole('button', { name: 'Thêm vai trò mới' });
    await userEvent.click(screen.getByRole('button', { name: 'Thêm vai trò mới' }));
    const dialog = await screen.findByRole('dialog', { name: 'Thêm vai trò mới' });
    await userEvent.type(within(dialog).getByLabelText('Tên vai trò'), 'Vai trò mới');
    await userEvent.type(within(dialog).getByLabelText('Tên ngắn (shortName)'), 'newrole');
    await userEvent.selectOptions(within(dialog).getByLabelText('Ngữ cảnh'), SYSTEM_CONTEXT_ID);
    await userEvent.selectOptions(within(dialog).getByLabelText('Chọn nhanh'), '-1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Áp cho toàn bộ' }));
    expect((within(dialog).getByLabelText('course:view') as HTMLSelectElement).value).toBe('-1');
    expect((within(dialog).getByLabelText('user:view') as HTMLSelectElement).value).toBe('-1');
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
        { capability: 'course:view', permission: -1 },
        { capability: 'course:edit', permission: -1 },
        { capability: 'user:view', permission: -1 },
      ],
    });
  });

  it('chọn nhanh theo hàng chỉ áp cho các năng lực trong cùng nhóm resource', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    await screen.findByRole('button', { name: 'Thêm vai trò mới' });
    await userEvent.click(screen.getByRole('button', { name: 'Thêm vai trò mới' }));
    const dialog = await screen.findByRole('dialog', { name: 'Thêm vai trò mới' });
    await userEvent.type(within(dialog).getByLabelText('Tên vai trò'), 'Vai trò mới');
    await userEvent.type(within(dialog).getByLabelText('Tên ngắn (shortName)'), 'newrole');
    await userEvent.selectOptions(within(dialog).getByLabelText('Ngữ cảnh'), SYSTEM_CONTEXT_ID);
    await userEvent.selectOptions(within(dialog).getByLabelText('Chọn nhanh cho nhóm course'), '1');
    // Mỗi nhóm resource có một nút "Áp cho hàng" riêng nên phải khoanh vùng theo nhóm course.
    await userEvent.click(
      within(screen.getByRole('region', { name: 'course' })).getByRole('button', { name: 'Áp cho hàng' }),
    );
    expect((within(dialog).getByLabelText('course:view') as HTMLSelectElement).value).toBe('1');
    expect((within(dialog).getByLabelText('course:edit') as HTMLSelectElement).value).toBe('1');
    expect((within(dialog).getByLabelText('user:view') as HTMLSelectElement).value).toBe('0');
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
    // Sau thử lại, ma trận tải thành công: course:view đã lưu Ngăn chặn (−1) ở ngữ cảnh hệ thống.
    await waitFor(() => expect((within(dialog).getByLabelText('course:view') as HTMLSelectElement).value).toBe('-1'));
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
    await userEvent.click(within(createDialog).getByRole('button', { name: 'Đóng' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await openEditDialog();
    const editDialog = screen.getByRole('dialog', { name: 'Sửa vai trò' });
    expect(
      within(editDialog).getByText('Cập nhật tên vai trò và đặt quyền theo từng resource.'),
    ).toBeInTheDocument();
    expect(within(editDialog).getAllByRole('button', { name: 'Huỷ' })).toHaveLength(1);
    await userEvent.click(within(editDialog).getByRole('button', { name: 'Đóng' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('Trang vai trò — bảng người dùng kèm vai trò (issue #569)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  /** Bảng mặc định: đợi hàng đầu tiên rồi trả về phần tử bảng để các test soi trong phạm vi bảng. */
  async function renderTable(calls: RecordedCall[], options: StubOptions = {}, waitText = 'An Nguyễn') {
    stubFetch(calls, options);
    renderPage();
    await screen.findByText(waitText);
    return screen.getByRole('table');
  }

  /** Mở hộp thoại gán vai trò chung từ nút trên thanh công cụ của bảng. */
  async function openAssignDialog() {
    await userEvent.click(screen.getByRole('button', { name: 'Gán vai trò' }));
    return screen.getByRole('dialog', { name: 'Gán vai trò' });
  }

  /** Mở hộp thoại quản lý vai trò của dòng thứ `index` trong bảng (thứ tự theo id người dùng). */
  async function openManageDialog(table: HTMLElement, index: number) {
    const buttons = within(table).getAllByRole('button', { name: 'Quản lý vai trò' });
    await userEvent.click(buttons[index]);
    return screen.getByRole('dialog', { name: /Vai trò của / });
  }

  it('hiện đúng một dòng cho mỗi người dùng với đủ năm cột, không Plan/Billing/Export/Import và không mã định danh', async () => {
    const calls: RecordedCall[] = [];
    const table = await renderTable(calls);
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Người dùng', 'Vai trò', 'Trạng thái', 'Ngày tham gia', 'Thao tác']);
    // Mỗi người dùng một dòng: tiêu đề + ba dòng dữ liệu.
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    // Người giữ nhiều vai vẫn một dòng, bày đủ mọi gán kèm nhãn cấp dạng chữ.
    // 'Giáo viên · Hệ thống' xuất hiện hai lần (An Nguyễn và Cô Lan cùng giữ gán đó).
    expect(within(table).getAllByText('Giáo viên · Hệ thống')).toHaveLength(2);
    expect(within(table).getByText('Giáo viên · Trung tâm')).toBeInTheDocument();
    // Ngày tham gia theo định dạng tiếng Việt dễ đọc, không MM/DD/YYYY.
    expect(within(table).getByText('14 tháng 1, 2022')).toBeInTheDocument();
    // Trạng thái theo người dùng: An/Bình đang hoạt động, Cô Lan bị khoá.
    expect(within(table).getAllByText('Đang hoạt động')).toHaveLength(2);
    expect(within(table).getByText('Bị khoá')).toBeInTheDocument();
    // Chân bảng đếm theo người dùng, không theo dòng gán.
    expect(screen.getByText('Hiển thị 1 đến 3 trong 3 người dùng')).toBeInTheDocument();
    // Quét toàn bảng: không UUID, không đường dẫn thô, không nhãn cấp dạng số.
    const tableText = table.textContent ?? '';
    expect(tableText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(tableText).not.toContain('/1');
    expect(tableText).not.toContain('cấp 10');
    expect(screen.queryByText('Plan')).toBeNull();
    expect(screen.queryByText('Billing')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
    // Không cột checkbox chọn: bảng không có ô checkbox nào.
    expect(within(table).queryByRole('checkbox')).toBeNull();
    expect(calls.some((c) => c.url.startsWith('/api/v1/access/users-with-assignments'))).toBe(true);
    expect(calls.some((c) => c.url.startsWith('/api/v1/access/assignments') && c.method === 'GET')).toBe(false);
  });

  it('thanh công cụ đúng hai hàng: hàng một chỉ có lọc vai trò và trạng thái, hàng hai có tìm kiếm, cỡ trang và nút gán', async () => {
    const calls: RecordedCall[] = [];
    await renderTable(calls);
    const filtersRow = screen.getByTestId('user-roles-toolbar-filters');
    const searchRow = screen.getByTestId('user-roles-toolbar-search');
    // Hàng lọc: nhãn nằm phía trên ô chọn, chỉ có hai bộ lọc.
    expect(within(filtersRow).getByLabelText('Lọc theo vai trò')).toBeInTheDocument();
    expect(within(filtersRow).getByLabelText('Trạng thái')).toBeInTheDocument();
    expect(within(filtersRow).queryByLabelText('Tìm người dùng')).toBeNull();
    expect(within(filtersRow).queryByLabelText('Số người dùng mỗi trang')).toBeNull();
    expect(within(filtersRow).queryByRole('button', { name: 'Gán vai trò' })).toBeNull();
    // Hàng tìm kiếm: ô tìm kiếm bên trái, cỡ trang và nút gán bên phải.
    expect(within(searchRow).getByLabelText('Tìm người dùng')).toBeInTheDocument();
    expect(within(searchRow).getByLabelText('Số người dùng mỗi trang')).toBeInTheDocument();
    expect(within(searchRow).getByRole('button', { name: 'Gán vai trò' })).toBeInTheDocument();
    expect(within(searchRow).queryByLabelText('Lọc theo vai trò')).toBeNull();
    expect(within(searchRow).queryByLabelText('Trạng thái')).toBeNull();
  });

  it('lọc vai trò gửi roleId, lọc trạng thái gửi status, tìm kiếm gửi search và đổi cỡ trang gửi pageSize lên endpoint gộp', async () => {
    const calls: RecordedCall[] = [];
    await renderTable(calls);
    // Lọc vai trò là điều kiện tồn tại: An vẫn giữ đủ cả hai gán dù chỉ một gán khớp vai.
    await userEvent.selectOptions(screen.getByLabelText('Lọc theo vai trò'), ROLE_ID);
    await waitFor(() =>
      expect(
        calls.some((c) => c.url.includes('/api/v1/access/users-with-assignments') && c.url.includes(`roleId=${ROLE_ID}`)),
      ).toBe(true),
    );
    expect(screen.getAllByText('Giáo viên · Hệ thống')).toHaveLength(2);
    expect(screen.getByText('Giáo viên · Trung tâm')).toBeInTheDocument();
    // Lọc trạng thái bị khoá chỉ còn Cô Lan.
    await userEvent.selectOptions(screen.getByLabelText('Trạng thái'), 'suspended');
    await waitFor(() =>
      expect(
        calls.some((c) => c.url.includes('/api/v1/access/users-with-assignments') && c.url.includes('status=suspended')),
      ).toBe(true),
    );
    // Dữ liệu cũ còn hiện trong lúc tải lại (keepPreviousData) nên phải chờ giao diện đổi theo dữ liệu mới.
    await waitFor(() => {
      expect(screen.queryByText('An Nguyễn')).toBeNull();
      expect(screen.getByText('Cô Lan')).toBeInTheDocument();
    });
    // Xoá trạng thái rồi tìm kiếm theo tên đăng nhập: chỉ còn An
    // (tìm 'An' sẽ khớp cả 'binhtran' vì backend tìm theo chuỗi con trên username).
    await userEvent.selectOptions(screen.getByLabelText('Trạng thái'), '');
    await userEvent.type(screen.getByLabelText('Tìm người dùng'), 'annguyen');
    await waitFor(() =>
      expect(
        calls.some((c) => c.url.includes('/api/v1/access/users-with-assignments') && c.url.includes('search=annguyen')),
      ).toBe(true),
    );
    await waitFor(() => {
      expect(screen.getByText('An Nguyễn')).toBeInTheDocument();
      expect(screen.queryByText('Bình Trần')).toBeNull();
    });
    // Đổi cỡ trang: lần gọi mới mang pageSize=100 và quay về trang đầu.
    await userEvent.selectOptions(screen.getByLabelText('Số người dùng mỗi trang'), '100');
    await waitFor(() =>
      expect(
        calls.some((c) => c.url.includes('/api/v1/access/users-with-assignments') && c.url.includes('pageSize=100')),
      ).toBe(true),
    );
  });

  it('phân trang theo người dùng: chuyển trang gửi page và chân bảng hiện đúng khoảng người dùng', async () => {
    const calls: RecordedCall[] = [];
    const table = await renderTable(calls, { pagedTableUsersTotal: 25 }, 'Người dùng 1');
    expect(screen.getByText('Hiển thị 1 đến 10 trong 25 người dùng')).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(11);
    await userEvent.click(screen.getAllByRole('button', { name: 'Sau' })[0]);
    await waitFor(() =>
      expect(
        calls.some((c) => c.url.includes('/api/v1/access/users-with-assignments') && c.url.includes('page=2')),
      ).toBe(true),
    );
    expect(screen.getByText('Hiển thị 11 đến 20 trong 25 người dùng')).toBeInTheDocument();
    // Lần gọi đầu mặc định cỡ trang 10.
    expect(calls.some((c) => c.url.includes('/api/v1/access/users-with-assignments') && c.url.includes('pageSize=10'))).toBe(true);
  });

  it('hộp thoại quản lý liệt kê mọi gán, gỡ gán thủ công qua xác nhận và không cho gỡ gán do ghi danh', async () => {
    const calls: RecordedCall[] = [];
    const table = await renderTable(calls);
    const manage = await openManageDialog(table, 0);
    expect(within(manage).getByRole('heading', { name: 'Vai trò của An Nguyễn' })).toBeInTheDocument();
    // Hộp thoại quản lý xếp tên vai và cấp thành hai dòng riêng nên soi riêng từng phần.
    expect(within(manage).getAllByText('Giáo viên')).toHaveLength(2);
    expect(within(manage).getByText('Hệ thống')).toBeInTheDocument();
    expect(within(manage).getByText('Trung tâm')).toBeInTheDocument();
    // Gỡ gán thủ công: xác nhận rồi DELETE đúng id gán, hộp thoại quản lý vẫn mở để thấy dữ liệu mới.
    const before = calls.length;
    await userEvent.click(within(manage).getAllByRole('button', { name: 'Gỡ gán' })[0]);
    const confirm = await screen.findByRole('dialog', { name: 'Gỡ gán vai trò' });
    expect(within(confirm).getByText('Gỡ vai trò “Giáo viên” của An Nguyễn tại Hệ thống?')).toBeInTheDocument();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Gỡ gán' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/access/assignments/${ASSIGN_A_ID}` && c.method === 'DELETE')).toBe(true),
    );
    expect(screen.queryByRole('dialog', { name: 'Gỡ gán vai trò' })).toBeNull();
    expect(screen.getByRole('dialog', { name: /Vai trò của / })).toBeInTheDocument();
    // Sau khi gỡ, bảng tải lại từ endpoint gộp (invalidation theo tiền tố khoá).
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
    expect(calls.some((c) => c.url.startsWith('/api/v1/access/users-with-assignments'))).toBe(true);
    // Gán do ghi danh: không có nút gỡ, chỉ có lý do hiển thị.
    await userEvent.click(screen.getByRole('button', { name: 'Huỷ' }));
    const manageBinh = await openManageDialog(table, 1);
    expect(within(manageBinh).getByRole('heading', { name: 'Vai trò của Bình Trần' })).toBeInTheDocument();
    expect(within(manageBinh).getByText('Giáo viên')).toBeInTheDocument();
    expect(within(manageBinh).getByText('Khoá học')).toBeInTheDocument();
    expect(within(manageBinh).queryByRole('button', { name: 'Gỡ gán' })).toBeNull();
    expect(within(manageBinh).getByText('Không gỡ trực tiếp được — gỡ bằng cách rút ghi danh')).toBeInTheDocument();
  });

  it('gán thêm từ hộp thoại quản lý mở hộp thoại gán với người dùng đã cố định và POST đúng id người dùng đó', async () => {
    const calls: RecordedCall[] = [];
    const table = await renderTable(calls);
    const manage = await openManageDialog(table, 0);
    await userEvent.click(within(manage).getByRole('button', { name: 'Gán thêm vai trò' }));
    // Hộp thoại quản lý đóng, hộp thoại gán mở với người dùng cố định, không còn ô tìm người dùng.
    expect(screen.queryByRole('dialog', { name: /Vai trò của / })).toBeNull();
    const dialog = await screen.findByRole('dialog', { name: 'Gán vai trò' });
    expect(within(dialog).getByText('annguyen')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Tìm người dùng')).toBeNull();
    await userEvent.selectOptions(within(dialog).getByLabelText('Vai trò'), ROLE_ID);
    await userEvent.selectOptions(within(dialog).getByLabelText('Ngữ cảnh'), SYSTEM_CONTEXT_ID);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gán vai trò' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url === '/api/v1/access/assignments' &&
            c.method === 'POST' &&
            (c.body as { userId?: string } | undefined)?.userId === USER_A_ID,
        ),
      ).toBe(true),
    );
    const post = calls.find((c) => c.url === '/api/v1/access/assignments' && c.method === 'POST');
    expect(post?.body).toEqual({ userId: USER_A_ID, roleId: ROLE_ID, contextId: SYSTEM_CONTEXT_ID });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Gán vai trò' })).toBeNull());
  });

  it('nút gán chung vẫn mở hộp thoại tìm người dùng, chọn người dùng rồi gán qua POST đúng bộ ba', async () => {
    const calls: RecordedCall[] = [];
    await renderTable(calls);
    const dialog = await openAssignDialog();
    await userEvent.type(within(dialog).getByLabelText('Tìm người dùng'), 'annguyen');
    await userEvent.click(await within(dialog).findByRole('button', { name: /annguyen/ }));
    await userEvent.selectOptions(within(dialog).getByLabelText('Vai trò'), ROLE_ID);
    await userEvent.selectOptions(within(dialog).getByLabelText('Ngữ cảnh'), SYSTEM_CONTEXT_ID);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gán vai trò' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/access/assignments' && c.method === 'POST')).toBe(true),
    );
    const post = calls.find((c) => c.url === '/api/v1/access/assignments' && c.method === 'POST');
    expect(post?.body).toEqual({ userId: USER_A_ID, roleId: ROLE_ID, contextId: SYSTEM_CONTEXT_ID });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Gán vai trò' })).toBeNull());
  });

  it('gán bị chặn bởi giới hạn slot của gói vẫn báo đúng lỗi và giữ hộp thoại mở', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { assignErrorCode: 'plan.tenant_slot_limit_reached' });
    renderPage();
    await screen.findByText('An Nguyễn');
    const dialog = await openAssignDialog();
    await userEvent.type(within(dialog).getByLabelText('Tìm người dùng'), 'annguyen');
    await userEvent.click(await within(dialog).findByRole('button', { name: /annguyen/ }));
    await userEvent.selectOptions(within(dialog).getByLabelText('Vai trò'), ROLE_ID);
    await userEvent.selectOptions(within(dialog).getByLabelText('Ngữ cảnh'), SYSTEM_CONTEXT_ID);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gán vai trò' }));
    await screen.findByText('Trung tâm đã chạm hạn mức gói nên không gán thêm vai trò giảng dạy được.');
    expect(screen.getByRole('dialog', { name: 'Gán vai trò' })).toBeInTheDocument();
  });

  it('gán xung đột ngữ cảnh (người đang là học viên) vẫn báo đúng lỗi và giữ hộp thoại mở', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { assignErrorCode: 'access.role_context_conflict' });
    renderPage();
    await screen.findByText('An Nguyễn');
    const dialog = await openAssignDialog();
    await userEvent.type(within(dialog).getByLabelText('Tìm người dùng'), 'annguyen');
    await userEvent.click(await within(dialog).findByRole('button', { name: /annguyen/ }));
    await userEvent.selectOptions(within(dialog).getByLabelText('Vai trò'), ROLE_ID);
    await userEvent.selectOptions(within(dialog).getByLabelText('Ngữ cảnh'), SYSTEM_CONTEXT_ID);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gán vai trò' }));
    await screen.findByText('Người này đang là học viên đang hoạt động của khoá/lớp đó nên không nhận thêm vai trò giảng dạy tại đây.');
    expect(screen.getByRole('dialog', { name: 'Gán vai trò' })).toBeInTheDocument();
  });

  it('vào trang với tham số userId thì bảng lọc sẵn đúng người dùng đó và xoá lọc khôi phục toàn bảng', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage(`/admin/roles?userId=${USER_B_ID}`);
    // Chế độ lọc theo người dùng: chỉ một dòng Bình Trần, kèm biểu ngữ lọc — không hiện mã định danh.
    await screen.findByText('Đang lọc theo người dùng: Bình Trần');
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('Bình Trần')).toBeInTheDocument();
    expect(within(table).queryByText('An Nguyễn')).toBeNull();
    expect(screen.queryByText(USER_B_ID)).toBeNull();
    // Xoá lọc: bảng trở lại đủ ba người, biểu ngữ biến mất.
    await userEvent.click(screen.getByRole('button', { name: 'Xoá lọc' }));
    await screen.findByText('An Nguyễn');
    expect(screen.queryByText('Đang lọc theo người dùng: Bình Trần')).toBeNull();
    expect(screen.getByText('Hiển thị 1 đến 3 trong 3 người dùng')).toBeInTheDocument();
    // Sau khi xoá lọc, bảng đọc lại từ endpoint gộp ở chế độ thường.
    expect(calls.some((c) => c.url.startsWith('/api/v1/access/users-with-assignments'))).toBe(true);
  });

  it('vào trang với tham số userId không khớp ai thì báo không tìm thấy và xoá lọc khôi phục toàn bảng', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage('/admin/roles?userId=01900000-0000-7000-8000-0000000000ff');
    await screen.findByText('Không tìm thấy người dùng theo bộ lọc này.');
    expect(screen.queryByRole('table')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Xoá lọc' }));
    await screen.findByText('An Nguyễn');
    expect(screen.getByText('Hiển thị 1 đến 3 trong 3 người dùng')).toBeInTheDocument();
  });
});

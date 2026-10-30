import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { AdminUsersPage } from '../components/admin-users';

/**
 * Spec đợt trình bày của trang danh sách người dùng (issue #561) trên
 * hợp đồng của đợt 1 (issue #560): bốn thẻ thống kê đếm thật theo
 * trạng thái, thanh công cụ một thẻ hai hàng (tìm kiếm, lọc trạng
 * thái, lọc vai trò ở ngữ cảnh hệ thống, cỡ trang 10/25/50/100), cột
 * Vai trò bày theo mô hình gán theo ngữ cảnh (vai tại hệ thống + số
 * gán ở ngữ cảnh khác + liên kết sang trang vai trò lọc theo người
 * dùng), sắp xếp phía server theo hợp đồng, chân bảng khoảng dòng và
 * hộp thoại xác nhận xoá dựng bằng component Dialog thay cho
 * `window.confirm`. Mọi lọc/sắp xếp/phân trang đều kiểm chứng qua
 * tham số thật của các lời gọi API đã ghi lại, không qua trạng thái
 * nội bộ của component.
 */
const SYSTEM_CONTEXT_ID = '01900000-0000-7000-8000-000000000010';
const TENANT_CONTEXT_ID = '01900000-0000-7000-8000-000000000020';
const ROLE_ADMIN_ID = '01900000-0000-7000-8000-0000000000b1';
const ROLE_TEACHER_ID = '01900000-0000-7000-8000-0000000000b2';
const USER_A_ID = '01900000-0000-7000-8000-0000000000a1';
const USER_B_ID = '01900000-0000-7000-8000-0000000000a2';
const USER_C_ID = '01900000-0000-7000-8000-0000000000a3';
const USER_D_ID = '01900000-0000-7000-8000-0000000000a4';

interface FixtureUser {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  email?: string;
  suspended: boolean;
  deleted: boolean;
  isGuest: boolean;
  forcePasswordChange: boolean;
  lastLogin: string | null;
  createdAt: string;
  customFields: never[];
}

interface RecordedCall {
  url: string;
  method: string;
}

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Bộ dữ kiện mẫu: 2 đang hoạt động, 1 bị khoá, 1 đã xoá; A giữ vai quản trị ở hệ thống + vai giáo viên ở trung tâm, B giữ vai giáo viên ở hệ thống. */
function fixtureUsers(): FixtureUser[] {
  return [
    {
      id: USER_A_ID,
      username: 'annguyen',
      firstName: 'An',
      lastName: 'Nguyễn',
      email: 'an@example.com',
      suspended: false,
      deleted: false,
      isGuest: false,
      forcePasswordChange: false,
      lastLogin: '2026-10-20T08:00:00.000Z',
      createdAt: '2026-01-15T08:00:00.000Z',
      customFields: [],
    },
    {
      id: USER_B_ID,
      username: 'binhtran',
      firstName: 'Bình',
      lastName: 'Trần',
      email: 'binh@example.com',
      suspended: true,
      deleted: false,
      isGuest: false,
      forcePasswordChange: false,
      lastLogin: null,
      createdAt: '2026-02-01T08:00:00.000Z',
      customFields: [],
    },
    {
      id: USER_C_ID,
      username: 'cudo',
      firstName: 'Cư',
      lastName: 'Đỗ',
      suspended: false,
      deleted: true,
      isGuest: false,
      forcePasswordChange: false,
      lastLogin: '2026-03-01T08:00:00.000Z',
      createdAt: '2025-12-01T08:00:00.000Z',
      customFields: [],
    },
    {
      id: USER_D_ID,
      username: 'dungpham',
      firstName: 'Dũng',
      lastName: 'Phạm',
      email: 'dung@example.com',
      suspended: false,
      deleted: false,
      isGuest: false,
      forcePasswordChange: false,
      lastLogin: '2026-10-25T08:00:00.000Z',
      createdAt: '2026-03-10T08:00:00.000Z',
      customFields: [],
    },
  ];
}

const FIXTURE_ASSIGNMENTS = [
  { id: 'as1', userId: USER_A_ID, roleId: ROLE_ADMIN_ID, contextId: SYSTEM_CONTEXT_ID },
  { id: 'as2', userId: USER_A_ID, roleId: ROLE_TEACHER_ID, contextId: TENANT_CONTEXT_ID },
  { id: 'as3', userId: USER_B_ID, roleId: ROLE_TEACHER_ID, contextId: SYSTEM_CONTEXT_ID },
];

function stubFetch(calls: RecordedCall[], users: FixtureUser[]) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET') ?? 'GET').toUpperCase();
    calls.push({ url, method });

    if (url.startsWith('/api/v1/users') && method === 'GET' && !/^\/api\/v1\/users\/[^?]+/.test(url)) {
      const query = new URLSearchParams(url.split('?')[1] ?? '');
      const status = query.get('status');
      const search = (query.get('search') ?? '').toLowerCase();
      const sortBy = query.get('sortBy');
      const sortDirection = query.get('sortDirection') ?? 'asc';
      const page = Number(query.get('page') ?? 1);
      const pageSize = Number(query.get('pageSize') ?? 10);
      let filtered = users.filter((u) => {
        if (status === 'active') return !u.deleted && !u.suspended;
        if (status === 'suspended') return !u.deleted && u.suspended;
        if (status === 'deleted') return u.deleted;
        return !u.deleted;
      });
      if (search !== '') {
        filtered = filtered.filter((u) =>
          `${u.username} ${u.firstName} ${u.lastName} ${u.email ?? ''}`.toLowerCase().includes(search),
        );
      }
      const direction = sortDirection === 'desc' ? -1 : 1;
      const sorted = [...filtered].sort((a, b) => {
        if (sortBy === 'name') return direction * `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`);
        if (sortBy === 'createdAt') return direction * a.createdAt.localeCompare(b.createdAt);
        if (sortBy === 'lastLogin') return direction * (a.lastLogin ?? '').localeCompare(b.lastLogin ?? '');
        return a.id.localeCompare(b.id);
      });
      const start = (page - 1) * pageSize;
      return respond({ users: sorted.slice(start, start + pageSize), total: sorted.length, page, pageSize });
    }
    const deleteMatch = /^\/api\/v1\/users\/([^/?]+)$/.exec(url);
    if (deleteMatch && method === 'DELETE') {
      const target = users.find((u) => u.id === deleteMatch[1]);
      if (target) target.deleted = true;
      return respond({ deleted: true });
    }
    if (url === '/api/v1/access/roles') {
      return respond([
        {
          id: ROLE_ADMIN_ID,
          name: 'Quản trị viên',
          shortName: 'admin',
          description: '',
          archetype: 'siteadmin',
          userCount: 1,
          overrideCount: 0,
          readOverrideCount: 0,
          writeOverrideCount: 0,
          resourceCount: 0,
        },
        {
          id: ROLE_TEACHER_ID,
          name: 'Giáo viên',
          shortName: 'teacher',
          description: '',
          archetype: 'editingteacher',
          userCount: 2,
          overrideCount: 0,
          readOverrideCount: 0,
          writeOverrideCount: 0,
          resourceCount: 0,
        },
      ]);
    }
    if (url === '/api/v1/access/contexts') {
      return respond([
        { id: SYSTEM_CONTEXT_ID, contextLevel: 10, instanceId: '0', path: '/1' },
        { id: TENANT_CONTEXT_ID, contextLevel: 20, instanceId: '1', path: '/1/2' },
      ]);
    }
    if (url.startsWith('/api/v1/access/assignments') && method === 'GET') {
      const query = new URLSearchParams(url.split('?')[1] ?? '');
      const userId = query.get('userId');
      const roleId = query.get('roleId');
      const contextId = query.get('contextId');
      const page = Number(query.get('page') ?? 1);
      const pageSize = Number(query.get('pageSize') ?? 100);
      const filtered = FIXTURE_ASSIGNMENTS.filter(
        (a) =>
          (userId === null || a.userId === userId) &&
          (roleId === null || a.roleId === roleId) &&
          (contextId === null || a.contextId === contextId),
      ).map((a) => ({
        ...a,
        component: '',
        itemId: null,
        modifierId: null,
        updatedAt: '2026-10-01T00:00:00.000Z',
        userName: null,
        userEmail: null,
      }));
      const start = (page - 1) * pageSize;
      return respond({ assignments: filtered.slice(start, start + pageSize), total: filtered.length, page, pageSize });
    }
    return respond({}, 404);
  };
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/admin/users', element: <AdminUsersPage /> }], {
    initialEntries: ['/admin/users'],
  });
  render(
    <TestProviders>
      <RouterProvider router={router} />
    </TestProviders>,
  );
}

function setup() {
  const calls: RecordedCall[] = [];
  const users = fixtureUsers();
  vi.stubGlobal('fetch', stubFetch(calls, users));
  renderPage();
  return { calls, users };
}

/** Các lời gọi GET danh sách người dùng đã ghi lại (không gồm các lời gọi đọc một hồ sơ). */
function userListCalls(calls: RecordedCall[]) {
  return calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/v1/users?'));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Trang danh sách người dùng — trình bày đợt 2', () => {
  it('hiển thị bốn thẻ thống kê bằng số đếm thật theo trạng thái, đủ các cột mới và chân bảng khoảng dòng', async () => {
    setup();
    // Thẻ render nhãn ngay, giá trị về theo truy vấn đếm — chờ số thật của thẻ tổng rồi mới đối chiếu các thẻ còn lại.
    await waitFor(() => {
      expect(screen.getByTestId('stat-card-total')).toHaveTextContent('4');
    });
    expect(screen.getByTestId('stat-card-active')).toHaveTextContent('2');
    expect(screen.getByTestId('stat-card-suspended')).toHaveTextContent('1');
    expect(screen.getByTestId('stat-card-deleted')).toHaveTextContent('1');
    for (const header of ['Người dùng', 'Vai trò', 'Trạng thái', 'Ngày tham gia', 'Lần đăng nhập cuối', 'Thao tác']) {
      expect(screen.getByRole('columnheader', { name: new RegExp(header) })).toBeTruthy();
    }
    // Danh sách mặc định ẩn tài khoản đã xoá: 3 dòng và chân bảng khớp.
    expect(await screen.findByText('An Nguyễn')).toBeTruthy();
    expect(screen.getByText('Bình Trần')).toBeTruthy();
    expect(screen.queryByText('Cư Đỗ')).toBeNull();
    expect(screen.getByText('Đang hiện 1 đến 3 trong 3')).toBeTruthy();
    // Người chưa từng đăng nhập hiện trạng thái rỗng rõ ràng ở cột lần đăng nhập cuối.
    const rowB = screen.getByText('Bình Trần').closest('tr') as HTMLElement;
    expect(within(rowB).getByText('Chưa đăng nhập')).toBeTruthy();
    expect(within(rowB).getByText('Bị khoá')).toBeTruthy();
  });

  it('cột Vai trò bày vai trò tại ngữ cảnh hệ thống, số gán ở ngữ cảnh khác và liên kết sang trang vai trò lọc theo đúng người dùng', async () => {
    setup();
    const rowA = (await screen.findByText('An Nguyễn')).closest('tr') as HTMLElement;
    expect(await within(rowA).findByText('Quản trị viên')).toBeTruthy();
    expect(within(rowA).getByText('+1 gán ở ngữ cảnh khác')).toBeTruthy();
    const link = within(rowA).getByRole('link', { name: 'Xem tại trang vai trò' });
    expect(link.getAttribute('href')).toBe(`/admin/roles?userId=${USER_A_ID}`);
    // B giữ vai giáo viên ngay tại hệ thống nên không có dòng gán ngữ cảnh khác.
    const rowB = screen.getByText('Bình Trần').closest('tr') as HTMLElement;
    expect(await within(rowB).findByText('Giáo viên')).toBeTruthy();
    expect(within(rowB).queryByText(/gán ở ngữ cảnh khác/)).toBeNull();
  });

  it('lọc theo trạng thái đã xoá gửi đúng tham số lên server và chỉ hiện tài khoản đã xoá, dòng không có email thì không hiện dòng email', async () => {
    const { calls } = setup();
    await screen.findByText('An Nguyễn');
    await userEvent.selectOptions(screen.getByLabelText('Trạng thái'), 'deleted');
    expect(await screen.findByText('Cư Đỗ')).toBeTruthy();
    expect(screen.queryByText('An Nguyễn')).toBeNull();
    expect(userListCalls(calls).some((c) => c.url.includes('status=deleted'))).toBe(true);
    const rowC = screen.getByText('Cư Đỗ').closest('tr') as HTMLElement;
    expect(rowC.textContent).not.toContain('@');
    expect(within(rowC).getByText('Đã xoá')).toBeTruthy();
    // Tài khoản đã xoá không còn nút Xoá.
    expect(within(rowC).queryByRole('button', { name: 'Xoá' })).toBeNull();
  });

  it('lọc theo vai trò hệ thống lấy tập người giữ vai từ endpoint gán vai và chỉ hiện người giữ vai đó tại ngữ cảnh hệ thống', async () => {
    const { calls } = setup();
    await screen.findByText('An Nguyễn');
    await userEvent.selectOptions(screen.getByLabelText('Vai trò hệ thống'), ROLE_ADMIN_ID);
    await waitFor(() => {
      expect(screen.queryByText('Bình Trần')).toBeNull();
      expect(screen.queryByText('Dũng Phạm')).toBeNull();
    });
    expect(screen.getByText('An Nguyễn')).toBeTruthy();
    expect(screen.getByText('Đang hiện 1 đến 1 trong 1')).toBeTruthy();
    expect(
      calls.some(
        (c) =>
          c.url.startsWith('/api/v1/access/assignments') &&
          c.url.includes(`roleId=${ROLE_ADMIN_ID}`) &&
          c.url.includes(`contextId=${SYSTEM_CONTEXT_ID}`),
      ),
    ).toBe(true);
  });

  it('đổi cỡ trang và sắp xếp theo ngày tham gia đều gửi tham số hợp đồng lên server, sắp xếp đủ hai chiều', async () => {
    const { calls } = setup();
    await screen.findByText('An Nguyễn');
    await userEvent.selectOptions(screen.getByLabelText('Số dòng mỗi trang'), '25');
    await waitFor(() => {
      expect(userListCalls(calls).some((c) => c.url.includes('pageSize=25'))).toBe(true);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Ngày tham gia' }));
    await waitFor(() => {
      expect(userListCalls(calls).some((c) => c.url.includes('sortBy=createdAt') && c.url.includes('sortDirection=asc'))).toBe(true);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Ngày tham gia' }));
    await waitFor(() => {
      expect(userListCalls(calls).some((c) => c.url.includes('sortBy=createdAt') && c.url.includes('sortDirection=desc'))).toBe(true);
    });
  });

  it('xoá người dùng mở hộp thoại xác nhận dựng bằng component nêu đúng tên người dùng thay cho window.confirm, xoá xong danh sách và thẻ thống kê cập nhật', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { calls } = setup();
    const rowA = (await screen.findByText('An Nguyễn')).closest('tr') as HTMLElement;
    await userEvent.click(within(rowA).getByRole('button', { name: 'Xoá' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/An Nguyễn/)).toBeTruthy();
    expect(confirmSpy).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xoá' }));
    await waitFor(() => {
      expect(screen.queryByText('An Nguyễn')).toBeNull();
    });
    expect(calls.some((c) => c.method === 'DELETE' && c.url === `/api/v1/users/${USER_A_ID}`)).toBe(true);
    await waitFor(() => {
      expect(screen.getByTestId('stat-card-deleted')).toHaveTextContent('2');
    });
  });
});

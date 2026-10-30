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
  /** Tổng số dòng gán fixture trả về (mặc định 2) — dùng để kiểm chứng số trang. */
  assignmentsTotal?: number;
  /** Dòng gán thường trỏ tới người dùng không còn tồn tại (tên/email null). */
  nullUserRow?: boolean;
  /** Bảng gán phân trang động: tạo đúng số dòng này, GET cắt theo trang/cỡ trang, DELETE trừ thật khỏi danh sách. */
  pagedAssignmentsTotal?: number;
  /** Danh sách người dùng phân trang động: tạo đúng số người này, GET lọc theo từ khoá rồi cắt theo trang/cỡ trang. */
  pagedUsersTotal?: number;
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
    expect(screen.getByText(/Đọc: 2/)).toBeInTheDocument();
    expect(screen.getByText(/Ghi: 1/)).toBeInTheDocument();
    expect(screen.getByText('Tổng: 2 resource')).toBeInTheDocument();
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
});

describe('Trang vai trò — bảng gán vai (đợt 3, #547)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  /** Mở hộp thoại gán từ bảng và chọn người dùng annguyen trong danh sách tìm kiếm. */
  async function openAssignDialog() {
    await userEvent.click(screen.getByRole('button', { name: 'Gán vai trò' }));
    const dialog = await screen.findByRole('dialog', { name: 'Gán vai trò' });
    const userButton = await within(dialog).findByRole('button', { name: /annguyen/ });
    await userEvent.click(userButton);
    return dialog;
  }

  it('hiện đủ cột, dòng enrol-managed không có nút gỡ mà hiện lý do', async () => {
    stubFetch([]);
    renderPage();

    await screen.findByText('An Nguyễn');
    const table = screen.getByRole('table');
    // Tiêu đề cột đúng đặc tả, không có cột Plan/Billing.
    for (const header of ['Người dùng', 'Vai trò', 'Ngữ cảnh', 'Ngày gán', 'Thao tác']) {
      expect(within(table).getByText(header)).toBeInTheDocument();
    }
    expect(within(table).queryByText('Plan')).not.toBeInTheDocument();
    expect(within(table).queryByText('Billing')).not.toBeInTheDocument();
    // Cả hai dòng đều mang tên vai trò phân giải từ danh sách vai.
    expect(within(table).getAllByText('Giáo viên')).toHaveLength(2);
    // Nhãn ngữ cảnh kèm cấp của từng dòng.
    expect(within(table).getByText('cấp 10 · thực thể 0 · /1')).toBeInTheDocument();
    expect(within(table).getByText('cấp 20 · thực thể 1 · /1/2')).toBeInTheDocument();
    // Chỉ dòng thường có nút gỡ; dòng enrol-managed hiện lý do thay cho nút.
    expect(within(table).getAllByRole('button', { name: 'Gỡ gán' })).toHaveLength(1);
    expect(within(table).getByText('Không gỡ trực tiếp được — gỡ bằng cách rút ghi danh')).toBeInTheDocument();
    expect(screen.getByText('Tổng: 2 dòng gán')).toBeInTheDocument();
    // Bảng không có nút Export/Import.
    expect(screen.queryByText(/Export/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Import/)).not.toBeInTheDocument();
  });

  it('lọc theo vai trò và ngữ cảnh, tìm kiếm, đổi cỡ trang và chuyển trang đều gửi tham số lên server', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { assignmentsTotal: 25 });
    renderPage();

    await screen.findByText('An Nguyễn');
    const assignmentsCalls = () =>
      calls.filter((c) => c.url.startsWith('/api/v1/access/assignments') && c.method === 'GET');

    await userEvent.type(screen.getByLabelText('Tìm người dùng'), 'An');
    await waitFor(() => expect(assignmentsCalls().some((c) => c.url.includes('search=An'))).toBe(true));

    await userEvent.selectOptions(screen.getByLabelText('Lọc theo vai trò'), ROLE_ID);
    await waitFor(() => expect(assignmentsCalls().some((c) => c.url.includes(`roleId=${ROLE_ID}`))).toBe(true));

    await userEvent.selectOptions(screen.getByLabelText('Lọc theo ngữ cảnh'), TENANT_CONTEXT_ID);
    await waitFor(() =>
      expect(assignmentsCalls().some((c) => c.url.includes(`contextId=${TENANT_CONTEXT_ID}`))).toBe(true),
    );

    await userEvent.selectOptions(screen.getByLabelText('Số dòng mỗi trang'), '10');
    await waitFor(() => expect(assignmentsCalls().some((c) => c.url.includes('pageSize=10'))).toBe(true));
    // Tổng 25 dòng với cỡ trang 10 thành 3 trang: nút chuyển trang hiện ra.
    expect(screen.getByText('Trang 1 / 3')).toBeInTheDocument();
    // Bảng có hai nút mang tên 'Sau' (tới trang kế và tới trang cuối, nút
    // cuối ẩn bằng class responsive mà jsdom không tính) nên bấm nút đầu.
    await userEvent.click(screen.getAllByRole('button', { name: 'Sau' })[0]);
    await waitFor(() => expect(assignmentsCalls().some((c) => c.url.includes('page=2'))).toBe(true));
    expect(screen.getByText('Trang 2 / 3')).toBeInTheDocument();
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
    expect(within(dialog).getByText(/Gỡ vai trò “Giáo viên” của An Nguyễn tại cấp 10/)).toBeInTheDocument();
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
    const table = screen.getByRole('table');
    expect(within(table).getByText('Người dùng không còn tồn tại')).toBeInTheDocument();
  });

  it('gỡ dòng duy nhất của trang cuối thì bảng tự về trang hợp lệ cuối cùng thay vì kẹt ở trang rỗng', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { pagedAssignmentsTotal: 21 });
    renderPage();

    await screen.findByText('Người dùng 1');
    expect(screen.getByText('Trang 1 / 2')).toBeInTheDocument();
    // Sang trang 2: chỉ còn dòng 21.
    await userEvent.click(screen.getAllByRole('button', { name: 'Sau' })[0]);
    await waitFor(() => expect(screen.getByText('Trang 2 / 2')).toBeInTheDocument());
    expect(screen.getByText('Người dùng 21')).toBeInTheDocument();
    // Gỡ dòng duy nhất của trang 2 rồi xác nhận.
    await userEvent.click(screen.getByRole('button', { name: 'Gỡ gán' }));
    const dialog = await screen.findByRole('dialog', { name: 'Gỡ gán vai trò' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gỡ gán' }));
    // Tổng còn 20 dòng (1 trang): bảng tự về trang 1, không kẹt 'Trang 2 / 1' rỗng.
    await waitFor(() => expect(screen.getByText('Trang 1 / 1')).toBeInTheDocument());
    expect(screen.getByText('Người dùng 1')).toBeInTheDocument();
    expect(screen.queryByText('Trang 2 / 1')).not.toBeInTheDocument();
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
    await userEvent.click(screen.getByRole('button', { name: 'Gán vai trò' }));
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
});

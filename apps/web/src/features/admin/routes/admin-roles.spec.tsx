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
 * nhận xoá hiển thị đúng lý do backend chặn.
 *
 * Giữ lại hai kiểm chứng F-01 cũ: ba danh sách (vai / capability /
 * context) là ba query TanStack, và mutation gán vai làm mới các truy
 * vấn access sau POST.
 */
const ROLE_ID = '01900000-0000-7000-8000-0000000000b1';
const NEW_ROLE_ID = '01900000-0000-7000-8000-0000000000b2';
const SYSTEM_CONTEXT_ID = '01900000-0000-7000-8000-000000000010';
const TENANT_CONTEXT_ID = '01900000-0000-7000-8000-000000000020';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

interface StubOptions {
  /** DELETE /access/roles/:id trả về mã lỗi này thay vì thành công. */
  deleteErrorCode?: string;
}

function stubFetch(calls: RecordedCall[], options: StubOptions = {}) {
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
            archetype: 'editingteacher',
            userCount: 5,
            overrideCount: 3,
            readOverrideCount: 2,
            writeOverrideCount: 1,
            resourceCount: 2,
          },
        ]);
      if (url === '/api/v1/access/capabilities')
        return respond([
          { id: '01900000-0000-7000-8000-0000000000c1', name: 'course:view', capType: 'read', contextLevel: 50, component: 'core' },
          { id: '01900000-0000-7000-8000-0000000000c2', name: 'course:edit', capType: 'write', contextLevel: 50, component: 'core' },
          { id: '01900000-0000-7000-8000-0000000000c3', name: 'user:view', capType: 'read', contextLevel: 30, component: 'core' },
        ]);
      if (url === '/api/v1/access/contexts')
        return respond([
          { id: SYSTEM_CONTEXT_ID, contextLevel: 10, instanceId: '0', path: '/1' },
          { id: TENANT_CONTEXT_ID, contextLevel: 20, instanceId: '1', path: '/1/2' },
        ]);
      if (url === '/api/v1/access/assignments' && method === 'POST') return respond({});
      if (url === `/api/v1/access/roles/${ROLE_ID}/capabilities` && method === 'GET')
        return respond([
          { roleId: ROLE_ID, capability: 'course:view', contextId: SYSTEM_CONTEXT_ID, permission: -1 },
          { roleId: ROLE_ID, capability: 'course:edit', contextId: TENANT_CONTEXT_ID, permission: 1 },
        ]);
      if (url === '/api/v1/access/roles' && method === 'POST')
        return respond({ id: NEW_ROLE_ID, name: 'Vai trò mới', shortName: 'newrole', description: '', archetype: null });
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

    expect(await screen.findByText('Giáo viên')).toBeInTheDocument();
    expect(screen.getByText('5 người dùng')).toBeInTheDocument();
    expect(screen.getByText(/Đọc: 2/)).toBeInTheDocument();
    expect(screen.getByText(/Ghi: 1/)).toBeInTheDocument();
    expect(screen.getByText('Tổng: 2 resource')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Thêm vai trò mới' })).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/v1/access/roles')).toBe(true);
    expect(calls.some((c) => c.url === '/api/v1/access/capabilities')).toBe(true);
    expect(calls.some((c) => c.url === '/api/v1/access/contexts')).toBe(true);
  });

  it('gán vai POST tới /access/assignments và làm mới các query access', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    await screen.findByText('Giáo viên');
    const roleLoadsBefore = calls.filter((c) => c.url === '/api/v1/access/roles' && c.method === 'GET').length;
    await userEvent.type(screen.getByLabelText('ID người dùng'), '123');
    await userEvent.click(screen.getByRole('button', { name: 'Gán vai trò' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/access/assignments' && c.method === 'POST')).toBe(true),
    );
    const post = calls.find((c) => c.url === '/api/v1/access/assignments');
    expect(post?.body).toMatchObject({ userId: '123', contextId: SYSTEM_CONTEXT_ID });
    // Sau đột biến, truy vấn access được làm mới (danh sách vai tải lại).
    await waitFor(() =>
      expect(calls.filter((c) => c.url === '/api/v1/access/roles' && c.method === 'GET').length).toBeGreaterThan(
        roleLoadsBefore,
      ),
    );
  });

  it('tạo vai trò mới qua thẻ thêm rồi lưu ma trận bằng đúng một lần gọi thay toàn bộ', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    await screen.findByText('Giáo viên');
    await userEvent.click(screen.getByRole('button', { name: 'Thêm vai trò mới' }));
    const dialog = await screen.findByRole('dialog', { name: 'Thêm vai trò mới' });
    await userEvent.type(within(dialog).getByLabelText('Tên vai trò'), 'Vai trò mới');
    await userEvent.type(within(dialog).getByLabelText('Tên ngắn (shortName)'), 'newrole');
    await userEvent.selectOptions(within(dialog).getByLabelText('Ngữ cảnh'), SYSTEM_CONTEXT_ID);
    // Chỉ một ô khác kế thừa: course:view thành Cho phép; các ô còn lại giữ Kế thừa nên không vào tập gửi lên.
    await userEvent.selectOptions(within(dialog).getByLabelText('course:view'), '1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu vai trò' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/access/roles' && c.method === 'POST')).toBe(true),
    );
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.url === `/api/v1/access/roles/${NEW_ROLE_ID}/capabilities` && c.method === 'PUT',
        ),
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

    await screen.findByText('Giáo viên');
    await openEditDialog();
    const dialog = screen.getByRole('dialog', { name: 'Sửa vai trò' });
    // Ngữ cảnh hệ thống mặc định: course:view đã lưu Ngăn chặn (−1).
    await waitFor(() =>
      expect((within(dialog).getByLabelText('course:view') as HTMLSelectElement).value).toBe('-1'),
    );
    // Chuyển sang ngữ cảnh trung tâm: course:view không có ghi đè ở đó nên về Kế thừa, course:edit giữ Cho phép.
    await userEvent.selectOptions(within(dialog).getByLabelText('Ngữ cảnh'), TENANT_CONTEXT_ID);
    await waitFor(() =>
      expect((within(dialog).getByLabelText('course:view') as HTMLSelectElement).value).toBe('0'),
    );
    expect((within(dialog).getByLabelText('course:edit') as HTMLSelectElement).value).toBe('1');
    // Lưu ở ngữ cảnh trung tâm: một PATCH tên/mô tả rồi đúng một PUT cho ngữ cảnh đó.
    await userEvent.selectOptions(within(dialog).getByLabelText('course:view'), '-1000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu vai trò' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/access/roles/${ROLE_ID}/capabilities` && c.method === 'PUT'),
      ).toBe(true),
    );
    const put = calls.find((c) => c.url === `/api/v1/access/roles/${ROLE_ID}/capabilities` && c.method === 'PUT');
    expect(put?.body).toEqual({
      contextId: TENANT_CONTEXT_ID,
      overrides: [
        { capability: 'course:edit', permission: 1 },
        { capability: 'course:view', permission: -1000 },
      ],
    });
  });

  it('chọn nhanh toàn cục áp đúng trạng thái cho mọi ô rồi lưu qua một lần gọi thay toàn bộ', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    await screen.findByText('Giáo viên');
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

    await screen.findByText('Giáo viên');
    await userEvent.click(screen.getByRole('button', { name: 'Thêm vai trò mới' }));
    const dialog = await screen.findByRole('dialog', { name: 'Thêm vai trò mới' });
    await userEvent.type(within(dialog).getByLabelText('Tên vai trò'), 'Vai trò mới');
    await userEvent.type(within(dialog).getByLabelText('Tên ngắn (shortName)'), 'newrole');
    await userEvent.selectOptions(within(dialog).getByLabelText('Ngữ cảnh'), SYSTEM_CONTEXT_ID);
    await userEvent.selectOptions(within(dialog).getByLabelText('Chọn nhanh cho nhóm course'), '1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Áp cho hàng' }));
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

  it('xoá vai trò bị backend chặn thì hiển thị đúng lý do và giữ nguyên vai trò', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { deleteErrorCode: 'access.role_has_assignments' });
    renderPage();

    await screen.findByText('Giáo viên');
    await userEvent.click(screen.getByRole('button', { name: 'Thao tác với vai trò' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Xoá vai trò' }));
    const dialog = await screen.findByRole('dialog', { name: 'Xoá vai trò' });
    expect(within(dialog).getByText(/Xoá vai trò “Giáo viên”/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xoá vai trò' }));
    await waitFor(() =>
      expect(screen.getByText('Vai trò vẫn còn người giữ nên không xoá được.')).toBeInTheDocument(),
    );
    // Hộp thoại vẫn mở, vai trò vẫn trên lưới.
    expect(screen.getByRole('dialog', { name: 'Xoá vai trò' })).toBeInTheDocument();
    expect(screen.getByText('Giáo viên')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('xoá vai trò thường không còn người giữ thì thành công và hộp thoại đóng', async () => {
    stubFetch([]);
    renderPage();

    await screen.findByText('Giáo viên');
    await userEvent.click(screen.getByRole('button', { name: 'Thao tác với vai trò' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Xoá vai trò' }));
    const dialog = await screen.findByRole('dialog', { name: 'Xoá vai trò' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xoá vai trò' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

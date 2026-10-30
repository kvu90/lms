import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { AdminPermissionsPage } from './admin-permissions';

/**
 * Spec trang Permissions độc lập (issue #570): bảng chuyển vị dựng từ
 * ĐÚNG MỘT lần gọi ma trận toàn trang theo ngữ cảnh (không gọi ma
 * trận riêng cho từng vai), ba thẻ tổng quan đếm đúng tại ngữ cảnh
 * đang chọn, sửa từng ô áp dụng ngay qua đúng một lần gọi ghi từng
 * ô, ghi lỗi thì ô hoàn lại kèm thông báo, đổi ngữ cảnh thì tải lại
 * ma trận của ngữ cảnh mới, và ma trận chưa tải xong thì không có ô
 * nào sửa được. Stub giữ kho ma trận theo ngữ cảnh để các lần gọi
 * POST đổi thật dữ kiện mà lần gọi GET sau đó trả về.
 */
const ROLE_A_ID = '01900000-0000-7000-8000-0000000000b1';
const ROLE_B_ID = '01900000-0000-7000-8000-0000000000b2';
const SYSTEM_CONTEXT_ID = '01900000-0000-7000-8000-000000000010';
const TENANT_CONTEXT_ID = '01900000-0000-7000-8000-000000000020';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

interface StubOptions {
  /** Ma trận treo mãi không về (ca chặn sửa khi chưa tải xong). */
  matrixBehavior?: 'pending';
  /** POST /access/overrides luôn trả lỗi 500 (ca hoàn lại khi ghi lỗi). */
  postError?: boolean;
}

/** Kho ghi đè theo ngữ cảnh, khởi tạo lại mỗi lần stub. */
function initialStore(): Record<string, Record<string, Record<string, number>>> {
  return {
    [SYSTEM_CONTEXT_ID]: {
      [ROLE_A_ID]: { 'course:view': 1 },
    },
    [TENANT_CONTEXT_ID]: {
      [ROLE_A_ID]: { 'course:edit': 1 },
      [ROLE_B_ID]: { 'course:view': 1 },
    },
  };
}

function stubFetch(calls: RecordedCall[], options: StubOptions = {}) {
  const store = initialStore();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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
      if (url.startsWith('/api/v1/access/capability-matrix') && method === 'GET') {
        if (options.matrixBehavior === 'pending') return new Promise<Response>(() => {});
        const contextId = new URLSearchParams(url.split('?')[1] ?? '').get('contextId') ?? '';
        const roles = [
          { id: ROLE_A_ID, name: 'Giáo viên', userCount: 5 },
          { id: ROLE_B_ID, name: 'Quản trị viên', userCount: 2 },
        ];
        return respond({
          contextId,
          roles: roles.map((role) => ({
            ...role,
            overrides: Object.entries(store[contextId]?.[role.id] ?? {}).map(([capability, permission]) => ({
              capability,
              permission,
            })),
          })),
        });
      }
      if (url === '/api/v1/access/overrides' && method === 'POST') {
        if (options.postError)
          return respond({ type: 'about:blank', title: 'Không ghi được ô', status: 500 }, 500);
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          roleId: string;
          capability: string;
          contextId: string;
          permission: number;
        };
        const contextStore = (store[body.contextId] ??= {});
        const roleStore = (contextStore[body.roleId] ??= {});
        if (body.permission === 0) delete roleStore[body.capability];
        else roleStore[body.capability] = body.permission;
        return respond({ updated: true });
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/admin/permissions', element: <AdminPermissionsPage /> }], {
    initialEntries: ['/admin/permissions'],
  });
  render(
    <TestProviders>
      <RouterProvider router={router} />
    </TestProviders>,
  );
}

/** Ô select bốn trạng thái của một cặp vai trò × năng lực. */
function cellSelect(roleName: string, capability: string) {
  return screen.getByRole('combobox', { name: `Quyền ${capability} của vai trò ${roleName}` });
}

describe('Trang Permissions độc lập — bảng chuyển vị và ghi từng ô (#570)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('hiện đủ nhóm resource, hàng năng lực và cột vai trò kèm số người giữ, thẻ đếm đúng tại ngữ cảnh hệ thống', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    await screen.findByRole('combobox', { name: 'Quyền course:view của vai trò Giáo viên' });
    // Ma trận toàn trang chỉ gọi đúng một lần cho ngữ cảnh hệ thống,
    // không gọi ma trận riêng cho từng vai.
    const matrixCalls = calls.filter((call) => call.url.startsWith('/api/v1/access/capability-matrix'));
    expect(matrixCalls).toHaveLength(1);
    expect(matrixCalls[0]?.url).toContain(`contextId=${SYSTEM_CONTEXT_ID}`);
    // Hai nhóm resource, ba hàng năng lực.
    expect(screen.getByText('course')).toBeInTheDocument();
    expect(screen.getByText('user')).toBeInTheDocument();
    for (const capability of ['course:view', 'course:edit', 'user:view']) {
      expect(screen.getByText(capability)).toBeInTheDocument();
    }
    // Tiêu đề cột vai trò kèm số người giữ phân biệt.
    expect(screen.getByText('Giáo viên')).toBeInTheDocument();
    expect(screen.getByText('5 người dùng')).toBeInTheDocument();
    expect(screen.getByText('Quản trị viên')).toBeInTheDocument();
    expect(screen.getByText('2 người dùng')).toBeInTheDocument();
    // Ba thẻ: 2 vai trò, 2 resource, 1 ô Cho phép tại ngữ cảnh hệ thống.
    expect(screen.getByText('Vai trò')).toBeInTheDocument();
    expect(screen.getByText('Tài nguyên')).toBeInTheDocument();
    expect(screen.getByText('Quyền đang cho phép')).toBeInTheDocument();
    const cards = document.querySelectorAll('[data-slot="card"]');
    expect(cards.length).toBeGreaterThanOrEqual(3);
    // Ô đã lưu Cho phép hiện đúng giá trị, ô chưa có ghi đè hiện Kế thừa.
    expect(cellSelect('Giáo viên', 'course:view')).toHaveValue('1');
    expect(cellSelect('Quản trị viên', 'course:view')).toHaveValue('0');
  });

  it('đổi một ô gọi đúng một lần POST ghi từng ô với thân đúng và thẻ Cho phép tăng ngay 1, đổi khỏi Cho phép giảm ngay 1', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    const cell = await screen.findByRole('combobox', { name: 'Quyền course:edit của vai trò Giáo viên' });
    await userEvent.selectOptions(cell, '1');
    await waitFor(() => {
      expect(calls.filter((call) => call.url === '/api/v1/access/overrides' && call.method === 'POST')).toHaveLength(1);
    });
    expect(calls.filter((call) => call.url === '/api/v1/access/overrides')[0]?.body).toEqual({
      roleId: ROLE_A_ID,
      capability: 'course:edit',
      contextId: SYSTEM_CONTEXT_ID,
      permission: 1,
    });
    // Thẻ Cho phép tăng từ 1 lên 2 ngay khi đổi ô, không cần tải lại.
    const allowCard = screen.getByText('Quyền đang cho phép').closest('[data-slot="card"]');
    expect(within(allowCard as HTMLElement).getByText('2')).toBeInTheDocument();
    // Đổi ô Cho phép sẵn có sang Ngăn chặn thì thẻ giảm ngay về 1.
    const allowCell = cellSelect('Giáo viên', 'course:view');
    await userEvent.selectOptions(allowCell, '-1');
    await waitFor(() => {
      expect(calls.filter((call) => call.url === '/api/v1/access/overrides' && call.method === 'POST')).toHaveLength(2);
    });
    expect(within(allowCard as HTMLElement).getByText('1')).toBeInTheDocument();
  });

  it('ghi ô lỗi thì ô hoàn lại giá trị cũ và hiện thông báo lỗi', async () => {
    stubFetch([], { postError: true });
    renderPage();

    const cell = await screen.findByRole('combobox', { name: 'Quyền course:edit của vai trò Giáo viên' });
    expect(cell).toHaveValue('0');
    await userEvent.selectOptions(cell, '1');
    await screen.findByText('Không lưu được ô này — giá trị đã hoàn lại.');
    expect(cellSelect('Giáo viên', 'course:edit')).toHaveValue('0');
  });

  it('đổi ngữ cảnh thì tải lại ma trận của ngữ cảnh mới và thẻ cập nhật theo', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    await screen.findByRole('combobox', { name: 'Quyền course:view của vai trò Giáo viên' });
    expect(cellSelect('Giáo viên', 'course:view')).toHaveValue('1');
    const picker = screen.getByLabelText('Ngữ cảnh');
    await userEvent.selectOptions(picker, TENANT_CONTEXT_ID);
    await waitFor(() => {
      expect(
        calls.filter((call) => call.url.startsWith('/api/v1/access/capability-matrix')),
      ).toHaveLength(2);
    });
    expect(
      calls.filter((call) => call.url.startsWith('/api/v1/access/capability-matrix'))[1]?.url,
    ).toContain(`contextId=${TENANT_CONTEXT_ID}`);
    // Ma trận ngữ cảnh mới: course:view của Giáo viên về Kế thừa,
    // course:edit của Giáo viên và course:view của Quản trị viên là
    // Cho phép — thẻ Cho phép thành 2.
    expect(cellSelect('Giáo viên', 'course:view')).toHaveValue('0');
    expect(cellSelect('Giáo viên', 'course:edit')).toHaveValue('1');
    expect(cellSelect('Quản trị viên', 'course:view')).toHaveValue('1');
    const allowCard = screen.getByText('Quyền đang cho phép').closest('[data-slot="card"]');
    expect(within(allowCard as HTMLElement).getByText('2')).toBeInTheDocument();
  });

  it('ma trận chưa tải xong thì không có ô nào sửa được', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { matrixBehavior: 'pending' });
    renderPage();

    // Danh mục và cây context đã về nhưng ma trận vẫn treo: trang vẫn
    // ở trạng thái chờ, không hiện ô select hay bộ chọn ngữ cảnh nào.
    await waitFor(() => {
      expect(calls.filter((call) => call.url.startsWith('/api/v1/access/capability-matrix'))).toHaveLength(1);
    });
    expect(screen.getByRole('heading', { name: 'Quyền' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('đặt ô về Kế thừa rồi tải lại trang thì ô không còn ghi đè', async () => {
    stubFetch([]);
    renderPage();

    const cell = await screen.findByRole('combobox', { name: 'Quyền course:view của vai trò Giáo viên' });
    expect(cell).toHaveValue('1');
    await userEvent.selectOptions(cell, '0');
    await waitFor(() => {
      expect(cellSelect('Giáo viên', 'course:view')).toHaveValue('0');
    });
    // Tải lại trang từ đầu (QueryClient mới, không còn sửa đổi lạc
    // quan): ô vẫn là Kế thừa vì dòng ghi đè đã bị xoá phía server.
    cleanup();
    renderPage();
    const reloaded = await screen.findByRole('combobox', { name: 'Quyền course:view của vai trò Giáo viên' });
    expect(reloaded).toHaveValue('0');
  });
});

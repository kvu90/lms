import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { AdminPermissionsPage } from './admin-permissions';

/**
 * Spec trang Quyền độc lập (issue #597, bề mặt 4): bảng ma trận toàn
 * trang dựng từ ĐÚNG MỘT lần gọi ma trận theo ngữ cảnh (không gọi ma
 * trận riêng cho từng vai), ba thẻ tổng quan đếm đúng tại ngữ cảnh
 * đang chọn (thẻ Cho phép đếm trực tiếp từ các ô đang hiển thị), sửa
 * từng ô áp dụng ngay qua đúng một lần gọi ghi từng ô, ghi lỗi thì ô
 * hoàn lại kèm thông báo, đổi ngữ cảnh thì tải lại ma trận của ngữ
 * cảnh mới, và ma trận chưa tải xong thì không có ô nào sửa được.
 * Nhãn của bộ chọn ngữ cảnh là tên cấp dạng chữ qua adapter (Hệ
 * thống / Trung tâm). Stub giữ kho ma trận theo ngữ cảnh để các lần
 * gọi POST đổi thật dữ kiện mà lần gọi GET sau đó trả về.
 *
 * Vòng sửa theo phán quyết điều phối (PR #601): ghi ô thành công thì
 * nháp của lần ghi đó bị xoá để giá trị mới từ server hiện lên thay
 * vì bị nháp cũ che; nháp mang cả ngữ cảnh của lần ghi nên lỗi muộn
 * của ngữ cảnh cũ không xoá nháp mới ở ngữ cảnh mới dù trùng giá trị.
 *
 * Vòng sửa 3 theo phán quyết 6539398880 (hình dạng demo, dữ kiện
 * thật): ô select bốn trạng thái thay bằng nút toggle icon hai trạng
 * thái (bật = Cho phép, tắt = Kế thừa); ô đang mang Ngăn chặn/Cấm
 * hẳn đã lưu thì toggle bị khoá kèm huy hiệu trạng thái và không
 * thao tác nào ghi đè được — fixture mang sẵn một ô Cấm hẳn ở ngữ
 * cảnh hệ thống và một ô Ngăn chặn ở ngữ cảnh trung tâm để ghim
 * hành vi này.
 *
 * Vòng sửa bố cục (PR #601): bảng gom mỗi resource thành đúng MỘT
 * hàng như bảng mẫu — ô của một (resource × vai trò) chứa các nút
 * toggle của mọi năng lực thuộc resource đó cạnh nhau, tên năng
 * lực truy được qua aria-label và title của nút thay vì một hàng
 * riêng cho từng năng lực. Mọi hành vi ghi từng ô, hoàn lại khi
 * lỗi và khoá ô chặn đã ghim ở các vòng trước giữ nguyên.
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
  /** POST /access/overrides treo chờ điều khiển tay (ca đổi ngữ cảnh khi lưu còn chờ). */
  onPostDeferred?: (controls: {
    resolvePost: () => void;
    rejectPost: (reason?: unknown) => void;
  }) => void;
  /** Ghi đè kho sau khi POST ghi từng ô áp dụng xong (mô phỏng quản trị viên khác đổi cùng ô). */
  afterPostApply?: (store: Record<string, Record<string, Record<string, number>>>) => void;
}

/** Kho ghi đè theo ngữ cảnh, khởi tạo lại mỗi lần stub. */
function initialStore(): Record<string, Record<string, Record<string, number>>> {
  return {
    [SYSTEM_CONTEXT_ID]: {
      [ROLE_A_ID]: { 'course:view': 1 },
      [ROLE_B_ID]: { 'user:view': -1000 },
    },
    [TENANT_CONTEXT_ID]: {
      [ROLE_A_ID]: { 'course:edit': 1, 'user:view': -1 },
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
        const applyAndRespond = () => {
          const contextStore = (store[body.contextId] ??= {});
          const roleStore = (contextStore[body.roleId] ??= {});
          if (body.permission === 0) delete roleStore[body.capability];
          else roleStore[body.capability] = body.permission;
          options.afterPostApply?.(store);
          return respond({ updated: true });
        };
        if (options.onPostDeferred) {
          return new Promise<Response>((resolve, reject) => {
            options.onPostDeferred!({
              resolvePost: () => resolve(applyAndRespond()),
              rejectPost: (reason) => reject(reason ?? new Error('Lỗi ghi ô')),
            });
          });
        }
        return applyAndRespond();
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

/** Nút toggle của một cặp vai trò × năng lực; trạng thái bật/tắt đọc ở thuộc tính aria-pressed. */
function cellToggle(roleName: string, capability: string) {
  return screen.getByRole('button', { name: `Quyền ${capability} của vai trò ${roleName}` });
}

describe('Trang Quyền độc lập — ma trận toàn trang và ghi từng ô', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('hiện đủ hàng resource, cột vai trò kèm số người giữ và mọi ô năng lực, thẻ đếm đúng tại ngữ cảnh hệ thống', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    await screen.findByRole('button', { name: 'Quyền course:view của vai trò Giáo viên' });
    // Ma trận toàn trang chỉ gọi đúng một lần cho ngữ cảnh hệ thống,
    // không gọi ma trận riêng cho từng vai.
    const matrixCalls = calls.filter((call) => call.url.startsWith('/api/v1/access/capability-matrix'));
    expect(matrixCalls).toHaveLength(1);
    expect(matrixCalls[0]?.url).toContain(`contextId=${SYSTEM_CONTEXT_ID}`);
    // Hai hàng resource (mỗi resource một hàng như bảng mẫu); năng
    // lực không còn là một hàng riêng — tên của nó nằm ở aria-label
    // và title của nút toggle trong ô của hàng resource, đủ 6 cặp
    // vai trò × năng lực đều có đúng một nút.
    expect(screen.getByText('course')).toBeInTheDocument();
    expect(screen.getByText('user')).toBeInTheDocument();
    for (const roleName of ['Giáo viên', 'Quản trị viên']) {
      for (const capability of ['course:view', 'course:edit', 'user:view']) {
        expect(cellToggle(roleName, capability)).toBeInTheDocument();
        expect(cellToggle(roleName, capability)).toHaveAttribute('title', capability);
      }
    }
    // Bảng chỉ còn đúng hai hàng thân (một hàng mỗi resource) cộng hàng tiêu đề.
    expect(screen.getAllByRole('row')).toHaveLength(3);
    // Tiêu đề cột đầu của bảng là "Tài nguyên" — cột đó chứa tên
    // resource của từng hàng, không mang nhãn năng lực.
    expect(screen.getByRole('columnheader', { name: 'Tài nguyên' })).toBeInTheDocument();
    // Tiêu đề cột vai trò kèm số người giữ phân biệt.
    expect(screen.getByText('Giáo viên')).toBeInTheDocument();
    expect(screen.getByText('5 người dùng')).toBeInTheDocument();
    expect(screen.getByText('Quản trị viên')).toBeInTheDocument();
    expect(screen.getByText('2 người dùng')).toBeInTheDocument();
    // Ba thẻ: 2 vai trò, 2 resource, 1 ô Cho phép tại ngữ cảnh hệ thống.
    expect(screen.getByText('Vai trò')).toBeInTheDocument();
    // "Tài nguyên" xuất hiện đúng hai lần trên trang: tiêu đề cột
    // đầu của bảng (đã khẳng định theo role ở trên) và nhãn của thẻ
    // tổng kết số resource ở đây.
    expect(screen.getAllByText('Tài nguyên')).toHaveLength(2);
    expect(screen.getByText('Quyền đang cho phép')).toBeInTheDocument();
    const cards = document.querySelectorAll('[data-slot="card"]');
    expect(cards.length).toBeGreaterThanOrEqual(3);
    // Ô đã lưu Cho phép hiện toggle đang bật, ô chưa có ghi đè hiện toggle đang tắt.
    expect(cellToggle('Giáo viên', 'course:view')).toHaveAttribute('aria-pressed', 'true');
    expect(cellToggle('Quản trị viên', 'course:view')).toHaveAttribute('aria-pressed', 'false');
  });

  it('bật một ô gọi đúng một lần POST ghi từng ô với thân Cho phép và thẻ Cho phép tăng ngay 1, tắt ô Cho phép thì ghi Kế thừa và thẻ giảm ngay 1', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    const cell = await screen.findByRole('button', { name: 'Quyền course:edit của vai trò Giáo viên' });
    expect(cell).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(cell);
    await waitFor(() => {
      expect(calls.filter((call) => call.url === '/api/v1/access/overrides' && call.method === 'POST')).toHaveLength(1);
    });
    expect(calls.filter((call) => call.url === '/api/v1/access/overrides')[0]?.body).toEqual({
      roleId: ROLE_A_ID,
      capability: 'course:edit',
      contextId: SYSTEM_CONTEXT_ID,
      permission: 1,
    });
    // Thẻ Cho phép tăng từ 1 lên 2 ngay khi bật ô, không cần tải lại.
    const allowCard = screen.getByText('Quyền đang cho phép').closest('[data-slot="card"]');
    expect(within(allowCard as HTMLElement).getByText('2')).toBeInTheDocument();
    // Tắt ô Cho phép sẵn có thì ghi Kế thừa (0) và thẻ giảm ngay về 1.
    const allowCell = cellToggle('Giáo viên', 'course:view');
    await userEvent.click(allowCell);
    await waitFor(() => {
      expect(calls.filter((call) => call.url === '/api/v1/access/overrides' && call.method === 'POST')).toHaveLength(2);
    });
    expect(calls.filter((call) => call.url === '/api/v1/access/overrides')[1]?.body).toEqual({
      roleId: ROLE_A_ID,
      capability: 'course:view',
      contextId: SYSTEM_CONTEXT_ID,
      permission: 0,
    });
    expect(within(allowCard as HTMLElement).getByText('1')).toBeInTheDocument();
  });

  it('ghi ô lỗi thì ô hoàn lại giá trị cũ và hiện thông báo lỗi', async () => {
    stubFetch([], { postError: true });
    renderPage();

    const cell = await screen.findByRole('button', { name: 'Quyền course:edit của vai trò Giáo viên' });
    expect(cell).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(cell);
    await screen.findByText('Không lưu được ô này — giá trị đã hoàn lại.');
    expect(cellToggle('Giáo viên', 'course:edit')).toHaveAttribute('aria-pressed', 'false');
  });

  it('đổi ngữ cảnh thì tải lại ma trận của ngữ cảnh mới và thẻ cập nhật theo', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    await screen.findByRole('button', { name: 'Quyền course:view của vai trò Giáo viên' });
    expect(cellToggle('Giáo viên', 'course:view')).toHaveAttribute('aria-pressed', 'true');
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
    // Ma trận ngữ cảnh mới: course:view của Giáo viên về Kế thừa (toggle tắt),
    // course:edit của Giáo viên và course:view của Quản trị viên đang Cho phép
    // (toggle bật) — thẻ Cho phép thành 2.
    expect(cellToggle('Giáo viên', 'course:view')).toHaveAttribute('aria-pressed', 'false');
    expect(cellToggle('Giáo viên', 'course:edit')).toHaveAttribute('aria-pressed', 'true');
    expect(cellToggle('Quản trị viên', 'course:view')).toHaveAttribute('aria-pressed', 'true');
    const allowCard = screen.getByText('Quyền đang cho phép').closest('[data-slot="card"]');
    expect(within(allowCard as HTMLElement).getByText('2')).toBeInTheDocument();
  });

  it('đổi ngữ cảnh trong lúc lưu còn chờ thì ô cùng vị trí ở ngữ cảnh mới vẫn sửa được và lỗi muộn của ngữ cảnh cũ không hiện ở ngữ cảnh mới', async () => {
    const calls: RecordedCall[] = [];
    let postControls:
      | { resolvePost: () => void; rejectPost: (reason?: unknown) => void }
      | undefined;
    stubFetch(calls, {
      onPostDeferred: (controls) => {
        postControls = controls;
      },
    });
    renderPage();

    const cell = await screen.findByRole('button', { name: 'Quyền course:edit của vai trò Giáo viên' });
    expect(cell).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(cell);
    // Ô đang chờ ghi thì bị khoá tại ngữ cảnh hệ thống, và lần ghi
    // đã thực sự bay đi (treo chờ điều khiển tay).
    await waitFor(() => {
      expect(cellToggle('Giáo viên', 'course:edit')).toBeDisabled();
      expect(postControls).toBeDefined();
    });
    // Đổi sang ngữ cảnh tenant trong lúc lần ghi còn chờ: ô cùng vị
    // trí ở ngữ cảnh mới không bị khoá nhầm theo lần ghi cũ.
    const picker = screen.getByLabelText('Ngữ cảnh');
    await userEvent.selectOptions(picker, TENANT_CONTEXT_ID);
    await waitFor(() => {
      expect(
        calls.filter((call) => call.url.startsWith('/api/v1/access/capability-matrix')),
      ).toHaveLength(2);
    });
    const tenantCell = cellToggle('Giáo viên', 'course:edit');
    expect(tenantCell).not.toBeDisabled();
    expect(tenantCell).toHaveAttribute('aria-pressed', 'true');
    // Lỗi muộn của lần ghi ở ngữ cảnh hệ thống về sau khi đã đổi ngữ
    // cảnh: cho chuỗi xử lý lỗi chạy xong rồi mới khẳng định banner
    // không hiện sai chỗ.
    await act(async () => {
      postControls?.rejectPost(new Error('Lỗi ghi muộn'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText('Không lưu được ô này — giá trị đã hoàn lại.')).not.toBeInTheDocument();
    // Quay lại ngữ cảnh hệ thống: lần ghi đã lỗi nên ô hoàn về giá
    // trị đã lưu và không còn bị khoá. Ma trận hệ thống còn tươi
    // trong cache nên lần quay lại này không gọi lại server — chỉ
    // khẳng định giá trị hiển thị, không đếm lần gọi. Lưu ý: phải
    // tìm lại bộ chọn ngữ cảnh vì khối chứa nó đã tháo ra rồi gắn
    // lại trong lúc tải ma trận của ngữ cảnh mới (nút cũ đã rời cây).
    const pickerBack = screen.getByLabelText('Ngữ cảnh');
    await userEvent.selectOptions(pickerBack, SYSTEM_CONTEXT_ID);
    await waitFor(() => {
      expect(cellToggle('Giáo viên', 'course:edit')).toHaveAttribute('aria-pressed', 'false');
    });
    const systemCell = cellToggle('Giáo viên', 'course:edit');
    expect(systemCell).not.toBeDisabled();
  });

  it('ghi ô thành công thì xoá nháp để giá trị mới từ server hiện lên thay vì bị nháp cũ che', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, {
      afterPostApply: (store) => {
        // Quản trị viên khác đổi cùng ô ngay sau lần ghi của mình,
        // trước khi ma trận tải lại sau ghi thành công.
        const roleStore = store[SYSTEM_CONTEXT_ID]?.[ROLE_A_ID];
        if (roleStore) roleStore['course:view'] = 1;
      },
    });
    renderPage();

    const cell = await screen.findByRole('button', { name: 'Quyền course:view của vai trò Giáo viên' });
    expect(cell).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(cell);
    await waitFor(() => {
      expect(calls.filter((call) => call.url === '/api/v1/access/overrides' && call.method === 'POST')).toHaveLength(1);
    });
    expect(calls.filter((call) => call.url === '/api/v1/access/overrides')[0]?.body).toEqual({
      roleId: ROLE_A_ID,
      capability: 'course:view',
      contextId: SYSTEM_CONTEXT_ID,
      permission: 0,
    });
    // Ma trận làm mới sau ghi thành công trả về giá trị mới (Cho
    // phép): ô phải hiện đang bật, không giữ nháp cũ (đang tắt) che
    // mất giá trị mới.
    await waitFor(() => {
      expect(cellToggle('Giáo viên', 'course:view')).toHaveAttribute('aria-pressed', 'true');
    });
  });

  it('lỗi muộn của ngữ cảnh cũ không xoá nháp mới ở ngữ cảnh mới', async () => {
    const calls: RecordedCall[] = [];
    const posts: Array<{
      resolvePost: () => void;
      rejectPost: (reason?: unknown) => void;
    }> = [];
    stubFetch(calls, {
      onPostDeferred: (controls) => {
        posts.push(controls);
      },
    });
    renderPage();

    const systemCell = await screen.findByRole('button', { name: 'Quyền course:view của vai trò Giáo viên' });
    expect(systemCell).toHaveAttribute('aria-pressed', 'true');
    // Tắt ô ở ngữ cảnh hệ thống (ghi Kế thừa), treo chờ.
    await userEvent.click(systemCell);
    await waitFor(() => expect(posts).toHaveLength(1));
    // Đổi sang ngữ cảnh tenant: nháp cũ bị xoá theo hành vi gốc, ô
    // cùng vị trí hiện giá trị đã lưu tại ngữ cảnh mới (Kế thừa — đang tắt).
    const picker = screen.getByLabelText('Ngữ cảnh');
    await userEvent.selectOptions(picker, TENANT_CONTEXT_ID);
    await waitFor(() => {
      expect(
        calls.filter((call) => call.url.startsWith('/api/v1/access/capability-matrix')),
      ).toHaveLength(2);
    });
    const tenantCell = cellToggle('Giáo viên', 'course:view');
    expect(tenantCell).toHaveAttribute('aria-pressed', 'false');
    // Bật cùng ô ở ngữ cảnh mới (ghi Cho phép), treo chờ.
    await userEvent.click(tenantCell);
    await waitFor(() => expect(posts).toHaveLength(2));
    // Lỗi muộn của lần ghi ở ngữ cảnh hệ thống về: nháp mới ở tenant
    // phải còn nguyên, ô vẫn hiện đang bật, không hiện banner sai chỗ.
    await act(async () => {
      posts[0]?.rejectPost(new Error('Lỗi ghi muộn'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => {
      expect(cellToggle('Giáo viên', 'course:view')).toHaveAttribute('aria-pressed', 'true');
    });
    expect(screen.queryByText('Không lưu được ô này — giá trị đã hoàn lại.')).not.toBeInTheDocument();
    // Dọn lần ghi tenant còn treo để không rò rỉ promise qua cuối test.
    await act(async () => {
      posts[1]?.resolvePost();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  it('ma trận chưa tải xong thì không có ô nào sửa được', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, { matrixBehavior: 'pending' });
    renderPage();

    // Danh mục và cây context đã về nhưng ma trận vẫn treo: trang vẫn
    // ở trạng thái chờ, không hiện nút toggle hay bộ chọn ngữ cảnh nào.
    await waitFor(() => {
      expect(calls.filter((call) => call.url.startsWith('/api/v1/access/capability-matrix'))).toHaveLength(1);
    });
    expect(screen.getByRole('heading', { name: 'Quyền' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Quyền course:view của vai trò Giáo viên' }),
    ).not.toBeInTheDocument();
  });

  it('ô đang mang Cấm hẳn hoặc Ngăn chặn thì bị khoá kèm huy hiệu trạng thái và không thao tác nào ghi đè được', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    // Ngữ cảnh hệ thống: user:view của Quản trị viên đang Cấm hẳn (−1000).
    const prohibitCell = await screen.findByRole('button', {
      name: 'Quyền user:view của vai trò Quản trị viên',
    });
    expect(prohibitCell).toBeDisabled();
    expect(prohibitCell).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Cấm hẳn')).toBeInTheDocument();
    // Bấm vào ô khoá không phát sinh lần ghi nào.
    await userEvent.click(prohibitCell);
    expect(calls.filter((call) => call.url === '/api/v1/access/overrides')).toHaveLength(0);
    // Đổi sang ngữ cảnh trung tâm: user:view của Giáo viên đang Ngăn chặn (−1) — cũng khoá.
    const picker = screen.getByLabelText('Ngữ cảnh');
    await userEvent.selectOptions(picker, TENANT_CONTEXT_ID);
    const preventCell = await screen.findByRole('button', {
      name: 'Quyền user:view của vai trò Giáo viên',
    });
    expect(preventCell).toBeDisabled();
    expect(screen.getByText('Ngăn chặn')).toBeInTheDocument();
    await userEvent.click(preventCell);
    expect(calls.filter((call) => call.url === '/api/v1/access/overrides')).toHaveLength(0);
    // Ô thường ở cùng ngữ cảnh vẫn sửa được — khoá chỉ áp cho ô mang giá trị chặn.
    expect(cellToggle('Giáo viên', 'course:view')).not.toBeDisabled();
  });

  it('tắt ô về Kế thừa rồi tải lại trang thì ô không còn ghi đè', async () => {
    stubFetch([]);
    renderPage();

    const cell = await screen.findByRole('button', { name: 'Quyền course:view của vai trò Giáo viên' });
    expect(cell).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(cell);
    await waitFor(() => {
      expect(cellToggle('Giáo viên', 'course:view')).toHaveAttribute('aria-pressed', 'false');
    });
    // Tải lại trang từ đầu (QueryClient mới, không còn sửa đổi lạc
    // quan): ô vẫn đang tắt vì dòng ghi đè đã bị xoá phía server.
    cleanup();
    renderPage();
    const reloaded = await screen.findByRole('button', {
      name: 'Quyền course:view của vai trò Giáo viên',
    });
    expect(reloaded).toHaveAttribute('aria-pressed', 'false');
  });
});

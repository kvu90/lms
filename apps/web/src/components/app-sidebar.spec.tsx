import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import App from '../root';
import Shell from '../routes/shell';
import { queryClient } from '../lib/query-client';

/**
 * Test cho cây điều hướng sidebar sau Lát 1 của hồ sơ UI/UX (sidebar
 * collapse theo cơ chế sidebar-07): 6 mục trực tiếp + các mục cha
 * thu/mở (Học tập / Ngân hàng câu hỏi / Người dùng & quyền / Hệ thống
 * & dữ liệu) thay cho 3 nhóm phẳng cũ. Dựng đúng cây thật (App →
 * Shell → AppSidebar) như sidebar-notification-count.spec, stub fetch
 * theo vai trò:
 *
 * - Admin thấy đủ cây (4 mục cha); nhóm cha đóng mặc định, bấm mới mở
 *   mục con; các nhóm mở độc lập (không accordion).
 * - Trạng thái mở của nhóm lưu ở localStorage `lms:sidebar:open-groups`
 *   — "F5" (gỡ cây, dựng lại) vẫn giữ; nhóm chứa route đang xem thì
 *   luôn tự mở và mục con + nút cha cùng mang trạng thái active.
 * - Nhóm Ngân hàng câu hỏi (mở lại issue #70) đứng riêng ngay sau Học
 *   tập, gác canUseQuestionBank: 4 mục con liên kết sâu tới các khu
 *   vực của /questions (?bank=...); đang ở URL đích theo neo thì nhóm
 *   tự mở và đúng mục con đó active. Học viên không thấy nút cha này;
 *   giáo viên có capability câu hỏi thì thấy.
 * - Cookie `sidebar_state=false` → sidebar ở chế độ rail icon
 *   (data-collapsible="icon", có SidebarRail); bấm mục cha ở chế độ
 *   này bung sidebar ra và mở nhóm.
 */

const ADMIN_ID = '01900000-0000-7000-8000-0000000000a1';
const STUDENT_ID = '01900000-0000-7000-8000-0000000000b2';
const TEACHER_ID = '01900000-0000-7000-8000-0000000000c3';
const SYSTEM_CONTEXT_ID = '01900000-0000-7000-8000-0000000000d4';

function profileOf(id: string, username: string) {
  return {
    id,
    username,
    firstName: 'Tên',
    lastName: 'Mẫu',
    email: `${username}@example.com`,
    suspended: false,
    deleted: false,
    isGuest: false,
    forcePasswordChange: false,
    lastLogin: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    customFields: [],
  };
}

const ADMIN_ACCESS = { userId: ADMIN_ID, isSiteAdmin: true, assignments: [], contexts: [] };
const STUDENT_ACCESS = { userId: STUDENT_ID, isSiteAdmin: false, assignments: [], contexts: [] };
const TEACHER_ACCESS = {
  userId: TEACHER_ID,
  isSiteAdmin: false,
  assignments: [],
  contexts: [
    {
      contextId: SYSTEM_CONTEXT_ID,
      contextLevel: 10,
      contextPath: '/1',
      capabilities: ['question:add'],
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(profile: unknown, access: unknown, unread = 0) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/v1/users/me') return jsonResponse(profile);
      if (url === '/api/v1/users/me/capabilities') return jsonResponse(access);
      if (url === '/api/v1/courses') return jsonResponse([]);
      if (url === '/api/v1/notifications/unread-count') return jsonResponse({ unread });
      if (url === '/api/v1/auth/refresh') return jsonResponse({}, 401);
      return jsonResponse({}, 404);
    }),
  );
}

const PROBE_PATHS = [
  'courses',
  'calendar',
  'messages',
  'notifications',
  'search',
  'badges',
  'learning-plan',
  'blog',
  'questions',
  'admin/users',
  'admin/roles',
  'tokens',
  'admin/site-config',
  'reports',
  'insights',
  'contentbank',
  'backup',
  'privacy',
  'health',
];

function renderShell(initialPath = '/') {
  const router = createMemoryRouter(
    [
      {
        element: <App />,
        children: [
          {
            element: <Shell />,
            children: [
              { index: true, element: <div data-testid="probe-index" /> },
              ...PROBE_PATHS.map((path) => ({
                path,
                element: <div data-testid={`probe-${path.replaceAll('/', '-')}`} />,
              })),
            ],
          },
        ],
      },
    ],
    { initialEntries: [initialPath] },
  );
  return render(<RouterProvider router={router} />);
}

function seedTokens() {
  localStorage.setItem('lms.accessToken', 'access-test');
  localStorage.setItem('lms.refreshToken', 'refresh-test');
}

function sidebarRoot(container: HTMLElement): HTMLElement {
  const root = container.querySelector('[data-slot="sidebar"]');
  if (!root) throw new Error('không thấy sidebar');
  return root as HTMLElement;
}

beforeAll(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.cookie = 'sidebar_state=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  queryClient.clear();
});

describe('cây điều hướng sidebar — admin', () => {
  it('thấy 6 mục trực tiếp + 4 mục cha; nhóm đóng mặc định nên chưa thấy mục con', async () => {
    seedTokens();
    stubFetch(profileOf(ADMIN_ID, 'admin'), ADMIN_ACCESS, 2);
    renderShell();

    // 6 mục trực tiếp là link thật, đúng thứ tự cây của hồ sơ §4.1.
    for (const name of ['Tổng quan', 'Khoá học', 'Lịch', 'Tin nhắn', 'Thông báo', 'Tìm kiếm']) {
      expect(await screen.findByRole('link', { name: new RegExp(name) })).toBeInTheDocument();
    }
    // Huy hiệu số chưa đọc vẫn nằm trên mục Thông báo.
    const notifications = await screen.findByRole('link', { name: /Thông báo/ });
    expect(await within(notifications).findByText('2')).toBeInTheDocument();

    // 4 mục cha là nút thu/mở thuần (button, không phải link).
    for (const name of ['Học tập', 'Ngân hàng câu hỏi', 'Người dùng & quyền', 'Hệ thống & dữ liệu']) {
      expect(await screen.findByRole('button', { name })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
    }
    // Nhóm đang đóng: không mục con nào xuất hiện.
    expect(screen.queryByRole('link', { name: 'Sao lưu' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Vai trò' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Huy hiệu' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Câu hỏi của tôi' })).not.toBeInTheDocument();
  });

  it('mở "Ngân hàng câu hỏi" thấy 4 mục con liên kết sâu đúng thứ tự và đúng href', async () => {
    seedTokens();
    stubFetch(profileOf(ADMIN_ID, 'admin'), ADMIN_ACCESS);
    renderShell();

    await userEvent.click(await screen.findByRole('button', { name: 'Ngân hàng câu hỏi' }));

    const hrefs: string[] = [];
    for (const name of ['Ngân hàng hệ thống', 'Câu hỏi của tôi', 'Đề của tôi', 'Ma trận của tôi']) {
      const link = await screen.findByRole('link', { name });
      hrefs.push(link.getAttribute('href')!);
    }
    expect(hrefs).toEqual([
      '/questions?bank=system',
      '/questions?bank=my-questions',
      '/questions?bank=my-papers',
      '/questions?bank=my-matrices',
    ]);
  });

  it('mở "Hệ thống & dữ liệu" thấy đủ 7 mục con đúng thứ tự; các nhóm mở độc lập và đóng riêng được', async () => {
    seedTokens();
    stubFetch(profileOf(ADMIN_ID, 'admin'), ADMIN_ACCESS);
    renderShell();

    await userEvent.click(await screen.findByRole('button', { name: 'Hệ thống & dữ liệu' }));

    const expectedOrder = [
      '/admin/site-config',
      '/reports',
      '/insights',
      '/contentbank',
      '/backup',
      '/privacy',
      '/health',
    ];
    const hrefs: string[] = [];
    for (const name of [
      'Cấu hình site',
      'Báo cáo',
      'Nhận định',
      'Ngân hàng nội dung',
      'Sao lưu',
      'Quyền riêng tư',
      'Trạng thái hệ thống',
    ]) {
      const link = await screen.findByRole('link', { name });
      hrefs.push(link.getAttribute('href')!);
    }
    expect(hrefs).toEqual(expectedOrder);

    // Mở thêm nhóm thứ hai: cả hai cùng mở (không accordion).
    await userEvent.click(screen.getByRole('button', { name: 'Người dùng & quyền' }));
    expect(await screen.findByRole('link', { name: 'Vai trò' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sao lưu' })).toBeInTheDocument();

    // Đóng nhóm Hệ thống: mục con của nó ẩn, nhóm Người dùng vẫn mở.
    await userEvent.click(screen.getByRole('button', { name: 'Hệ thống & dữ liệu' }));
    expect(screen.queryByRole('link', { name: 'Sao lưu' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Vai trò' })).toBeInTheDocument();
  });

  it('bấm mục con điều hướng tới đúng trang', async () => {
    seedTokens();
    stubFetch(profileOf(ADMIN_ID, 'admin'), ADMIN_ACCESS);
    renderShell();

    await userEvent.click(await screen.findByRole('button', { name: 'Hệ thống & dữ liệu' }));
    await userEvent.click(await screen.findByRole('link', { name: 'Sao lưu' }));
    expect(await screen.findByTestId('probe-backup')).toBeInTheDocument();
  });
});

describe('cây điều hướng sidebar — trạng thái nhóm', () => {
  it('lưu nhóm đang mở vào localStorage và giữ nguyên sau khi dựng lại cây (F5)', async () => {
    seedTokens();
    stubFetch(profileOf(ADMIN_ID, 'admin'), ADMIN_ACCESS);
    const first = renderShell();

    await userEvent.click(await screen.findByRole('button', { name: 'Học tập' }));
    expect(await screen.findByRole('link', { name: 'Huy hiệu' })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('lms:sidebar:open-groups') ?? '[]')).toEqual(['learning']);

    // F5: gỡ toàn bộ cây, dựng lại từ đầu — localStorage còn nguyên.
    first.unmount();
    renderShell();
    expect(await screen.findByRole('link', { name: 'Huy hiệu' })).toBeInTheDocument();
    // Nhóm khác không bị mở lây.
    expect(screen.queryByRole('link', { name: 'Sao lưu' })).not.toBeInTheDocument();
  });

  it('nhóm chứa route đang xem luôn tự mở; mục con và nút cha cùng mang trạng thái active', async () => {
    seedTokens();
    stubFetch(profileOf(ADMIN_ID, 'admin'), ADMIN_ACCESS);
    renderShell('/admin/roles');

    const child = await screen.findByRole('link', { name: 'Vai trò' });
    expect(child).toHaveAttribute('href', '/admin/roles');
    expect(child.hasAttribute('data-active')).toBe(true);
    const parent = screen.getByRole('button', { name: 'Người dùng & quyền' });
    expect(parent.hasAttribute('data-active')).toBe(true);
  });

  it('đang ở /questions?bank=my-papers: nhóm Ngân hàng câu hỏi tự mở, đúng mục con "Đề của tôi" active', async () => {
    seedTokens();
    stubFetch(profileOf(TEACHER_ID, 'teacher1'), TEACHER_ACCESS);
    renderShell('/questions?bank=my-papers');

    // Không cần bấm nút cha: mục con hiện sẵn vì nhóm tự mở theo neo.
    const child = await screen.findByRole('link', { name: 'Đề của tôi' });
    expect(child).toHaveAttribute('href', '/questions?bank=my-papers');
    expect(child.hasAttribute('data-active')).toBe(true);
    const parent = screen.getByRole('button', { name: 'Ngân hàng câu hỏi' });
    expect(parent.hasAttribute('data-active')).toBe(true);
    // Mục con khác cùng pathname /questions nhưng khác tham số thì
    // không active — khớp phải gồm cả search.
    expect(screen.getByRole('link', { name: 'Câu hỏi của tôi' }).hasAttribute('data-active')).toBe(false);
    expect(screen.getByRole('link', { name: 'Ngân hàng hệ thống' }).hasAttribute('data-active')).toBe(false);
  });
});

describe('cây điều hướng sidebar — lọc theo quyền', () => {
  it('học viên: không thấy hai nhóm quản trị và không thấy nút cha Ngân hàng câu hỏi', async () => {
    seedTokens();
    stubFetch(profileOf(STUDENT_ID, 'student1'), STUDENT_ACCESS);
    renderShell();

    expect(await screen.findByRole('link', { name: 'Tổng quan' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Người dùng & quyền' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hệ thống & dữ liệu' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ngân hàng câu hỏi' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Học tập' }));
    expect(await screen.findByRole('link', { name: 'Huy hiệu' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Kế hoạch học tập' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Blog' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ngân hàng câu hỏi' })).not.toBeInTheDocument();
  });

  it('giáo viên có capability câu hỏi: Ngân hàng câu hỏi là mục cha riêng ngay sau Học tập, 4 mục con deep-link đúng href', async () => {
    seedTokens();
    stubFetch(profileOf(TEACHER_ID, 'teacher1'), TEACHER_ACCESS);
    renderShell();

    // Nhóm Học tập không còn chứa Ngân hàng câu hỏi.
    await userEvent.click(await screen.findByRole('button', { name: 'Học tập' }));
    expect(await screen.findByRole('link', { name: 'Huy hiệu' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ngân hàng câu hỏi' })).not.toBeInTheDocument();

    // Mục cha riêng: mở ra 4 mục con liên kết sâu đúng href từng khu vực.
    await userEvent.click(screen.getByRole('button', { name: 'Ngân hàng câu hỏi' }));
    expect(await screen.findByRole('link', { name: 'Ngân hàng hệ thống' })).toHaveAttribute(
      'href',
      '/questions?bank=system',
    );
    expect(screen.getByRole('link', { name: 'Câu hỏi của tôi' })).toHaveAttribute('href', '/questions?bank=my-questions');
    expect(screen.getByRole('link', { name: 'Đề của tôi' })).toHaveAttribute('href', '/questions?bank=my-papers');
    expect(screen.getByRole('link', { name: 'Ma trận của tôi' })).toHaveAttribute('href', '/questions?bank=my-matrices');
    // Giáo viên thuần vẫn không thấy nhóm quản trị.
    expect(screen.queryByRole('button', { name: 'Người dùng & quyền' })).not.toBeInTheDocument();
  });
});

describe('cây điều hướng sidebar — chế độ rail icon', () => {
  it('cookie sidebar_state=false → rail icon có SidebarRail; bấm mục cha bung sidebar và mở nhóm', async () => {
    seedTokens();
    document.cookie = 'sidebar_state=false; path=/';
    stubFetch(profileOf(ADMIN_ID, 'admin'), ADMIN_ACCESS);
    const { container } = renderShell();

    // Chờ phiên resolve và sidebar vẽ xong (trước đó là khung giữ chỗ).
    const parentButton = await screen.findByRole('button', { name: 'Học tập' });
    const root = sidebarRoot(container);
    expect(root).toHaveAttribute('data-state', 'collapsed');
    expect(root).toHaveAttribute('data-collapsible', 'icon');
    expect(container.querySelector('[data-slot="sidebar-rail"]')).not.toBeNull();

    // Bấm mục cha ở chế độ icon: sidebar bung ra (data-state đổi) và
    // nhóm mở — mục con hiện để bấm tiếp.
    await userEvent.click(parentButton);
    expect(sidebarRoot(container)).toHaveAttribute('data-state', 'expanded');
    expect(await screen.findByRole('link', { name: 'Huy hiệu' })).toBeInTheDocument();
  });
});

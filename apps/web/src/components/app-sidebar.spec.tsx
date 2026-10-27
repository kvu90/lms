import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import App from '../root';
import Shell from '../routes/shell';
import { queryClient } from '../lib/query-client';
import { baSessionResponse, isGetSessionUrl } from '#test/ba-session';

/**
 * Test cho cây điều hướng sidebar sau Lát 1 của hồ sơ UI/UX (sidebar
 * collapse theo cơ chế sidebar-07): 5 mục trực tiếp + các mục cha
 * thu/mở (Học tập / Người dùng & quyền / Cài đặt hệ thống) thay cho 3
 * nhóm phẳng cũ. Mục "Tìm kiếm" không còn ở sidebar từ chốt 23:52
 * ngày 26/10/2026 (issue #303 — ô tìm kiếm chuyển ra giữa header).
 * Dựng đúng cây thật (App → Shell → AppSidebar) như
 * sidebar-notification-count.spec, stub fetch theo vai trò:
 *
 * - Admin thấy đủ cây (3 mục cha); nhóm cha đóng mặc định, bấm mới mở
 *   mục con; các nhóm mở độc lập (không accordion).
 * - Trạng thái mở của nhóm lưu ở localStorage `lms:sidebar:open-groups`
 *   — "F5" (gỡ cây, dựng lại) vẫn giữ; nhóm chứa route đang xem thì
 *   luôn tự mở và mục con + nút cha cùng mang trạng thái active.
 * - Ba mục ngân hàng CẤP CAO NHẤT ngay sau Học tập (chốt lại của Lão
 *   gia 11:40 ngày 26/10/2026, issue #228 — BỎ hẳn mục "Ngân hàng hệ
 *   thống" ở sidebar), gác canUseQuestionBank: "Ngân hàng câu hỏi"
 *   (link /questions, thu/mở ra mục con "Ngữ liệu" ở
 *   /questions/stimuli), "Ngân hàng đề" (/exams), "Ngân hàng ma trận"
 *   (/matrices) — mỗi khu vực một PATH RIÊNG theo chuẩn đường dẫn
 *   (issue #221, lát R1); khu hệ thống đi qua thanh tab Cá nhân | Hệ
 *   thống trong chính màn danh sách, không qua sidebar. Đang ở path
 *   của khu vực thì mục/nhóm tương ứng tự mở và active. Học viên
 *   không thấy mục ngân hàng nào; giáo viên có capability câu hỏi
 *   thì thấy đủ ba.
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

/**
 * Fixture ảnh chụp quyền dùng chung: cả ba đều có dấu chân học tập qua
 * hiện vật (hasLearnerArtifacts: true) nên nhóm "Học tập" hiện đủ cho
 * các test cây điều hướng — quy tắc dấu chân (kể cả ca GV thuần ẩn)
 * khoá riêng ở describe "nhóm Học tập theo dấu chân" cuối file.
 */
const ADMIN_ACCESS = { userId: ADMIN_ID, isSiteAdmin: true, assignments: [], contexts: [], hasLearnerArtifacts: true };
const STUDENT_ACCESS = { userId: STUDENT_ID, isSiteAdmin: false, assignments: [], contexts: [], hasLearnerArtifacts: true };
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
  hasLearnerArtifacts: true,
};

const COURSE_CONTEXT_ID = '01900000-0000-7000-8000-0000000000e5';
const COURSE_ID = '01900000-0000-7000-8000-0000000000f6';
const COURSE_CATEGORY_ID = '01900000-0000-7000-8000-0000000000a7';
const COURSE = { id: COURSE_ID, category: COURSE_CATEGORY_ID, fullName: 'Toán 6', shortName: 'TOAN6' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(
  profile: unknown,
  access: unknown,
  unread = 0,
  opts: { courses?: unknown[]; guardianChildren?: unknown[] } = {},
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      // Phiên cookie Better Auth: id phiên khớp id hồ sơ của vai đang stub.
      if (isGetSessionUrl(url)) return baSessionResponse({ id: (profile as { id: string }).id });
      if (url === '/api/v1/users/me') return jsonResponse(profile);
      if (url === '/api/v1/users/me/capabilities') return jsonResponse(access);
      if (url === '/api/v1/courses') return jsonResponse(opts.courses ?? []);
      if (url === '/api/v1/guardian-links/mine/students') {
        return opts.guardianChildren ? jsonResponse(opts.guardianChildren) : jsonResponse({}, 404);
      }
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
  'questions',
  'questions/stimuli',
  'exams',
  'matrices',
  'system-bank/questions',
  'system-bank/exams',
  'system-bank/matrices',
  'admin/users',
  'admin/roles',
  'tokens',
  'admin/site-config',
  'reports',
  'insights',
  'content-bank',
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
  it('thấy 5 mục trực tiếp + 3 mục cha; nhóm đóng mặc định nên chưa thấy mục con', async () => {
    stubFetch(profileOf(ADMIN_ID, 'admin'), ADMIN_ACCESS, 2);
    renderShell();

    // 5 mục trực tiếp là link thật, đúng thứ tự cây của hồ sơ §4.1.
    for (const name of ['Tổng quan', 'Khoá học', 'Lịch', 'Tin nhắn', 'Thông báo']) {
      expect(await screen.findByRole('link', { name: new RegExp(name) })).toBeInTheDocument();
    }
    // Mục "Tìm kiếm" KHÔNG còn ở sidebar (chốt 23:52 ngày 26/10/2026,
    // issue #303): tìm nội dung đi qua ô giữa header, sidebar không
    // giữ link /search nữa — ai thêm lại link này thì test phải đỏ.
    expect(screen.queryByRole('link', { name: /Tìm kiếm/ })).not.toBeInTheDocument();
    // Huy hiệu số chưa đọc vẫn nằm trên mục Thông báo.
    const notifications = await screen.findByRole('link', { name: /Thông báo/ });
    expect(await within(notifications).findByText('2')).toBeInTheDocument();

    // 3 mục cha là nút thu/mở thuần (button, không phải link).
    for (const name of ['Học tập', 'Người dùng & quyền', 'Cài đặt hệ thống']) {
      expect(await screen.findByRole('button', { name })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
    }
    // Ba mục ngân hàng là mục CẤP CAO NHẤT dạng link, hiện ngay; bản
    // thân "Ngân hàng câu hỏi" là link (không phải nút cha bọc ngoài).
    for (const name of ['Ngân hàng câu hỏi', 'Ngân hàng đề', 'Ngân hàng ma trận']) {
      expect(await screen.findByRole('link', { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Ngân hàng câu hỏi' })).not.toBeInTheDocument();
    // BỎ hẳn mục "Ngân hàng hệ thống" ở sidebar (chốt 26/10/2026,
    // issue #228): không nút, không link, không mục con hệ thống nào.
    expect(screen.queryByRole('button', { name: 'Ngân hàng hệ thống' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ngân hàng hệ thống' })).not.toBeInTheDocument();
    // Nhóm đang đóng: không mục con nào xuất hiện.
    expect(screen.queryByRole('link', { name: 'Sao lưu' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Vai trò' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Huy hiệu' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ngữ liệu' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Câu hỏi hệ thống' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Đề hệ thống' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ma trận hệ thống' })).not.toBeInTheDocument();
  });

  it('mở thu/mở của "Ngân hàng câu hỏi" thấy mục con "Ngữ liệu" đúng href theo path riêng (chuẩn #221)', async () => {
    stubFetch(profileOf(ADMIN_ID, 'admin'), ADMIN_ACCESS);
    renderShell();

    // Thân mục cha là link tới danh sách câu hỏi (tab Cá nhân mặc định).
    expect(await screen.findByRole('link', { name: 'Ngân hàng câu hỏi' })).toHaveAttribute('href', '/questions');
    // Chưa mở collapse: chưa thấy Ngữ liệu.
    expect(screen.queryByRole('link', { name: 'Ngữ liệu' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Thu/mở Ngân hàng câu hỏi' }));
    expect(await screen.findByRole('link', { name: 'Ngữ liệu' })).toHaveAttribute('href', '/questions/stimuli');
  });

  it('chevron của "Ngân hàng câu hỏi" nằm trong cùng bề mặt nút với nhãn; nhóm chưa có mục con không có nút thu/mở', async () => {
    stubFetch(profileOf(ADMIN_ID, 'admin'), ADMIN_ACCESS);
    renderShell();

    const label = await screen.findByRole('link', { name: 'Ngân hàng câu hỏi' });
    const toggle = screen.getByRole('button', { name: 'Thu/mở Ngân hàng câu hỏi' });
    // Một nút liền: nhãn (link) và chevron (nút thu/mở) chung đúng một
    // sidebar-menu-item — chevron gắn ở cuối cùng bề mặt nút của nhãn,
    // không còn là hộp trigger 32px (h-8 w-8) tách riêng đứng cạnh
    // (chốt sổ quyết định [26/10 23:16], issue #70).
    // Lưu ý: li của nhóm collapse mang data-slot="collapsible" (gốc
    // Collapsible ghi đè data-slot của SidebarMenuItem) nên neo theo
    // data-sidebar="menu-item" mới ổn định.
    const item = label.closest('li[data-sidebar="menu-item"]');
    expect(item).not.toBeNull();
    expect(item!.contains(toggle)).toBe(true);
    expect(toggle.className).not.toMatch(/\bh-8\b/);
    expect(toggle.className).not.toMatch(/\bw-8\b/);
    // "Ngân hàng đề" và "Ngân hàng ma trận" chưa có mục con: liên kết
    // thuần, không nút thu/mở nào.
    expect(screen.queryByRole('button', { name: 'Thu/mở Ngân hàng đề' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Thu/mở Ngân hàng ma trận' })).not.toBeInTheDocument();
  });

  it('bấm thân "Ngân hàng câu hỏi" điều hướng tới trang /questions', async () => {
    stubFetch(profileOf(ADMIN_ID, 'admin'), ADMIN_ACCESS);
    renderShell();

    await userEvent.click(await screen.findByRole('link', { name: 'Ngân hàng câu hỏi' }));
    expect(await screen.findByTestId('probe-questions')).toBeInTheDocument();
  });

  it('sidebar không còn đường nào tới khu hệ thống — khu hệ thống chỉ vào bằng tab trong trang danh sách', async () => {
    stubFetch(profileOf(ADMIN_ID, 'admin'), ADMIN_ACCESS);
    const { container } = renderShell();

    expect(await screen.findByRole('link', { name: 'Ngân hàng câu hỏi' })).toBeInTheDocument();
    // Không phần tử nào trong sidebar trỏ vào /system-bank/* nữa.
    const sidebar = sidebarRoot(container);
    expect(sidebar.querySelector('a[href^="/system-bank"]')).toBeNull();
    expect(within(sidebar).queryByText('Ngân hàng hệ thống')).not.toBeInTheDocument();
  });

  it('mở "Cài đặt hệ thống" thấy đủ 7 mục con đúng thứ tự; các nhóm mở độc lập và đóng riêng được', async () => {
    stubFetch(profileOf(ADMIN_ID, 'admin'), ADMIN_ACCESS);
    renderShell();

    await userEvent.click(await screen.findByRole('button', { name: 'Cài đặt hệ thống' }));

    const expectedOrder = [
      '/admin/site-config',
      '/reports',
      '/insights',
      '/content-bank',
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
    await userEvent.click(screen.getByRole('button', { name: 'Cài đặt hệ thống' }));
    expect(screen.queryByRole('link', { name: 'Sao lưu' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Vai trò' })).toBeInTheDocument();
  });

  it('bấm mục con điều hướng tới đúng trang', async () => {
    stubFetch(profileOf(ADMIN_ID, 'admin'), ADMIN_ACCESS);
    renderShell();

    await userEvent.click(await screen.findByRole('button', { name: 'Cài đặt hệ thống' }));
    await userEvent.click(await screen.findByRole('link', { name: 'Sao lưu' }));
    expect(await screen.findByTestId('probe-backup')).toBeInTheDocument();
  });
});

describe('cây điều hướng sidebar — trạng thái nhóm', () => {
  it('lưu nhóm đang mở vào localStorage và giữ nguyên sau khi dựng lại cây (F5)', async () => {
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
    stubFetch(profileOf(ADMIN_ID, 'admin'), ADMIN_ACCESS);
    renderShell('/admin/roles');

    const child = await screen.findByRole('link', { name: 'Vai trò' });
    expect(child).toHaveAttribute('href', '/admin/roles');
    expect(child.hasAttribute('data-active')).toBe(true);
    const parent = screen.getByRole('button', { name: 'Người dùng & quyền' });
    expect(parent.hasAttribute('data-active')).toBe(true);
  });

  it('đang ở /exams: mục top level "Ngân hàng đề" là link active, hai mục ngân hàng còn lại không', async () => {
    stubFetch(profileOf(TEACHER_ID, 'teacher1'), TEACHER_ACCESS);
    renderShell('/exams');

    const child = await screen.findByRole('link', { name: 'Ngân hàng đề' });
    expect(child).toHaveAttribute('href', '/exams');
    expect(child.hasAttribute('data-active')).toBe(true);
    // Mỗi khu vực có pathname riêng (chuẩn #221) nên hai mục ngân
    // hàng còn lại không thể active lây.
    expect(screen.getByRole('link', { name: 'Ngân hàng câu hỏi' }).hasAttribute('data-active')).toBe(false);
    expect(screen.getByRole('link', { name: 'Ngân hàng ma trận' }).hasAttribute('data-active')).toBe(false);
  });

  it('đang ở /system-bank/exams: sidebar không có mục hệ thống nào; ba mục ngân hàng hiện đúng tên và không mục nào active lây', async () => {
    stubFetch(profileOf(TEACHER_ID, 'teacher1'), TEACHER_ACCESS);
    renderShell('/system-bank/exams');

    // Khu hệ thống không còn là bề mặt của sidebar (chốt 26/10/2026):
    // ngữ cảnh Cá nhân/Hệ thống do thanh tab trong trang danh sách
    // mang, sidebar không mục nào nhận active ở path hệ thống.
    expect(await screen.findByRole('link', { name: 'Ngân hàng đề' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ngân hàng hệ thống' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Đề hệ thống' })).not.toBeInTheDocument();
    for (const name of ['Ngân hàng câu hỏi', 'Ngân hàng đề', 'Ngân hàng ma trận']) {
      expect(screen.getByRole('link', { name }).hasAttribute('data-active')).toBe(false);
    }
  });

  it('đang ở /questions: "Ngân hàng câu hỏi" active và collapse tự mở thấy "Ngữ liệu" chưa active', async () => {
    stubFetch(profileOf(TEACHER_ID, 'teacher1'), TEACHER_ACCESS);
    renderShell('/questions');

    const parent = await screen.findByRole('link', { name: 'Ngân hàng câu hỏi' });
    expect(parent.hasAttribute('data-active')).toBe(true);
    // Nhóm tự mở theo URL của chính nó: Ngữ liệu hiện sẵn, không cần
    // bấm nút chevron; chưa ở /questions/stimuli nên Ngữ liệu chưa
    // active.
    const child = await screen.findByRole('link', { name: 'Ngữ liệu' });
    expect(child).toHaveAttribute('href', '/questions/stimuli');
    expect(child.hasAttribute('data-active')).toBe(false);
  });

  it('đang ở /questions/stimuli: cả mục cha "Ngân hàng câu hỏi" lẫn mục con "Ngữ liệu" cùng active', async () => {
    stubFetch(profileOf(TEACHER_ID, 'teacher1'), TEACHER_ACCESS);
    renderShell('/questions/stimuli');

    // Route con làm sáng cả cha (khớp tiền tố path) lẫn chính nó
    // (khớp chính xác) — hành vi đã chốt ở nghiệm thu #203, nay theo
    // path thay cho query.
    const parent = await screen.findByRole('link', { name: 'Ngân hàng câu hỏi' });
    expect(parent.hasAttribute('data-active')).toBe(true);
    const child = await screen.findByRole('link', { name: 'Ngữ liệu' });
    expect(child).toHaveAttribute('href', '/questions/stimuli');
    expect(child.hasAttribute('data-active')).toBe(true);
  });
});

describe('cây điều hướng sidebar — lọc theo quyền', () => {
  it('học viên: không thấy hai nhóm quản trị và không thấy mục ngân hàng nào', async () => {
    stubFetch(profileOf(STUDENT_ID, 'student1'), STUDENT_ACCESS);
    renderShell();

    expect(await screen.findByRole('link', { name: 'Tổng quan' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Người dùng & quyền' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cài đặt hệ thống' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ngân hàng hệ thống' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ngân hàng câu hỏi' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ngân hàng đề' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ngân hàng ma trận' })).not.toBeInTheDocument();

    // Nhóm Học tập nay gác theo ảnh chụp quyền (bất đồng bộ): phải chờ
    // nút cha xuất hiện sau khi snapshot về, không dùng getByRole đồng
    // bộ như khi nhóm còn render vô điều kiện.
    await userEvent.click(await screen.findByRole('button', { name: 'Học tập' }));
    expect(await screen.findByRole('link', { name: 'Huy hiệu' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Kế hoạch học tập' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ngữ liệu' })).not.toBeInTheDocument();
  });

  it('giáo viên có capability câu hỏi: 3 mục ngân hàng ở cấp cao nhất, đúng href path riêng từng khu vực (chuẩn #221)', async () => {
    stubFetch(profileOf(TEACHER_ID, 'teacher1'), TEACHER_ACCESS);
    renderShell();

    // Ba mục ngân hàng là link cấp cao nhất, đúng href từng khu vực
    // (đây là tab Cá nhân mặc định của từng màn danh sách).
    expect(await screen.findByRole('link', { name: 'Ngân hàng câu hỏi' })).toHaveAttribute('href', '/questions');
    expect(screen.getByRole('link', { name: 'Ngân hàng đề' })).toHaveAttribute('href', '/exams');
    expect(screen.getByRole('link', { name: 'Ngân hàng ma trận' })).toHaveAttribute('href', '/matrices');
    // Ngữ liệu nằm trong collapse của chính "Ngân hàng câu hỏi".
    expect(screen.queryByRole('link', { name: 'Ngữ liệu' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Thu/mở Ngân hàng câu hỏi' }));
    expect(await screen.findByRole('link', { name: 'Ngữ liệu' })).toHaveAttribute('href', '/questions/stimuli');
    // Không còn mục "Ngân hàng hệ thống" và không link hệ thống nào.
    expect(screen.queryByRole('button', { name: 'Ngân hàng hệ thống' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Câu hỏi hệ thống' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Đề hệ thống' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ma trận hệ thống' })).not.toBeInTheDocument();
    // Giáo viên thuần vẫn không thấy nhóm quản trị.
    expect(screen.queryByRole('button', { name: 'Người dùng & quyền' })).not.toBeInTheDocument();
  });
});

describe('cây điều hướng sidebar — chế độ rail icon', () => {
  it('cookie sidebar_state=false → rail icon có SidebarRail; bấm mục cha bung sidebar và mở nhóm', async () => {
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

describe('nhóm Học tập theo dấu chân (issue #176, quy tắc M+A)', () => {
  const TEACHER_PURE = { ...TEACHER_ACCESS, hasLearnerArtifacts: false };
  const NO_FOOTPRINT = { userId: STUDENT_ID, isSiteAdmin: false, assignments: [], contexts: [], hasLearnerArtifacts: false };
  // Gán vai học viên tại context khoá (không phải staff: không có
  // grade:viewall) — nhánh (M): khoá lọt vào perms.learning.
  const LEARNER_ACCESS = {
    userId: STUDENT_ID,
    isSiteAdmin: false,
    assignments: [
      {
        id: '01900000-0000-7000-8000-0000000000b8',
        roleId: '01900000-0000-7000-8000-0000000000b9',
        roleShortname: 'student',
        roleName: 'Học viên',
        contextId: COURSE_CONTEXT_ID,
        contextLevel: 50,
        contextPath: `/1/${COURSE_CONTEXT_ID}`,
        instanceId: COURSE_ID,
      },
    ],
    contexts: [
      {
        contextId: COURSE_CONTEXT_ID,
        contextLevel: 50,
        contextPath: `/1/${COURSE_CONTEXT_ID}`,
        capabilities: ['course:view'],
      },
    ],
    hasLearnerArtifacts: false,
  };

  it('1. GV thuần (dạy, không học ở đâu, không hiện vật): không có nút nhóm Học tập', async () => {
    stubFetch(profileOf(TEACHER_ID, 'teacher1'), TEACHER_PURE);
    renderShell();

    expect(await screen.findByRole('link', { name: 'Tổng quan' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Học tập' })).not.toBeInTheDocument();
  });

  it('2. GV có ghi danh học viên ở khoá khác: nhóm hiện, mở ra thấy Huy hiệu + Kế hoạch học tập', async () => {
    stubFetch(profileOf(TEACHER_ID, 'teacher1'), { ...LEARNER_ACCESS, userId: TEACHER_ID }, 0, { courses: [COURSE] });
    renderShell();

    await userEvent.click(await screen.findByRole('button', { name: 'Học tập' }));
    expect(await screen.findByRole('link', { name: 'Huy hiệu' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Kế hoạch học tập' })).toBeInTheDocument();
  });

  it('3. HS (ghi danh học viên): nhóm hiện như hiện tại', async () => {
    stubFetch(profileOf(STUDENT_ID, 'student1'), LEARNER_ACCESS, 0, { courses: [COURSE] });
    renderShell();

    await userEvent.click(await screen.findByRole('button', { name: 'Học tập' }));
    expect(await screen.findByRole('link', { name: 'Huy hiệu' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Kế hoạch học tập' })).toBeInTheDocument();
  });

  it('4. Hết ghi danh nhưng còn hiện vật: nhóm vẫn hiện', async () => {
    stubFetch(profileOf(STUDENT_ID, 'student1'), STUDENT_ACCESS);
    renderShell();

    await userEvent.click(await screen.findByRole('button', { name: 'Học tập' }));
    expect(await screen.findByRole('link', { name: 'Huy hiệu' })).toBeInTheDocument();
  });

  it('5. Tài khoản mới (mọi tín hiệu rỗng): nhóm ẩn nhưng mục trực tiếp Khoá học vẫn hiện', async () => {
    stubFetch(profileOf(STUDENT_ID, 'newuser'), NO_FOOTPRINT);
    renderShell();

    expect(await screen.findByRole('link', { name: 'Khoá học' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Học tập' })).not.toBeInTheDocument();
  });

  it('6. Phụ huynh thuần (có liên kết giám hộ, không dấu chân): nhóm ẩn, mục Phụ huynh hiện', async () => {
    stubFetch(profileOf(STUDENT_ID, 'parent1'), NO_FOOTPRINT, 0, {
      guardianChildren: [{ student: { id: '01900000-0000-7000-8000-0000000000c0' } }],
    });
    renderShell();

    expect(await screen.findByRole('link', { name: 'Phụ huynh' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Học tập' })).not.toBeInTheDocument();
  });
});

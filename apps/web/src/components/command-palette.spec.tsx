import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import App from '../root';
import Shell from '../routes/shell';
import { queryClient } from '../lib/query-client';
import { baSessionResponse, isGetSessionUrl } from '#test/ba-session';

/**
 * Test cho bảng lệnh tìm nhanh Cmd+K (issue #54): dựng đúng cây thật
 * (App → Shell → SiteHeader → CommandPalette) như app-sidebar.spec,
 * stub fetch theo vai trò:
 *
 * - Ctrl+K mở bảng lệnh từ bất kỳ trang nào; nút ở header cũng mở được;
 *   Escape đóng.
 * - Kết quả tôn trọng quyền của vai đang đăng nhập, theo cùng cổng với
 *   sidebar: học viên không thấy mục quản trị cũng không thấy Ngân
 *   hàng câu hỏi; admin thấy đủ; giáo viên có capability câu hỏi thì
 *   thấy Ngân hàng câu hỏi.
 * - Khoá học lấy từ danh sách khoá của người dùng; gõ không dấu vẫn
 *   khớp ("toan" → "Toán 6"); Enter đi thẳng tới trang khoá.
 */

const ADMIN_ID = '01900000-0000-7000-8000-0000000000a1';
const STUDENT_ID = '01900000-0000-7000-8000-0000000000b2';
const TEACHER_ID = '01900000-0000-7000-8000-0000000000c3';
const SYSTEM_CONTEXT_ID = '01900000-0000-7000-8000-0000000000d4';
const COURSE_ID = '01900000-0000-7000-8000-0000000000e5';
const CATEGORY_ID = '01900000-0000-7000-8000-0000000000f6';

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
 * Fixture dùng chung có dấu chân học tập qua hiện vật (issue #176) để
 * các test palette cũ không đổi hành vi; ca GV thuần không dấu chân
 * khoá riêng ở describe cuối file.
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

/** Kết quả nội dung mẫu của GET /api/v1/search: khoá học không thuộc "khoá học của tôi". */
const CONTENT_COURSE_ID = '01900000-0000-7000-8000-0000000000e9';
const CONTENT_DOC = {
  id: 'doc-search-1',
  area: 'courses',
  itemId: CONTENT_COURSE_ID,
  title: 'Toán nâng cao',
  content: 'TOANNC Nội dung khoá toán nâng cao',
};

/**
 * Kết quả nội dung area `users`: API trả cho MỌI người tìm đã đăng
 * nhập (cổng re-check chỉ là `user:viewdetails`), nên ca phân vai
 * nằm ở phía gắn đích — chỉ người có quyền quản trị người dùng mới
 * được mục chọn trỏ tới màn quản trị.
 */
const USER_CONTENT_ID = '01900000-0000-7000-8000-0000000000e8';
const USER_CONTENT_DOC = {
  id: 'doc-search-2',
  area: 'users',
  itemId: USER_CONTENT_ID,
  title: 'Nguyễn Văn A',
  content: 'vana học viên',
};

const COURSE = {
  id: COURSE_ID,
  category: CATEGORY_ID,
  fullName: 'Toán 6',
  shortName: 'TOAN6',
  idNumber: '',
  summary: '',
  format: 'topics',
  visible: true,
  startDate: null,
  endDate: null,
  groupMode: 0,
  groupModeForce: false,
  enableCompletion: true,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(profile: unknown, access: unknown, searchDocs: unknown[] = [CONTENT_DOC]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      // Phiên cookie Better Auth: id phiên khớp id hồ sơ của vai đang stub.
      if (isGetSessionUrl(url)) return baSessionResponse({ id: (profile as { id: string }).id });
      if (url === '/api/v1/users/me') return jsonResponse(profile);
      if (url === '/api/v1/users/me/capabilities') return jsonResponse(access);
      if (url === '/api/v1/courses') return jsonResponse([COURSE]);
      // Tìm kiếm toàn cục cho nhóm "Nội dung": mặc định một khoá học
      // khác với khoá của người dùng, để phân biệt với nhóm "Đi tới";
      // ca phân vai truyền tập kết quả riêng qua `searchDocs`.
      if (url.startsWith('/api/v1/search?q=')) return jsonResponse(searchDocs);
      if (url === '/api/v1/notifications/unread-count') return jsonResponse({ unread: 0 });
      if (url === '/api/v1/auth/refresh') return jsonResponse({}, 401);
      return jsonResponse({}, 404);
    }),
  );
}

function renderShell() {
  const router = createMemoryRouter(
    [
      {
        element: <App />,
        children: [
          {
            element: <Shell />,
            children: [
              { index: true, element: <div data-testid="probe-index" /> },
              { path: 'courses/:id', element: <div data-testid="probe-course" /> },
              { path: 'admin/users', element: <div data-testid="probe-admin-users" /> },
              { path: 'admin/users/:id/edit', element: <div data-testid="probe-admin-user-edit" /> },
            ],
          },
        ],
      },
    ],
    { initialEntries: ['/'] },
  );
  return render(<RouterProvider router={router} />);
}

async function openPaletteWithKeyboard() {
  // Chờ shell (nơi mount SiteHeader chứa CommandPalette + listener
  // phím toàn cục) dựng xong rồi mới bắn phím. Bề mặt hợp nhất
  // không còn nút mở riêng nên dấu hiệu chờ là trang chủ đã dựng
  // trong cùng cây shell. DOM hiện vẫn có thể sớm hơn nhịp gắn
  // listener (hiệu ứng thụ động chạy sau commit, cây quản trị nặng
  // càng rõ) nên lần bắn đầu có thể rơi: bắn lại chừng nào bề mặt
  // chưa mở — mỗi lần bắn được kiểm tra đồng bộ ngay sau đó (sự
  // kiện đã flush) nên lần bắn thừa không bao giờ đóng nhầm bề mặt
  // vừa mở.
  await screen.findByTestId('probe-index');
  for (let attempt = 0; attempt < 20 && !screen.queryByTestId('command-palette'); attempt++) {
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    if (!screen.queryByTestId('command-palette')) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
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

describe('bảng lệnh Cmd+K — học viên', () => {
  it('mở bằng Ctrl+K, chỉ hiện màn hình thường + khoá của mình, Enter đi tới khoá', async () => {
    stubFetch(profileOf(STUDENT_ID, 'student'), STUDENT_ACCESS);
    renderShell();

    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
    await openPaletteWithKeyboard();
    expect(await screen.findByTestId('command-palette')).toBeInTheDocument();

    // Màn hình thường + khoá học của học viên.
    expect(await screen.findByTestId('palette-item-screen-courses')).toBeInTheDocument();
    expect(await screen.findByTestId(`palette-item-course-${COURSE_ID}`)).toHaveTextContent('Toán 6');
    // Không có quyền: mục quản trị và Ngân hàng câu hỏi không xuất hiện.
    expect(screen.queryByTestId('palette-item-screen-admin-users')).not.toBeInTheDocument();
    expect(screen.queryByTestId('palette-item-screen-questions')).not.toBeInTheDocument();

    // Gõ không dấu vẫn khớp tên khoá có dấu; Enter đi thẳng tới khoá.
    const input = screen.getByPlaceholderText(/Tìm nội dung hoặc đi tới/);
    fireEvent.change(input, { target: { value: 'toan' } });
    expect(await screen.findByTestId(`palette-item-course-${COURSE_ID}`)).toBeInTheDocument();
    expect(screen.queryByTestId('palette-item-screen-courses')).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByTestId('probe-course')).toBeInTheDocument();
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
  });

  it('Escape đóng bảng lệnh', async () => {
    stubFetch(profileOf(STUDENT_ID, 'student'), STUDENT_ACCESS);
    renderShell();

    await openPaletteWithKeyboard();
    const input = await screen.findByPlaceholderText(/Tìm nội dung hoặc đi tới/);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
  });
});

describe('bảng lệnh Cmd+K — quản trị và giáo viên', () => {
  it('admin mở bằng Ctrl+K và thấy mục quản trị (không còn nút mở riêng)', async () => {
    stubFetch(profileOf(ADMIN_ID, 'admin'), ADMIN_ACCESS);
    renderShell();

    expect(screen.queryByTestId('command-palette-trigger')).not.toBeInTheDocument();
    await openPaletteWithKeyboard();
    expect(await screen.findByTestId('command-palette')).toBeInTheDocument();
    expect(await screen.findByTestId('palette-item-screen-admin-users')).toHaveTextContent('Người dùng');
    expect(await screen.findByTestId('palette-item-screen-contentbank')).toBeInTheDocument();
  });

  it('giáo viên có capability câu hỏi thấy Ngân hàng câu hỏi nhưng không thấy quản trị', async () => {
    stubFetch(profileOf(TEACHER_ID, 'teacher'), TEACHER_ACCESS);
    renderShell();

    await openPaletteWithKeyboard();
    expect(await screen.findByTestId('command-palette')).toBeInTheDocument();
    expect(await screen.findByTestId('palette-item-screen-questions')).toHaveTextContent('Ngân hàng câu hỏi');
    expect(screen.queryByTestId('palette-item-screen-admin-users')).not.toBeInTheDocument();
  });
});

describe('bề mặt hợp nhất — nhóm Nội dung (chốt gộp tìm kiếm 27/10/2026)', () => {
  it('mở bằng Ctrl+K thấy hai nhóm; kết quả nội dung bấm mở được item; mục Tìm kiếm trần không còn', async () => {
    stubFetch(profileOf(STUDENT_ID, 'student'), STUDENT_ACCESS);
    renderShell();

    await openPaletteWithKeyboard();
    expect(await screen.findByTestId('command-palette')).toBeInTheDocument();
    // Nhóm "Đi tới" hiện ngay khi mở; mục "Tìm kiếm" trỏ /search trần đã bỏ.
    expect(screen.getByText('Đi tới')).toBeInTheDocument();
    expect(screen.queryByTestId('palette-item-screen-search')).not.toBeInTheDocument();

    // Gõ từ khoá → nhóm "Nội dung" gọi /api/v1/search và hiện kết quả.
    const input = screen.getByPlaceholderText(/Tìm nội dung hoặc đi tới/);
    fireEvent.change(input, { target: { value: 'toán' } });
    expect(await screen.findByText('Nội dung')).toBeInTheDocument();
    const contentItem = await screen.findByTestId('palette-item-content-doc-search-1');
    expect(contentItem).toHaveTextContent('Toán nâng cao');
    expect(contentItem).toHaveTextContent('Khoá học');

    // Bấm kết quả nội dung → đi thẳng tới trang của khoá đó, bề mặt đóng.
    fireEvent.click(contentItem);
    expect(await screen.findByTestId('probe-course')).toBeInTheDocument();
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
  });
});

describe('bề mặt hợp nhất — kết quả Nội dung area users theo quyền người tìm', () => {
  it('quản trị: kết quả người dùng hiện trong nhóm Nội dung và bấm tới màn quản trị người dùng', async () => {
    stubFetch(profileOf(ADMIN_ID, 'admin'), ADMIN_ACCESS, [USER_CONTENT_DOC]);
    renderShell();

    await openPaletteWithKeyboard();
    expect(await screen.findByTestId('command-palette')).toBeInTheDocument();
    const input = screen.getByPlaceholderText(/Tìm nội dung hoặc đi tới/);
    fireEvent.change(input, { target: { value: 'nguyễn' } });
    const contentItem = await screen.findByTestId('palette-item-content-doc-search-2');
    expect(contentItem).toHaveTextContent('Nguyễn Văn A');
    expect(contentItem).toHaveTextContent('Người dùng');

    // Bấm kết quả → đi thẳng tới màn quản trị của người dùng đó, bề mặt đóng.
    fireEvent.click(contentItem);
    expect(await screen.findByTestId('probe-admin-user-edit')).toBeInTheDocument();
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
  });

  it('học viên: kết quả người dùng KHÔNG thành mục chọn (không điều hướng vào màn quản trị), kết quả khoá học vẫn hiện', async () => {
    stubFetch(profileOf(STUDENT_ID, 'student'), STUDENT_ACCESS, [CONTENT_DOC, USER_CONTENT_DOC]);
    renderShell();

    await openPaletteWithKeyboard();
    expect(await screen.findByTestId('command-palette')).toBeInTheDocument();
    const input = screen.getByPlaceholderText(/Tìm nội dung hoặc đi tới/);
    fireEvent.change(input, { target: { value: 'toán' } });
    // Nhóm Nội dung đã nạp (kết quả khoá học hiện) — chứng tỏ lượt
    // tìm đã trả về cả hai kết quả…
    expect(await screen.findByTestId('palette-item-content-doc-search-1')).toBeInTheDocument();
    // …nhưng kết quả người dùng không thành mục chọn nào.
    expect(screen.queryByTestId('palette-item-content-doc-search-2')).not.toBeInTheDocument();
    expect(screen.queryByText('Nguyễn Văn A')).not.toBeInTheDocument();
  });
});

describe('bảng lệnh Cmd+K — gác Huy hiệu/Kế hoạch theo dấu chân (issue #176)', () => {
  it('GV thuần không dấu chân: không thấy hai mục Huy hiệu/Kế hoạch trong palette', async () => {
    stubFetch(profileOf(TEACHER_ID, 'teacher'), { ...TEACHER_ACCESS, hasLearnerArtifacts: false });
    renderShell();

    await openPaletteWithKeyboard();
    expect(await screen.findByTestId('command-palette')).toBeInTheDocument();
    expect(screen.queryByTestId('palette-item-screen-badges')).not.toBeInTheDocument();
    expect(screen.queryByTestId('palette-item-screen-learning-plan')).not.toBeInTheDocument();
  });

  it('người có dấu chân (hiện vật): thấy đủ hai mục Huy hiệu/Kế hoạch trong palette', async () => {
    stubFetch(profileOf(STUDENT_ID, 'student'), STUDENT_ACCESS);
    renderShell();

    await openPaletteWithKeyboard();
    expect(await screen.findByTestId('palette-item-screen-badges')).toBeInTheDocument();
    expect(await screen.findByTestId('palette-item-screen-learning-plan')).toBeInTheDocument();
  });
});

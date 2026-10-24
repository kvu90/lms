import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import App from '../root';
import Shell from '../routes/shell';
import { queryClient } from '../lib/query-client';

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

function stubFetch(profile: unknown, access: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/v1/users/me') return jsonResponse(profile);
      if (url === '/api/v1/users/me/capabilities') return jsonResponse(access);
      if (url === '/api/v1/courses') return jsonResponse([COURSE]);
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
            ],
          },
        ],
      },
    ],
    { initialEntries: ['/'] },
  );
  return render(<RouterProvider router={router} />);
}

function seedTokens() {
  localStorage.setItem('lms.accessToken', 'access-test');
  localStorage.setItem('lms.refreshToken', 'refresh-test');
}

async function openPaletteWithKeyboard() {
  // Chờ header (nơi mount CommandPalette + listener phím toàn cục) dựng
  // xong rồi mới bắn phím — bắn sớm hơn thì listener chưa gắn.
  await screen.findByTestId('command-palette-trigger');
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
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
    seedTokens();
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
    const input = screen.getByPlaceholderText(/Tới màn hình hoặc khoá học/);
    fireEvent.change(input, { target: { value: 'toan' } });
    expect(await screen.findByTestId(`palette-item-course-${COURSE_ID}`)).toBeInTheDocument();
    expect(screen.queryByTestId('palette-item-screen-courses')).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByTestId('probe-course')).toBeInTheDocument();
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
  });

  it('Escape đóng bảng lệnh', async () => {
    seedTokens();
    stubFetch(profileOf(STUDENT_ID, 'student'), STUDENT_ACCESS);
    renderShell();

    await openPaletteWithKeyboard();
    const input = await screen.findByPlaceholderText(/Tới màn hình hoặc khoá học/);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
  });
});

describe('bảng lệnh Cmd+K — quản trị và giáo viên', () => {
  it('admin mở bằng nút ở header và thấy mục quản trị', async () => {
    seedTokens();
    stubFetch(profileOf(ADMIN_ID, 'admin'), ADMIN_ACCESS);
    renderShell();

    fireEvent.click(await screen.findByTestId('command-palette-trigger'));
    expect(await screen.findByTestId('command-palette')).toBeInTheDocument();
    expect(await screen.findByTestId('palette-item-screen-admin-users')).toHaveTextContent('Người dùng');
    expect(await screen.findByTestId('palette-item-screen-contentbank')).toBeInTheDocument();
  });

  it('giáo viên có capability câu hỏi thấy Ngân hàng câu hỏi nhưng không thấy quản trị', async () => {
    seedTokens();
    stubFetch(profileOf(TEACHER_ID, 'teacher'), TEACHER_ACCESS);
    renderShell();

    await openPaletteWithKeyboard();
    expect(await screen.findByTestId('command-palette')).toBeInTheDocument();
    expect(await screen.findByTestId('palette-item-screen-questions')).toHaveTextContent('Câu hỏi');
    expect(screen.queryByTestId('palette-item-screen-admin-users')).not.toBeInTheDocument();
  });
});

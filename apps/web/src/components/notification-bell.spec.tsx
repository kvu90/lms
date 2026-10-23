import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import App from '../root';
import Shell from '../routes/shell';
import { queryClient } from '../lib/query-client';

/**
 * Test cho chuông thông báo ở góc phải site-header (thay bộ chọn ngôn
 * ngữ đã gỡ): huy hiệu phải hiện đúng số chưa đọc từ
 * GET /notifications/unread-count; mở panel phải thấy danh sách từ
 * GET /notifications; bấm một thông báo chưa đọc phải gọi
 * POST /notifications/:id/read rồi điều hướng sang trang thông báo;
 * nút chân panel phải gọi POST /notifications/read-all. Dựng đúng cây
 * thật (App → Shell → SiteHeader) như nav-user.spec, stub fetch theo
 * từng URL và ghi lại mọi lời gọi để khẳng định.
 */

const ADMIN_ID = '01900000-0000-7000-8000-0000000000a1';
const UNREAD_ID = '01900000-0000-7000-8000-0000000000b1';
const READ_ID = '01900000-0000-7000-8000-0000000000b2';

const PROFILE = {
  id: ADMIN_ID,
  username: 'admin',
  firstname: 'Quản',
  lastname: 'Trị',
  email: 'admin@example.com',
  suspended: false,
  deleted: false,
  isGuest: false,
  forcePasswordChange: false,
  lastlogin: null,
  timecreated: '2026-01-01T00:00:00.000Z',
  customFields: [],
};

const ACCESS = { userId: ADMIN_ID, isSiteAdmin: true, assignments: [], contexts: [] };

const NOTIFICATIONS = [
  {
    id: UNREAD_ID,
    subject: 'Có bài tập mới cần chấm',
    fullmessage: 'Học viên vừa nộp bài trong khoá DEMO101.',
    eventtype: 'grading',
    timeread: null,
    timecreated: '2026-10-23T08:00:00.000Z',
  },
  {
    id: READ_ID,
    subject: 'Lịch học tuần này',
    fullmessage: 'Buổi học trực tuyến bắt đầu lúc 19 giờ.',
    eventtype: 'calendar',
    timeread: '2026-10-23T09:00:00.000Z',
    timecreated: '2026-10-22T08:00:00.000Z',
  },
];

interface RecordedCall {
  url: string;
  method: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(calls: RecordedCall[], unread: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (url === '/api/v1/users/me') return jsonResponse(PROFILE);
      if (url === '/api/v1/users/me/capabilities') return jsonResponse(ACCESS);
      if (url === '/api/v1/courses') return jsonResponse([]);
      if (url === '/api/v1/notifications/unread-count') return jsonResponse({ unread });
      if (url === '/api/v1/notifications') return jsonResponse(NOTIFICATIONS);
      if (url === '/api/v1/notifications/read-all') return jsonResponse({});
      if (url === `/api/v1/notifications/${UNREAD_ID}/read`) return jsonResponse({});
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
              { index: true, element: <div data-testid="home-probe" /> },
              { path: 'notifications', element: <div data-testid="notifications-probe" /> },
            ],
          },
        ],
      },
    ],
    { initialEntries: ['/'] },
  );
  return render(<RouterProvider router={router} />);
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
  // jsdom không có ResizeObserver; lớp định vị của menu (Base UI)
  // quan sát kích thước phần tử neo khi panel mở.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  queryClient.clear();
});

describe('chuông thông báo ở site-header', () => {
  it('hiện huy hiệu đúng số chưa đọc và không còn bộ chọn ngôn ngữ', async () => {
    localStorage.setItem('lms.accessToken', 'access-test');
    localStorage.setItem('lms.refreshToken', 'refresh-test');
    const calls: RecordedCall[] = [];
    stubFetch(calls, 1);
    renderShell();

    const bell = await screen.findByRole('button', { name: 'Thông báo' });
    // Huy hiệu đỏ nằm trong chính nút chuông, mang số chưa đọc từ API.
    expect(await within(bell).findByText('1')).toBeInTheDocument();
    // Bộ chọn ngôn ngữ đã gỡ khỏi header: không còn combobox nào.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('mở panel thấy danh sách; bấm thông báo chưa đọc thì đánh dấu đã đọc và sang trang thông báo', async () => {
    localStorage.setItem('lms.accessToken', 'access-test');
    localStorage.setItem('lms.refreshToken', 'refresh-test');
    const calls: RecordedCall[] = [];
    stubFetch(calls, 1);
    const user = userEvent.setup();
    renderShell();

    const bell = await screen.findByRole('button', { name: 'Thông báo' });
    await user.click(bell);

    // Panel liệt kê cả thông báo chưa đọc lẫn đã đọc.
    const unreadItem = await screen.findByRole('menuitem', { name: /Có bài tập mới cần chấm/ });
    expect(screen.getByRole('menuitem', { name: /Lịch học tuần này/ })).toBeInTheDocument();

    await user.click(unreadItem);
    // Đã gọi đúng endpoint đánh dấu một thông báo đã đọc…
    expect(calls).toContainEqual({ url: `/api/v1/notifications/${UNREAD_ID}/read`, method: 'POST' });
    // …và đã điều hướng sang trang thông báo đầy đủ.
    expect(await screen.findByTestId('notifications-probe')).toBeInTheDocument();
  });

  it('nút chân panel gọi đánh dấu tất cả đã đọc', async () => {
    localStorage.setItem('lms.accessToken', 'access-test');
    localStorage.setItem('lms.refreshToken', 'refresh-test');
    const calls: RecordedCall[] = [];
    stubFetch(calls, 2);
    const user = userEvent.setup();
    renderShell();

    const bell = await screen.findByRole('button', { name: 'Thông báo' });
    await user.click(bell);
    await user.click(await screen.findByRole('menuitem', { name: 'Đánh dấu đã đọc tất cả' }));

    expect(calls).toContainEqual({ url: '/api/v1/notifications/read-all', method: 'POST' });
  });
});

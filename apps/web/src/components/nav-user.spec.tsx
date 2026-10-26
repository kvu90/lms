import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import App from '../root';
import Shell from '../routes/shell';
import { queryClient } from '../lib/query-client';
import { baSessionResponse, isGetSessionUrl } from '#test/ba-session';

/**
 * Test hồi quy cho menu tài khoản ở chân sidebar (NavUser): trên bản
 * live sau đợt chuyển Radix → Base UI, bấm nút ba chấm cạnh hồ sơ làm
 * sập toàn màn hình sang trang lỗi dự phòng ở cả phiên admin lẫn học
 * viên. Test dựng đúng cây thật (App của root → Shell → sidebar thật),
 * phiên đăng nhập resolve ngay, rồi bấm mở menu như người dùng:
 * menu phải hiện đủ mục "Hồ sơ" và "Đăng xuất" và không được ném lỗi
 * render nào (không có trang lỗi dự phòng nào thay thế màn hình).
 */

const ADMIN_ID = '01900000-0000-7000-8000-0000000000a1';

const PROFILE = {
  id: ADMIN_ID,
  username: 'admin',
  firstName: 'Quản',
  lastName: 'Trị',
  email: 'admin@example.com',
  suspended: false,
  deleted: false,
  isGuest: false,
  forcePasswordChange: false,
  lastLogin: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  customFields: [],
};

const ACCESS = { userId: ADMIN_ID, isSiteAdmin: true, assignments: [], contexts: [] };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      // Phiên cookie Better Auth: get-session báo danh tính admin.
      if (isGetSessionUrl(url)) return baSessionResponse({ id: ADMIN_ID, username: 'admin', email: 'admin@example.com' });
      if (url === '/api/v1/users/me') return jsonResponse(PROFILE);
      if (url === '/api/v1/users/me/capabilities') return jsonResponse(ACCESS);
      if (url === '/api/v1/courses') return jsonResponse([]);
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
            children: [{ index: true, element: <div data-testid="home-probe" /> }],
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
  // jsdom không có ResizeObserver; lớp định vị của menu (Floating UI
  // qua Base UI) quan sát kích thước phần tử neo khi menu mở.
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

describe('menu tài khoản ở chân sidebar', () => {
  it('bấm mở menu: hiện mục Hồ sơ và Đăng xuất, không sập màn hình', async () => {
    stubFetch();
    const user = userEvent.setup();
    renderShell();

    // Nút mở menu là nút hồ sơ ở chân sidebar, hiện tên người dùng.
    const trigger = await screen.findByRole('button', { name: /Quản Trị/ });
    await user.click(trigger);

    // Menu mở: đủ hai mục thao tác với chính mình.
    expect(await screen.findByRole('menuitem', { name: /Hồ sơ/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Đăng xuất/ })).toBeInTheDocument();
    // Màn hình chính vẫn nguyên, không bị trang lỗi dự phòng thay thế.
    expect(screen.getByTestId('home-probe')).toBeInTheDocument();
  });
});

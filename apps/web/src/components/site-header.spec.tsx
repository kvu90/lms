import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SidebarProvider } from '@lms/ui/components/sidebar';
import { TestProviders } from '#test/providers';
import { SiteHeader } from '#components/site-header';

/**
 * Test cho header ba vùng sau chốt 23:52 ngày 26/10/2026 (issue
 * #303 — ô tìm kiếm ra giữa header theo khuôn Facebook/YouTube):
 *
 * - Gõ từ khoá vào ô giữa + Enter → điều hướng tới `/search?q=…`
 *   (từ khoá được mã hoá URL); đây là đường chính tới trang kết quả
 *   kể từ khi sidebar bỏ mục "Tìm kiếm".
 * - Đang ở `/search` thì ô giữa đồng bộ đúng tham số `q` hiện tại:
 *   mở thẳng link có `q` là ô hiện sẵn `q`, `q` đổi thì ô đổi theo.
 * - Ô trống (hoặc chỉ khoảng trắng) + Enter → KHÔNG điều hướng.
 * - Bề mặt tìm kiếm hợp nhất (chốt gộp 27/10/2026): nút "Tìm
 *   nhanh…" riêng ở vùng phải đã BỎ (không còn trigger trong
 *   header) nhưng Ctrl+K vẫn mở được bề mặt từ header.
 *
 * Dựng SiteHeader thật trong SidebarProvider + router nhớ giống
 * shell thật; fetch chỉ stub cho chuông thông báo (số chưa đọc) vì
 * header tự nó không gọi API nào khác khi hiển thị.
 */

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
      if (url === '/api/v1/notifications/unread-count') return jsonResponse({ unread: 0 });
      if (url.startsWith('/api/v1/notifications?')) return jsonResponse({ items: [], nextCursor: null });
      return jsonResponse({}, 404);
    }),
  );
}

/** Thăm dò đường dẫn hiện tại (kèm query) để khẳng định điều hướng. */
function CurrentPath() {
  const location = useLocation();
  return <p data-testid="current-path">{`${location.pathname}${location.search}`}</p>;
}

function Layout() {
  return (
    <SidebarProvider>
      <SiteHeader />
      <CurrentPath />
      <Outlet />
    </SidebarProvider>
  );
}

function renderHeader(initialPath = '/') {
  const router = createMemoryRouter(
    [
      {
        element: <Layout />,
        children: [
          { index: true, element: <p>Trang chủ thử</p> },
          { path: 'courses', element: <p>Trang khoá học thử</p> },
          { path: 'search', element: <p>Trang kết quả thử</p> },
        ],
      },
    ],
    { initialEntries: [initialPath] },
  );
  render(
    <TestProviders>
      <RouterProvider router={router} />
    </TestProviders>,
  );
  return router;
}

function headerSearchInput(): HTMLElement {
  return screen.getByRole('textbox', { name: 'Từ khoá tìm kiếm' });
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
});

describe('site-header — ô tìm kiếm ở giữa (issue #303)', () => {
  it('gõ từ khoá + Enter ở ô giữa → tới /search?q=… đã mã hoá', async () => {
    stubFetch();
    renderHeader('/');
    const user = userEvent.setup();
    await user.type(headerSearchInput(), 'khoá học{Enter}');
    await waitFor(() =>
      expect(screen.getByTestId('current-path')).toHaveTextContent(`/search?q=${encodeURIComponent('khoá học')}`),
    );
    expect(await screen.findByText('Trang kết quả thử')).toBeInTheDocument();
  });

  it('mở thẳng /search?q=abc → ô giữa hiện sẵn abc; q đổi thì ô đổi theo', async () => {
    stubFetch();
    const router = renderHeader('/search?q=abc');
    expect(headerSearchInput()).toHaveValue('abc');
    await act(async () => {
      await router.navigate('/search?q=xyz');
    });
    expect(headerSearchInput()).toHaveValue('xyz');
  });

  it('ô trống hoặc chỉ khoảng trắng + Enter → không điều hướng', async () => {
    stubFetch();
    renderHeader('/courses');
    const user = userEvent.setup();
    await user.type(headerSearchInput(), '{Enter}');
    await user.type(headerSearchInput(), '   {Enter}');
    expect(screen.getByTestId('current-path')).toHaveTextContent('/courses');
    expect(screen.queryByText('Trang kết quả thử')).not.toBeInTheDocument();
  });

  it('không còn nút Tìm nhanh riêng ở header; Ctrl+K vẫn mở bề mặt hợp nhất', async () => {
    stubFetch();
    renderHeader('/');
    expect(screen.queryByTestId('command-palette-trigger')).not.toBeInTheDocument();
    expect(screen.queryByText('Tìm nhanh…')).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByTestId('command-palette')).toBeInTheDocument();
  });
});

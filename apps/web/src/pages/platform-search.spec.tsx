import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { SearchPage } from './platform-search';

/**
 * Test cho trang kết quả tìm kiếm sau chốt 23:52 ngày 26/10/2026
 * (issue #303 — ô tìm kiếm giữa header là đường chính dẫn tới
 * trang này):
 *
 * - Vào trang bằng link `/search?q=abc` (đúng link ô giữa header
 *   tạo ra) → ô của trang điền sẵn "abc" và API tìm kiếm được gọi
 *   NGAY bằng đúng từ khoá đó, kết quả hiện ra không cần thao tác.
 * - Vào `/search` trần (không tham số) → không gọi API, ô trống —
 *   giữ nguyên trạng thái khởi đầu như trước.
 * - Form trong trang giữ hành vi cũ: gõ từ khoá khác + bấm "Tìm
 *   kiếm" thì chạy lại bằng từ khoá mới.
 */

const DOC = {
  id: 'doc-1',
  area: 'course',
  itemId: 'course-1',
  title: 'Khoá Toán 10',
  content: 'Nội dung khoá toán',
};

let searchCalls: string[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch() {
  searchCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.startsWith('/api/v1/search?q=')) {
        searchCalls.push(url);
        return jsonResponse([DOC]);
      }
      return jsonResponse({}, 404);
    }),
  );
}

function renderSearch(initialPath = '/search') {
  const router = createMemoryRouter([{ path: 'search', element: <SearchPage /> }], {
    initialEntries: [initialPath],
  });
  render(
    <TestProviders>
      <RouterProvider router={router} />
    </TestProviders>,
  );
  return router;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('trang kết quả tìm kiếm — đọc tham số q (issue #303)', () => {
  it('vào bằng /search?q=abc → ô điền sẵn abc và chạy tìm ngay', async () => {
    stubFetch();
    renderSearch('/search?q=abc');
    expect(screen.getByLabelText('Từ khoá tìm kiếm')).toHaveValue('abc');
    expect(await screen.findByText('Khoá Toán 10')).toBeInTheDocument();
    expect(searchCalls).toEqual(['/api/v1/search?q=abc']);
  });

  it('vào /search trần → không gọi API, ô trống', async () => {
    stubFetch();
    renderSearch('/search');
    expect(await screen.findByRole('button', { name: 'Tìm kiếm' })).toBeInTheDocument();
    expect(screen.getByLabelText('Từ khoá tìm kiếm')).toHaveValue('');
    expect(searchCalls).toEqual([]);
  });

  it('form trong trang giữ hành vi cũ: gõ + bấm Tìm kiếm chạy bằng từ khoá mới', async () => {
    stubFetch();
    renderSearch('/search');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Từ khoá tìm kiếm'), 'văn');
    await user.click(screen.getByRole('button', { name: 'Tìm kiếm' }));
    expect(await screen.findByText('Khoá Toán 10')).toBeInTheDocument();
    expect(searchCalls).toEqual([`/api/v1/search?q=${encodeURIComponent('văn')}`]);
  });
});

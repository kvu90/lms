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
 * - Kết quả ĐIỀU HƯỚNG ĐƯỢC (chốt gộp tìm kiếm 27/10/2026): bấm
 *   một kết quả thì tới đúng trang của item đó theo loại — khoá
 *   học → /courses/:id, người dùng → /admin/users/:id/edit, học
 *   liệu → /content-bank/:id/edit (trước chốt này danh sách chỉ
 *   là chữ tĩnh không bấm được).
 */

// Hình dạng kết quả khớp API thật: `area` là một trong ba area
// phía API đăng ký (courses/users/contentbank), `itemId` là định
// danh của chính item — bản cũ dùng area 'course' sai hợp đồng mà
// không lộ vì trang cũ chỉ in chữ tĩnh, không ánh xạ đích.
const DOC = {
  id: 'doc-1',
  area: 'courses',
  itemId: 'course-1',
  title: 'Khoá Toán 10',
  content: 'Nội dung khoá toán',
};

const USER_DOC = {
  id: 'doc-2',
  area: 'users',
  itemId: 'user-1',
  title: 'Nguyễn Văn A',
  content: 'vana học viên',
};

const CONTENT_DOC = {
  id: 'doc-3',
  area: 'contentbank',
  itemId: 'item-1',
  title: 'Bài giảng Đại số',
  content: 'Học liệu đại số',
};

let searchCalls: string[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(docs: unknown[] = [DOC]) {
  searchCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.startsWith('/api/v1/search?q=')) {
        searchCalls.push(url);
        return jsonResponse(docs);
      }
      return jsonResponse({}, 404);
    }),
  );
}

function renderSearch(initialPath = '/search') {
  const router = createMemoryRouter(
    [
      { path: 'search', element: <SearchPage /> },
      // Các route đích của kết quả: chỉ cần tồn tại để khẳng định
      // pathname sau khi bấm kết quả.
      { path: 'courses/:id', element: <div data-testid="probe-target" /> },
      { path: 'admin/users/:userId/edit', element: <div data-testid="probe-target" /> },
      { path: 'content-bank/:id/edit', element: <div data-testid="probe-target" /> },
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

describe('trang kết quả tìm kiếm — kết quả điều hướng được (chốt gộp 27/10/2026)', () => {
  it('bấm kết quả khoá học → tới /courses/:id', async () => {
    stubFetch([DOC]);
    const router = renderSearch('/search?q=toán');
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('search-result-doc-1'));
    expect(router.state.location.pathname).toBe('/courses/course-1');
  });

  it('bấm kết quả người dùng → tới /admin/users/:id/edit', async () => {
    stubFetch([USER_DOC]);
    const router = renderSearch('/search?q=văn');
    const user = userEvent.setup();
    const link = await screen.findByTestId('search-result-doc-2');
    expect(link).toHaveTextContent('Người dùng');
    await user.click(link);
    expect(router.state.location.pathname).toBe('/admin/users/user-1/edit');
  });

  it('bấm kết quả học liệu → tới /content-bank/:id/edit', async () => {
    stubFetch([CONTENT_DOC]);
    const router = renderSearch('/search?q=đại');
    const user = userEvent.setup();
    const link = await screen.findByTestId('search-result-doc-3');
    expect(link).toHaveTextContent('Nội dung học liệu');
    await user.click(link);
    expect(router.state.location.pathname).toBe('/content-bank/item-1/edit');
  });
});

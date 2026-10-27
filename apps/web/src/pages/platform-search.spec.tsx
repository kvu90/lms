import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { baSessionResponse, isGetSessionUrl } from '#test/ba-session';
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
 * - Riêng kết quả người dùng, đích màn quản trị chỉ gắn theo
 *   quyền của NGƯỜI TÌM (điều kiện review của PR gộp tìm kiếm):
 *   người tìm có quyền quản trị người dùng (`user:update` tại
 *   context hệ thống) thì bấm được tới màn quản trị; người tìm
 *   không có quyền đó (học viên — vẫn nhận kết quả `users` từ
 *   API) thì kết quả hiện dạng thông tin, không có liên kết nào
 *   tới màn quản trị.
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

/**
 * Hai người tìm mẫu cho các ca kết quả `users`: học viên (ảnh chụp
 * quyền không có `user:update`) và quản trị người dùng (có đúng
 * capability `user:update` tại context hệ thống — capability màn
 * đích `/admin/users/:id/edit` tự gác, không cần cờ site admin).
 */
const SYSTEM_CONTEXT_ID = '01900000-0000-7000-8000-0000000000d4';
const STUDENT_VIEWER = {
  profile: {
    id: '01900000-0000-7000-8000-0000000000b2',
    username: 'student',
    firstName: 'Tên',
    lastName: 'Mẫu',
    email: 'student@example.com',
    suspended: false,
    deleted: false,
    isGuest: false,
    forcePasswordChange: false,
    lastLogin: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    customFields: [],
  },
  access: {
    userId: '01900000-0000-7000-8000-0000000000b2',
    isSiteAdmin: false,
    assignments: [],
    contexts: [],
    hasLearnerArtifacts: false,
  },
};
const USER_ADMIN_VIEWER = {
  profile: {
    ...STUDENT_VIEWER.profile,
    id: '01900000-0000-7000-8000-0000000000a1',
    username: 'usermanager',
    email: 'usermanager@example.com',
  },
  access: {
    userId: '01900000-0000-7000-8000-0000000000a1',
    isSiteAdmin: false,
    assignments: [],
    contexts: [
      {
        contextId: SYSTEM_CONTEXT_ID,
        contextLevel: 10,
        contextPath: '/1',
        capabilities: ['user:update'],
      },
    ],
    hasLearnerArtifacts: false,
  },
};

/**
 * Stub fetch cho trang: mặc định không phiên (các ca không phụ
 * thuộc quyền); truyền `viewer` thì có thêm phiên Better Auth +
 * hồ sơ + ảnh chụp quyền của người tìm đó.
 */
function stubFetch(docs: unknown[] = [DOC], viewer?: { profile: unknown; access: unknown }) {
  searchCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (viewer && isGetSessionUrl(url)) {
        return baSessionResponse({ id: (viewer.profile as { id: string }).id });
      }
      if (viewer && url === '/api/v1/users/me') return jsonResponse(viewer.profile);
      if (viewer && url === '/api/v1/users/me/capabilities') return jsonResponse(viewer.access);
      if (viewer && url === '/api/v1/courses') return jsonResponse([]);
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

  it('người tìm có quyền quản trị người dùng: bấm kết quả người dùng → tới /admin/users/:id/edit', async () => {
    stubFetch([USER_DOC], USER_ADMIN_VIEWER);
    const router = renderSearch('/search?q=văn');
    const user = userEvent.setup();
    const link = await screen.findByTestId('search-result-doc-2');
    expect(link).toHaveTextContent('Người dùng');
    await user.click(link);
    expect(router.state.location.pathname).toBe('/admin/users/user-1/edit');
  });

  it('người tìm không có quyền quản trị người dùng: kết quả người dùng hiện dạng thông tin, không liên kết tới màn quản trị', async () => {
    stubFetch([USER_DOC], STUDENT_VIEWER);
    renderSearch('/search?q=văn');
    // Kết quả vẫn hiện đầy đủ thông tin (API trả cho mọi người tìm)…
    expect(await screen.findByText('Nguyễn Văn A')).toBeInTheDocument();
    expect(screen.getByText('vana học viên')).toBeInTheDocument();
    // …nhưng không phải liên kết và không có neo nào tới màn quản trị.
    expect(screen.queryByTestId('search-result-doc-2')).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/admin/users/user-1/edit"]')).toBeNull();
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

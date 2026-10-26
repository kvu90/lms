import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Outlet, RouterProvider, useRouteError } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import App, { loader as rootLoader } from '../root';
import Shell from './shell';
import { RouteErrorBoundary } from '../components/route-error-boundary';
import { queryClient } from '../lib/query-client';
import { baSessionResponse, isGetSessionUrl } from '#test/ba-session';

/**
 * Spec nghiệm thu cụm khung SSR (issue #146, từ rà soát #133):
 *
 * - F-11: root loader đọc cookie `sidebar_state` của chính request và
 *   trả `sidebarDefaultOpen` tương ứng; không có cookie phiên Better
 *   Auth thì KHÔNG gọi API (giữ nguyên tắc cách ly GĐ4). Shell dựng từ
 *   giá trị loader cho data-state khớp (false → collapsed, true →
 *   expanded) ngay từ lần render đầu.
 * - F-07: một route lá lỗi (loader ném lỗi route) thì biên lỗi của
 *   route đó hiện trong vùng nội dung, khung vẫn nguyên; bấm Thử lại
 *   (revalidate) sau khi hết lỗi thì trang hiện lại.
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

function requestWithCookie(cookie: string): Request {
  return new Request('http://localhost/', { headers: { Cookie: cookie } });
}

beforeAll(() => {
  // jsdom không có matchMedia; hook useIsMobile của @lms/ui cần nó khi
  // sidebar mount — stub tối thiểu trả "không phải mobile" (như
  // shell.spec.tsx).
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
  queryClient.clear();
});

describe('F-11 — root loader đọc cookie sidebar_state từ request', () => {
  it('sidebar_state=false → sidebarDefaultOpen=false, không gọi API khi không có cookie phiên', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal('fetch', fetchSpy);

    const data = await rootLoader({ request: requestWithCookie('sidebar_state=false') });

    expect(data.sidebarDefaultOpen).toBe(false);
    expect(data.initialUser).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sidebar_state=true → sidebarDefaultOpen=true; không có cookie → mặc định mở', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      rootLoader({ request: requestWithCookie('sidebar_state=true') }),
    ).resolves.toMatchObject({ sidebarDefaultOpen: true, initialUser: null });
    await expect(rootLoader({ request: requestWithCookie('') })).resolves.toMatchObject({
      sidebarDefaultOpen: true,
      initialUser: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('có cookie phiên Better Auth → gọi /users/me với nguyên Cookie và vẫn trả sidebarDefaultOpen từ cookie', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(PROFILE));
    vi.stubGlobal('fetch', fetchSpy);

    const data = await rootLoader({
      request: requestWithCookie('better-auth.session_token=abc; sidebar_state=false'),
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/v1/users/me');
    expect(new Headers(init.headers).get('Cookie')).toBe('better-auth.session_token=abc; sidebar_state=false');
    expect(data.initialUser?.username).toBe('admin');
    expect(data.sidebarDefaultOpen).toBe(false);
  });
});

describe('F-11 — shell dựng sidebar từ giá trị loader', () => {
  function renderShellWithSidebarDefault(sidebarDefaultOpen: boolean) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (isGetSessionUrl(url)) return baSessionResponse({ id: ADMIN_ID, username: 'admin', email: 'admin@example.com' });
        if (url === '/api/v1/users/me/capabilities') return jsonResponse(ACCESS);
        if (url === '/api/v1/courses') return jsonResponse([]);
        return jsonResponse({}, 404);
      }),
    );
    const router = createMemoryRouter(
      [
        {
          path: '/',
          loader: () => ({ initialUser: PROFILE, sidebarDefaultOpen }),
          element: <App />,
          children: [
            {
              element: <Shell />,
              children: [{ index: true, element: <div>Nội dung trang</div> }],
            },
          ],
        },
      ],
      { initialEntries: ['/'] },
    );
    return render(<RouterProvider router={router} />);
  }

  it('sidebarDefaultOpen=false → sidebar ở data-state collapsed ngay lần render đầu', async () => {
    const { container } = renderShellWithSidebarDefault(false);
    await screen.findByText('Nội dung trang');
    const sidebar = container.querySelector('[data-slot="sidebar"]');
    expect(sidebar).not.toBeNull();
    expect(sidebar?.getAttribute('data-state')).toBe('collapsed');
  });

  it('sidebarDefaultOpen=true → sidebar ở data-state expanded', async () => {
    const { container } = renderShellWithSidebarDefault(true);
    await screen.findByText('Nội dung trang');
    const sidebar = container.querySelector('[data-slot="sidebar"]');
    expect(sidebar).not.toBeNull();
    expect(sidebar?.getAttribute('data-state')).toBe('expanded');
  });
});

describe('F-07 — ErrorBoundary theo route chứa lỗi trong vùng nội dung', () => {
  it('route lỗi: khung còn nguyên, biên lỗi hiện có nút Thử lại; hết lỗi bấm Thử lại thì trang hiện lại', async () => {
    let failing = true;
    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: (
            <div data-testid="frame">
              <header>Khung trang</header>
              <Outlet />
            </div>
          ),
          children: [
            {
              path: 'boom',
              loader: () => {
                if (failing) {
                  throw new Response('Internal Server Error', {
                    status: 500,
                    statusText: 'Internal Server Error',
                  });
                }
                return null;
              },
              element: <div>Nội dung trang đã tải</div>,
              // Framework mode truyền { error, params, loaderData,
              // actionData } vào export ErrorBoundary của route module
              // (lớp bọc withErrorBoundaryProps của createClientRoutes).
              // Data router trần không truyền props, nên spec bọc tay
              // đúng ngữ nghĩa đó: lấy lỗi route bằng useRouteError rồi
              // đưa vào biên dùng chung qua prop error.
              ErrorBoundary: function BoomErrorBoundary() {
                const error = useRouteError();
                return <RouteErrorBoundary error={error} />;
              },
            },
          ],
        },
      ],
      { initialEntries: ['/boom'] },
    );
    render(<RouterProvider router={router} />);

    // Biên lỗi của route hiện trong vùng nội dung, khung vẫn nguyên.
    expect(await screen.findByText('Không tải được trang này')).toBeInTheDocument();
    expect(screen.getByText((content) => content.startsWith('500'))).toBeInTheDocument();
    expect(screen.getByTestId('frame')).toBeInTheDocument();
    expect(screen.getByText('Khung trang')).toBeInTheDocument();
    expect(screen.queryByText('Nội dung trang đã tải')).not.toBeInTheDocument();

    failing = false;
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));

    expect(await screen.findByText('Nội dung trang đã tải')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText('Không tải được trang này')).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('frame')).toBeInTheDocument();
  });
});

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth';
import { PermissionsProvider } from '@/lib/permissions';
import { BadgesPage } from './badges';

/**
 * Spec huy hiệu theo endpoint thật: "của tôi" qua GET /badges/mine (không
 * còn đường ghép theo userId), kích hoạt qua POST /badges/:id/status với
 * { status: 1 } (không còn /activate), và danh sách đã cấp của một badge
 * qua GET /badges/:id/issued trong panel quản trị (canAdminister).
 */
const ADMIN_ID = '01900000-0000-7000-8000-0000000000a1';
const BADGE_ID = '01900000-0000-7000-8000-000000000002';
const ISSUED_USER_ID = '01900000-0000-7000-8000-000000000099';

const PROFILE = {
  id: ADMIN_ID, username: 'admin', firstname: 'Quản', lastname: 'Trị', email: 'admin@example.com', suspended: false,
  deleted: false, isGuest: false, forcePasswordChange: false, lastlogin: null,
  timecreated: '2026-01-01T00:00:00.000Z', customFields: [],
};

interface RecordedCall { url: string; method: string; body: unknown }

/** Stub fetch ghi lại mọi lời gọi; badge lật trạng thái sau khi POST /status thành công. */
function stubFetch(calls: RecordedCall[], state: { badgeStatus: number }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url === '/api/v1/users/me') return respond(PROFILE);
    if (url === '/api/v1/users?pageSize=1') return respond({ users: [PROFILE], total: 1, page: 1, pageSize: 1 });
    if (url === '/api/v1/access/roles') return respond([]);
    if (url === '/api/v1/questions/categories') return respond([]);
    if (url === '/api/v1/courses') return respond([]);
    if (url === '/api/v1/badges') {
      return respond([{ id: BADGE_ID, name: 'Finisher', description: '', type: 1, courseid: null, status: state.badgeStatus }]);
    }
    if (url === '/api/v1/badges/mine') {
      return respond([{
        id: '01900000-0000-7000-8000-000000000011', badgeid: BADGE_ID, userid: ADMIN_ID, uniquehash: 'abcdef0123456789',
        dateissued: '2026-10-20T00:00:00.000Z', dateexpire: null, revoked: false,
        badge: { id: BADGE_ID, name: 'Finisher', description: '', type: 1, courseid: null, status: 1 },
      }]);
    }
    if (url === `/api/v1/badges/${BADGE_ID}/status` && method === 'POST') {
      state.badgeStatus = 1;
      return respond({ id: BADGE_ID, name: 'Finisher', description: '', type: 1, courseid: null, status: 1 });
    }
    if (url === `/api/v1/badges/${BADGE_ID}/criteria` && method === 'PUT') {
      return respond({ method: 1, criteria: [] });
    }
    if (url === `/api/v1/badges/${BADGE_ID}/issued`) {
      return respond([{
        id: '01900000-0000-7000-8000-000000000021', badgeid: BADGE_ID, userid: ISSUED_USER_ID, uniquehash: 'feedface99887766',
        dateissued: '2026-10-21T00:00:00.000Z', dateexpire: null, revoked: false,
      }]);
    }
    return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  }));
}

/** Render trang huy hiệu trong đúng khung provider của ứng dụng thật. */
function renderBadges() {
  const router = createMemoryRouter([{ path: '/badges', element: <BadgesPage /> }], { initialEntries: ['/badges'] });
  render(
    <AuthProvider>
      <PermissionsProvider>
        <RouterProvider router={router} />
      </PermissionsProvider>
    </AuthProvider>,
  );
}

describe('Badges page — real endpoints', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

  it('loads my badges from /badges/mine and never calls the old per-user or activate URLs', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubFetch(calls, { badgeStatus: 0 });
    renderBadges();

    expect((await screen.findAllByText('Finisher')).length).toBeGreaterThan(0);
    expect(calls.some((c) => c.url === '/api/v1/badges/mine' && c.method === 'GET')).toBe(true);
    expect(calls.some((c) => c.url.includes('/badges/users/'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/activate'))).toBe(false);
  });

  it('activates a badge via POST /badges/:id/status with { status: 1 }', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    const state = { badgeStatus: 0 };
    stubFetch(calls, state);
    renderBadges();

    const activateButton = await screen.findByRole('button', { name: 'Kích hoạt' });
    await userEvent.click(activateButton);

    await waitFor(() => expect(calls.some((c) => c.url === `/api/v1/badges/${BADGE_ID}/status`)).toBe(true));
    const statusCall = calls.find((c) => c.url === `/api/v1/badges/${BADGE_ID}/status`);
    expect(statusCall?.method).toBe('POST');
    expect(statusCall?.body).toEqual({ status: 1 });
    expect(calls.some((c) => c.url.includes('/activate'))).toBe(false);
  });

  it('shows the issued list of a badge from GET /badges/:id/issued in the admin panel', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubFetch(calls, { badgeStatus: 1 });
    renderBadges();

    const viewButton = await screen.findByRole('button', { name: 'Xem đã cấp' });
    await userEvent.click(viewButton);

    await waitFor(() => expect(calls.some((c) => c.url === `/api/v1/badges/${BADGE_ID}/issued` && c.method === 'GET')).toBe(true));
    expect(await screen.findByText(new RegExp(ISSUED_USER_ID))).toBeInTheDocument();
  });

  it('saves criteria via PUT with the contracts payload shape (criteria array, not leaves)', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubFetch(calls, { badgeStatus: 1 });
    renderBadges();

    const courseId = '01900000-0000-7000-8000-0000000000c1';
    await userEvent.type(await screen.findByLabelText('ID huy hiệu'), BADGE_ID);
    await userEvent.type(screen.getByLabelText('ID khoá học cho tiêu chí hoàn thành khoá học'), courseId);
    await userEvent.click(screen.getByRole('button', { name: 'Đặt tiêu chí (TẤT CẢ)' }));

    await waitFor(() => expect(calls.some((c) => c.url === `/api/v1/badges/${BADGE_ID}/criteria` && c.method === 'PUT')).toBe(true));
    const putCall = calls.find((c) => c.url === `/api/v1/badges/${BADGE_ID}/criteria`);
    expect(putCall?.body).toEqual({
      method: 1,
      criteria: [{ criteriatype: 'coursecompletion', params: { courseId } }],
    });
  });
});

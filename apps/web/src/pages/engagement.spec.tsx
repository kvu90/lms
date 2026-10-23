import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { PermissionsProvider } from '#lib/permissions';
import { BadgesPage } from './badges';
import { NotificationsPage } from './notifications';

/**
 * Engagement web tests (Testing Library): the two DoD-adjacent behaviours —
 * a notification preference toggle writes through to the API, and the
 * "my badges" list renders the caller's issued assertions.
 */
const PROFILE = {
  id: '01900000-0000-7000-8000-000000000007',
  username: 'learner7',
  firstName: 'Learner',
  lastName: 'Seven',
  suspended: false,
  deleted: false,
  isGuest: false,
  forcePasswordChange: false,
  lastLogin: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  customFields: [],
};

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = handler(url, init);
      if (body === undefined)
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

describe('Notifications page', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('toggling a preference sends a PUT with the flipped logged-in preference', async () => {
    const puts: unknown[] = [];
    stubFetch((url, init) => {
      if (url === '/api/v1/notifications')
        return [
          {
            id: '01900000-0000-7000-8000-000000000001',
            subject: 'Badge awarded',
            fullMessage: 'You earned Finisher',
            eventType: 'badge_awarded',
            timeRead: null,
            createdAt: '2026-10-22T00:00:00.000Z',
          },
        ];
      if (url === '/api/v1/messages/preferences' && init?.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)));
        return { saved: true };
      }
      if (url === '/api/v1/messages/preferences')
        return [
          { provider: 'badge_awarded', channel: 'popup', loggedin: true, loggedoff: true },
          { provider: 'badge_awarded', channel: 'email', loggedin: true, loggedoff: false },
        ];
      return undefined;
    });
    render(<NotificationsPage />);
    await waitFor(() => expect(screen.getByText('Badge awarded')).toBeInTheDocument());
    const toggle = screen.getByLabelText('badge_awarded popup đã đăng nhập');
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() => expect(puts).toHaveLength(1));
    const saved = (
      puts[0] as { preferences: { provider: string; channel: string; loggedin: boolean }[] }
    ).preferences.find((p) => p.provider === 'badge_awarded' && p.channel === 'popup');
    expect(saved?.loggedin).toBe(false);
  });
});

describe('Badges page', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders my issued badges with their assertion hashes, including revoked ones', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    stubFetch((url) => {
      if (url === '/api/v1/users/me') return PROFILE;
      // Điểm dò quyền của PermissionsProvider: học viên thường bị từ chối
      // (404 → probe null) nên panel quản trị phải ẩn, phần của tôi vẫn hiện.
      if (url === '/api/v1/courses') return [];
      if (url === '/api/v1/badges')
        return [
          {
            id: '01900000-0000-7000-8000-000000000002',
            name: 'Finisher',
            description: '',
            type: 1,
            courseId: null,
            status: 1,
          },
          {
            id: '01900000-0000-7000-8000-000000000003',
            name: 'Old honour',
            description: '',
            type: 1,
            courseId: null,
            status: 3,
          },
        ];
      // Shape thật của GET /badges/mine: IssuedRow kèm badge lồng bên trong.
      if (url === '/api/v1/badges/mine')
        return [
          {
            id: '01900000-0000-7000-8000-000000000011',
            badgeId: '01900000-0000-7000-8000-000000000002',
            userId: PROFILE.id,
            uniqueHash: 'abcdef0123456789',
            dateIssued: '2026-10-20T00:00:00.000Z',
            dateExpire: null,
            revoked: false,
            badge: {
              id: '01900000-0000-7000-8000-000000000002',
              name: 'Finisher',
              description: '',
              type: 1,
              courseId: null,
              status: 1,
            },
          },
          {
            id: '01900000-0000-7000-8000-000000000012',
            badgeId: '01900000-0000-7000-8000-000000000003',
            userId: PROFILE.id,
            uniqueHash: '0011223344556677',
            dateIssued: '2026-09-01T00:00:00.000Z',
            dateExpire: null,
            revoked: true,
            badge: {
              id: '01900000-0000-7000-8000-000000000003',
              name: 'Old honour',
              description: '',
              type: 1,
              courseId: null,
              status: 3,
            },
          },
        ];
      return undefined;
    });
    const router = createMemoryRouter([{ path: '/badges', element: <BadgesPage /> }], { initialEntries: ['/badges'] });
    render(
      <TestProviders>
        <PermissionsProvider>
          <RouterProvider router={router} />
        </PermissionsProvider>
      </TestProviders>,
    );
    // Wait for the issued list itself (it loads after the auth profile resolves).
    expect(await screen.findByText(/Old honour \(đã thu hồi\)/)).toBeInTheDocument();
    expect(screen.getByText(/bản ghi abcdef012345/)).toBeInTheDocument();
    expect(screen.queryByText('Quản trị huy hiệu')).not.toBeInTheDocument();
  });
});

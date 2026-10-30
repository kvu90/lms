import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { baSessionBody, isGetSessionUrl } from '#test/ba-session';
import { PermissionsProvider } from '#lib/permissions';
import { BadgesPage } from './routes/badges';

/**
 * Test web cho trang huy hiệu (Testing Library): danh sách "huy
 * hiệu của tôi" hiển thị các assertion đã cấp của chính người gọi.
 *
 * File này là nửa badges của `pages/engagement.spec.tsx` cũ, tách
 * theo miền khi tổ chức lại apps/web theo mô hình features/
 * (issue #500); nửa notifications nằm ở feature notifications.
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

describe('Trang huy hiệu', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('render các huy hiệu đã cấp của tôi kèm hash assertion của chúng, kể cả huy hiệu đã thu hồi', async () => {
    stubFetch((url) => {
      if (isGetSessionUrl(url)) return baSessionBody({ id: PROFILE.id, username: PROFILE.username });
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
    // Chờ chính danh sách đã cấp (nó tải sau khi hồ sơ auth được phân giải).
    expect(await screen.findByText(/Old honour \(đã thu hồi\)/)).toBeInTheDocument();
    expect(screen.getByText(/bản ghi abcdef012345/)).toBeInTheDocument();
    expect(screen.queryByText('Quản trị huy hiệu')).not.toBeInTheDocument();
  });
});

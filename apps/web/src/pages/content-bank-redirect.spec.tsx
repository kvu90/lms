import { cleanup, render, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { baSessionBody, isGetSessionUrl } from '#test/ba-session';
import ContentBankRoute from '../routes/contentbank';
import ContentBankNewRoute from '../routes/contentbank-new';
import ContentBankEditRoute from '../routes/contentbank-edit';
import LegacyContentBankRoute from '../routes/legacy-contentbank';
import LegacyContentBankNewRoute from '../routes/legacy-contentbank-new';
import LegacyContentBankEditRoute from '../routes/legacy-contentbank-edit';

/**
 * Lớp tương thích đường dẫn cũ của họ Kho học liệu (chuẩn đường
 * dẫn #221, lát R3): ba path cũ viết dính /contentbank* phải
 * CHUYỂN HƯỚNG THAY THẾ sang cây viết tách /content-bank* — kiểm
 * bằng route module thật trong memory router, khẳng định pathname
 * cuối cùng. Query trạng thái nội bộ của trang (lọc) được giữ
 * nguyên khi chuyển như khuôn lớp tương thích của cụm ngân hàng.
 */

const PROFILE = {
  id: '01900000-0000-7000-8000-0000000000a9',
  username: 'teacher1',
  firstName: 'Lan Anh',
  lastName: 'Nguyễn',
  email: 'teacher1@example.com',
  suspended: false,
  deleted: false,
  isGuest: false,
  forcePasswordChange: false,
  lastLogin: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  customFields: [],
};

const ITEM_ID = '01900000-0000-7000-8000-0000000000e5';

function stubRedirectFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const respond = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/users/me/capabilities')
        return respond({ userId: PROFILE.id, isSiteAdmin: false, assignments: [], contexts: [] });
      if (url === '/api/v1/contentbank/spaces') return respond([]);
      if (url === '/api/v1/contentbank') return respond([]);
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

const REDIRECT_CASES: Array<{ from: string; toPath: string; toSearch?: string }> = [
  { from: '/contentbank', toPath: '/content-bank', toSearch: '' },
  { from: '/contentbank?reviewStatus=pending', toPath: '/content-bank', toSearch: '?reviewStatus=pending' },
  { from: '/contentbank/new', toPath: '/content-bank/new', toSearch: '' },
  { from: `/contentbank/${ITEM_ID}/edit`, toPath: `/content-bank/${ITEM_ID}/edit`, toSearch: '' },
];

describe('Legacy content bank URLs — redirect to new paths (issue #221, R3)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  for (const redirectCase of REDIRECT_CASES) {
    it(`${redirectCase.from} → ${redirectCase.toPath}`, async () => {
      stubRedirectFetch();
      const router = createMemoryRouter(
        [
          { path: '/content-bank', element: <ContentBankRoute /> },
          { path: '/content-bank/new', element: <ContentBankNewRoute /> },
          { path: '/content-bank/:id/edit', element: <ContentBankEditRoute /> },
          { path: '/contentbank', element: <LegacyContentBankRoute /> },
          { path: '/contentbank/new', element: <LegacyContentBankNewRoute /> },
          { path: '/contentbank/:id/edit', element: <LegacyContentBankEditRoute /> },
        ],
        { initialEntries: [redirectCase.from] },
      );
      render(
        <TestProviders>
          <RouterProvider router={router} />
        </TestProviders>,
      );

      await waitFor(() => expect(router.state.location.pathname).toBe(redirectCase.toPath));
      if (redirectCase.toSearch !== undefined) {
        expect(router.state.location.search).toBe(redirectCase.toSearch);
      }
    });
  }
});

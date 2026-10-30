import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { PlayerPage } from './player';

const COURSE_ID = '01900000-0000-7000-8000-000000000010';
const PAGE_CM = '01900000-0000-7000-8000-000000001000';
const URL_CM = '01900000-0000-7000-8000-000000001001';
const USER_ID = '01900000-0000-7000-8000-000000000777';

function playerPayload(overrides: Record<string, unknown> = {}) {
  return {
    course: { id: COURSE_ID, fullName: 'Physics 101', shortName: 'PHY101' },
    cm: { id: PAGE_CM, name: 'Bài đọc 1', component: 'mod_page', instanceId: '01900000-0000-7000-8000-000000002000' },
    content: { type: 'page', page: { id: '01900000-0000-7000-8000-000000002000', name: 'Bài đọc 1', content: '<p>Nội dung bài đọc</p>' } },
    completion: { state: 0, viewed: false, mode: 'view' },
    progress: {
      percent: 0,
      completed: 0,
      total: 2,
      sections: [
        {
          sectionId: '01900000-0000-7000-8000-000000000100',
          name: 'Tuần 1',
          section: 1,
          percent: 0,
          items: [
            { cmId: PAGE_CM, name: 'Bài đọc 1', component: 'mod_page', completion: 2, state: 0, viewed: false, done: false },
            { cmId: URL_CM, name: 'Video bài giảng', component: 'mod_resource', completion: 1, state: 0, viewed: false, done: false },
          ],
        },
      ],
    },
    prevCmId: null,
    nextCmId: URL_CM,
    ...overrides,
  };
}

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const body = handler(url, init);
      if (body === undefined)
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return calls;
}

function renderPlayer(cmId: string) {
  const router = createMemoryRouter([{ path: '/courses/:id/learn/:cmId', element: <PlayerPage /> }], {
    initialEntries: [`/courses/${COURSE_ID}/learn/${cmId}`],
  });
  render(
    <TestProviders>
      <RouterProvider router={router} />
    </TestProviders>,
  );
}

describe('Trang trình phát (K2)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('render nội dung trang kèm dàn ý + liên kết tiếp theo, và tự ghi lại lượt xem qua POST /view', async () => {
    const calls = stubFetch((url, init) => {
      if (url === `/api/v1/courses/${COURSE_ID}/player/${PAGE_CM}`) return playerPayload();
      if (url === `/api/v1/courses/${COURSE_ID}/modules/${PAGE_CM}/view` && init?.method === 'POST') return { cmId: PAGE_CM, viewed: true };
      return undefined;
    });
    renderPlayer(PAGE_CM);
    await waitFor(() => expect(screen.getByText('Nội dung bài đọc')).toBeInTheDocument());
    // Outline kề bên có cả hai mục, mục sau nối sang player của nó.
    expect(screen.getByRole('link', { name: 'Video bài giảng' })).toHaveAttribute('href', `/courses/${COURSE_ID}/learn/${URL_CM}`);
    expect(screen.getByRole('link', { name: 'Tiếp' })).toHaveAttribute('href', `/courses/${COURSE_ID}/learn/${URL_CM}`);
    // Tự ghi nhận đã xem qua endpoint /view sẵn có.
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith(`/modules/${PAGE_CM}/view`) && c.init?.method === 'POST')).toBe(true),
    );
  });

  it('manual-mode link resource shows the embed and "Đánh dấu đã học" posts manual completion for self', async () => {
    const calls = stubFetch((url, init) => {
      if (url === `/api/v1/courses/${COURSE_ID}/player/${URL_CM}`) {
        return playerPayload({
          cm: { id: URL_CM, name: 'Video bài giảng', component: 'mod_resource', instanceId: '01900000-0000-7000-8000-000000002001' },
          content: {
            type: 'resource',
            resource: { id: '01900000-0000-7000-8000-000000002001', name: 'Video bài giảng', kind: 'url', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
            file: null,
            embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
          },
          completion: { state: 0, viewed: false, mode: 'manual' },
          prevCmId: PAGE_CM,
          nextCmId: null,
        });
      }
      if (url === `/api/v1/courses/${COURSE_ID}/completion/me`) return { activities: [], course: { userId: USER_ID } };
      if (url === `/api/v1/courses/${COURSE_ID}/modules/${URL_CM}/completion/manual` && init?.method === 'POST') return { state: 1 };
      return undefined;
    });
    renderPlayer(URL_CM);
    const button = await screen.findByRole('button', { name: 'Đánh dấu đã học' });
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
    await userEvent.click(button);
    await waitFor(() => {
      const post = calls.find((c) => c.url.endsWith(`/modules/${URL_CM}/completion/manual`));
      expect(post).toBeDefined();
      expect(JSON.parse(String(post!.init?.body))).toEqual({ userId: USER_ID, complete: true });
    });
  });
});

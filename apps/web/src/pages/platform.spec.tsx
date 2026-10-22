import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrivacyPage, SearchPage } from './platform';

/**
 * Platform web tests (Testing Library): global search hiển thị đúng kết quả đã
 * lọc quyền mà server trả về, và user tự gửi được privacy request.
 */
function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = handler(url, init);
    if (body === undefined) return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
}

describe('Search page (platform)', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('submits the query and renders only the permission-filtered results returned by the API', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/v1/search?q=')) return [
        { id: 1, area: 'courses', itemid: 5, contextid: 9, title: 'Visible Course', content: 'You may see this' },
      ];
      return undefined;
    });
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText('Search query'), 'Visible');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Visible Course')).toBeInTheDocument();
    expect(screen.queryByText('Hidden Course')).not.toBeInTheDocument();
  });
});

describe('Privacy page (platform)', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('sends an export request for the current user and shows it as pending', async () => {
    const posts: unknown[] = [];
    stubFetch((url, init) => {
      if (url === '/api/v1/privacy/requests' && init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return { id: 7, userid: 3, type: 'export', status: 'pending' };
      }
      if (url === '/api/v1/privacy/requests') return [{ id: 7, userid: 3, type: 'export', status: 'pending' }];
      return undefined;
    });
    render(<PrivacyPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Request my data export' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ type: 'export' });
    expect(await screen.findByText(/Request #7 \(export\) is pending/)).toBeInTheDocument();
    expect(screen.getByText(/#7 user 3 — export — pending/)).toBeInTheDocument();
  });
});

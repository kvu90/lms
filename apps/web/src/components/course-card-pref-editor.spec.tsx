import { useState } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '#lib/query-client';
import { useCourseCardPrefs } from '#lib/course-cards';
import { CourseCardPrefEditor } from './course-card-pref-editor';
import '../i18n';

/**
 * F-04 (rà soát #133, issue #149): editor lưu pref xong phải invalidate
 * khoá `courseCards` — trước đây dashboard (đọc pref qua
 * useCourseCardPrefs) giữ pref cũ tới khi staleTime hết. Spec dựng một
 * consumer thật của cùng khoá query và đếm số lần GET course-cards:
 * sau khi lưu, consumer phải tự tải lại (GET lần 2) mà không cần
 * remount.
 */

const COURSE_ID = '01900000-0000-7000-8000-000000000010';

function PrefsProbe() {
  const prefs = useCourseCardPrefs();
  return <div data-testid="prefs-count">{prefs.data ? prefs.data.size : -1}</div>;
}

describe('CourseCardPrefEditor — invalidate courseCards sau khi lưu (F-04)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lưu pref xong thì query courseCards được invalidate và tải lại', async () => {
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url, method });
        const respond = (body: unknown) =>
          new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url === '/api/v1/dashboard/course-cards' && method === 'GET') return respond({ prefs: [] });
        if (url === `/api/v1/dashboard/course-cards/${COURSE_ID}` && method === 'PUT') {
          return respond({ courseId: COURSE_ID, color: 'red', nickname: null });
        }
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      }),
    );

    const onSaved = vi.fn();
    function Harness() {
      const [client] = useState(() => {
        const created = createQueryClient();
        created.setDefaultOptions({ queries: { retry: false, staleTime: 60_000 } });
        return created;
      });
      return (
        <QueryClientProvider client={client}>
          <PrefsProbe />
          <CourseCardPrefEditor courseId={COURSE_ID} initial={undefined} onSaved={onSaved} onCancel={() => undefined} />
        </QueryClientProvider>
      );
    }
    render(<Harness />);

    // Consumer nạp pref lần đầu (GET 1 lần, cache còn tươi 60s).
    await waitFor(() => expect(screen.getByTestId('prefs-count')).toHaveTextContent('0'));
    const getsBefore = calls.filter((c) => c.url === '/api/v1/dashboard/course-cards' && c.method === 'GET').length;
    expect(getsBefore).toBe(1);

    await userEvent.click(screen.getByTestId('card-color-red'));
    await userEvent.click(screen.getByTestId('card-pref-save'));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ courseId: COURSE_ID, color: 'red', nickname: null }));
    // Dù staleTime còn 60s, invalidate buộc consumer tải lại pref.
    await waitFor(() => {
      const gets = calls.filter((c) => c.url === '/api/v1/dashboard/course-cards' && c.method === 'GET').length;
      expect(gets).toBe(2);
    });
  });
});

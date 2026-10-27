import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { queryClient } from '#lib/query-client';
import { queryKeys } from '#lib/query-keys';
import { insightsPageClientLoader } from '#lib/platform-data';
import { BackupPage } from './platform-backup';
import { InsightsPage } from './platform-insights';
import { PrivacyPage } from './platform-privacy';
import { ReportsPage } from './platform-reports';
import { SearchPage } from './platform-search';
import { TokensPage } from './platform-tokens';

/**
 * Platform web tests (Testing Library): global search hiển thị đúng kết quả đã
 * lọc quyền mà server trả về, và user tự gửi được privacy request.
 */
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

describe('Search page (platform)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('submits the query and renders only the permission-filtered results returned by the API', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/v1/search?q='))
        return [
          {
            id: '01900000-0000-7000-8000-000000000001',
            area: 'courses',
            itemId: '01900000-0000-7000-8000-000000000005',
            contextId: '01900000-0000-7000-8000-000000000009',
            title: 'Visible Course',
            content: 'You may see this',
          },
        ];
      return undefined;
    });
    // SearchPage đọc tham số q qua useSearchParams nên phải render trong Router
    // (đây là ca đỏ duy nhất của CI PR #305 trước khi sửa).
    const router = createMemoryRouter([{ path: 'search', element: <SearchPage /> }], {
      initialEntries: ['/search'],
    });
    render(<RouterProvider router={router} />);
    await userEvent.type(screen.getByLabelText('Từ khoá tìm kiếm'), 'Visible');
    await userEvent.click(screen.getByRole('button', { name: 'Tìm kiếm' }));
    expect(await screen.findByText('Visible Course')).toBeInTheDocument();
    expect(screen.queryByText('Hidden Course')).not.toBeInTheDocument();
  });
});

describe('Privacy page (platform)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('sends an export request for the current user and shows it as pending', async () => {
    const posts: unknown[] = [];
    stubFetch((url, init) => {
      if (url === '/api/v1/privacy/requests' && init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return {
          id: '01900000-0000-7000-8000-000000000007',
          userId: '01900000-0000-7000-8000-000000000003',
          type: 'export',
          status: 'pending',
        };
      }
      if (url === '/api/v1/privacy/requests')
        return [
          {
            id: '01900000-0000-7000-8000-000000000007',
            userId: '01900000-0000-7000-8000-000000000003',
            type: 'export',
            status: 'pending',
          },
        ];
      return undefined;
    });
    // PrivacyPage đọc dữ liệu qua TanStack Query (F-01 của #133) nên
    // render trong TestProviders như mọi spec trang đã chuyển khuôn.
    render(
      <TestProviders>
        <PrivacyPage />
      </TestProviders>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Yêu cầu xuất dữ liệu của tôi' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ type: 'export' });
    expect(
      await screen.findByText(/Yêu cầu #01900000-0000-7000-8000-000000000007 \(export\) đang pending/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /#01900000-0000-7000-8000-000000000007 người dùng 01900000-0000-7000-8000-000000000003 — export — pending/,
      ),
    ).toBeInTheDocument();
  });
});

/**
 * Cụm trang nền tảng sau khi chuyển khuôn TanStack Query (F-01 của
 * #133): dữ liệu hiển thị giữ nguyên như bản fetch thủ công — insight
 * kèm dòng học viên/khoá, job sao lưu xem được các bước, token thô chỉ
 * hiện một lần khi tạo và thu hồi cập nhật danh sách, chạy báo cáo hiện
 * đúng số dòng kết quả. Thêm ca khoá cho clientLoader: nạp trước đúng
 * khoá trang sẽ đọc thì trang mở ra hiện dữ liệu ngay, không fetch
 * trùng lần hai.
 */
describe('Insights page (platform)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the insights returned by the API with their student and course line', async () => {
    stubFetch((url) => {
      if (url === '/api/v1/analytics/insights/me')
        return [
          {
            id: '01900000-0000-7000-8000-000000000011',
            userId: '01900000-0000-7000-8000-000000000012',
            heading: 'Học viên ít hoạt động tuần này',
            courseId: '01900000-0000-7000-8000-000000000013',
          },
        ];
      return undefined;
    });
    render(
      <TestProviders>
        <InsightsPage />
      </TestProviders>,
    );
    expect(await screen.findByText('Học viên ít hoạt động tuần này')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Student 01900000-0000-7000-8000-000000000012 · course 01900000-0000-7000-8000-000000000013',
      ),
    ).toBeInTheDocument();
  });
});

describe('Backup page (platform)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists jobs, loads the steps of a job on demand and creates a job for the typed course', async () => {
    const posts: { url: string; body: unknown }[] = [];
    let jobs = [
      {
        id: 'job-1',
        type: 'backup',
        courseId: 'course-1',
        targetCourseId: null,
        mode: 'new',
        status: 'completed',
      },
    ];
    stubFetch((url, init) => {
      if (url === '/api/v1/backup/jobs' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { courseId: string };
        posts.push({ url, body });
        jobs = [
          ...jobs,
          { id: 'job-2', type: 'backup', courseId: body.courseId, targetCourseId: null, mode: 'new', status: 'pending' },
        ];
        return jobs[jobs.length - 1];
      }
      if (url === '/api/v1/backup/jobs') return jobs;
      if (url === '/api/v1/backup/jobs/job-1/steps')
        return [{ id: 'step-1', name: 'Export course', status: 'done' }];
      return undefined;
    });
    render(
      <TestProviders>
        <BackupPage />
      </TestProviders>,
    );
    expect(await screen.findByText(/backup job #job-1 — khoá course-1 — completed/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Các bước' }));
    expect(await screen.findByText('Export course: done')).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText('Mã khoá học'), 'course-9');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo bản sao lưu' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.body).toEqual({ courseId: 'course-9' });
    expect(await screen.findByText(/backup job #job-2 — khoá course-9 — pending/)).toBeInTheDocument();
  });
});

describe('Tokens page (platform)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('creates a token showing the raw value once and revokes it from the list', async () => {
    let revoked = false;
    const posts: string[] = [];
    stubFetch((url, init) => {
      if (url === '/api/v1/webservice/services')
        return [
          { id: 'svc-1', name: 'Mobile service', shortName: 'svc1', enabled: true, functions: ['core_course_get_courses'] },
        ];
      if (url === '/api/v1/webservice/tokens' && init?.method === 'POST') {
        posts.push(url);
        return { token: 'raw-token-123' };
      }
      if (url === '/api/v1/webservice/tokens')
        return [{ id: 'tok-1', userId: 'user-1', serviceId: 'svc-1', revoked }];
      if (url === '/api/v1/users/me') return { id: 'user-1' };
      if (url === '/api/v1/webservice/tokens/tok-1/revoke' && init?.method === 'POST') {
        posts.push(url);
        revoked = true;
        return { id: 'tok-1', userId: 'user-1', serviceId: 'svc-1', revoked: true };
      }
      return undefined;
    });
    render(
      <TestProviders>
        <TokensPage />
      </TestProviders>,
    );
    expect(await screen.findByText('Mobile service')).toBeInTheDocument();
    expect(screen.getByText(/Token #tok-1 for user user-1/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Tạo token' }));
    expect(await screen.findByText('Token mới (chỉ hiện một lần): raw-token-123')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Thu hồi' }));
    await waitFor(() => expect(posts).toContain('/api/v1/webservice/tokens/tok-1/revoke'));
    expect(await screen.findByText(/Token #tok-1 for user user-1 \(revoked\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Thu hồi' })).not.toBeInTheDocument();
  });
});

describe('Reports page (platform)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('runs a report and shows the returned rows', async () => {
    stubFetch((url) => {
      if (url === '/api/v1/reports')
        return [{ id: 'rep-1', name: 'Báo cáo ghi danh', dataSource: 'enrolments', columns: ['userId', 'courseId', 'status'] }];
      if (url === '/api/v1/reports/rep-1/run')
        return { rows: [{ userId: 'user-1', courseId: 'course-1', status: 'active' }] };
      return undefined;
    });
    render(
      <TestProviders>
        <ReportsPage />
      </TestProviders>,
    );
    expect(await screen.findByText('Báo cáo ghi danh (enrolments)')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Chạy' }));
    expect(await screen.findByText('1 dòng')).toBeInTheDocument();
    expect(screen.getByText('{"userId":"user-1","courseId":"course-1","status":"active"}')).toBeInTheDocument();
  });
});

describe('Platform clientLoaders (F-01 của #133)', () => {
  beforeEach(() => {
    queryClient.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    queryClient.clear();
  });

  it('insights loader prefetches the exact key the page reads, so the page renders without a second fetch', async () => {
    const payload = [
      {
        id: '01900000-0000-7000-8000-000000000021',
        userId: '01900000-0000-7000-8000-000000000022',
        heading: 'Nhận định đã nạp trước',
        courseId: '01900000-0000-7000-8000-000000000023',
      },
    ];
    let insightCalls = 0;
    stubFetch((url) => {
      if (url === '/api/v1/analytics/insights/me') {
        insightCalls += 1;
        return payload;
      }
      return undefined;
    });
    await insightsPageClientLoader();
    expect(queryClient.getQueryData(queryKeys.myInsights)).toEqual(payload);
    render(
      <QueryClientProvider client={queryClient}>
        <InsightsPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Nhận định đã nạp trước')).toBeInTheDocument();
    expect(insightCalls).toBe(1);
  });
});

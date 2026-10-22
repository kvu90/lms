import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth';
import { PermissionsProvider } from '@/lib/permissions';
import { LearningPlanPage } from './learning-plan';

/**
 * Spec khu quản lý competency trong trang kế hoạch học tập: tạo framework
 * phải POST đúng body của `createCompetencyFrameworkSchema` trong
 * contracts (`scale: { values, proficient }`), và hàng đợi duyệt phải gọi
 * POST /plans/:id/approve cho plan đang ở trạng thái đang duyệt (3) sau
 * khi chọn người dùng. Phần người học xem plan của mình giữ nguyên.
 */
const ADMIN_ID = '01900000-0000-7000-8000-0000000000a1';
const LEARNER_ID = '01900000-0000-7000-8000-000000000007';
const PLAN_ID = '01900000-0000-7000-8000-0000000000p1'.replace('p', 'b');

const PROFILE = {
  id: ADMIN_ID, username: 'admin', firstname: 'Quản', lastname: 'Trị', email: 'admin@example.com', suspended: false,
  deleted: false, isGuest: false, forcePasswordChange: false, lastlogin: null,
  timecreated: '2026-01-01T00:00:00.000Z', customFields: [],
};
const LEARNER = { ...PROFILE, id: LEARNER_ID, username: 'learner' };

interface RecordedCall { url: string; method: string; body: unknown }

/** Stub fetch ghi lại mọi lời gọi và phục vụ dữ liệu competency tối thiểu. */
function stubFetch(calls: RecordedCall[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url === '/api/v1/users/me') return respond(PROFILE);
    if (url === '/api/v1/users?pageSize=1') return respond({ users: [PROFILE], total: 1, page: 1, pageSize: 1 });
    if (url === '/api/v1/users?page=1&pageSize=50') return respond({ users: [LEARNER], total: 1, page: 1, pageSize: 50 });
    if (url === '/api/v1/access/roles') return respond([]);
    if (url === '/api/v1/questions/categories') return respond([]);
    if (url === '/api/v1/courses') return respond([]);
    if (url === '/api/v1/competencies/frameworks' && method === 'GET') return respond([]);
    if (url === '/api/v1/competencies/frameworks' && method === 'POST') {
      return respond({ id: '01900000-0000-7000-8000-0000000000f1'.replace('f', 'e'), shortname: 'FW1', scaleconfiguration: { values: ['Chưa đạt', 'Đạt'], proficient: [1] } });
    }
    if (url === '/api/v1/competencies/templates') return respond([]);
    if (url === `/api/v1/competencies/plans/user/${ADMIN_ID}`) return respond([]);
    if (url === `/api/v1/competencies/plans/user/${LEARNER_ID}`) {
      return respond([{ id: PLAN_ID, name: 'Plan chờ duyệt', status: 3, templateid: null, userid: LEARNER_ID }]);
    }
    if (url === `/api/v1/competencies/usercomp/user/${LEARNER_ID}`) return respond([]);
    if (url === `/api/v1/competencies/plans/${PLAN_ID}/approve` && method === 'POST') {
      return respond({ id: PLAN_ID, name: 'Plan chờ duyệt', status: 1, templateid: null, userid: LEARNER_ID });
    }
    return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  }));
}

/** Render trang kế hoạch trong đúng khung provider của ứng dụng thật. */
function renderPage() {
  const router = createMemoryRouter([{ path: '/learning-plan', element: <LearningPlanPage /> }], { initialEntries: ['/learning-plan'] });
  render(
    <AuthProvider>
      <PermissionsProvider>
        <RouterProvider router={router} />
      </PermissionsProvider>
    </AuthProvider>,
  );
}

describe('Learning plan page — competency administration', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

  it('creates a framework via POST with the real contracts DTO body', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    await userEvent.type(await screen.findByLabelText('Tên ngắn của framework'), 'FW1');
    await userEvent.type(screen.getByLabelText(/Các mức thang đánh giá/), 'Chưa đạt, Đạt');
    await userEvent.type(screen.getByLabelText(/Chỉ số các mức được coi là đạt/), '1');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo framework' }));

    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/competencies/frameworks' && c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.url === '/api/v1/competencies/frameworks' && c.method === 'POST');
    expect(post?.body).toEqual({
      shortname: 'FW1',
      scale: { values: ['Chưa đạt', 'Đạt'], proficient: [1] },
      visible: true,
    });
  });

  it('approves an in-review plan from the review queue via POST /plans/:id/approve', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    await userEvent.type(await screen.findByLabelText('ID người dùng cần duyệt'), LEARNER_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Tải hàng đợi duyệt' }));

    const approveButton = await screen.findByRole('button', { name: 'Duyệt kế hoạch' });
    await userEvent.click(approveButton);

    await waitFor(() => expect(calls.some((c) => c.url === `/api/v1/competencies/plans/${PLAN_ID}/approve` && c.method === 'POST')).toBe(true));
  });
});

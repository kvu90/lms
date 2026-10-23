import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '@/test/providers';
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
    if (url === '/api/v1/users/me/capabilities') return respond({ userId: PROFILE.id, isSiteAdmin: true, assignments: [], contexts: [] });
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

const FW_ID = '01900000-0000-7000-8000-00000000f001';
const FW_ROW = { id: FW_ID, shortname: 'FW1', idnumber: 'fw1', description: '', scaleconfiguration: { values: ['Chưa đạt', 'Đạt'], proficient: [1] }, visible: true };
const EXPORT_DOC = { framework: { shortname: 'FW1', idnumber: 'fw1', scale: { values: ['Chưa đạt', 'Đạt'], proficient: [1] } }, competencies: [] };

/**
 * Stub cho khu import/export framework: danh sách có sẵn một framework,
 * export trả tài liệu mẫu, import tạo framework mới — riêng tài liệu có
 * shortname BROKEN bị API từ chối bằng Problem Details 400 mang `detail`
 * toàn vẹn để khẳng định trang hiện nguyên văn lỗi của API.
 */
function stubFetchExport(calls: RecordedCall[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url === '/api/v1/users/me') return respond(PROFILE);
    if (url === '/api/v1/users/me/capabilities') return respond({ userId: PROFILE.id, isSiteAdmin: true, assignments: [], contexts: [] });
    if (url === '/api/v1/users?pageSize=1') return respond({ users: [PROFILE], total: 1, page: 1, pageSize: 1 });
    if (url === '/api/v1/users?page=1&pageSize=50') return respond({ users: [LEARNER], total: 1, page: 1, pageSize: 50 });
    if (url === '/api/v1/access/roles') return respond([]);
    if (url === '/api/v1/questions/categories') return respond([]);
    if (url === '/api/v1/courses') return respond([]);
    if (url === '/api/v1/competencies/frameworks' && method === 'GET') return respond([FW_ROW]);
    if (url === `/api/v1/competencies/frameworks/${FW_ID}/export`) return respond(EXPORT_DOC);
    if (url === '/api/v1/competencies/frameworks/import' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { framework?: { shortname?: string } };
      if (body.framework?.shortname === 'BROKEN') {
        return respond({ type: 'about:blank', title: 'Bad Request', status: 400, code: 'competency.import_invalid', detail: 'Tài liệu thiếu thang đánh giá của framework' }, 400);
      }
      return respond({ ...FW_ROW, id: '01900000-0000-7000-8000-00000000f002', shortname: body.framework?.shortname ?? 'FW-NEW' });
    }
    if (url === '/api/v1/competencies/templates') return respond([]);
    if (url === `/api/v1/competencies/plans/user/${ADMIN_ID}`) return respond([]);
    return respond({}, 404);
  }));
}

/** Render trang kế hoạch trong đúng khung provider của ứng dụng thật. */
function renderPage() {
  const router = createMemoryRouter([{ path: '/learning-plan', element: <LearningPlanPage /> }], { initialEntries: ['/learning-plan'] });
  render(
    <TestProviders>
      <PermissionsProvider>
        <RouterProvider router={router} />
      </PermissionsProvider>
    </TestProviders>,
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

  it('exports a framework as JSON via GET /frameworks/:id/export and downloads it', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubFetchExport(calls);
    const createObjectURL = vi.fn(() => 'blob:mock-url');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Xuất JSON' }));

    await waitFor(() => expect(calls.some((c) => c.url === `/api/v1/competencies/frameworks/${FW_ID}/export` && c.method === 'GET')).toBe(true));
    expect(createObjectURL).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent('Đã xuất framework "FW1"');
  });

  it('imports a framework by posting the parsed file JSON to /frameworks/import', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubFetchExport(calls);
    renderPage();

    const doc = { framework: { shortname: 'FW-NEW', idnumber: 'fwn', scale: { values: ['Chưa đạt', 'Đạt'], proficient: [1] } }, competencies: [] };
    const file = new File([JSON.stringify(doc)], 'fw.json', { type: 'application/json' });
    await userEvent.upload(await screen.findByLabelText(/File JSON framework/), file);
    await userEvent.click(screen.getByRole('button', { name: 'Nhập framework' }));

    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/competencies/frameworks/import' && c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.url === '/api/v1/competencies/frameworks/import' && c.method === 'POST');
    expect(post?.body).toEqual(doc);
    expect(await screen.findByRole('status')).toHaveTextContent('Đã nhập thành framework mới "FW-NEW"');
  });

  it('shows the API integrity error verbatim when the import document is rejected', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubFetchExport(calls);
    renderPage();

    const file = new File([JSON.stringify({ framework: { shortname: 'BROKEN' } })], 'broken.json', { type: 'application/json' });
    await userEvent.upload(await screen.findByLabelText(/File JSON framework/), file);
    await userEvent.click(screen.getByRole('button', { name: 'Nhập framework' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Tài liệu thiếu thang đánh giá của framework');
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

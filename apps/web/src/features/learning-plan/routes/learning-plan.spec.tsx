import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { baSessionBody, isGetSessionUrl } from '#test/ba-session';
import { PermissionsProvider } from '#lib/permissions';
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
  id: ADMIN_ID,
  username: 'admin',
  firstName: 'Quản',
  lastName: 'Trị',
  email: 'admin@example.com',
  suspended: false,
  deleted: false,
  isGuest: false,
  forcePasswordChange: false,
  lastLogin: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  customFields: [],
};
const LEARNER = { ...PROFILE, id: LEARNER_ID, username: 'learner' };

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** Stub fetch ghi lại mọi lời gọi và phục vụ dữ liệu competency tối thiểu. */
function stubFetch(calls: RecordedCall[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/users/me/capabilities')
        return respond({ userId: PROFILE.id, isSiteAdmin: true, assignments: [], contexts: [] });
      if (url === '/api/v1/users?pageSize=1') return respond({ users: [PROFILE], total: 1, page: 1, pageSize: 1 });
      if (url === '/api/v1/users?page=1&pageSize=50')
        return respond({ users: [LEARNER], total: 1, page: 1, pageSize: 50 });
      if (url === '/api/v1/access/roles') return respond([]);
      if (url === '/api/v1/questions/categories') return respond([]);
      if (url === '/api/v1/courses') return respond([]);
      if (url === '/api/v1/competencies/frameworks' && method === 'GET') return respond([]);
      if (url === '/api/v1/competencies/frameworks' && method === 'POST') {
        return respond({
          id: '01900000-0000-7000-8000-0000000000f1'.replace('f', 'e'),
          shortName: 'FW1',
          scaleConfiguration: { values: ['Chưa đạt', 'Đạt'], proficient: [1] },
        });
      }
      if (url === '/api/v1/competencies/templates') return respond([]);
      if (url === `/api/v1/competencies/plans/user/${ADMIN_ID}`) return respond([]);
      if (url === `/api/v1/competencies/plans/user/${LEARNER_ID}`) {
        return respond([{ id: PLAN_ID, name: 'Plan chờ duyệt', status: 3, templateId: null, userId: LEARNER_ID }]);
      }
      if (url === `/api/v1/competencies/usercomp/user/${LEARNER_ID}`) return respond([]);
      if (url === `/api/v1/competencies/plans/${PLAN_ID}/approve` && method === 'POST') {
        return respond({ id: PLAN_ID, name: 'Plan chờ duyệt', status: 1, templateId: null, userId: LEARNER_ID });
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

const FW_ID = '01900000-0000-7000-8000-00000000f001';
const FW_ROW = {
  id: FW_ID,
  shortName: 'FW1',
  idNumber: 'fw1',
  description: '',
  scaleConfiguration: { values: ['Chưa đạt', 'Đạt'], proficient: [1] },
  visible: true,
};
const EXPORT_DOC = {
  framework: { shortName: 'FW1', idNumber: 'fw1', scale: { values: ['Chưa đạt', 'Đạt'], proficient: [1] } },
  competencies: [],
};

/**
 * Stub cho khu import/export framework: danh sách có sẵn một framework,
 * export trả tài liệu mẫu, import tạo framework mới — riêng tài liệu có
 * shortName BROKEN bị API từ chối bằng Problem Details 400 mang `detail`
 * toàn vẹn để khẳng định trang hiện nguyên văn lỗi của API.
 */
function stubFetchExport(calls: RecordedCall[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (isGetSessionUrl(url)) return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/users/me/capabilities')
        return respond({ userId: PROFILE.id, isSiteAdmin: true, assignments: [], contexts: [] });
      if (url === '/api/v1/users?pageSize=1') return respond({ users: [PROFILE], total: 1, page: 1, pageSize: 1 });
      if (url === '/api/v1/users?page=1&pageSize=50')
        return respond({ users: [LEARNER], total: 1, page: 1, pageSize: 50 });
      if (url === '/api/v1/access/roles') return respond([]);
      if (url === '/api/v1/questions/categories') return respond([]);
      if (url === '/api/v1/courses') return respond([]);
      if (url === '/api/v1/competencies/frameworks' && method === 'GET') return respond([FW_ROW]);
      if (url === `/api/v1/competencies/frameworks/${FW_ID}/export`) return respond(EXPORT_DOC);
      if (url === '/api/v1/competencies/frameworks/import' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { framework?: { shortName?: string } };
        if (body.framework?.shortName === 'BROKEN') {
          return respond(
            {
              type: 'about:blank',
              title: 'Bad Request',
              status: 400,
              code: 'competency.import_invalid',
              detail: 'Tài liệu thiếu thang đánh giá của framework',
            },
            400,
          );
        }
        return respond({
          ...FW_ROW,
          id: '01900000-0000-7000-8000-00000000f002',
          shortName: body.framework?.shortName ?? 'FW-NEW',
        });
      }
      if (url === '/api/v1/competencies/templates') return respond([]);
      if (url === `/api/v1/competencies/plans/user/${ADMIN_ID}`) return respond([]);
      return respond({}, 404);
    }),
  );
}

/** Render trang kế hoạch trong đúng khung provider của ứng dụng thật. */
function renderPage() {
  const router = createMemoryRouter([{ path: '/learning-plan', element: <LearningPlanPage /> }], {
    initialEntries: ['/learning-plan'],
  });
  render(
    <TestProviders>
      <PermissionsProvider>
        <RouterProvider router={router} />
      </PermissionsProvider>
    </TestProviders>,
  );
}

describe('Learning plan page — competency administration', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('creates a framework via POST with the real contracts DTO body', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    await userEvent.type(await screen.findByLabelText('Tên ngắn của framework'), 'FW1');
    await userEvent.type(screen.getByLabelText(/Các mức thang đánh giá/), 'Chưa đạt, Đạt');
    await userEvent.type(screen.getByLabelText(/Chỉ số các mức được coi là đạt/), '1');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo framework' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/competencies/frameworks' && c.method === 'POST')).toBe(true),
    );
    const post = calls.find((c) => c.url === '/api/v1/competencies/frameworks' && c.method === 'POST');
    expect(post?.body).toEqual({
      shortName: 'FW1',
      scale: { values: ['Chưa đạt', 'Đạt'], proficient: [1] },
      visible: true,
    });
  });

  it('exports a framework as JSON via GET /frameworks/:id/export and downloads it', async () => {
    const calls: RecordedCall[] = [];
    stubFetchExport(calls);
    const createObjectURL = vi.fn(() => 'blob:mock-url');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Xuất JSON' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/competencies/frameworks/${FW_ID}/export` && c.method === 'GET')).toBe(
        true,
      ),
    );
    expect(createObjectURL).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    // Thông báo thao tác nay là Alert của @lms/ui (role="alert").
    expect(await screen.findByRole('alert')).toHaveTextContent('Đã xuất framework "FW1"');
  });

  it('imports a framework by posting the parsed file JSON to /frameworks/import', async () => {
    const calls: RecordedCall[] = [];
    stubFetchExport(calls);
    renderPage();

    const doc = {
      framework: { shortName: 'FW-NEW', idNumber: 'fwn', scale: { values: ['Chưa đạt', 'Đạt'], proficient: [1] } },
      competencies: [],
    };
    const file = new File([JSON.stringify(doc)], 'fw.json', { type: 'application/json' });
    await userEvent.upload(await screen.findByLabelText(/File JSON framework/), file);
    await userEvent.click(screen.getByRole('button', { name: 'Nhập framework' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/competencies/frameworks/import' && c.method === 'POST')).toBe(true),
    );
    const post = calls.find((c) => c.url === '/api/v1/competencies/frameworks/import' && c.method === 'POST');
    expect(post?.body).toEqual(doc);
    expect(await screen.findByRole('alert')).toHaveTextContent('Đã nhập thành framework mới "FW-NEW"');
  });

  it('shows the API integrity error verbatim when the import document is rejected', async () => {
    const calls: RecordedCall[] = [];
    stubFetchExport(calls);
    renderPage();

    const file = new File([JSON.stringify({ framework: { shortName: 'BROKEN' } })], 'broken.json', {
      type: 'application/json',
    });
    await userEvent.upload(await screen.findByLabelText(/File JSON framework/), file);
    await userEvent.click(screen.getByRole('button', { name: 'Nhập framework' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Tài liệu thiếu thang đánh giá của framework');
  });

  it('approves an in-review plan from the review queue via POST /plans/:id/approve', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    await userEvent.type(await screen.findByLabelText('ID người dùng cần duyệt'), LEARNER_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Tải hàng đợi duyệt' }));

    const approveButton = await screen.findByRole('button', { name: 'Duyệt kế hoạch' });
    await userEvent.click(approveButton);

    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/competencies/plans/${PLAN_ID}/approve` && c.method === 'POST')).toBe(
        true,
      ),
    );
  });
});

/**
 * Khu quản trị năng lực sau khi chuyển khuôn TanStack Query (lượt
 * riêng cuối của F-01 trong #133): các khẳng định ở đây khoá phần cơ
 * chế mới mà các ca trên chưa phủ — đột biến tạo framework phải làm
 * mới danh sách qua invalidate (framework mới hiện ngay không cần tải
 * lại trang), lỗi tải danh sách framework phải hiện đúng thông báo
 * lỗi của khu quản trị, và thao tác duyệt phải làm mới cả hai danh
 * sách của hàng đợi.
 */
describe('Learning plan page — competency administration (TanStack Query conversion)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  /**
   * Stub có trạng thái cho khu quản trị: danh sách framework rỗng cho
   * tới khi POST tạo thành công thì GET trả về framework vừa tạo;
   * tuỳ chọn `failFrameworks` làm GET danh sách framework trả 500.
   */
  function stubFetchAdminState(calls: RecordedCall[], opts: { failFrameworks?: boolean } = {}) {
    let created = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const respond = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
        if (isGetSessionUrl(url))
          return respond(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
        if (url === '/api/v1/users/me') return respond(PROFILE);
        if (url === '/api/v1/users/me/capabilities')
          return respond({ userId: PROFILE.id, isSiteAdmin: true, assignments: [], contexts: [] });
        if (url === '/api/v1/users?pageSize=1') return respond({ users: [PROFILE], total: 1, page: 1, pageSize: 1 });
        if (url === '/api/v1/users?page=1&pageSize=50')
          return respond({ users: [LEARNER], total: 1, page: 1, pageSize: 50 });
        if (url === '/api/v1/access/roles') return respond([]);
        if (url === '/api/v1/questions/categories') return respond([]);
        if (url === '/api/v1/courses') return respond([]);
        if (url === '/api/v1/competencies/frameworks' && method === 'GET') {
          if (opts.failFrameworks) {
            return respond(
              { type: 'about:blank', title: 'Server Error', status: 500, code: 'server.error', detail: 'boom' },
              500,
            );
          }
          return respond(created ? [FW_ROW] : []);
        }
        if (url === '/api/v1/competencies/frameworks' && method === 'POST') {
          created = true;
          return respond(FW_ROW);
        }
        if (url === '/api/v1/competencies/templates') return respond([]);
        if (url === `/api/v1/competencies/plans/user/${ADMIN_ID}`) return respond([]);
        if (url === `/api/v1/competencies/plans/user/${LEARNER_ID}`) {
          return respond([{ id: PLAN_ID, name: 'Plan chờ duyệt', status: 3, templateId: null, userId: LEARNER_ID }]);
        }
        if (url === `/api/v1/competencies/usercomp/user/${LEARNER_ID}`) return respond([]);
        if (url === `/api/v1/competencies/plans/${PLAN_ID}/approve` && method === 'POST') {
          return respond({ id: PLAN_ID, name: 'Plan chờ duyệt', status: 1, templateId: null, userId: LEARNER_ID });
        }
        return respond({}, 404);
      }),
    );
  }

  it('shows the newly created framework in the list via mutation invalidation, without a page reload', async () => {
    const calls: RecordedCall[] = [];
    stubFetchAdminState(calls);
    renderPage();

    expect(await screen.findByText('Chưa có framework nào.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Tên ngắn của framework'), 'FW1');
    await userEvent.type(screen.getByLabelText(/Các mức thang đánh giá/), 'Chưa đạt, Đạt');
    await userEvent.type(screen.getByLabelText(/Chỉ số các mức được coi là đạt/), '1');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo framework' }));

    // Hàng framework mới chỉ có thể hiện nếu danh sách được nạp lại sau đột biến.
    expect(await screen.findByRole('button', { name: 'Xem competency' })).toBeInTheDocument();
    const frameworkGets = calls.filter((c) => c.url === '/api/v1/competencies/frameworks' && c.method === 'GET');
    expect(frameworkGets.length).toBeGreaterThanOrEqual(2);
  });

  it('shows the admin load error message when the framework list fails to load', async () => {
    const calls: RecordedCall[] = [];
    stubFetchAdminState(calls, { failFrameworks: true });
    renderPage();

    expect(await screen.findByText('Không tải được dữ liệu quản lý năng lực.')).toBeInTheDocument();
  });

  it('refetches both review queue lists after a review action', async () => {
    const calls: RecordedCall[] = [];
    stubFetchAdminState(calls);
    renderPage();

    await userEvent.type(await screen.findByLabelText('ID người dùng cần duyệt'), LEARNER_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Tải hàng đợi duyệt' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Duyệt kế hoạch' }));

    await waitFor(() =>
      expect(
        calls.filter((c) => c.url === `/api/v1/competencies/plans/${PLAN_ID}/approve` && c.method === 'POST'),
      ).toHaveLength(1),
    );
    await waitFor(() =>
      expect(calls.filter((c) => c.url === `/api/v1/competencies/plans/user/${LEARNER_ID}` && c.method === 'GET').length).toBeGreaterThanOrEqual(2),
    );
    await waitFor(() =>
      expect(
        calls.filter((c) => c.url === `/api/v1/competencies/usercomp/user/${LEARNER_ID}` && c.method === 'GET').length,
      ).toBeGreaterThanOrEqual(2),
    );
  });
});

/**
 * Phần NGƯỜI HỌC của trang kế hoạch sau khi chuyển khuôn TanStack
 * Query (F-01 của #133): danh sách kế hoạch của chính người dùng hiện
 * đúng trạng thái, mở xem được chi tiết năng lực, yêu cầu duyệt cả kế
 * hoạch và gửi một năng lực đi duyệt đều gọi đúng endpoint và hiện
 * dòng xác nhận như bản fetch thủ công.
 */
describe('Learning plan page — learner side', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  function stubFetchLearner(calls: RecordedCall[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const respond = (body: unknown) =>
          new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (isGetSessionUrl(url))
          return respond(baSessionBody({ id: LEARNER.id, username: LEARNER.username, email: LEARNER.email }));
        if (url === '/api/v1/users/me') return respond(LEARNER);
        if (url === '/api/v1/users/me/capabilities')
          return respond({ userId: LEARNER_ID, isSiteAdmin: false, assignments: [], contexts: [] });
        if (url === `/api/v1/competencies/plans/user/${LEARNER_ID}`)
          return respond([{ id: PLAN_ID, name: 'Kế hoạch toán', status: 1, templateId: null, userId: LEARNER_ID }]);
        if (url === `/api/v1/competencies/plans/${PLAN_ID}` && method === 'GET')
          return respond({
            plan: { id: PLAN_ID, name: 'Kế hoạch toán', status: 1, templateId: null },
            competencies: [
              {
                competency: { id: 'comp-1', shortName: 'NL-1' },
                usercomp: { id: 'uc-1', grade: null, proficiency: null, status: 0 },
              },
            ],
            reviews: [],
          });
        if (url === `/api/v1/competencies/plans/${PLAN_ID}/request-review` && method === 'POST') return respond({});
        if (url === '/api/v1/competencies/usercomp/uc-1/evidence' && method === 'POST') return respond({});
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      }),
    );
  }

  it('shows my plans, opens the detail and sends review requests for the plan and one competency', async () => {
    const calls: RecordedCall[] = [];
    stubFetchLearner(calls);
    renderPage();

    expect(await screen.findByText('Kế hoạch toán')).toBeInTheDocument();
    expect(screen.getByText('đang thực hiện')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Yêu cầu duyệt kế hoạch' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/competencies/plans/${PLAN_ID}/request-review` && c.method === 'POST'),
      ).toBe(true),
    );
    expect(await screen.findByText('Đã yêu cầu duyệt.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Xem' }));
    expect(await screen.findByText('Kế hoạch toán — các năng lực')).toBeInTheDocument();
    expect(await screen.findByText('NL-1')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Gửi duyệt' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/competencies/usercomp/uc-1/evidence' && c.method === 'POST')).toBe(
        true,
      ),
    );
    const evidence = calls.find((c) => c.url === '/api/v1/competencies/usercomp/uc-1/evidence');
    expect(evidence?.body).toEqual({
      action: 'evidence',
      description: 'Vui lòng duyệt bằng chứng của tôi',
      sendForReview: true,
    });
    expect(await screen.findByText('Đã gửi năng lực để duyệt.')).toBeInTheDocument();
  });
});

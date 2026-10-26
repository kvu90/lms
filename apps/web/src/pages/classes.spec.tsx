import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { ClassDetailPage } from './class-detail';
import { ClassJoinPage } from './class-join';

/**
 * Spec bề mặt lớp của GV (CLASS-1, issue #184): kiểm LUỒNG NGHIỆP VỤ
 * qua endpoint thật (fetch được stub ở biên mạng): nạp học sinh theo
 * định danh tạo tài khoản thì mật khẩu tạm hiện đúng một lần trong thông
 * báo; import Excel trả báo cáo từng dòng (dòng lỗi không chặn dòng
 * tốt); duyệt yêu cầu tự báo danh gọi đúng endpoint; gán vai chấm bài
 * cho đồng GV gửi đúng bộ vai; kích hoạt lại học sinh đã đình chỉ là
 * thêm lại vào roster. Đổi luật nghiệp vụ (mã lỗi/mật khẩu tạm/hàng
 * chờ) thì các ca này phải đỏ.
 */
const CLASS_ID = '01900000-0000-7000-8000-0000000000c1';
const OWNER_ID = '01900000-0000-7000-8000-0000000000b1';
const STUDENT_ID = '01900000-0000-7000-8000-0000000000e1';
const SUSPENDED_ID = '01900000-0000-7000-8000-0000000000e2';
const CONVERSATION_ID = '01900000-0000-7000-8000-0000000000aa';
const REQUEST_ID = '01900000-0000-7000-8000-0000000000f1';
const REQUESTER_ID = '01900000-0000-7000-8000-0000000000e3';
const GRADER_ID = '01900000-0000-7000-8000-0000000000b2';

const CLASS_VIEW = {
  id: CLASS_ID,
  tenantId: '01900000-0000-7000-8000-0000000000a1',
  name: 'Lớp 10A1',
  code: '10A1',
  schoolYear: '2026-2027',
  ownerId: OWNER_ID,
  cohortId: '01900000-0000-7000-8000-0000000000d1',
  allowSelfReport: true,
  joinCode: 'LOP10A1XYZ',
  joinAutoApprove: false,
  onLeave: 'suspend',
  status: 'active',
  description: '',
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
};

const ROSTER = [
  { userId: STUDENT_ID, timeAdded: '2026-10-26T00:00:00.000Z', firstName: 'An', lastName: 'Nguyễn Văn', username: 'an.nguyen', email: 'an@example.com' },
];
const SUSPENDED = [
  { userId: SUSPENDED_ID, firstName: 'Bình', lastName: 'Trần Thị', username: 'binh.tran', email: 'binh@example.com' },
];
const STAFF = {
  staff: [
    { userId: OWNER_ID, firstName: 'Cô', lastName: 'Lê', username: 'teacher1', email: 'teacher1@example.com', isOwner: true, roles: [] },
    { userId: GRADER_ID, firstName: 'Dũng', lastName: 'Phạm', username: 'teacher2', email: 'teacher2@example.com', isOwner: false, roles: [] },
  ],
  canShare: true,
  canManageRoster: true,
};
const REQUESTS = [
  {
    id: REQUEST_ID,
    classId: CLASS_ID,
    userId: REQUESTER_ID,
    firstName: 'Hà',
    lastName: 'Vũ',
    username: 'ha.vu',
    email: 'ha@example.com',
    status: 'pending',
    createdAt: '2026-10-26T01:00:00.000Z',
    decidedAt: null,
  },
];

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(calls: RecordedCall[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const isForm = init?.body instanceof FormData;
      calls.push({ url, method, body: isForm ? 'form-data' : init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url === `/api/v1/classes/${CLASS_ID}`) return respond(CLASS_VIEW);
      if (url === `/api/v1/classes/${CLASS_ID}/courses`) return respond([]);
      if (url === `/api/v1/classes/${CLASS_ID}/roster` && method === 'GET') return respond(ROSTER);
      if (url === `/api/v1/classes/${CLASS_ID}/roster` && method === 'POST') return respond({ added: true }, 201);
      if (url === `/api/v1/classes/${CLASS_ID}/roster/identity` && method === 'POST')
        return respond(
          { userId: '01900000-0000-7000-8000-0000000000e9', username: '0901234567', email: 'moi@example.com', fullName: 'Học Sinh Mới', outcome: 'created', temporaryPassword: 'Lms@9AbCdEfGh' },
          201,
        );
      if (url === `/api/v1/classes/${CLASS_ID}/roster/import-file` && method === 'POST')
        return respond({
          total: 2,
          added: 1,
          created: 1,
          alreadyMembers: 0,
          failed: 1,
          results: [
            { row: 1, fullName: 'Học Sinh Mới', status: 'added_created', userId: '01900000-0000-7000-8000-0000000000e9', username: '0901234567', temporaryPassword: 'Lms@9AbCdEfGh', error: null },
            { row: 2, fullName: 'Dòng Hỏng', status: 'error', userId: null, username: null, temporaryPassword: null, error: 'class.roster_identity_missing' },
          ],
        });
      if (url === `/api/v1/classes/${CLASS_ID}/roster/suspended`) return respond(SUSPENDED);
      if (url === `/api/v1/classes/${CLASS_ID}/staff` && method === 'GET') return respond(STAFF);
      if (url === `/api/v1/classes/${CLASS_ID}/staff` && method === 'POST') return respond(STAFF);
      if (url === `/api/v1/messages/classes/${CLASS_ID}/conversation`) return respond({ id: CONVERSATION_ID, type: 2, itemType: 'class', itemId: CLASS_ID, members: [OWNER_ID, STUDENT_ID] });
      if (url === `/api/v1/classes/${CLASS_ID}/join-requests` && method === 'GET') return respond(REQUESTS);
      if (url === `/api/v1/classes/${CLASS_ID}/join-requests/${REQUEST_ID}/approve` && method === 'POST')
        return respond({ ...REQUESTS[0], status: 'approved', decidedAt: '2026-10-26T02:00:00.000Z' });
      if (url.startsWith('/api/v1/classes/join-preview')) return respond({ classId: CLASS_ID, name: 'Lớp 10A1', schoolYear: '2026-2027', ownerName: 'Lê Cô' });
      if (url === '/api/v1/classes/join' && method === 'POST')
        return respond({ outcome: 'pending', class: { id: CLASS_ID, name: 'Lớp 10A1', schoolYear: '2026-2027' } }, 201);
      return respond({}, 404);
    }),
  );
}

function renderDetail() {
  localStorage.setItem('lms.accessToken', 'test-token');
  const router = createMemoryRouter([{ path: '/classes/:id', element: <ClassDetailPage /> }], { initialEntries: [`/classes/${CLASS_ID}`] });
  render(
    <TestProviders>
      <RouterProvider router={router} />
    </TestProviders>,
  );
}

describe('Chi tiết lớp — roster và các luồng quản trị (CLASS-1)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('nạp HS theo định danh: tài khoản mới tạo thì thông báo hiện mật khẩu tạm đúng lần đó', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderDetail();

    expect(await screen.findByText('Nguyễn Văn An')).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/Họ tên học sinh/), 'Học Sinh Mới');
    await userEvent.type(screen.getByLabelText(/Số điện thoại/), '0901234567');
    await userEvent.click(screen.getByRole('button', { name: 'Thêm vào lớp' }));

    expect(await screen.findByText(/mật khẩu tạm: Lms@9AbCdEfGh/)).toBeTruthy();
    const call = calls.find((c) => c.url.endsWith('/roster/identity'));
    expect(call?.body).toEqual({ fullName: 'Học Sinh Mới', phone: '0901234567' });
  });

  it('import Excel: báo cáo hiện cả dòng tạo tài khoản (kèm mật khẩu tạm) lẫn dòng lỗi theo đúng số dòng', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderDetail();

    const fileInput = await screen.findByLabelText(/Chọn file Excel/);
    const file = new File(['xlsx-bytes'], 'danh-sach.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    await userEvent.upload(fileInput, file);
    await userEvent.click(screen.getByRole('button', { name: 'Nhập danh sách' }));

    expect(await screen.findByText(/Kết quả nhập: 2 dòng/)).toBeTruthy();
    expect(screen.getByText(/Dòng 1: tạo tài khoản 0901234567/)).toBeTruthy();
    expect(screen.getByText(/Dòng 2 \(Dòng Hỏng\): lỗi class\.roster_identity_missing/)).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/roster/import-file') && c.method === 'POST')).toBe(true);
  });

  it('duyệt yêu cầu tự báo danh: gọi endpoint approve của đúng yêu cầu trong hàng chờ', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderDetail();

    expect(await screen.findByText('Vũ Hà')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Duyệt' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/classes/${CLASS_ID}/join-requests/${REQUEST_ID}/approve` && c.method === 'POST')).toBe(true),
    );
  });

  it('phân quyền: tick vai Chấm bài cho đồng GV gửi POST staff với đúng bộ vai', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderDetail();

    expect(await screen.findByText('Phạm Dũng')).toBeTruthy();
    const graderRow = screen.getByText('Phạm Dũng').closest('tr');
    expect(graderRow).not.toBeNull();
    await userEvent.click(within(graderRow as HTMLElement).getByLabelText('Chấm bài'));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/staff') && c.method === 'POST')).toBe(true));
    const call = calls.find((c) => c.url.endsWith('/staff') && c.method === 'POST');
    expect(call?.body).toEqual({ userId: GRADER_ID, roles: ['classgrader'] });
  });

  it('kích hoạt lại học sinh đã đình chỉ = thêm lại vào roster theo userId', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderDetail();

    expect(await screen.findByText('Trần Thị Bình')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Kích hoạt lại' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/roster') && c.method === 'POST')).toBe(true));
    const call = calls.find((c) => c.url.endsWith('/roster') && c.method === 'POST');
    expect(call?.body).toEqual({ userId: SUSPENDED_ID });
  });
});

/**
 * Luồng nút "Chat lớp" ở trang chi tiết lớp (MSG-T2, issue #184):
 * người dùng bấm nút → trang gọi đúng endpoint ensure chat cấp lớp
 * phía messages → điều hướng sang trang Tin nhắn với tham số mở
 * đúng conversation mà server trả. Đổi endpoint hoặc deep-link thì
 * ca này phải đỏ.
 */
describe('Chi tiết lớp — nút Chat lớp (MSG-T2)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('nút "Chat lớp" gọi ensure chat cấp lớp phía messages rồi điều hướng sang Tin nhắn mở đúng conversation', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    localStorage.setItem('lms.accessToken', 'test-token');
    const router = createMemoryRouter(
      [
        { path: '/classes/:id', element: <ClassDetailPage /> },
        { path: '/messages', element: <div>Trang tin nhắn</div> },
      ],
      { initialEntries: [`/classes/${CLASS_ID}`] },
    );
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );

    expect(await screen.findByText('Nguyễn Văn An')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Chat lớp' }));

    expect(await screen.findByText('Trang tin nhắn')).toBeTruthy();
    expect(calls.some((c) => c.url === `/api/v1/messages/classes/${CLASS_ID}/conversation` && c.method === 'GET')).toBe(true);
    expect(router.state.location.pathname).toBe('/messages');
    expect(router.state.location.search).toBe(`?conversation=${CONVERSATION_ID}`);
  });
});

describe('Tự báo danh bằng mã tham gia (CLASS-1)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('mở link có mã: xem trước thấy tên lớp + chủ lớp, xin vào lớp đã có HS thì nhận trạng thái chờ duyệt', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    localStorage.setItem('lms.accessToken', 'test-token');
    const router = createMemoryRouter([{ path: '/classes/join', element: <ClassJoinPage /> }], { initialEntries: ['/classes/join?code=LOP10A1XYZ'] });
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );

    expect(await screen.findByText('Chủ lớp: Lê Cô')).toBeTruthy();
    const joinButtons = screen.getAllByRole('button', { name: 'Xin vào lớp' });
    await userEvent.click(joinButtons[joinButtons.length - 1]!);
    expect(await screen.findByText(/Đã gửi yêu cầu vào lớp "Lớp 10A1"/)).toBeTruthy();
    const call = calls.find((c) => c.url === '/api/v1/classes/join');
    expect(call?.body).toEqual({ joinCode: 'LOP10A1XYZ' });
  });
});

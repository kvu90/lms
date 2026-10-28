import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { ExamPaperEditPage } from './exam-paper-editor';

/**
 * Spec màn soạn đề sau khi chuyển khuôn TanStack Query (F-01 của
 * #133): mở màn sửa thì form khởi tạo đúng từ view đề (tên + slot đã
 * ghim kèm huy hiệu version), tìm câu trong ngân hàng rồi thêm vào đề
 * được, và lưu khi CHỈ slots đổi thì chỉ gọi PUT slots — không gọi
 * PATCH metadata (luật "chỉ gọi phần thật sự đổi" của màn soạn).
 */
const PAPER_ID = '01900000-0000-7000-8000-0000000000e1';
const Q1 = '01900000-0000-7000-8000-0000000000q1'.replace('q', 'a');
const Q2 = '01900000-0000-7000-8000-0000000000q2'.replace('q', 'a');
const COURSE_ID = '01900000-0000-7000-8000-0000000000c1';
const SECTION_ID = '01900000-0000-7000-8000-000000000051';
const PIN_ID = '01900000-0000-7000-8000-0000000000b1';

const PAPER_VIEW = {
  paper: { id: PAPER_ID, bankId: 'bank-1', kind: 'exam', status: 'ready', latestVersion: 3, derivedFromPaperId: null },
  version: {
    id: 'ver-3', version: 3, name: 'Đề giữa kỳ', subjectId: null, grade: 5, examKind: 'midterm',
    totalScore: 10, durationMinutes: 45, matrixId: null, matrixVersion: null,
  },
  slots: [
    {
      position: 1, section: 'A', questionId: Q1, questionName: 'Câu một', qtype: 'multichoice',
      pinnedVersionNumber: 2, latestReadyVersionNumber: 2, hasNewerVersion: false,
      maxMark: 2, clusterId: null, matrixCellId: null,
    },
  ],
  capabilities: { edit: true },
};

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
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === `/api/v1/exams/${PAPER_ID}` && method === 'GET') return respond(PAPER_VIEW);
      if (url === `/api/v1/exams/${PAPER_ID}/pins`) return respond([]);
      if (url.startsWith('/api/v1/questions/discovery?'))
        return respond([{ questionId: Q2, name: 'Câu hai', qtype: 'multichoice', bankName: 'Ngân hàng A' }]);
      if (url === `/api/v1/exams/${PAPER_ID}/slots` && method === 'PUT')
        return respond({ ...PAPER_VIEW, version: { ...PAPER_VIEW.version, version: 4 } });
      if (url === `/api/v1/exams/${PAPER_ID}` && method === 'PATCH')
        return respond({ ...PAPER_VIEW, version: { ...PAPER_VIEW.version, version: 4 } });
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/exams/:paperId/edit', element: <ExamPaperEditPage /> },
      { path: '/exams', element: <div>DANH SÁCH ĐỀ</div> },
    ],
    { initialEntries: [`/exams/${PAPER_ID}/edit`] },
  );
  render(
    <TestProviders>
      <RouterProvider router={router} />
    </TestProviders>,
  );
}

describe('Exam paper editor (F-01 của #133)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('initializes the form from the paper view, adds a discovered question and saves slots only via PUT', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderPage();

    // Form khởi tạo từ view đề: tên đề + slot đã ghim hiện đúng.
    expect(await screen.findByDisplayValue('Đề giữa kỳ')).toBeInTheDocument();
    expect(await screen.findByText(/Câu một/)).toBeInTheDocument();
    expect(screen.getByText('ghim v2')).toBeInTheDocument();

    // Tìm câu theo từ khoá và thêm vào đề.
    await userEvent.type(screen.getByPlaceholderText('Tìm câu trong ngân hàng…'), 'hai');
    await userEvent.click(screen.getByRole('button', { name: 'Tìm trong ngân hàng' }));
    expect(await screen.findByText('Câu hai')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Thêm vào đề' }));

    // Lưu: chỉ slots đổi nên chỉ PUT slots (hai câu, điểm mặc định 1
    // cho câu mới), tuyệt đối không PATCH metadata.
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    expect(await screen.findByText('DANH SÁCH ĐỀ')).toBeInTheDocument();
    const put = calls.find((c) => c.method === 'PUT' && c.url === `/api/v1/exams/${PAPER_ID}/slots`);
    expect(put?.body).toEqual({
      slots: [
        { questionId: Q1, maxMark: 2, section: 'A' },
        { questionId: Q2, maxMark: 1 },
      ],
    });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    const discovery = calls.find((c) => c.url.startsWith('/api/v1/questions/discovery?'));
    expect(discovery?.url).toContain('keyword=hai');
  });
});

/**
 * Ghim đề vào khoá ngay tại màn soạn: form ghim chỉ mở khi đề
 * `ready` và view đề mang cờ deploy; thao tác gọi đúng endpoint
 * exam-pins của hộp ghim ở trang ngân hàng (chọn khoá → chương tự
 * chọn chương đầu → ghim), thành công thì lần ghim mới hiện ngay
 * trong thẻ từ cùng nguồn danh sách lần ghim của đề; API từ chối
 * thì báo kèm lý do và không sinh lần ghim.
 */
function stubPinFetch(calls: RecordedCall[], opts: { deploy: boolean; status?: string; failPin?: boolean }) {
  let pinned = false;
  const view = {
    ...PAPER_VIEW,
    paper: { ...PAPER_VIEW.paper, status: opts.status ?? 'ready' },
    capabilities: { edit: true, deploy: opts.deploy },
  };
  const pinRow = {
    id: PIN_ID, courseId: COURSE_ID, courseName: 'Khoá Toán 5', versionNumber: 3,
    name: null, variantCount: 1, variantCodes: ['001'], createdAt: '2026-10-28T01:00:00.000Z',
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url === `/api/v1/exams/${PAPER_ID}` && method === 'GET') return respond(view);
      if (url === `/api/v1/exams/${PAPER_ID}/pins`) return respond(pinned ? [pinRow] : []);
      if (url === '/api/v1/courses') return respond([{ id: COURSE_ID, fullName: 'Khoá Toán 5' }]);
      if (url === `/api/v1/courses/${COURSE_ID}/content`)
        return respond({
          course: { id: COURSE_ID }, contextId: 'ctx-1', customFields: [],
          sections: [{ id: SECTION_ID, name: 'Chương 1', modules: [] }],
        });
      if (url === `/api/v1/courses/${COURSE_ID}/groups`) return respond([]);
      if (url === `/api/v1/courses/${COURSE_ID}/exam-pins` && method === 'POST') {
        if (opts.failPin) {
          return respond(
            {
              type: 'about:blank', title: 'Forbidden', status: 403, code: 'course.pin_forbidden',
              detail: 'Thiếu quyền tạo hoạt động trong khoá',
            },
            403,
          );
        }
        pinned = true;
        return respond({ id: PIN_ID });
      }
      return respond({}, 404);
    }),
  );
}

describe('Exam paper editor — pin into a course from the editor', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('pins the ready paper into the picked course and shows the new pin in place', async () => {
    const calls: RecordedCall[] = [];
    stubPinFetch(calls, { deploy: true });
    renderPage();

    expect(await screen.findByDisplayValue('Đề giữa kỳ')).toBeInTheDocument();
    // Form ghim hiện dù đề chưa có lần ghim nào.
    await userEvent.selectOptions(await screen.findByLabelText('Chọn khoá học'), COURSE_ID);
    // Chương đầu tiên của khoá đích tự được chọn khi nội dung khoá về.
    await waitFor(() =>
      expect((screen.getByLabelText('Chọn chương') as HTMLSelectElement).value).toBe(SECTION_ID),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ghim vào khoá' }));

    // Đúng thao tác exam-pins dùng chung với hộp ghim ở trang ngân hàng.
    const post = calls.find((c) => c.method === 'POST' && c.url === `/api/v1/courses/${COURSE_ID}/exam-pins`);
    expect(post?.body).toEqual({ sectionId: SECTION_ID, examId: PAPER_ID, variantCount: 1 });
    // Báo thành công kèm phiên bản đã ghim + lần ghim mới hiện tại chỗ.
    expect(await screen.findByText('Đã ghim đề vào khoá (phiên bản v3).')).toBeInTheDocument();
    await waitFor(() => expect(document.body.textContent).toContain('Khoá Toán 5 · v3'));
  });

  it('hides the pin form when the viewer lacks the deploy capability', async () => {
    const calls: RecordedCall[] = [];
    stubPinFetch(calls, { deploy: false });
    renderPage();

    expect(await screen.findByDisplayValue('Đề giữa kỳ')).toBeInTheDocument();
    expect(screen.queryByLabelText('Chọn khoá học')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ghim vào khoá' })).not.toBeInTheDocument();
    // Chưa có lần ghim + không được ghim → thẻ lần ghim không hiện.
    expect(screen.queryByText('Các lần ghim của đề')).not.toBeInTheDocument();
  });

  it('hides the pin form while the paper is not ready', async () => {
    const calls: RecordedCall[] = [];
    stubPinFetch(calls, { deploy: true, status: 'draft' });
    renderPage();

    expect(await screen.findByDisplayValue('Đề giữa kỳ')).toBeInTheDocument();
    expect(screen.queryByLabelText('Chọn khoá học')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ghim vào khoá' })).not.toBeInTheDocument();
  });

  it('reports the API reason when pinning is rejected and creates no pin', async () => {
    const calls: RecordedCall[] = [];
    stubPinFetch(calls, { deploy: true, failPin: true });
    renderPage();

    expect(await screen.findByDisplayValue('Đề giữa kỳ')).toBeInTheDocument();
    await userEvent.selectOptions(await screen.findByLabelText('Chọn khoá học'), COURSE_ID);
    await waitFor(() =>
      expect((screen.getByLabelText('Chọn chương') as HTMLSelectElement).value).toBe(SECTION_ID),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ghim vào khoá' }));

    expect(await screen.findByText(/Ghim đề thất bại/)).toBeInTheDocument();
    expect(screen.getByText(/Thiếu quyền tạo hoạt động trong khoá/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Khoá Toán 5 · v3');
  });
});

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import QuizPaperPage from './quiz-paper';

/**
 * Spec trang chấm bài giấy (CAM-0, issue #112) theo endpoint thật:
 * lô phiếu qua GET /quizzes/:id/paper-batches, hàng chờ qua
 * GET /paper-scans?quizId=, gán định danh qua POST .../assign-identity,
 * xác nhận câu mơ hồ qua POST .../resolve-readings, ghi điểm qua
 * POST .../record. Ảnh phiếu qua GET /paper-scans/:id/image/warped.
 */
const COURSE_ID = '01900000-0000-7000-8000-0000000000c1';
const QUIZ_ID = '01900000-0000-7000-8000-0000000000c2';
const BATCH_ID = '01900000-0000-7000-8000-0000000000c3';
const STUDENT_A = '01900000-0000-7000-8000-0000000000a1';
const STUDENT_B = '01900000-0000-7000-8000-0000000000a2';
const TEACHER_ID = '01900000-0000-7000-8000-0000000000a9';

const PROFILE = {
  id: TEACHER_ID, username: 'teacher1', firstName: 'Giáo', lastName: 'Viên',
  email: 'teacher@example.com', suspended: false, deleted: false, isGuest: false,
  forcePasswordChange: false, lastLogin: null, createdAt: '2026-01-01T00:00:00.000Z', customFields: [],
};

const BATCH = {
  id: BATCH_ID, quizId: QUIZ_ID, variantCode: 'A',
  layout: [1, 2].map((slot) => ({
    slot, questionId: `01900000-0000-7000-8000-0000000000d${slot}`, versionId: `01900000-0000-7000-8000-0000000000e${slot}`,
    qtype: 'multichoice', optionCount: 4, answerIds: ['x1', 'x2', 'x3', 'x4'], maxMark: 2, clusterId: null,
  })),
  roster: [
    { code: '0017', userId: STUDENT_A, displayName: 'Em An' },
    { code: '0024', userId: STUDENT_B, displayName: 'Em Bình' },
  ],
  createdBy: TEACHER_ID, createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z',
};

function makeScan(overrides: Record<string, unknown>) {
  return {
    id: '01900000-0000-7000-8000-0000000000f1', batchId: BATCH_ID, quizId: QUIZ_ID,
    studentId: null, studentName: null, identitySource: null, identityCode: null,
    status: 'needs_identity', quality: { blurVariance: 900, glareRatio: 0.01, fiducialCount: 4 },
    readings: [], rows: [], attemptId: null, expiresAt: null,
    createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z',
    ...overrides,
  };
}

interface RecordedCall { url: string; method: string; body: unknown }

function stubFetch(calls: RecordedCall[], state: { scans: Record<string, unknown>[] }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const respond = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (method !== 'GET' || url.includes('/image/')) {
      calls.push({ url, method, body: init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    }
    if (url === '/api/v1/users/me') return respond(PROFILE);
    if (url === '/api/v1/users/me/capabilities') return respond({ userId: TEACHER_ID, isSiteAdmin: false, assignments: [], contexts: [] });
    if (url.startsWith('/api/v1/users?')) return respond({ users: [PROFILE], total: 1, page: 1, pageSize: 1 });
    if (url === '/api/v1/access/roles') return respond([]);
    if (url === '/api/v1/questions/categories') return respond([]);
    if (url === '/api/v1/courses') return respond([]);
    if (url === `/api/v1/quizzes/${QUIZ_ID}/paper-batches`) return respond([BATCH]);
    if (url === `/api/v1/paper-scans?quizId=${QUIZ_ID}`) return respond(state.scans);
    if (url.includes('/image/warped')) return new Response(new Blob(['png'], { type: 'image/png' }), { status: 200 });
    if (url.endsWith('/assign-identity')) {
      const scan = state.scans.find((s) => url.includes(String(s.id)));
      if (scan) { scan.status = 'ready'; scan.studentId = STUDENT_A; scan.studentName = 'Em An'; scan.identitySource = 'manual'; }
      return respond({ ...scan }, 201);
    }
    if (url.endsWith('/resolve-readings')) {
      const scan = state.scans.find((s) => url.includes(String(s.id)));
      if (scan) scan.status = 'ready';
      return respond({ ...scan }, 201);
    }
    if (url.endsWith('/record')) {
      const scan = state.scans.find((s) => url.includes(String(s.id)));
      if (scan) { scan.status = 'recorded'; scan.attemptId = '01900000-0000-7000-8000-0000000000aa'; }
      return respond({ ...scan, sumGrades: 8 }, 201);
    }
    return respond({}, 404);
  }));
}

function renderPage() {
  const router = createMemoryRouter(
    [{ path: '/courses/:id/quizzes/:quizId/paper', element: <QuizPaperPage /> }],
    { initialEntries: [`/courses/${COURSE_ID}/quizzes/${QUIZ_ID}/paper`] },
  );
  render(
    <TestProviders>
      <RouterProvider router={router} />
    </TestProviders>,
  );
}

describe('Quiz paper page — CAM-0 queues', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('loads batches and queues, then assigns identity, resolves an ambiguous answer and records a grade', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    // jsdom thiếu URL.createObjectURL cho ảnh phiếu: gắn trực tiếp lên
    // class URL (thay cả global URL sẽ làm hỏng constructor của router).
    const urlStatics = URL as unknown as { createObjectURL: () => string; revokeObjectURL: () => void };
    urlStatics.createObjectURL = () => 'blob:fake';
    urlStatics.revokeObjectURL = () => undefined;
    const identityScan = makeScan({ id: '01900000-0000-7000-8000-0000000000f1', status: 'needs_identity', identityCode: '9999' });
    const reviewScan = makeScan({
      id: '01900000-0000-7000-8000-0000000000f2', status: 'needs_review', studentId: STUDENT_B, studentName: 'Em Bình',
      identitySource: 'bubbles', identityCode: '0024',
      readings: [
        { slot: 1, densities: [0.9, 0.02, 0.01, 0.01], chosen: 0, state: 'filled', margin: 0.88, resolvedBy: 'omr' },
        { slot: 2, densities: [0.3, 0.28, 0.02, 0.01], chosen: null, state: 'ambiguous', margin: 0.02, resolvedBy: null },
      ],
      rows: [
        { slot: 1, centers: [{ x: 100, y: 700 }, { x: 142, y: 700 }, { x: 184, y: 700 }, { x: 226, y: 700 }] },
        { slot: 2, centers: [{ x: 100, y: 736 }, { x: 142, y: 736 }, { x: 184, y: 736 }, { x: 226, y: 736 }] },
      ],
    });
    const readyScan = makeScan({
      id: '01900000-0000-7000-8000-0000000000f3', status: 'ready', studentId: STUDENT_A, studentName: 'Em An',
      identitySource: 'qr',
      readings: [{ slot: 1, densities: [0.9, 0.02, 0.01, 0.01], chosen: 0, state: 'filled', margin: 0.88, resolvedBy: 'omr' }],
    });
    const state = { scans: [identityScan, reviewScan, readyScan] as Record<string, unknown>[] };
    const calls: RecordedCall[] = [];
    stubFetch(calls, state);
    renderPage();

    // Lô + ba hàng chờ hiện đúng.
    expect(await screen.findByText(/Mã đề A — 2 học sinh, 2 câu/)).toBeInTheDocument();
    expect(await screen.findByText(/Hàng chờ gán học sinh \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/mã đọc được: 9999/)).toBeInTheDocument();
    expect(screen.getByText(/Hàng chờ xác nhận câu mơ hồ \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Sẵn sàng ghi điểm \(1\)/)).toBeInTheDocument();

    const user = userEvent.setup();
    // Gán định danh: chọn học sinh trong roster của lô → POST assign-identity.
    const select = document.querySelector('select')!;
    await user.selectOptions(select, STUDENT_A);
    await user.click(screen.getByRole('button', { name: 'Gán học sinh này' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/assign-identity')
        && (c.body as { studentId?: string }).studentId === STUDENT_A)).toBe(true));
    expect(await screen.findByText(/Hàng chờ gán học sinh \(0\)/)).toBeInTheDocument();

    // Xác nhận câu mơ hồ: chọn đáp án B cho câu 2 → POST resolve-readings.
    await user.click(screen.getByRole('button', { name: 'B' }));
    await user.click(screen.getByRole('button', { name: 'Xác nhận các câu này' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/resolve-readings')
        && JSON.stringify(c.body) === JSON.stringify({ readings: [{ slot: 2, chosen: 1 }] }))).toBe(true));
    expect(await screen.findByText(/Hàng chờ xác nhận câu mơ hồ \(0\)/)).toBeInTheDocument();

    // Ghi điểm cho phiếu ready đầu tiên → POST record, phiếu sang nhóm đã ghi.
    const recordButtons = screen.getAllByRole('button', { name: 'Ghi điểm' });
    await user.click(recordButtons[0]!);
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/record'))).toBe(true));
    expect(await screen.findByText(/Đã ghi điểm \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/tổng điểm 8/)).toBeInTheDocument();
  });
});

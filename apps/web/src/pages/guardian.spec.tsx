import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { GuardianPage } from './guardian';

const GUARDIAN_ID = '01900000-0000-7000-8000-0000000000p1'.replace('p', 'a');
const CHILD_A = '01900000-0000-7000-8000-0000000000a3';
const CHILD_B = '01900000-0000-7000-8000-0000000000a4';
const COURSE_ID = '01900000-0000-7000-8000-000000000010';
const COURSE2_ID = '01900000-0000-7000-8000-000000000011';

const PROFILE = {
  id: GUARDIAN_ID,
  username: 'phuhuynh1',
  firstName: 'Văn',
  lastName: 'Nguyễn',
  email: 'phuhuynh1@example.com',
  suspended: false,
  deleted: false,
  isGuest: false,
  forcePasswordChange: false,
  lastLogin: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  customFields: [],
};

const ACCESS_VIEW = {
  userId: GUARDIAN_ID,
  isSiteAdmin: false,
  assignments: [],
  contexts: [{ contextId: '01900000-0000-7000-8000-0000000000e1', contextLevel: 10, contextPath: '/1', capabilities: [] }],
};

const STUDENTS = [
  { link: { id: 'link-a' }, student: { id: CHILD_A, username: 'con.a', firstName: 'An', lastName: 'Trần', email: 'a@example.com' } },
  { link: { id: 'link-b' }, student: { id: CHILD_B, username: 'con.b', firstName: 'Bình', lastName: 'Trần', email: 'b@example.com' } },
];

function overviewFor(childId: string) {
  if (childId === CHILD_B) {
    return {
      student: { id: CHILD_B, firstName: 'Bình', lastName: 'Trần' },
      generatedAt: new Date().toISOString(),
      previousSeenAt: null,
      weekly: { weekStart: '2026-10-19T00:00:00.000Z', weekEnd: '2026-10-25T23:59:59.999Z', dueThisWeek: 0, submitted: 0, notSubmitted: 0, overdue: 0, items: [] },
      newResults: [],
      announcements: [],
      courseProgress: [],
    };
  }
  const past = new Date(Date.now() - 3_600_000).toISOString();
  const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
  return {
    student: { id: CHILD_A, firstName: 'An', lastName: 'Trần' },
    generatedAt: new Date().toISOString(),
    previousSeenAt: null,
    weekly: {
      weekStart: '2026-10-19T00:00:00.000Z',
      weekEnd: '2026-10-25T23:59:59.999Z',
      dueThisWeek: 3,
      submitted: 1,
      notSubmitted: 1,
      overdue: 1,
      items: [
        { courseId: COURSE_ID, courseName: 'Toán 1', cmId: 'cm-1', kind: 'assignment', name: 'Bài nộp quá hạn', dueAt: past, status: 'overdue' },
        { courseId: COURSE_ID, courseName: 'Toán 1', cmId: 'cm-2', kind: 'quiz', name: 'Quiz sắp đến hạn', dueAt: soon, status: 'not_submitted' },
      ],
    },
    newResults: [
      { courseId: COURSE_ID, courseName: 'Toán 1', kind: 'grade_item', itemId: 'item-1', itemName: 'Điểm kiểm tra', finalGrade: 9, gradeMax: 10, feedback: 'Làm tốt', changedAt: new Date().toISOString() },
    ],
    announcements: [
      { id: 'n-1', courseId: COURSE_ID, courseName: 'Toán 1', subject: 'Thông báo lớp PH1', body: 'Nội dung thông báo', createdAt: new Date().toISOString() },
    ],
    courseProgress: [
      { courseId: COURSE_ID, courseName: 'Toán 1', total: 2, completed: 1, percent: 50 },
      { courseId: COURSE2_ID, courseName: 'Ngữ văn 1', total: 0, completed: 0, percent: null },
    ],
  };
}

function resultsFor(childId: string) {
  if (childId === CHILD_B) return { student: { id: CHILD_B, firstName: 'Bình', lastName: 'Trần' }, courses: [] };
  return {
    student: { id: CHILD_A, firstName: 'An', lastName: 'Trần' },
    courses: [
      {
        courseId: COURSE_ID,
        courseName: 'Toán 1',
        terms: [{ bookId: 'book-1', term: 'hk1', assessmentMode: 'score', dtbHk: 7.9, commentResult: null, comment: 'Tiến bộ rõ rệt' }],
        year: { dtbYear: 8.6, comment: null },
        courseTotal: { finalGrade: 8.5, gradeMax: 10 },
      },
    ],
  };
}

type Handler = (url: string) => { status: number; body: unknown } | undefined;

function stubFetch(handler: Handler) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const result = handler(url);
      if (!result) return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

function ok(body: unknown) {
  return { status: 200, body };
}

function baseHandler(withChildren: boolean): Handler {
  return (url) => {
    if (url === '/api/v1/users/me') return ok(PROFILE);
    if (url === '/api/v1/users/me/capabilities') return ok(ACCESS_VIEW);
    if (url === '/api/v1/guardian-links/mine/students') return ok(withChildren ? STUDENTS : []);
    const ov = url.match(/^\/api\/v1\/guardian\/students\/([^/]+)\/overview$/);
    if (ov) return ok(overviewFor(ov[1]!));
    const rs = url.match(/^\/api\/v1\/guardian\/students\/([^/]+)\/results$/);
    if (rs) return ok(resultsFor(rs[1]!));
    return undefined;
  };
}

function renderPage() {
  localStorage.setItem('lms.accessToken', 'test-token');
  const router = createMemoryRouter([{ path: '/guardian', element: <GuardianPage /> }], { initialEntries: ['/guardian'] });
  render(
    <TestProviders>
      <RouterProvider router={router} />
    </TestProviders>,
  );
}

describe('Trang phụ huynh chỉ-xem (PH-1, issue #130)', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('hiện đủ 4 khối + kết quả đã công bố của con đầu tiên', async () => {
    stubFetch(baseHandler(true));
    renderPage();

    expect(await screen.findByText('Theo dõi học tập của con')).toBeTruthy();
    // Khối tuần: số liệu + một việc quá hạn.
    expect(await screen.findByText('Bài nộp quá hạn')).toBeTruthy();
    expect(screen.getByText('Quá hạn')).toBeTruthy();
    expect(screen.getByText('Quiz sắp đến hạn')).toBeTruthy();
    // Khối kết quả mới: điểm + lời phê đã công bố.
    expect(screen.getByText('Điểm kiểm tra')).toBeTruthy();
    expect(screen.getByText('9 / 10')).toBeTruthy();
    expect(screen.getByText('Làm tốt')).toBeTruthy();
    // Khối thông báo lớp.
    expect(screen.getByText('Thông báo lớp PH1')).toBeTruthy();
    // Khối tiến độ: 50% + khoá chưa theo dõi.
    expect(screen.getByText(/50%/)).toBeTruthy();
    expect(screen.getByText('Khoá chưa bật theo dõi hoàn thành')).toBeTruthy();
    // Kết quả theo môn: ĐTB kì 7,9 (định dạng vi) + nhận xét tổng + ĐTB năm.
    expect(screen.getByText('7,9')).toBeTruthy();
    expect(screen.getByText(/Tiến bộ rõ rệt/)).toBeTruthy();
    expect(screen.getByText('8,6')).toBeTruthy();
    // Chỉ-xem: ngoài hai nút chọn con, trang không có nút hành động nào.
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Trần An', 'Trần Bình']);
  });

  it('chuyển con: dữ liệu đổi đúng sang con thứ hai (trống)', async () => {
    stubFetch(baseHandler(true));
    renderPage();
    expect(await screen.findByText('Bài nộp quá hạn')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Trần Bình' }));

    expect(await screen.findByText('Tuần này con không có việc nào đến hạn.')).toBeTruthy();
    expect(screen.getByText('Chưa có kết quả mới kể từ lần xem trước.')).toBeTruthy();
    expect(screen.queryByText('Bài nộp quá hạn')).toBeNull();
    expect(screen.queryByText('7,9')).toBeNull();
  });

  it('tài khoản chưa liên kết con nào: báo rõ, không lộ dữ liệu', async () => {
    stubFetch(baseHandler(false));
    renderPage();

    expect(await screen.findByText(/chưa được liên kết với học sinh nào/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Tuần này của con')).toBeNull());
  });
});

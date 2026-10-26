import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuizPage } from './quiz';
import { QuizAttemptPage } from './quiz-attempt';
import { QuizResultsPage } from './quiz-results';

/**
 * Spec web của hoạt động Quiz (issue #30 chặng 1) theo endpoint thật:
 * giáo viên dựng đề (thêm slot cố định từ ngân hàng), học sinh làm bài
 * qua trang attempt (lưu từng câu rồi nộp để chốt điểm), giáo viên chấm
 * tay essay ở trang kết quả và điểm bài được tính lại.
 */
const COURSE_ID = '01900000-0000-7000-8000-0000000000c1';
const QUIZ_ID = '01900000-0000-7000-8000-0000000000c2';
const CATEGORY_ID = '01900000-0000-7000-8000-0000000000c3';
const QUESTION_ID = '01900000-0000-7000-8000-0000000000c4';
const SLOT_ID = '01900000-0000-7000-8000-0000000000c5';
const ATTEMPT_ID = '01900000-0000-7000-8000-0000000000c7';
const QA_ID = '01900000-0000-7000-8000-0000000000c8';
const ANSWER_ID = '01900000-0000-7000-8000-0000000000c9';
const STUDENT_ID = '01900000-0000-7000-8000-0000000000ca';

const doc = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const quizView = (slots: unknown[]) => ({
  id: QUIZ_ID,
  courseId: COURSE_ID,
  cmId: '01900000-0000-7000-8000-0000000000cb',
  name: 'Kiểm tra chương 1',
  intro: '',
  timeOpen: null,
  timeClose: null,
  timeLimitSeconds: null,
  attemptsAllowed: 0,
  gradeMethod: 'highest',
  grade: 10,
  shuffleAnswers: false,
  examId: '01900000-0000-7000-8000-0000000000cc',
  examVersionId: '01900000-0000-7000-8000-0000000000cd',
  targetGroupId: null,
  sumGrades: slots.reduce<number>((sum, s) => sum + (s as { maxMark: number }).maxMark, 0),
  slots,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Pin page — pinned exam surface (#226)', () => {
  it('shows the frozen slots with marks, links to the exam editor and upgrades the pin version', async () => {
    const calls: RecordedCall[] = [];
    const EXAM_ID = '01900000-0000-7000-8000-0000000000cc';
    const OLD_VERSION_ID = '01900000-0000-7000-8000-0000000000cd';
    const NEW_VERSION_ID = '01900000-0000-7000-8000-0000000000ce';
    const slots: unknown[] = [
      {
        id: SLOT_ID, slot: 1, page: 1, questionId: QUESTION_ID, categoryId: null, maxMark: 5,
        versionMode: 'pinned', pinnedVersion: 1, latestVersion: 1, hasNewerVersion: false,
        bankId: null, bankName: null, bankScope: null, questionStatus: null,
      },
    ];
    let pinVersionId = OLD_VERSION_ID;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
        calls.push({ url, method, body });
        if (url === `/api/v1/exam-pins/${QUIZ_ID}` && method === 'GET')
          return respond({
            quiz: { ...quizView(slots), examId: EXAM_ID, examVersionId: pinVersionId },
            effective: { timeOpen: null, timeClose: null, timeLimitSeconds: null, attemptsAllowed: 0, passwordRequired: false, nextAttemptAt: null },
            permissions: { attempt: false, manage: true, manageOverrides: false, grade: true, viewReports: true, preview: true },
            canAttempt: false,
            attemptBlockedReason: null,
            inProgressAttemptId: null,
            myAttempts: [],
            myGrade: null,
          });
        if (url === `/api/v1/exam-pins/${QUIZ_ID}` && method === 'PATCH') {
          pinVersionId = body?.examVersionId as string;
          return respond({ ...quizView(slots), examId: EXAM_ID, examVersionId: pinVersionId });
        }
        if (url === `/api/v1/exams/${EXAM_ID}`)
          return respond({
            paper: { id: EXAM_ID, bankId: 'b1', kind: 'snapshot', status: 'ready', latestVersion: 2 },
            version: { id: NEW_VERSION_ID, version: 2, name: 'Kiểm tra chương 1' },
            slots: [],
            capabilities: { edit: true },
          });
        if (url === `/api/v1/questions/${QUESTION_ID}`)
          return respond({
            question: { id: QUESTION_ID, category: CATEGORY_ID, qtype: 'multichoice', name: 'Capital' },
            entry: { id: 'e1', questionCategoryId: CATEGORY_ID, questionId: QUESTION_ID, latestVersion: 1 },
            latestVersion: { id: 'v1', questionBankEntryId: 'e1', questionId: QUESTION_ID, version: 1, questionText: doc('Capital?'), defaultMark: 2 },
          });
        if (url === `/api/v1/courses/${COURSE_ID}/groups`) return respond([]);
        return respond({}, 404);
      }),
    );

    const router = createMemoryRouter([{ path: '/courses/:id/exams/:pinId', element: <QuizPage /> }], {
      initialEntries: [`/courses/${COURSE_ID}/exams/${QUIZ_ID}`],
    });
    // Trang lần ghim đã chuyển sang TanStack Query (F-01 đợt 1, #133):
    // render qua TestProviders để có QueryClient như cây provider thật.
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );

    // Slot đã ghim hiện tên câu + điểm, CHỈ ĐỌC (không còn ô sửa điểm/soạn slot trong khoá).
    const slotEl = await screen.findByTestId(`slot-${SLOT_ID}`);
    expect(slotEl).toHaveTextContent('Capital');
    expect(slotEl).toHaveTextContent('5 điểm');
    expect(slotEl.querySelector('input')).toBeNull();

    // Nút mở trình soạn đề trỏ về trang Đề.
    const editorLink = await screen.findByRole('link', { name: 'Mở trình soạn đề' });
    expect(editorLink.getAttribute('href')).toBe(`/exams/${EXAM_ID}/edit`);

    // Đề ở bank đã có version 2 → nâng version của lần ghim qua PATCH pin.
    await userEvent.click(await screen.findByRole('button', { name: 'Nâng lên version 2' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: `/api/v1/exam-pins/${QUIZ_ID}`,
        method: 'PATCH',
        body: { examVersionId: NEW_VERSION_ID },
      }),
    );
    // Sau khi nâng, nút nâng biến mất (pin đã ở version hiện hành).
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Nâng lên version 2' })).toBeNull());
  });
});

describe('Quiz attempt page — real endpoints', () => {
  it('saves an answer per question and submits to reveal the graded result', async () => {
    const calls: RecordedCall[] = [];
    let submitted = false;
    let savedResponse: string | null = null;
    const attemptView = () => ({
      attempt: {
        id: ATTEMPT_ID,
        quizId: QUIZ_ID,
        userId: STUDENT_ID,
        attemptNumber: 1,
        state: submitted ? 'finished' : 'inprogress',
        preview: false,
        timeStart: new Date().toISOString(),
        timeFinish: submitted ? new Date().toISOString() : null,
        sumGrades: submitted ? 5 : null,
        grade: submitted ? 10 : null,
      },
      quiz: { ...quizView([]), sumGrades: 5 },
      questions: [
        {
          slot: 1,
          page: 1,
          questionAttemptId: QA_ID,
          questionId: QUESTION_ID,
          qtype: 'multichoice',
          name: 'Capital',
          questionText: doc('Capital of France?'),
          stimulus: null,
          answers: [
            { id: ANSWER_ID, text: doc('Paris') },
            { id: '01900000-0000-7000-8000-0000000000cc', text: doc('London') },
          ],
          options: { single: true },
          maxMark: 5,
          state: submitted ? 'gradedright' : 'todo',
          response: savedResponse,
          fraction: submitted ? 1 : null,
          mark: submitted ? 5 : null,
          rightAnswer: submitted ? 'Paris' : null,
        },
      ],
      totalMax: 5,
      pendingManualCount: 0,
      closedDueToTimeLimit: false,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method, body });
        if (url === `/api/v1/quiz-attempts/${ATTEMPT_ID}`) return respond(attemptView());
        if (url === `/api/v1/quiz-attempts/${ATTEMPT_ID}/responses` && method === 'POST') {
          savedResponse = body.response;
          return respond({ id: QA_ID }, 201);
        }
        if (url === `/api/v1/quiz-attempts/${ATTEMPT_ID}/submit` && method === 'POST') {
          submitted = true;
          return respond(attemptView(), 201);
        }
        return respond({}, 404);
      }),
    );

    const router = createMemoryRouter([{ path: '/quiz-attempts/:attemptId', element: <QuizAttemptPage /> }], {
      initialEntries: [`/quiz-attempts/${ATTEMPT_ID}`],
    });
    // Trang lần ghim đã chuyển sang TanStack Query (F-01 đợt 1, #133):
    // render qua TestProviders để có QueryClient như cây provider thật.
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );

    await userEvent.click(await screen.findByRole('radio', { name: 'Paris' }));
    await userEvent.click(screen.getByRole('button', { name: 'Lưu câu trả lời' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: `/api/v1/quiz-attempts/${ATTEMPT_ID}/responses`,
        method: 'POST',
        body: { questionAttemptId: QA_ID, response: ANSWER_ID },
      }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Nộp bài' }));
    expect(await screen.findByText(/Kết quả: 5\/5 điểm câu — điểm bài 10\/10/)).toBeInTheDocument();
    expect(screen.getByText(/Đáp án đúng: Paris/)).toBeInTheDocument();
  });

  it('renders all four feedback layers on the review page (ĐX-3, #181)', async () => {
    const finishedView = {
      attempt: {
        id: ATTEMPT_ID,
        quizId: QUIZ_ID,
        userId: STUDENT_ID,
        attemptNumber: 1,
        state: 'finished',
        preview: false,
        timeStart: new Date().toISOString(),
        timeFinish: new Date().toISOString(),
        sumGrades: 5,
        grade: 10,
      },
      quiz: { ...quizView([]), sumGrades: 5 },
      questions: [
        {
          slot: 1,
          page: 1,
          questionAttemptId: QA_ID,
          questionId: QUESTION_ID,
          qtype: 'multichoice',
          name: 'Capital',
          questionText: doc('Capital of France?'),
          stimulus: null,
          answers: [
            { id: ANSWER_ID, text: doc('Paris') },
            { id: '01900000-0000-7000-8000-0000000000cc', text: doc('London') },
          ],
          options: { single: true },
          maxMark: 5,
          state: 'gradedright',
          response: ANSWER_ID,
          fraction: 1,
          mark: 5,
          rightAnswer: 'Paris',
          feedback: doc('Nhận xét riêng cho đáp án Paris.'),
          generalFeedback: doc('Paris là thủ đô của Pháp.'),
          manualComment: 'Cô đã đọc bài của em.',
        },
      ],
      totalMax: 5,
      pendingManualCount: 0,
      closedDueToTimeLimit: false,
      overallFeedback: 'Làm tốt lắm, tiếp tục phát huy.',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === `/api/v1/quiz-attempts/${ATTEMPT_ID}`) return respond(finishedView);
        return respond({}, 404);
      }),
    );

    const router = createMemoryRouter([{ path: '/quiz-attempts/:attemptId', element: <QuizAttemptPage /> }], {
      initialEntries: [`/quiz-attempts/${ATTEMPT_ID}`],
    });
    // Trang lần ghim đã chuyển sang TanStack Query (F-01 đợt 1, #133):
    // render qua TestProviders để có QueryClient như cây provider thật.
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );

    expect(await screen.findByText(/Nhận xét cho đáp án của bạn: Nhận xét riêng cho đáp án Paris\./)).toBeInTheDocument();
    expect(screen.getByText(/Nhận xét của giáo viên: Cô đã đọc bài của em\./)).toBeInTheDocument();
    expect(screen.getByText('Lời giải')).toBeInTheDocument();
    expect(screen.getByText(/Paris là thủ đô của Pháp\./)).toBeInTheDocument();
    expect(screen.getByText(/Nhận xét chung: Làm tốt lắm, tiếp tục phát huy\./)).toBeInTheDocument();
  });
});

describe('Quiz results page — manual grading', () => {
  it('grades a pending essay and the queue empties after reload', async () => {
    const calls: RecordedCall[] = [];
    let graded = false;
    const results = () => ({
      quiz: { ...quizView([]), sumGrades: 3 },
      attempts: [
        {
          id: ATTEMPT_ID,
          quizId: QUIZ_ID,
          userId: STUDENT_ID,
          attemptNumber: 1,
          state: graded ? 'finished' : 'needsgrading',
          preview: false,
          timeStart: new Date().toISOString(),
          timeFinish: new Date().toISOString(),
          sumGrades: graded ? 2 : 0,
          grade: graded ? 6.67 : null,
        },
      ],
      gradesByUser: [{ userId: STUDENT_ID, grade: graded ? 6.67 : null }],
      questionStats: [],
      needsGrading: graded
        ? []
        : [
            {
              quizAttemptId: ATTEMPT_ID,
              userId: STUDENT_ID,
              attemptNumber: 1,
              questionAttemptId: QA_ID,
              slot: 1,
              questionId: QUESTION_ID,
              maxMark: 3,
              response: 'My essay text',
            },
          ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method, body });
        if (url === `/api/v1/exam-pins/${QUIZ_ID}/results`) return respond(results());
        if (url === `/api/v1/quiz-attempts/${ATTEMPT_ID}/questions/${QA_ID}/grade` && method === 'POST') {
          graded = true;
          return respond({ state: 'gradedpartial' }, 201);
        }
        return respond({}, 404);
      }),
    );

    const router = createMemoryRouter(
      [{ path: '/courses/:id/exams/:pinId/results', element: <QuizResultsPage /> }],
      { initialEntries: [`/courses/${COURSE_ID}/exams/${QUIZ_ID}/results`] },
    );
    render(<RouterProvider router={router} />);

    expect(await screen.findByText('My essay text')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Điểm'), '2');
    await userEvent.click(screen.getByRole('button', { name: 'Chấm câu này' }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        url: `/api/v1/quiz-attempts/${ATTEMPT_ID}/questions/${QA_ID}/grade`,
        method: 'POST',
        body: { mark: 2 },
      }),
    );
    expect(await screen.findByText('Không có câu nào đang chờ chấm.')).toBeInTheDocument();
  });

  it('shows per-question wrong statistics with the students who missed each question', async () => {
    const STUDENT2_ID = '01900000-0000-7000-8000-0000000000cc';
    const results = {
      quiz: { ...quizView([]), sumGrades: 6 },
      attempts: [],
      gradesByUser: [],
      needsGrading: [],
      questionStats: [
        {
          slot: 1,
          questionId: QUESTION_ID,
          questionName: 'Capital',
          maxMark: 5,
          attemptsCount: 2,
          gradedCount: 2,
          pendingCount: 0,
          wrongCount: 2,
          fullyWrongCount: 2,
          wrongStudents: [
            { userId: STUDENT_ID, displayName: 'Trần Minh Quân', quizAttemptId: ATTEMPT_ID, attemptNumber: 1, fraction: 0, mark: 0 },
            { userId: STUDENT2_ID, displayName: 'Phạm Thu Hằng', quizAttemptId: '01900000-0000-7000-8000-0000000000cd', attemptNumber: 1, fraction: 0, mark: 0 },
          ],
        },
        {
          slot: 2,
          questionId: null,
          questionName: null,
          maxMark: 1,
          attemptsCount: 2,
          gradedCount: 2,
          pendingCount: 0,
          wrongCount: 0,
          fullyWrongCount: 0,
          wrongStudents: [],
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === `/api/v1/exam-pins/${QUIZ_ID}/results`) return respond(results);
        return respond({}, 404);
      }),
    );

    const router = createMemoryRouter(
      [{ path: '/courses/:id/exams/:pinId/results', element: <QuizResultsPage /> }],
      { initialEntries: [`/courses/${COURSE_ID}/exams/${QUIZ_ID}/results`] },
    );
    render(<RouterProvider router={router} />);

    // Câu sai nhiều nhất (API đã xếp slot 1 lên đầu) kèm tên học sinh sai.
    const first = await screen.findByTestId('question-stat-1');
    expect(first).toHaveTextContent('Capital');
    expect(first).toHaveTextContent('2/2');
    expect(await screen.findByTestId(`question-stat-1-wrong-${STUDENT_ID}`)).toHaveTextContent('Trần Minh Quân');
    expect(await screen.findByTestId(`question-stat-1-wrong-${STUDENT2_ID}`)).toHaveTextContent('Phạm Thu Hằng');
    // Slot ngẫu nhiên không có tên câu; không ai sai thì báo rõ.
    const second = await screen.findByTestId('question-stat-2');
    expect(second).toHaveTextContent('Câu ngẫu nhiên');
    expect(second).toHaveTextContent('Chưa có học sinh nào làm sai câu này.');
  });
});

describe('Quiz overrides — teacher surface (#182)', () => {
  const GROUP_ID = '01900000-0000-7000-8000-0000000000d1';
  const OVERRIDE_GROUP_ID = '01900000-0000-7000-8000-0000000000d2';
  const OVERRIDE_USER_ID = '01900000-0000-7000-8000-0000000000d3';
  const TEACHER_ID = '01900000-0000-7000-8000-0000000000d4';

  function setup() {
    const calls: RecordedCall[] = [];
    let overrides: Record<string, unknown>[] = [
      {
        id: OVERRIDE_GROUP_ID, quizId: QUIZ_ID, groupId: GROUP_ID, groupName: 'Nhóm 1',
        userId: null, userName: null, timeOpen: null, timeClose: null,
        timeLimitSeconds: 2700, attempts: null, hasPassword: false, reason: 'Nhóm học chậm hơn',
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
        calls.push({ url, method, body });
        if (url === `/api/v1/exam-pins/${QUIZ_ID}` && method === 'GET')
          return respond({
            quiz: quizView([]),
            effective: { timeOpen: null, timeClose: null, timeLimitSeconds: null, attemptsAllowed: 0, passwordRequired: false, nextAttemptAt: null },
            permissions: { attempt: false, manage: false, manageOverrides: true, grade: false, viewReports: true, preview: false },
            canAttempt: false, attemptBlockedReason: null, inProgressAttemptId: null, myAttempts: [], myGrade: null,
          });
        if (url === `/api/v1/exam-pins/${QUIZ_ID}/overrides` && method === 'GET') return respond(overrides);
        if (url === `/api/v1/exam-pins/${QUIZ_ID}/overrides` && method === 'POST') {
          const created = {
            id: OVERRIDE_USER_ID, quizId: QUIZ_ID,
            groupId: (body?.groupId as string) ?? null, groupName: body?.groupId ? 'Nhóm 1' : null,
            userId: (body?.userId as string) ?? null, userName: body?.userId ? 'Trần Minh Quân' : null,
            timeOpen: (body?.timeOpen as string) ?? null, timeClose: (body?.timeClose as string) ?? null,
            timeLimitSeconds: (body?.timeLimitSeconds as number) ?? null, attempts: (body?.attempts as number) ?? null,
            hasPassword: Boolean(body?.password), reason: (body?.reason as string) ?? null,
          };
          overrides = [...overrides, created];
          return respond(created, 201);
        }
        if (url.startsWith(`/api/v1/exam-pin-overrides/`) && method === 'PATCH') {
          const id = url.split('/').pop();
          overrides = overrides.map((ov) => {
            if (ov.id !== id) return ov;
            const next = { ...ov, ...body };
            if (body && 'password' in body) next.hasPassword = Boolean(body.password);
            return next;
          });
          return respond(overrides.find((ov) => ov.id === id));
        }
        if (url.startsWith(`/api/v1/exam-pin-overrides/`) && method === 'DELETE') {
          const id = url.split('/').pop();
          overrides = overrides.filter((ov) => ov.id !== id);
          return respond({ deleted: true });
        }
        if (url === `/api/v1/messages/courses/${COURSE_ID}/members?limit=100`)
          return respond({
            members: [
              { userId: STUDENT_ID, displayName: 'Trần Minh Quân', username: 'student1', role: 'student', relationship: 'none' },
              { userId: TEACHER_ID, displayName: 'Cô Lan', username: 'teacher1', role: 'teacher', relationship: 'none' },
            ],
            nextCursor: null,
          });
        if (url === `/api/v1/courses/${COURSE_ID}/groups`)
          return respond([{ id: GROUP_ID, courseId: COURSE_ID, name: 'Nhóm 1', idNumber: '', description: '' }]);
        return respond({}, 404);
      }),
    );
    const router = createMemoryRouter([{ path: '/courses/:id/exams/:pinId', element: <QuizPage /> }], {
      initialEntries: [`/courses/${COURSE_ID}/exams/${QUIZ_ID}`],
    });
    // Trang lần ghim đã chuyển sang TanStack Query (F-01 đợt 1, #133):
    // render qua TestProviders để có QueryClient như cây provider thật.
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );
    return { calls };
  }

  it('blocks a student override that opens a window without a reason, then creates it once the reason is given', async () => {
    const { calls } = setup();
    // Ghi đè nhóm có sẵn hiện với tên nhóm + lý do.
    const groupRow = await screen.findByTestId(`override-${OVERRIDE_GROUP_ID}`);
    expect(groupRow).toHaveTextContent('Nhóm 1');
    expect(groupRow).toHaveTextContent('Nhóm học chậm hơn');

    // Chọn học sinh (giáo viên trong roster bị lọc khỏi ô chọn), mở cửa sổ riêng, KHÔNG nhập lý do.
    await userEvent.click(await screen.findByLabelText('Chọn học sinh'));
    await userEvent.click(await screen.findByRole('option', { name: 'Trần Minh Quân' }));
    fireEvent.change(screen.getByLabelText('Mở riêng lúc'), { target: { value: '2026-10-26T08:00' } });
    await userEvent.click(screen.getByRole('button', { name: 'Thêm ghi đè' }));

    // Bị chặn ngay ở web: hiện lỗi lý do và KHÔNG có POST nào được phát.
    expect(await screen.findByText(/bắt buộc phải có lý do/)).toBeInTheDocument();
    expect(calls.some((c) => c.url === `/api/v1/exam-pins/${QUIZ_ID}/overrides` && c.method === 'POST')).toBe(false);

    // Bổ sung lý do → tạo thành công đúng payload cho đúng học sinh đó.
    await userEvent.type(screen.getByLabelText('Lý do ghi đè'), 'Ốm, kiểm tra bù');
    await userEvent.click(screen.getByRole('button', { name: 'Thêm ghi đè' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: `/api/v1/exam-pins/${QUIZ_ID}/overrides`,
        method: 'POST',
        body: {
          userId: STUDENT_ID,
          timeOpen: new Date('2026-10-26T08:00').toISOString(),
          timeClose: null,
          timeLimitSeconds: null,
          attempts: null,
          reason: 'Ốm, kiểm tra bù',
        },
      }),
    );
    // Dòng ghi đè mới hiện tên học sinh + nhãn Kiểm tra bù (cửa sổ riêng cho học sinh).
    const userRow = await screen.findByTestId(`override-${OVERRIDE_USER_ID}`);
    expect(userRow).toHaveTextContent('Trần Minh Quân');
    expect(userRow).toHaveTextContent('Kiểm tra bù');
  });

  it('edits an override (PATCH) and deletes it (DELETE)', async () => {
    const { calls } = setup();
    const groupRow = await screen.findByTestId(`override-${OVERRIDE_GROUP_ID}`);
    await userEvent.click(within(groupRow).getByRole('button', { name: 'Sửa' }));

    // Form nạp sẵn giá trị hiện tại: 2700 giây = 45 phút, lý do có sẵn.
    const limitInput = screen.getByLabelText('Thời gian làm riêng (phút)');
    expect(limitInput).toHaveValue('45');
    expect(screen.getByLabelText('Lý do ghi đè')).toHaveValue('Nhóm học chậm hơn');
    fireEvent.change(limitInput, { target: { value: '60' } });
    await userEvent.click(screen.getByRole('button', { name: 'Lưu ghi đè' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: `/api/v1/exam-pin-overrides/${OVERRIDE_GROUP_ID}`,
        method: 'PATCH',
        body: { timeOpen: null, timeClose: null, timeLimitSeconds: 3600, attempts: null, reason: 'Nhóm học chậm hơn' },
      }),
    );

    const updatedRow = await screen.findByTestId(`override-${OVERRIDE_GROUP_ID}`);
    expect(updatedRow).toHaveTextContent('Thời gian làm: 60 phút');
    await userEvent.click(within(updatedRow).getByRole('button', { name: 'Xoá ghi đè' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: `/api/v1/exam-pin-overrides/${OVERRIDE_GROUP_ID}`,
        method: 'DELETE',
        body: undefined,
      }),
    );
    expect(await screen.findByText('Chưa có ghi đè nào.')).toBeInTheDocument();
  });
});

describe('Quiz page — student sees their effective (overridden) settings (#182)', () => {
  it('shows the effective window/limits from the API, not the quiz-wide ones', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === `/api/v1/exam-pins/${QUIZ_ID}`)
          return respond({
            quiz: {
              ...quizView([]),
              timeOpen: '2026-10-20T07:00:00.000Z', timeClose: '2026-10-20T09:00:00.000Z',
              timeLimitSeconds: 1800, attemptsAllowed: 1,
            },
            effective: {
              timeOpen: '2026-10-27T07:00:00.000Z', timeClose: '2026-10-27T09:00:00.000Z',
              timeLimitSeconds: 2700, attemptsAllowed: 2, passwordRequired: false, nextAttemptAt: null,
            },
            permissions: { attempt: true, manage: false, manageOverrides: false, grade: false, viewReports: false, preview: false },
            canAttempt: false, attemptBlockedReason: 'not_yet_open', inProgressAttemptId: null, myAttempts: [], myGrade: null,
          });
        return respond({}, 404);
      }),
    );
    const router = createMemoryRouter([{ path: '/courses/:id/exams/:pinId', element: <QuizPage /> }], {
      initialEntries: [`/courses/${COURSE_ID}/exams/${QUIZ_ID}`],
    });
    // Trang lần ghim đã chuyển sang TanStack Query (F-01 đợt 1, #133):
    // render qua TestProviders để có QueryClient như cây provider thật.
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );

    expect(await screen.findByText('Đang áp dụng ghi đè riêng cho bạn — cửa sổ và giới hạn dưới đây là của riêng bạn.')).toBeInTheDocument();
    // Giới hạn hiệu lực 45 phút (ghi đè) chứ không phải 30 phút (cài đặt chung); số lần làm 2 chứ không phải 1.
    expect(screen.getByText(/Giới hạn thời gian làm bài: 45/)).toBeInTheDocument();
    expect(screen.queryByText(/Giới hạn thời gian làm bài: 30/)).not.toBeInTheDocument();
    expect(screen.getByText(/Số lần làm cho phép: 2/)).toBeInTheDocument();
  });
});

describe('Quiz results page — makeup badge (#182)', () => {
  it('labels makeup attempts for the teacher and leaves normal attempts unlabelled', async () => {
    const ATTEMPT2_ID = '01900000-0000-7000-8000-0000000000d5';
    const baseAttempt = {
      quizId: QUIZ_ID, userId: STUDENT_ID, attemptNumber: 1, state: 'finished', preview: false,
      timeStart: new Date().toISOString(), timeFinish: new Date().toISOString(), sumGrades: 8, grade: 8,
    };
    const results = {
      quiz: { ...quizView([]), sumGrades: 10 },
      attempts: [
        { ...baseAttempt, id: ATTEMPT_ID, makeup: true },
        { ...baseAttempt, id: ATTEMPT2_ID, attemptNumber: 2, makeup: false },
      ],
      gradesByUser: [{ userId: STUDENT_ID, grade: 8 }],
      needsGrading: [],
      questionStats: [],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === `/api/v1/exam-pins/${QUIZ_ID}/results`) return respond(results);
        return respond({}, 404);
      }),
    );
    const router = createMemoryRouter(
      [{ path: '/courses/:id/exams/:pinId/results', element: <QuizResultsPage /> }],
      { initialEntries: [`/courses/${COURSE_ID}/exams/${QUIZ_ID}/results`] },
    );
    render(<RouterProvider router={router} />);

    const makeupRow = await screen.findByTestId(`result-attempt-${ATTEMPT_ID}`);
    expect(makeupRow).toHaveTextContent('Kiểm tra bù');
    const normalRow = await screen.findByTestId(`result-attempt-${ATTEMPT2_ID}`);
    expect(normalRow).not.toHaveTextContent('Kiểm tra bù');
  });
});

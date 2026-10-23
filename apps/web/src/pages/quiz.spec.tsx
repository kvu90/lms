import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
const SLOT2_ID = '01900000-0000-7000-8000-0000000000c6';
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
  sumGrades: slots.reduce<number>((sum, s) => sum + (s as { maxMark: number }).maxMark, 0),
  slots,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Quiz builder page — real endpoints', () => {
  it('shows slots with their marks and adds a fixed question from the bank', async () => {
    const calls: RecordedCall[] = [];
    const slots: unknown[] = [
      { id: SLOT_ID, slot: 1, page: 1, questionId: QUESTION_ID, categoryId: null, maxMark: 5 },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url === `/api/v1/quizzes/${QUIZ_ID}`)
          return respond({
            quiz: quizView(slots),
            slots,
            permissions: { attempt: false, manage: true, grade: true, viewReports: true, preview: true },
            canAttempt: false,
            attemptBlockedReason: null,
            myAttempts: [],
            myGrade: null,
            activeAttemptId: null,
          });
        if (url === '/api/v1/questions/categories')
          return respond([{ id: CATEGORY_ID, name: 'General', contextId: CATEGORY_ID, info: '', parent: null }]);
        if (url === `/api/v1/questions/categories/${CATEGORY_ID}/questions`)
          return respond([
            {
              question: { id: QUESTION_ID, category: CATEGORY_ID, qtype: 'multichoice', name: 'Capital' },
              entry: { id: 'e1', questionCategoryId: CATEGORY_ID, questionId: QUESTION_ID, latestVersion: 1 },
              latestVersion: { id: 'v1', questionBankEntryId: 'e1', questionId: QUESTION_ID, version: 1, questionText: doc('Capital?'), defaultMark: 2 },
            },
          ]);
        if (url === `/api/v1/questions/${QUESTION_ID}`)
          return respond({
            question: { id: QUESTION_ID, category: CATEGORY_ID, qtype: 'multichoice', name: 'Capital' },
            entry: { id: 'e1', questionCategoryId: CATEGORY_ID, questionId: QUESTION_ID, latestVersion: 1 },
            latestVersion: { id: 'v1', questionBankEntryId: 'e1', questionId: QUESTION_ID, version: 1, questionText: doc('Capital?'), defaultMark: 2 },
          });
        if (url === `/api/v1/quizzes/${QUIZ_ID}/slots` && method === 'POST') {
          slots.push({ id: SLOT2_ID, slot: 2, page: 1, questionId: QUESTION_ID, categoryId: null, maxMark: 2 });
          return respond({ id: SLOT2_ID, slot: 2, page: 1, questionId: QUESTION_ID, categoryId: null, maxMark: 2 }, 201);
        }
        return respond({}, 404);
      }),
    );

    const router = createMemoryRouter([{ path: '/courses/:id/quizzes/:quizId', element: <QuizPage /> }], {
      initialEntries: [`/courses/${COURSE_ID}/quizzes/${QUIZ_ID}`],
    });
    render(<RouterProvider router={router} />);

    // Slot hiện có hiện với điểm đã sửa ở slot (5) chứ không phải default (2).
    const slotEl = await screen.findByTestId(`slot-${SLOT_ID}`);
    expect(slotEl).toHaveTextContent('Capital');
    expect(slotEl.querySelector('input')).toHaveValue('5');

    // Cả hai form (cố định/ngẫu nhiên) đều có ô chọn danh mục; form cố định đứng trước.
    const [fixedCategorySelect] = await screen.findAllByLabelText('Chọn danh mục');
    await userEvent.selectOptions(fixedCategorySelect!, CATEGORY_ID);
    await userEvent.selectOptions(await screen.findByLabelText('Chọn câu hỏi'), QUESTION_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Thêm vào đề' }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        url: `/api/v1/quizzes/${QUIZ_ID}/slots`,
        method: 'POST',
        body: { questionId: QUESTION_ID },
      }),
    );
    // Sau reload, slot mới xuất hiện và tổng điểm đề là 7.
    expect(await screen.findByTestId(`slot-${SLOT2_ID}`)).toBeInTheDocument();
    expect(screen.getByText(/Tổng điểm các câu: 7/)).toBeInTheDocument();
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
    render(<RouterProvider router={router} />);

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
        if (url === `/api/v1/quizzes/${QUIZ_ID}/results`) return respond(results());
        if (url === `/api/v1/quiz-attempts/${ATTEMPT_ID}/questions/${QA_ID}/grade` && method === 'POST') {
          graded = true;
          return respond({ state: 'gradedpartial' }, 201);
        }
        return respond({}, 404);
      }),
    );

    const router = createMemoryRouter(
      [{ path: '/courses/:id/quizzes/:quizId/results', element: <QuizResultsPage /> }],
      { initialEntries: [`/courses/${COURSE_ID}/quizzes/${QUIZ_ID}/results`] },
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
});

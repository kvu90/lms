import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { QuizPage } from './quiz';
import { QuizAttemptPage } from './quiz-attempt';
import { QuizResultsPage } from './quiz-results';

/**
 * Giả lập @lms/editor cho spec trang attempt: chỉ cần RichTextView
 * dựng nội dung rich text thành chữ đọc được — spec trang kiểm LUỒNG
 * NGHIỆP VỤ phía học sinh (hướng dẫn/lời giải hiện theo cổng), cơ chế
 * render Tiptap thật thuộc spec của chính package editor (mẫu P4).
 */
vi.mock('@lms/editor', async () => {
  const React = await import('react');
  interface NodeLike {
    type: string;
    text?: string;
    content?: NodeLike[];
  }
  const collectText = (node: NodeLike | null | undefined): string => {
    if (!node) return '';
    if (typeof node.text === 'string') return node.text;
    return (node.content ?? []).map((child) => collectText(child)).join(' ');
  };
  return {
    RichTextView: ({ value }: { value: NodeLike | null }) =>
      value ? React.createElement('div', null, collectText(value)) : null,
  };
});

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
  examVersionNumber: 1,
  latestExamVersionNumber: 1,
  hasNewerExamVersion: false,
  versionMode: 'pinned',
  targetGroupId: null,
  sumGrades: slots.reduce<number>((sum, s) => sum + (s as { maxMark: number }).maxMark, 0),
  slots,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Trang ghim — bề mặt đề đã ghim (#226)', () => {
  it('hiện slot đã đóng băng kèm điểm, liên kết tới trình sửa đề và cập nhật phiên bản ghim qua luồng diff-first (#254)', async () => {
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
            quiz: {
              ...quizView(slots), examId: EXAM_ID, examVersionId: pinVersionId,
              examVersionNumber: pinVersionId === OLD_VERSION_ID ? 1 : 2,
              latestExamVersionNumber: 2,
              hasNewerExamVersion: pinVersionId === OLD_VERSION_ID,
            },
            effective: { timeOpen: null, timeClose: null, timeLimitSeconds: null, attemptsAllowed: 0, passwordRequired: false, nextAttemptAt: null },
            permissions: { attempt: false, manage: true, manageOverrides: false, grade: true, viewReports: true, preview: true },
            canAttempt: false,
            attemptBlockedReason: null,
            inProgressAttemptId: null,
            myAttempts: [],
            myGrade: null,
          });
        if (url === `/api/v1/exam-pins/${QUIZ_ID}/version-update` && method === 'GET')
          return respond({
            pinId: QUIZ_ID, fromExamVersionId: OLD_VERSION_ID, fromVersionNumber: 1,
            toExamVersionId: NEW_VERSION_ID, toVersionNumber: 2, examStatus: 'ready',
            available: true, blockedByAttempts: false,
            slotDiffs: [{
              position: 1, change: 'question_version_changed',
              fromQuestionId: QUESTION_ID, toQuestionId: QUESTION_ID,
              fromPinnedVersionNumber: 1, toPinnedVersionNumber: 2,
              fromMaxMark: 5, toMaxMark: 5,
            }],
          });
        if (url === `/api/v1/exam-pins/${QUIZ_ID}/version-update` && method === 'POST') {
          pinVersionId = body?.toExamVersionId as string;
          return respond({
            ...quizView(slots), examId: EXAM_ID, examVersionId: pinVersionId,
            examVersionNumber: 2, latestExamVersionNumber: 2, hasNewerExamVersion: false,
          });
        }
        if (url === `/api/v1/exam-pins/${QUIZ_ID}/my-regrades`) return respond([]);
        if (url === `/api/v1/exam-pins/${QUIZ_ID}/regrades`) return respond([]);
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

    // Huy hiệu bản đề mới hiện ở cấp pin (đang ghim v1, bank đã có v2 ready).
    expect(await screen.findByText('Có bản đề ready mới: v2')).toBeTruthy();
    expect(screen.getByText('Đang ghim bản đề v1')).toBeTruthy();

    // Cập nhật TƯỜNG MINH (#254): xem diff từng slot TRƯỚC, xác nhận rồi mới áp.
    await userEvent.click(await screen.findByRole('button', { name: 'Xem thay đổi & cập nhật' }));
    expect(await screen.findByText('Từ bản đề v1 lên v2')).toBeTruthy();
    expect(screen.getByText(/Version câu: v1 → v2/)).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: 'Áp dụng cập nhật' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: `/api/v1/exam-pins/${QUIZ_ID}/version-update`,
        method: 'POST',
        body: { toExamVersionId: NEW_VERSION_ID },
      }),
    );
    // Sau khi áp, huy hiệu bản mới biến mất (pin đã ở bản mới nhất).
    await waitFor(() => expect(screen.queryByText('Có bản đề ready mới: v2')).toBeNull());
  });
});

describe('Trang làm bài quiz — endpoint thật', () => {
  it('lưu một đáp án cho mỗi câu hỏi và nộp để hiện kết quả đã chấm', async () => {
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
          questionExcerpt: 'Capital of France?',
          questionText: doc('Capital of France?'),
          guidance: null,
          solution: submitted ? { correctAnswerId: ANSWER_ID } : null,
          stimulus: null,
          answers: [
            { id: ANSWER_ID, text: doc('Paris') },
            { id: '01900000-0000-7000-8000-0000000000cc', text: doc('London') },
          ],
          options: {},
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
          questionExcerpt: 'Capital of France?',
          questionText: doc('Capital of France?'),
          guidance: doc('Gợi ý: nhớ lại bản đồ châu Âu.'),
          solution: { correctAnswerId: ANSWER_ID },
          stimulus: null,
          answers: [
            { id: ANSWER_ID, text: doc('Paris') },
            { id: '01900000-0000-7000-8000-0000000000cc', text: doc('London') },
          ],
          options: {},
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

describe('Quiz attempt page — hướng dẫn & lời giải theo mô hình giaokhoa (P7, #248)', () => {
  const baseAttempt = (state: string) => ({
    id: ATTEMPT_ID,
    quizId: QUIZ_ID,
    userId: STUDENT_ID,
    attemptNumber: 1,
    state,
    preview: false,
    timeStart: new Date().toISOString(),
    timeFinish: state === 'inprogress' ? null : new Date().toISOString(),
    sumGrades: state === 'inprogress' ? null : 5,
    grade: state === 'inprogress' ? null : 10,
  });
  const viewWith = (state: string, question: Record<string, unknown>) => ({
    attempt: baseAttempt(state),
    quiz: { ...quizView([]), sumGrades: 5 },
    questions: [question],
    totalMax: 5,
    pendingManualCount: 0,
    closedDueToTimeLimit: false,
    overallFeedback: null,
  });
  const mcQuestion = (overrides: Record<string, unknown>) => ({
    slot: 1,
    page: 1,
    questionAttemptId: QA_ID,
    questionId: QUESTION_ID,
    qtype: 'multichoice',
    questionExcerpt: 'Capital of France?',
    questionText: doc('Capital of France?'),
    guidance: doc('Hãy nhớ lại vị trí các thủ đô châu Âu.'),
    solution: null,
    stimulus: null,
    answers: [
      { id: ANSWER_ID, text: doc('Paris') },
      { id: '01900000-0000-7000-8000-0000000000cc', text: doc('London') },
    ],
    options: {},
    maxMark: 5,
    state: 'todo',
    response: null,
    fraction: null,
    mark: null,
    rightAnswer: null,
    feedback: null,
    generalFeedback: null,
    manualComment: null,
    ...overrides,
  });
  const renderAttempt = (view: unknown) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === `/api/v1/quiz-attempts/${ATTEMPT_ID}`) return respond(view);
        return respond({}, 404);
      }),
    );
    const router = createMemoryRouter([{ path: '/quiz-attempts/:attemptId', element: <QuizAttemptPage /> }], {
      initialEntries: [`/quiz-attempts/${ATTEMPT_ID}`],
    });
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );
  };

  it('hiện Hướng dẫn kèm câu hỏi ngay trong lúc làm, không lộ lời giải hay đáp án đúng (D-4)', async () => {
    renderAttempt(viewWith('inprogress', mcQuestion({})));
    // Guidance là gợi ý cách làm: học sinh thấy ngay trong lúc làm bài.
    const guidance = await screen.findByTestId('quiz-guidance-1');
    expect(guidance).toHaveTextContent('Hướng dẫn');
    expect(guidance).toHaveTextContent('Hãy nhớ lại vị trí các thủ đô châu Âu.');
    // Solution chỉ thuộc màn xem lại: không khối Lời giải, không đánh dấu đáp án đúng.
    expect(screen.queryByTestId('quiz-solution-1')).toBeNull();
    expect(document.querySelector('[data-correct="true"]')).toBeNull();
    // Multichoice luôn là radio chọn một — không còn ô checkbox chọn-nhiều.
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('xem lại: đánh dấu đáp án đúng trên lựa chọn và hiện khối Lời giải (generalFeedback + feedback đáp án đã chọn)', async () => {
    renderAttempt(
      viewWith(
        'finished',
        mcQuestion({
          state: 'gradedwrong',
          response: '01900000-0000-7000-8000-0000000000cc',
          fraction: 0,
          mark: 0,
          solution: { correctAnswerId: ANSWER_ID },
          rightAnswer: 'Paris',
          feedback: doc('London là thủ đô của Anh.'),
          generalFeedback: doc('Paris là thủ đô của Pháp từ nhiều thế kỷ.'),
        }),
      ),
    );
    // Đáp án đúng được đánh dấu trực tiếp trên lựa chọn Paris; lựa chọn sai đã chọn không bị đánh dấu.
    const correctLabel = (await screen.findByText('Paris')).closest('label');
    expect(correctLabel?.getAttribute('data-correct')).toBe('true');
    const chosenLabel = screen.getByText('London').closest('label');
    expect(chosenLabel?.getAttribute('data-correct')).toBeNull();
    // Guidance vẫn hiện ở màn xem lại, cùng vị trí như lúc làm.
    expect(screen.getByTestId('quiz-guidance-1')).toHaveTextContent('Hãy nhớ lại vị trí các thủ đô châu Âu.');
    // Khối Lời giải gồm đáp án đúng dạng chữ + feedback của đáp án đã chọn + generalFeedback.
    const solution = screen.getByTestId('quiz-solution-1');
    expect(solution).toHaveTextContent('Lời giải');
    expect(solution).toHaveTextContent('Đáp án đúng: Paris');
    expect(solution).toHaveTextContent('London là thủ đô của Anh.');
    expect(solution).toHaveTextContent('Paris là thủ đô của Pháp từ nhiều thế kỷ.');
  });

  it('xem lại khi cổng đóng (API không trả solution/rightAnswer/feedback): không có khối Lời giải, không đánh dấu', async () => {
    renderAttempt(
      viewWith(
        'finished',
        mcQuestion({
          state: 'gradedright',
          response: ANSWER_ID,
          fraction: 1,
          mark: 5,
          guidance: null,
          solution: null,
          rightAnswer: null,
          feedback: null,
          generalFeedback: null,
        }),
      ),
    );
    expect(await screen.findByText(/Điểm câu: 5\/5/)).toBeInTheDocument();
    expect(screen.queryByTestId('quiz-solution-1')).toBeNull();
    expect(document.querySelector('[data-correct="true"]')).toBeNull();
  });

  it('xem lại shortanswer: hiện các đáp án được chấp nhận từ solution', async () => {
    renderAttempt(
      viewWith('finished', {
        ...mcQuestion({}),
        qtype: 'shortanswer',
        questionExcerpt: 'Thủ đô của Pháp là gì?',
        questionText: doc('Thủ đô của Pháp là gì?'),
        answers: [],
        response: 'Paris',
        state: 'gradedright',
        fraction: 1,
        mark: 5,
        solution: { acceptedAnswers: ['Paris', 'paris'] },
        rightAnswer: 'Paris',
      }),
    );
    const solution = await screen.findByTestId('quiz-solution-1');
    expect(solution).toHaveTextContent('Đáp án được chấp nhận: Paris, paris');
  });

  it('xem lại essay: hiện Lời giải mẫu từ solution của bản ghi phía đáp án', async () => {
    renderAttempt(
      viewWith('needsgrading', {
        ...mcQuestion({}),
        qtype: 'essay',
        questionExcerpt: 'Phân tích nguyên nhân…',
        questionText: doc('Phân tích nguyên nhân của hiện tượng.'),
        answers: [],
        response: 'Bài làm của học sinh.',
        state: 'needsgrading',
        solution: { answer: doc('Bài mẫu: mở bài nêu vấn đề, thân bài có ba luận điểm.') },
      }),
    );
    const solution = await screen.findByTestId('quiz-solution-1');
    expect(solution).toHaveTextContent('Lời giải mẫu');
    expect(solution).toHaveTextContent('Bài mẫu: mở bài nêu vấn đề, thân bài có ba luận điểm.');
  });

  it('làm bài truefalse TF-A: trả lời Đ/S từng mệnh đề, response là JSON theo statementId', async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const tfDoc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Xét các mệnh đề sau:' }] },
        {
          type: 'statementList',
          content: ['tf1', 'tf2', 'tf3', 'tf4'].map((id, i) => ({
            type: 'statement',
            attrs: { id },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: `Mệnh đề ${i + 1}.` }] }],
          })),
        },
      ],
    };
    const view = viewWith('inprogress', {
      ...mcQuestion({}),
      qtype: 'truefalse',
      questionExcerpt: 'Xét các mệnh đề sau:',
      questionText: tfDoc,
      answers: [],
      solution: null,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url === `/api/v1/quiz-attempts/${ATTEMPT_ID}`) return respond(view);
        if (url === `/api/v1/quiz-attempts/${ATTEMPT_ID}/responses` && method === 'POST') return respond({});
        return respond({}, 404);
      }),
    );
    const router = createMemoryRouter([{ path: '/quiz-attempts/:attemptId', element: <QuizAttemptPage /> }], {
      initialEntries: [`/quiz-attempts/${ATTEMPT_ID}`],
    });
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );
    // 4 mệnh đề, mỗi mệnh đề một cặp radio Đ/S riêng; chưa có đáp án nào lộ.
    expect(await screen.findByTestId('quiz-tf-statement-1-0')).toHaveTextContent('Mệnh đề 1.');
    expect(screen.getAllByRole('radio')).toHaveLength(8);
    expect(document.querySelector('[data-correct="true"]')).toBeNull();
    const first = screen.getByTestId('quiz-tf-statement-1-0');
    await userEvent.click(within(first).getByLabelText('Đúng'));
    const second = screen.getByTestId('quiz-tf-statement-1-1');
    await userEvent.click(within(second).getByLabelText('Sai'));
    await userEvent.click(screen.getByRole('button', { name: 'Lưu câu trả lời' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/responses') && c.method === 'POST')).toBe(true),
    );
    const save = calls.find((c) => c.url.endsWith('/responses'));
    expect((save?.body as { response: string }).response).toBe('{"tf1":true,"tf2":false}');
  });

  it('xem lại truefalse TF-A: đúng/sai TỪNG Ý từ solution.statements + response đã lưu', async () => {
    const tfDoc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Xét các mệnh đề sau:' }] },
        {
          type: 'statementList',
          content: ['tf1', 'tf2', 'tf3', 'tf4'].map((id, i) => ({
            type: 'statement',
            attrs: { id },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: `Mệnh đề ${i + 1}.` }] }],
          })),
        },
      ],
    };
    renderAttempt(
      viewWith('finished', {
        ...mcQuestion({}),
        qtype: 'truefalse',
        questionExcerpt: 'Xét các mệnh đề sau:',
        questionText: tfDoc,
        answers: [],
        // tf1 chọn đúng, tf2 chọn sai phía, tf3 bỏ trống, tf4 chọn đúng.
        response: '{"tf1":true,"tf2":true,"tf4":false}',
        state: 'gradedpartial',
        fraction: 0.25,
        mark: 1.25,
        solution: {
          statements: [
            { statementId: 'tf1', value: true },
            { statementId: 'tf2', value: false },
            { statementId: 'tf3', value: true },
            { statementId: 'tf4', value: false },
          ],
        },
        rightAnswer: 'Đúng, Sai, Đúng, Sai',
      }),
    );
    expect((await screen.findByTestId('quiz-tf-statement-1-0')).getAttribute('data-verdict')).toBe('correct');
    expect(screen.getByTestId('quiz-tf-statement-1-1').getAttribute('data-verdict')).toBe('incorrect');
    expect(screen.getByTestId('quiz-tf-statement-1-2').getAttribute('data-verdict')).toBe('unanswered');
    expect(screen.getByTestId('quiz-tf-statement-1-3').getAttribute('data-verdict')).toBe('correct');
    // Mỗi mệnh đề có đúng một phía được đánh dấu "Đáp án đúng".
    expect(document.querySelectorAll('[data-correct="true"]')).toHaveLength(4);
    const solution = screen.getByTestId('quiz-solution-1');
    expect(solution).toHaveTextContent('Đáp án đúng: Đúng, Sai, Đúng, Sai');
  });
});

describe('Trang kết quả quiz — chấm thủ công', () => {
  it('chấm câu tự luận đang chờ và hàng đợi rỗng sau khi tải lại', async () => {
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
    // Trang kết quả đã chuyển sang TanStack Query (F-01 đợt 1, #133):
    // render qua TestProviders để có QueryClient như cây provider thật.
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );

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

  it('hiện thống kê sai theo từng câu hỏi kèm học viên làm sai mỗi câu', async () => {
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
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );

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

describe('Ghi đè quiz — bề mặt giáo viên (#182)', () => {
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

  it('chặn ghi đè học viên mở cửa sổ mà không có lý do, rồi tạo nó khi đã có lý do', async () => {
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

  it('sửa ghi đè (PATCH) và xoá nó (DELETE)', async () => {
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

describe('Trang quiz — học viên thấy cài đặt hiệu dụng (đã ghi đè) của mình (#182)', () => {
  it('hiện cửa sổ/giới hạn hiệu dụng từ API, không phải giới hạn toàn quiz', async () => {
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

describe('Trang kết quả quiz — huy hiệu thi bù (#182)', () => {
  it('gắn nhãn lượt thi bù cho giáo viên và để lượt thường không nhãn', async () => {
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
    render(
      <TestProviders>
        <RouterProvider router={router} />
      </TestProviders>,
    );

    const makeupRow = await screen.findByTestId(`result-attempt-${ATTEMPT_ID}`);
    expect(makeupRow).toHaveTextContent('Kiểm tra bù');
    const normalRow = await screen.findByTestId(`result-attempt-${ATTEMPT2_ID}`);
    expect(normalRow).not.toHaveTextContent('Kiểm tra bù');
  });
});

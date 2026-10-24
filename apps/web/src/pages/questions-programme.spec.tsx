import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { QuestionsPage } from './questions';

/**
 * Spec khối "Chương trình" trong editor câu hỏi (issue #20 Chặng 2, mục
 * A.6): chọn môn → cây → YCCĐ + mức, ghi qua các API gắn kết ở cấp danh
 * tính câu hỏi (subjects/outcomes/curriculum-links).
 */
const CATEGORY_ID = '01900000-0000-7000-8000-000000000001';
const QUESTION_ID = '01900000-0000-7000-8000-000000000004';
const VERSION_ID = '01900000-0000-7000-8000-000000000008';
const SYSTEM_CTX_ID = '01900000-0000-7000-8000-0000000000a1';
const SUBJECT_ID = '01900000-0000-7000-8000-0000000000a2';
const CURRICULUM_ID = '01900000-0000-7000-8000-0000000000a3';
const OUTCOME_ID = '01900000-0000-7000-8000-0000000000a4';

const PROFILE = {
  id: '01900000-0000-7000-8000-0000000000a9',
  username: 'teacher1',
  firstName: 'Lan Anh',
  lastName: 'Nguyễn',
  email: 'teacher1@example.com',
  suspended: false,
  deleted: false,
  isGuest: false,
  forcePasswordChange: false,
  lastLogin: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  customFields: [],
};

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function multichoiceView() {
  return {
    question: { id: QUESTION_ID, category: CATEGORY_ID, qtype: 'multichoice', name: 'Thủ đô' },
    entry: {
      id: '01900000-0000-7000-8000-000000000002',
      questionCategoryId: CATEGORY_ID,
      questionId: QUESTION_ID,
      latestVersion: 1,
    },
    latestVersion: {
      id: VERSION_ID,
      questionBankEntryId: '01900000-0000-7000-8000-000000000002',
      questionId: QUESTION_ID,
      version: 1,
      questionText: doc('Thủ đô của Việt Nam là gì?'),
      generalFeedback: null,
      guidance: null,
      defaultMark: 1,
      penalty: 0,
      stimulusId: null,
    },
    answers: [
      {
        id: '01900000-0000-7000-8000-000000000041',
        questionVersionId: VERSION_ID,
        answer: doc('Hà Nội'),
        fraction: 1,
        feedback: null,
        sortOrder: 0,
      },
      {
        id: '01900000-0000-7000-8000-000000000042',
        questionVersionId: VERSION_ID,
        answer: doc('Huế'),
        fraction: 0,
        feedback: null,
        sortOrder: 1,
      },
    ],
    options: {
      single: true,
      shuffleAnswers: false,
      answerNumbering: 'abc',
      showNumCorrect: false,
      showStandardInstruction: true,
    },
    stimulus: null,
  };
}

/** Stub fetch mô phỏng ngân hàng câu hỏi + curriculum có gắn kết trong bộ nhớ. */
function stubFetch(calls: RecordedCall[]) {
  const state = {
    links: {
      questionId: QUESTION_ID,
      subjectIds: [] as string[],
      outcomes: [] as { outcomeId: string; cognitiveLevel: string }[],
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/users/me/capabilities')
        return respond({ userId: PROFILE.id, isSiteAdmin: true, assignments: [], contexts: [] });
      if (url === '/api/v1/courses') return respond([]);
      if (url === '/api/v1/questions/categories')
        return respond([{ id: CATEGORY_ID, name: 'General', contextId: CATEGORY_ID, info: '', parent: null }]);
      if (url === `/api/v1/questions/categories/${CATEGORY_ID}/questions`) return respond([multichoiceView()]);
      if (url === `/api/v1/stimuli?categoryId=${CATEGORY_ID}`) return respond([]);
      if (url === '/api/v1/access/contexts') return respond([{ id: SYSTEM_CTX_ID, contextLevel: 10 }]);
      if (url === `/api/v1/curriculum/subjects?contextId=${SYSTEM_CTX_ID}`)
        return respond([{ id: SUBJECT_ID, name: 'Toán', slug: 'toan', contextId: SYSTEM_CTX_ID, position: 1 }]);
      if (url === `/api/v1/curriculum/curricula?subjectId=${SUBJECT_ID}`)
        return respond([{ id: CURRICULUM_ID, subjectId: SUBJECT_ID, grade: 10 }]);
      if (url === `/api/v1/curriculum/curricula/${CURRICULUM_ID}/tree`)
        return respond({
          curriculum: { id: CURRICULUM_ID, subjectId: SUBJECT_ID, grade: 10 },
          subject: { id: SUBJECT_ID, name: 'Toán' },
          nodes: [
            {
              id: '01900000-0000-7000-8000-0000000000a5',
              title: 'Hàm số',
              kind: 'topic',
              outcomes: [{ id: OUTCOME_ID, content: 'Nhận biết được khái niệm hàm số.', position: 1 }],
              children: [],
            },
          ],
        });
      if (url === `/api/v1/curriculum/outcomes/${OUTCOME_ID}`)
        return respond({ id: OUTCOME_ID, content: 'Nhận biết được khái niệm hàm số.' });
      if (url === `/api/v1/questions/${QUESTION_ID}/curriculum-links`) return respond(state.links);
      if (url === `/api/v1/questions/${QUESTION_ID}/subjects` && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { subjectId: string };
        state.links = { ...state.links, subjectIds: [...state.links.subjectIds, body.subjectId] };
        return respond(state.links);
      }
      if (url === `/api/v1/questions/${QUESTION_ID}/subjects/${SUBJECT_ID}` && method === 'DELETE') {
        state.links = { ...state.links, subjectIds: [] };
        return respond(state.links);
      }
      if (url === `/api/v1/questions/${QUESTION_ID}/outcomes` && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { outcomeId: string; cognitiveLevel: string };
        state.links = { ...state.links, outcomes: [...state.links.outcomes, body] };
        return respond(state.links);
      }
      if (url === `/api/v1/questions/${QUESTION_ID}/outcomes/${OUTCOME_ID}` && method === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as { cognitiveLevel: string };
        state.links = {
          ...state.links,
          outcomes: state.links.outcomes.map((o) =>
            o.outcomeId === OUTCOME_ID ? { ...o, cognitiveLevel: body.cognitiveLevel } : o,
          ),
        };
        return respond(state.links);
      }
      if (url === `/api/v1/questions/${QUESTION_ID}/outcomes/${OUTCOME_ID}` && method === 'DELETE') {
        state.links = { ...state.links, outcomes: [] };
        return respond(state.links);
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return state;
}

function renderBank() {
  localStorage.setItem('lms.accessToken', 'test-token');
  const router = createMemoryRouter([{ path: '/questions', element: <QuestionsPage /> }], {
    initialEntries: ['/questions'],
  });
  render(
    <TestProviders>
      <RouterProvider router={router} />
    </TestProviders>,
  );
}

describe('Question editor — programme links (issue #20 phase 2)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('links a subject and an outcome with a cognitive level from the editor', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderBank();

    const row = await screen.findByTestId(`question-${QUESTION_ID}`);
    await userEvent.click(within(row).getByRole('button', { name: 'Sửa (phiên bản mới)' }));

    const card = within(await screen.findByTestId('question-programme'));
    expect(card.getByText('Chương trình')).toBeTruthy();

    // Chọn môn → gắn môn.
    await userEvent.selectOptions(card.getByLabelText('Chọn môn học'), SUBJECT_ID);
    await userEvent.click(card.getAllByRole('button', { name: 'Gắn' })[0]!);
    const subjectRow = await screen.findByTestId(`programme-subject-${SUBJECT_ID}`);
    expect(subjectRow).toHaveTextContent('Toán');
    const subjectCall = calls.find((c) => c.url === `/api/v1/questions/${QUESTION_ID}/subjects` && c.method === 'POST');
    expect(subjectCall?.body).toEqual({ subjectId: SUBJECT_ID });

    // YCCĐ của môn đã nạp qua cây → chọn YCCĐ + mức Vận dụng → gắn.
    const outcomeSelect = card.getByLabelText('Chọn yêu cầu cần đạt');
    await waitFor(() => expect((outcomeSelect as HTMLSelectElement).options.length).toBeGreaterThan(1));
    await userEvent.selectOptions(outcomeSelect, OUTCOME_ID);
    await userEvent.selectOptions(card.getByLabelText('Mức độ nhận thức'), 'van_dung');
    await userEvent.click(card.getAllByRole('button', { name: 'Gắn' })[1]!);
    const outcomeRow = await screen.findByTestId(`programme-outcome-${OUTCOME_ID}`);
    expect(outcomeRow).toHaveTextContent('Nhận biết được khái niệm hàm số.');
    const outcomeCall = calls.find((c) => c.url === `/api/v1/questions/${QUESTION_ID}/outcomes` && c.method === 'POST');
    expect(outcomeCall?.body).toEqual({ outcomeId: OUTCOME_ID, cognitiveLevel: 'van_dung' });

    // Đổi mức ngay tại dòng gắn → PATCH.
    await userEvent.selectOptions(within(outcomeRow).getByLabelText('Mức độ nhận thức'), 'hieu');
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/questions/${QUESTION_ID}/outcomes/${OUTCOME_ID}` && c.method === 'PATCH'),
      ).toBe(true),
    );
    const patchCall = calls.find(
      (c) => c.url === `/api/v1/questions/${QUESTION_ID}/outcomes/${OUTCOME_ID}` && c.method === 'PATCH',
    );
    expect(patchCall?.body).toEqual({ cognitiveLevel: 'hieu' });

    // Gỡ gắn YCCĐ → dòng biến mất.
    await userEvent.click(within(outcomeRow).getByRole('button', { name: 'Gỡ gắn' }));
    await waitFor(() => expect(screen.queryByTestId(`programme-outcome-${OUTCOME_ID}`)).toBeNull());
  });
});

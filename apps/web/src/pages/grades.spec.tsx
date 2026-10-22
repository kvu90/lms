import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GradebookPage } from './grades';
import { QuestionsPage, QuestionUsagePage } from './questions';

const ITEM = {
  id: '01900000-0000-7000-8000-000000000005', courseid: '01900000-0000-7000-8000-000000000010', categoryid: '01900000-0000-7000-8000-000000000001', itemname: 'Quiz 1', itemtype: 'manual', itemmodule: null,
  iteminstance: null, grademax: 100, grademin: 0, gradepass: 50, weightoverride: false,
  aggregationcoef: 0, extracredit: false, multiplicator: 1, plusfactor: 0, hidden: false, locked: false,
};
const GRADE = {
  id: '01900000-0000-7000-8000-000000000002', itemid: '01900000-0000-7000-8000-000000000005', userid: '01900000-0000-7000-8000-000000000007', rawgrade: 85, finalgrade: 85, hidden: false, locked: false,
  overridden: false, excluded: false, frozen: false, feedback: null, aggregationweight: 100, letter: 'B',
};
const BOOK = {
  courseId: '01900000-0000-7000-8000-000000000010', userId: '01900000-0000-7000-8000-000000000007',
  categories: [{
    category: {
      id: '01900000-0000-7000-8000-000000000001', courseid: '01900000-0000-7000-8000-000000000010', parent: null, fullname: '', aggregation: 'natural', droplow: 0, keephigh: 0,
      aggregateonlygraded: false, depth: 1, path: '/1', hidden: false,
    },
    total: {
      item: { ...ITEM, id: '01900000-0000-7000-8000-000000000009', itemname: 'Course total', itemtype: 'course', iteminstance: '01900000-0000-7000-8000-000000000010' },
      grade: { ...GRADE, id: '01900000-0000-7000-8000-000000000003', itemid: '01900000-0000-7000-8000-000000000009', finalgrade: 85, letter: 'B' },
    },
    items: [{ item: ITEM, grade: GRADE }],
    children: [{
      category: {
        id: '01900000-0000-7000-8000-000000000002', courseid: '01900000-0000-7000-8000-000000000010', parent: '01900000-0000-7000-8000-000000000001', fullname: 'Quizzes', aggregation: 'mean', droplow: 0, keephigh: 0,
        aggregateonlygraded: false, depth: 2, path: '/1/2', hidden: false,
      },
      total: null, items: [], children: [],
    }],
  }],
  courseTotal: {
    item: { ...ITEM, id: '01900000-0000-7000-8000-000000000009', itemname: 'Course total', itemtype: 'course', iteminstance: '01900000-0000-7000-8000-000000000010' },
    grade: { ...GRADE, id: '01900000-0000-7000-8000-000000000003', itemid: '01900000-0000-7000-8000-000000000009', finalgrade: 85, letter: 'B' },
  },
};
const REPORT = { courseId: '01900000-0000-7000-8000-000000000010', rows: [{ userId: '01900000-0000-7000-8000-000000000007', finalgrade: 85, letter: 'B' }, { userId: '01900000-0000-7000-8000-000000000008', finalgrade: 40, letter: 'F' }] };

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = handler(url, init);
    if (body === undefined) return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
}

describe('Gradebook page', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders the category/item tree with grades, letters and the course total', async () => {
    stubFetch((url) => {
      if (url === '/api/v1/courses/01900000-0000-7000-8000-000000000010/gradebook') return BOOK;
      if (url === '/api/v1/courses/01900000-0000-7000-8000-000000000010/grades/report') return REPORT;
      return undefined;
    });
    const router = createMemoryRouter([{ path: '/courses/:id/grades', element: <GradebookPage /> }], { initialEntries: ['/courses/01900000-0000-7000-8000-000000000010/grades'] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getByText('Quiz 1')).toBeInTheDocument());
    expect(screen.getByTestId('grade-item-01900000-0000-7000-8000-000000000005')).toHaveTextContent('85');
    expect(screen.getByTestId('grade-item-01900000-0000-7000-8000-000000000005')).toHaveTextContent('B');
    expect(screen.getByText('Quizzes')).toBeInTheDocument();
    expect(screen.getByText(/Tổng điểm khoá học: 85 \(B\)/)).toBeInTheDocument();
    // Teacher report renders alongside.
    expect(screen.getByText('Báo cáo lớp')).toBeInTheDocument();
  });
});

describe('Question bank page', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders the version badge, and editing bumps the badge to the new version', async () => {
    let edited = false;
    const questionView = (version: number) => ({
      question: { id: '01900000-0000-7000-8000-000000000004', category: '01900000-0000-7000-8000-000000000001', qtype: 'truefalse', name: 'Sky', createdby: '01900000-0000-7000-8000-000000000001', modifiedby: '01900000-0000-7000-8000-000000000001', timecreated: 'x', timemodified: 'x' },
      entry: { id: '01900000-0000-7000-8000-000000000002', questioncategoryid: '01900000-0000-7000-8000-000000000001', questionid: '01900000-0000-7000-8000-000000000004', latestversion: version, status: 'ready', timecreated: 'x', timemodified: 'x' },
      latestVersion: {
        id: '01900000-0000-7000-8000-000000000008', questionbankentryid: '01900000-0000-7000-8000-000000000002', questionid: '01900000-0000-7000-8000-000000000004', version, status: 'ready',
        questiontext: version === 1 ? 'The sky is blue.' : 'The sky is blue. (edited)', defaultmark: 1, answerdata: { correct: true },
        timecreated: 'x',
      },
    });
    stubFetch((url, init) => {
      if (url === '/api/v1/questions/categories') return [{ id: '01900000-0000-7000-8000-000000000001', name: 'General', contextid: '01900000-0000-7000-8000-000000000001', info: '', parent: null, sortorder: 0, stamp: 's', timecreated: 'x', timemodified: 'x' }];
      if (url === '/api/v1/questions/categories/01900000-0000-7000-8000-000000000001/questions') return [questionView(edited ? 2 : 1)];
      if (url === '/api/v1/questions/01900000-0000-7000-8000-000000000004' && init?.method === 'PATCH') { edited = true; return questionView(2); }
      return undefined;
    });
    const router = createMemoryRouter([{ path: '/questions', element: <QuestionsPage /> }], { initialEntries: ['/questions'] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getByTestId('version-badge-01900000-0000-7000-8000-000000000004')).toHaveTextContent('v1'));
    await userEvent.click(screen.getByRole('button', { name: /Sửa \(phiên bản mới\)/ }));
    await waitFor(() => expect(screen.getByTestId('version-badge-01900000-0000-7000-8000-000000000004')).toHaveTextContent('v2'));
    expect(screen.getByText(/Các lượt làm đã bắt đầu vẫn giữ phiên bản đã gắn/)).toBeInTheDocument();
  });

  it('renders a usage with attempt states, steps and the pinned version', async () => {
    stubFetch((url) => {
      if (url === '/api/v1/question-usages/01900000-0000-7000-8000-000000000009') {
        return {
          usage: { id: '01900000-0000-7000-8000-000000000009', component: 'mod_quiz', instanceid: '01900000-0000-7000-8000-000000000042', owningcontextid: null, preferredbehaviour: 'deferredfeedback', userid: '01900000-0000-7000-8000-000000000007', timecreated: 'x', timemodified: 'x' },
          state: 'finished',
          attempts: [{
            id: '01900000-0000-7000-8000-000000000011', questionusageid: '01900000-0000-7000-8000-000000000009', slot: 1, behaviour: 'deferredfeedback', questionid: '01900000-0000-7000-8000-000000000004', questionversionid: '01900000-0000-7000-8000-000000000008',
            variant: 1, maxmark: 1, minfraction: 0, maxfraction: 1, flagged: false, questionsummary: 'Q', responsesummary: 'true',
            rightanswer: 'True', state: 'gradedright', fraction: 1, userid: '01900000-0000-7000-8000-000000000007', timecreated: 'x', timemodified: 'x',
            steps: [
              { id: '01900000-0000-7000-8000-000000000001', sequencenumber: 0, state: 'todo', fraction: null, data: {} },
              { id: '01900000-0000-7000-8000-000000000002', sequencenumber: 1, state: 'complete', fraction: null, data: { answer: 'true' } },
              { id: '01900000-0000-7000-8000-000000000003', sequencenumber: 2, state: 'gradedright', fraction: 1, data: {} },
            ],
          }],
        };
      }
      return undefined;
    });
    const router = createMemoryRouter([{ path: '/question-usages/:id', element: <QuestionUsagePage /> }], { initialEntries: ['/question-usages/01900000-0000-7000-8000-000000000009'] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getByTestId('attempt-01900000-0000-7000-8000-000000000011')).toBeInTheDocument());
    expect(screen.getByTestId('attempt-01900000-0000-7000-8000-000000000011')).toHaveTextContent('gradedright');
    expect(screen.getByTestId('attempt-01900000-0000-7000-8000-000000000011')).toHaveTextContent('todo → complete → gradedright');
    expect(screen.getByText(/Trạng thái lượt làm: finished/)).toBeInTheDocument();
  });
});

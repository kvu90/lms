import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GradebookPage } from './grades';
import { QuestionsPage, QuestionUsagePage } from './questions';

const ITEM = {
  id: 5, courseid: 10, categoryid: 1, itemname: 'Quiz 1', itemtype: 'manual', itemmodule: null,
  iteminstance: 0, grademax: 100, grademin: 0, gradepass: 50, weightoverride: false,
  aggregationcoef: 0, extracredit: false, multiplicator: 1, plusfactor: 0, hidden: false, locked: false,
};
const GRADE = {
  id: 2, itemid: 5, userid: 7, rawgrade: 85, finalgrade: 85, hidden: false, locked: false,
  overridden: false, excluded: false, frozen: false, feedback: null, aggregationweight: 100, letter: 'B',
};
const BOOK = {
  courseId: 10, userId: 7,
  categories: [{
    category: {
      id: 1, courseid: 10, parent: null, fullname: '', aggregation: 'natural', droplow: 0, keephigh: 0,
      aggregateonlygraded: false, depth: 1, path: '/1', hidden: false,
    },
    total: {
      item: { ...ITEM, id: 9, itemname: 'Course total', itemtype: 'course', iteminstance: 10 },
      grade: { ...GRADE, id: 3, itemid: 9, finalgrade: 85, letter: 'B' },
    },
    items: [{ item: ITEM, grade: GRADE }],
    children: [{
      category: {
        id: 2, courseid: 10, parent: 1, fullname: 'Quizzes', aggregation: 'mean', droplow: 0, keephigh: 0,
        aggregateonlygraded: false, depth: 2, path: '/1/2', hidden: false,
      },
      total: null, items: [], children: [],
    }],
  }],
  courseTotal: {
    item: { ...ITEM, id: 9, itemname: 'Course total', itemtype: 'course', iteminstance: 10 },
    grade: { ...GRADE, id: 3, itemid: 9, finalgrade: 85, letter: 'B' },
  },
};
const REPORT = { courseId: 10, rows: [{ userId: 7, finalgrade: 85, letter: 'B' }, { userId: 8, finalgrade: 40, letter: 'F' }] };

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = handler(url, init);
    if (body === undefined) return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
}

describe('Gradebook page (P3)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders the category/item tree with grades, letters and the course total', async () => {
    stubFetch((url) => {
      if (url === '/api/v1/courses/10/gradebook') return BOOK;
      if (url === '/api/v1/courses/10/grades/report') return REPORT;
      return undefined;
    });
    const router = createMemoryRouter([{ path: '/courses/:id/grades', element: <GradebookPage /> }], { initialEntries: ['/courses/10/grades'] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getByText('Quiz 1')).toBeInTheDocument());
    expect(screen.getByTestId('grade-item-5')).toHaveTextContent('85');
    expect(screen.getByTestId('grade-item-5')).toHaveTextContent('B');
    expect(screen.getByText('Quizzes')).toBeInTheDocument();
    expect(screen.getByText(/Course total: 85 \(B\)/)).toBeInTheDocument();
    // Teacher report renders alongside.
    expect(screen.getByText('Class report')).toBeInTheDocument();
  });
});

describe('Question bank page (P3)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders the version badge, and editing bumps the badge to the new version', async () => {
    let edited = false;
    const questionView = (version: number) => ({
      question: { id: 4, category: 1, qtype: 'truefalse', name: 'Sky', createdby: 1, modifiedby: 1, timecreated: 'x', timemodified: 'x' },
      entry: { id: 2, questioncategoryid: 1, questionid: 4, latestversion: version, status: 'ready', timecreated: 'x', timemodified: 'x' },
      latestVersion: {
        id: 8, questionbankentryid: 2, questionid: 4, version, status: 'ready',
        questiontext: version === 1 ? 'The sky is blue.' : 'The sky is blue. (edited)', defaultmark: 1, answerdata: { correct: true },
        timecreated: 'x',
      },
    });
    stubFetch((url, init) => {
      if (url === '/api/v1/questions/categories') return [{ id: 1, name: 'General', contextid: 1, info: '', parent: null, sortorder: 0, stamp: 's', timecreated: 'x', timemodified: 'x' }];
      if (url === '/api/v1/questions/categories/1/questions') return [questionView(edited ? 2 : 1)];
      if (url === '/api/v1/questions/4' && init?.method === 'PATCH') { edited = true; return questionView(2); }
      return undefined;
    });
    const router = createMemoryRouter([{ path: '/questions', element: <QuestionsPage /> }], { initialEntries: ['/questions'] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getByTestId('version-badge-4')).toHaveTextContent('v1'));
    await userEvent.click(screen.getByRole('button', { name: /Edit \(new version\)/ }));
    await waitFor(() => expect(screen.getByTestId('version-badge-4')).toHaveTextContent('v2'));
    expect(screen.getByText(/Attempts already started keep their pinned version/)).toBeInTheDocument();
  });

  it('renders a usage with attempt states, steps and the pinned version', async () => {
    stubFetch((url) => {
      if (url === '/api/v1/question-usages/9') {
        return {
          usage: { id: 9, component: 'mod_quiz', instanceid: 42, owningcontextid: null, preferredbehaviour: 'deferredfeedback', userid: 7, timecreated: 'x', timemodified: 'x' },
          state: 'finished',
          attempts: [{
            id: 11, questionusageid: 9, slot: 1, behaviour: 'deferredfeedback', questionid: 4, questionversionid: 8,
            variant: 1, maxmark: 1, minfraction: 0, maxfraction: 1, flagged: false, questionsummary: 'Q', responsesummary: 'true',
            rightanswer: 'True', state: 'gradedright', fraction: 1, userid: 7, timecreated: 'x', timemodified: 'x',
            steps: [
              { id: 1, sequencenumber: 0, state: 'todo', fraction: null, data: {} },
              { id: 2, sequencenumber: 1, state: 'complete', fraction: null, data: { answer: 'true' } },
              { id: 3, sequencenumber: 2, state: 'gradedright', fraction: 1, data: {} },
            ],
          }],
        };
      }
      return undefined;
    });
    const router = createMemoryRouter([{ path: '/question-usages/:id', element: <QuestionUsagePage /> }], { initialEntries: ['/question-usages/9'] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getByTestId('attempt-11')).toBeInTheDocument());
    expect(screen.getByTestId('attempt-11')).toHaveTextContent('gradedright');
    expect(screen.getByTestId('attempt-11')).toHaveTextContent('todo → complete → gradedright');
    expect(screen.getByText(/Usage state: finished/)).toBeInTheDocument();
  });
});

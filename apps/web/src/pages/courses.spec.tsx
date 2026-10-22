import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoursePage } from './course';
import { CoursesPage } from './courses';

const TREE = [
  {
    id: '01900000-0000-7000-8000-000000000001', name: 'Science', idnumber: null, description: '', parent: null, sortorder: 0,
    path: '/1', depth: 1, visible: true,
    children: [
      {
        id: '01900000-0000-7000-8000-000000000002', name: 'Physics', idnumber: null, description: '', parent: '01900000-0000-7000-8000-000000000001', sortorder: 0,
        path: '/1/2', depth: 2, visible: true, children: [],
      },
    ],
  },
];
const COURSES = [
  {
    id: '01900000-0000-7000-8000-000000000010', category: '01900000-0000-7000-8000-000000000002', fullname: 'Physics 101', shortname: 'PHY101', idnumber: '', summary: '',
    format: 'topics', visible: true, startdate: null, enddate: null, groupmode: 0, enablecompletion: true,
  },
];
const CONTENT = {
  course: COURSES[0],
  contextId: '01900000-0000-7000-8000-000000000055',
  customFields: [],
  sections: [
    {
      id: '01900000-0000-7000-8000-000000000100', course: '01900000-0000-7000-8000-000000000010', section: 0, name: 'General', summary: '', visible: true, availability: null,
      availabilityResult: { available: true, visible: true, failedDescriptions: [] },
      modules: [
        {
          id: '01900000-0000-7000-8000-000000001000', course: '01900000-0000-7000-8000-000000000010', section: '01900000-0000-7000-8000-000000000100', component: 'mod_page', instanceid: '01900000-0000-7000-8000-000000000001', name: 'Welcome page',
          visible: true, groupmode: 0, availability: null, completion: 0, completionview: false,
          availabilityResult: { available: true, visible: true, failedDescriptions: [] },
        },
        {
          id: '01900000-0000-7000-8000-000000001001', course: '01900000-0000-7000-8000-000000000010', section: '01900000-0000-7000-8000-000000000100', component: 'mod_quiz', instanceid: '01900000-0000-7000-8000-000000000002', name: 'Locked quiz',
          visible: true, groupmode: 0,
          availability: { op: '&', show: true, showc: [true], c: [{ type: 'date', d: '>=', t: 4102444800 }] },
          completion: 2, completionview: true,
          availabilityResult: { available: false, visible: true, failedDescriptions: ['Available >= 2100-01-01'] },
        },
      ],
    },
  ],
};

function stubFetch(handler: (url: string) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = handler(url);
    if (body === undefined) return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
}

describe('Courses pages', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders the category tree with its courses nested under the right category', async () => {
    stubFetch((url) => {
      if (url === '/api/v1/courses/categories/tree') return TREE;
      if (url === '/api/v1/courses') return COURSES;
      return undefined;
    });
    const router = createMemoryRouter([{ path: '/courses', element: <CoursesPage /> }], { initialEntries: ['/courses'] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getAllByText('Science').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Physics').length).toBeGreaterThan(0);
    const courseLink = screen.getByRole('link', { name: /Physics 101/ });
    expect(courseLink).toHaveAttribute('href', '/courses/01900000-0000-7000-8000-000000000010');
  });

  it('renders a locked module as shown-but-unavailable (show=true) with its restriction text, and an available module as available', async () => {
    stubFetch((url) => {
      if (url === '/api/v1/courses/01900000-0000-7000-8000-000000000010/content') return CONTENT;
      return undefined;
    });
    const router = createMemoryRouter([{ path: '/courses/:id', element: <CoursePage /> }], { initialEntries: ['/courses/01900000-0000-7000-8000-000000000010'] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getByText('Welcome page')).toBeInTheDocument());
    const locked = screen.getByTestId('cm-01900000-0000-7000-8000-000000001001');
    expect(locked).toHaveAttribute('aria-disabled', 'true');
    expect(locked).toHaveTextContent(/Đã khoá:/);
    expect(locked).toHaveTextContent(/2100-01-01/);
    const open = screen.getByTestId('cm-01900000-0000-7000-8000-000000001000');
    expect(open).not.toHaveAttribute('aria-disabled');
    expect(open).toHaveTextContent(/Có thể truy cập/);
  });
});

import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoursePage } from './course';
import { CoursesPage } from './courses';

const TREE = [
  {
    id: 1, name: 'Science', idnumber: null, description: '', parent: 0, sortorder: 0,
    path: '/1', depth: 1, visible: true,
    children: [
      {
        id: 2, name: 'Physics', idnumber: null, description: '', parent: 1, sortorder: 0,
        path: '/1/2', depth: 2, visible: true, children: [],
      },
    ],
  },
];
const COURSES = [
  {
    id: 10, category: 2, fullname: 'Physics 101', shortname: 'PHY101', idnumber: '', summary: '',
    format: 'topics', visible: true, startdate: null, enddate: null, groupmode: 0, enablecompletion: true,
  },
];
const CONTENT = {
  course: COURSES[0],
  contextId: 55,
  customFields: [],
  sections: [
    {
      id: 100, course: 10, section: 0, name: 'General', summary: '', visible: true, availability: null,
      availabilityResult: { available: true, visible: true, failedDescriptions: [] },
      modules: [
        {
          id: 1000, course: 10, section: 100, component: 'mod_page', instanceid: 1, name: 'Welcome page',
          visible: true, groupmode: 0, availability: null, completion: 0, completionview: false,
          availabilityResult: { available: true, visible: true, failedDescriptions: [] },
        },
        {
          id: 1001, course: 10, section: 100, component: 'mod_quiz', instanceid: 2, name: 'Locked quiz',
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

describe('Courses pages (P2)', () => {
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
    expect(courseLink).toHaveAttribute('href', '/courses/10');
  });

  it('renders a locked module as shown-but-unavailable (show=true) with its restriction text, and an available module as available', async () => {
    stubFetch((url) => {
      if (url === '/api/v1/courses/10/content') return CONTENT;
      return undefined;
    });
    const router = createMemoryRouter([{ path: '/courses/:id', element: <CoursePage /> }], { initialEntries: ['/courses/10'] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getByText('Welcome page')).toBeInTheDocument());
    const locked = screen.getByTestId('cm-1001');
    expect(locked).toHaveAttribute('aria-disabled', 'true');
    expect(locked).toHaveTextContent(/Locked:/);
    expect(locked).toHaveTextContent(/2100-01-01/);
    const open = screen.getByTestId('cm-1000');
    expect(open).not.toHaveAttribute('aria-disabled');
    expect(open).toHaveTextContent(/Available/);
  });
});

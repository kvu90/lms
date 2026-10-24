import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '#test/providers';
import { PermissionsProvider } from '#lib/permissions';
import { CourseBuilderPage } from './course-builder';

/**
 * Spec Builder Outline (K1 — issue #68): trang xây dựng khoá học
 * riêng `/courses/:id/builder` tách khỏi trang quản trị gộp. Hai
 * describe đầu di trú nguyên vẹn từ course-admin.spec (tiêu chí hoàn
 * thành + thao tác section/module cơ bản) khi khối builder được tách
 * trang; describe cuối kiểm các thao tác outline mới của K1: đổi thứ
 * tự bằng nút lên/xuống, nhân bản tại dòng, thêm nội dung bằng menu
 * chọn loại và trạng thái Mở theo lịch qua trường ngày mở riêng.
 */
const TEACHER_ID = '01900000-0000-7000-8000-0000000000a2';
const COURSE_ID = '01900000-0000-7000-8000-000000000010';
const CATEGORY_ID = '01900000-0000-7000-8000-000000000001';
const SECTION_ID = '01900000-0000-7000-8000-000000000100';
const SECTION2_ID = '01900000-0000-7000-8000-000000000101';
const MODULE_ID = '01900000-0000-7000-8000-000000001000';
const MODULE2_ID = '01900000-0000-7000-8000-000000001001';

const PROFILE = {
  id: TEACHER_ID,
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

const COURSE = {
  id: COURSE_ID,
  category: CATEGORY_ID,
  fullName: 'Physics 101',
  shortName: 'PHY101',
  idNumber: '',
  summary: 'Mô tả khoá',
  format: 'topics',
  visible: true,
  isTemplate: false,
  startDate: null,
  endDate: null,
  groupMode: 0,
  enableCompletion: true,
};

function moduleRow(id: string, name: string) {
  return {
    id,
    course: COURSE_ID,
    section: SECTION_ID,
    component: 'mod_page',
    instanceId: '01900000-0000-7000-8000-000000000001',
    name,
    visible: true,
    groupMode: 0,
    availability: null,
    completion: 0,
    completionView: false,
    completionManual: false,
    sortOrder: 0,
    openAt: null,
  };
}

const CONTENT = {
  course: COURSE,
  contextId: '01900000-0000-7000-8000-000000000055',
  customFields: [],
  sections: [
    {
      id: SECTION_ID,
      course: COURSE_ID,
      section: 0,
      name: 'General',
      summary: '',
      visible: true,
      availability: null,
      openAt: null,
      modules: [moduleRow(MODULE_ID, 'Welcome page')],
    },
  ],
};

/** Outline hai section cho các thao tác đổi thứ tự/nhân bản của K1. */
const CONTENT_TWO_SECTIONS = {
  ...CONTENT,
  sections: [
    CONTENT.sections[0]!,
    {
      id: SECTION2_ID,
      course: COURSE_ID,
      section: 1,
      name: 'Week 2',
      summary: '',
      visible: true,
      availability: null,
      openAt: null,
      modules: [{ ...moduleRow(MODULE2_ID, 'Second page'), section: SECTION2_ID }],
    },
  ],
};

const FORBIDDEN = { type: 'about:blank', title: 'Forbidden', status: 403, code: 'access.capability_denied' };

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** Stub fetch ghi lại mọi lời gọi; giáo viên có editingteacher tại context khoá kèm course:update + completion:manage. */
function stubFetch(calls: RecordedCall[], content: unknown = CONTENT) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/users/me/capabilities') {
        return respond({
          userId: TEACHER_ID,
          isSiteAdmin: false,
          assignments: [
            {
              id: '01900000-0000-7000-8000-0000000000f1',
              roleId: '01900000-0000-7000-8000-0000000000b9',
              roleShortname: 'editingteacher',
              roleName: 'Teacher',
              contextId: CONTENT.contextId,
              contextLevel: 50,
              contextPath: '/1/9/10',
              instanceId: COURSE_ID,
            },
          ],
          contexts: [
            {
              contextId: '01900000-0000-7000-8000-0000000000e1',
              contextLevel: 10,
              contextPath: '/1',
              capabilities: [],
            },
            {
              contextId: CONTENT.contextId,
              contextLevel: 50,
              contextPath: '/1/9/10',
              capabilities: ['grade:viewall', 'course:update', 'question:useall', 'completion:manage'],
            },
          ],
        });
      }
      if (url === '/api/v1/users?pageSize=1') return respond(FORBIDDEN, 403);
      if (url === '/api/v1/access/roles') return respond(FORBIDDEN, 403);
      if (url === '/api/v1/questions/categories') return respond([]);
      if (url === '/api/v1/courses' && method === 'GET') return respond([COURSE]);
      if (url === '/api/v1/courses/templates') return respond([]);
      if (url === `/api/v1/courses/${COURSE_ID}` && method === 'GET')
        return respond({ ...COURSE, contextId: CONTENT.contextId, customFields: [], formatOptions: {} });
      if (url === `/api/v1/courses/${COURSE_ID}/content`) return respond(content);
      if (url === `/api/v1/courses/${COURSE_ID}/sections` && method === 'POST')
        return respond({ id: SECTION2_ID, course: COURSE_ID, section: 1, name: 'Week 1', summary: '', visible: true, availability: null, modules: [] });
      if (url === `/api/v1/courses/${COURSE_ID}/modules/${MODULE_ID}` && method === 'DELETE') return respond({ deleted: true });
      if (url === `/api/v1/courses/${COURSE_ID}/modules/${MODULE_ID}` && method === 'PATCH')
        return respond({ ...moduleRow(MODULE_ID, 'Welcome page') });
      if (url === `/api/v1/courses/${COURSE_ID}/modules/${MODULE_ID}/duplicate` && method === 'POST')
        return respond({ ...moduleRow('01900000-0000-7000-8000-000000001099', 'Welcome page') });
      if (url === `/api/v1/courses/${COURSE_ID}/sections/${SECTION_ID}` && method === 'PATCH')
        return respond({ ...(content as typeof CONTENT).sections[0], modules: undefined });
      if (url === `/api/v1/courses/${COURSE_ID}/reorder-sections` && method === 'POST') return respond({ reordered: true });
      if (url === `/api/v1/courses/${COURSE_ID}/sections/${SECTION_ID}/reorder-modules` && method === 'POST')
        return respond({ reordered: true });
      if (url === `/api/v1/courses/${COURSE_ID}/quizzes` && method === 'POST')
        return respond({ id: '01900000-0000-7000-8000-00000000aa01', course: COURSE_ID, name: 'Quiz mới' });
      if (url === `/api/v1/courses/${COURSE_ID}/groupings`) return respond([]);
      if (url === `/api/v1/courses/${COURSE_ID}/groups`) return respond([]);
      if (url === `/api/v1/courses/${COURSE_ID}/grades/items`) return respond([]);
      if (url === `/api/v1/courses/${COURSE_ID}/completion/criteria`) {
        if (init?.method === 'PUT') return respond({ method: 1, criteria: [] });
        return respond({ method: 1, criteria: [] });
      }
      if (url === `/api/v1/courses/${COURSE_ID}/completion/recalculate` && init?.method === 'POST')
        return respond({ courseId: COURSE_ID, enrolled: 1, evaluated: 1, completed: 0 });
      return respond({}, 404);
    }),
  );
}

/** Render trang builder trong đúng khung provider của ứng dụng thật. */
function renderCourseBuilder() {
  localStorage.setItem('lms.accessToken', 'test-token');
  const router = createMemoryRouter(
    [
      { path: '/courses/:id/builder', element: <CourseBuilderPage /> },
      { path: '/courses/:id/quizzes/:quizId', element: <p>quiz-editor</p> },
    ],
    { initialEntries: [`/courses/${COURSE_ID}/builder`] },
  );
  render(
    <TestProviders>
      <PermissionsProvider>
        <RouterProvider router={router} />
      </PermissionsProvider>
    </TestProviders>,
  );
}

describe('Course completion criteria (teacher with completion:manage)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('saves the criteria set via PUT /courses/:id/completion/criteria with an activity-completion criterion', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderCourseBuilder();

    const box = await screen.findByTestId('completion-criteria');
    await userEvent.selectOptions(within(box).getByLabelText('Cách tổng hợp tiêu chí'), '2');
    await userEvent.click(within(box).getByRole('button', { name: 'Thêm tiêu chí' }));
    await userEvent.selectOptions(within(box).getByLabelText('Loại tiêu chí'), 'module');
    await userEvent.click(within(box).getByRole('button', { name: 'Lưu tiêu chí hoàn thành' }));

    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/completion/criteria` && c.method === 'PUT'),
      ).toBe(true),
    );
    const put = calls.find((c) => c.url === `/api/v1/courses/${COURSE_ID}/completion/criteria` && c.method === 'PUT');
    expect(put?.body).toEqual({ method: 2, criteria: [{ criteriaType: 'module', moduleInstance: MODULE_ID }] });
  });
});

describe('Course builder (teacher)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('creates a section via POST /courses/:id/sections with the entered name', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderCourseBuilder();

    await userEvent.type(await screen.findByLabelText('Tên section mới'), 'Week 1');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo section' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/sections` && c.method === 'POST')).toBe(true),
    );
    const createCall = calls.find((c) => c.url === `/api/v1/courses/${COURSE_ID}/sections` && c.method === 'POST');
    expect(createCall?.body).toEqual({ name: 'Week 1' });
  });

  it('saves a module availability tree via PATCH /courses/:id/modules/:cmId', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderCourseBuilder();

    const availabilityBox = await screen.findByTestId(`module-availability-${MODULE_ID}`);
    await userEvent.selectOptions(within(availabilityBox).getByLabelText('Loại điều kiện mới'), 'date');
    await userEvent.click(within(availabilityBox).getByRole('button', { name: 'Thêm điều kiện' }));
    await userEvent.click(within(availabilityBox).getByRole('button', { name: 'Lưu điều kiện truy cập' }));

    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url === `/api/v1/courses/${COURSE_ID}/modules/${MODULE_ID}` &&
            c.method === 'PATCH' &&
            (c.body as { availability?: unknown })?.availability != null,
        ),
      ).toBe(true),
    );
    const patch = calls.find(
      (c) =>
        c.url === `/api/v1/courses/${COURSE_ID}/modules/${MODULE_ID}` &&
        c.method === 'PATCH' &&
        (c.body as { availability?: unknown })?.availability != null,
    );
    const tree = (patch?.body as { availability: { op: string; c: { type: string; d: string; t: number }[] } })
      .availability;
    expect(tree.op).toBe('&');
    expect(tree.c).toHaveLength(1);
    expect(tree.c[0]?.type).toBe('date');
    expect(tree.c[0]?.d).toBe('>=');
    expect(typeof tree.c[0]?.t).toBe('number');
  });

  it('deletes a module via DELETE /courses/:id/modules/:cmId after confirmation', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderCourseBuilder();

    const moduleRow = await screen.findByTestId(`module-builder-${MODULE_ID}`);
    await userEvent.click(within(moduleRow).getByRole('button', { name: 'Xoá module' }));

    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/modules/${MODULE_ID}` && c.method === 'DELETE'),
      ).toBe(true),
    );
  });
});

describe('Builder Outline K1 (teacher)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('đổi thứ tự section bằng nút Xuống gọi POST reorder-sections với thứ tự mới', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls, CONTENT_TWO_SECTIONS);
    renderCourseBuilder();

    const first = await screen.findByTestId(`section-builder-${SECTION_ID}`);
    // Nút Xuống đầu tiên trong section là của chính section (trước các nút của module bên trong).
    await userEvent.click(within(first).getAllByRole('button', { name: 'Xuống' })[0]!);

    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/reorder-sections` && c.method === 'POST')).toBe(true),
    );
    const call = calls.find((c) => c.url === `/api/v1/courses/${COURSE_ID}/reorder-sections`);
    expect(call?.body).toEqual({ sectionIds: [SECTION2_ID, SECTION_ID] });
  });

  it('nhân bản module tại dòng gọi POST /modules/:cmId/duplicate', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderCourseBuilder();

    const row = await screen.findByTestId(`module-builder-${MODULE_ID}`);
    await userEvent.click(within(row).getByRole('button', { name: 'Nhân bản' }));

    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/modules/${MODULE_ID}/duplicate` && c.method === 'POST'),
      ).toBe(true),
    );
  });

  it('thêm nội dung bằng menu chọn loại Quiz gọi POST /courses/:id/quizzes thay vì gõ component', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderCourseBuilder();

    const sectionBox = await screen.findByTestId(`section-builder-${SECTION_ID}`);
    await userEvent.selectOptions(within(sectionBox).getByLabelText('Loại nội dung'), 'mod_quiz');
    // Ô tên của form thêm mới (phân biệt với ô sửa tên của module hiện có bằng id).
    const nameInput = sectionBox.querySelector<HTMLInputElement>(`#module-new-name-${SECTION_ID}`);
    await userEvent.type(nameInput!, 'Kiểm tra 15 phút');
    await userEvent.click(within(sectionBox).getByRole('button', { name: 'Thêm module' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/quizzes` && c.method === 'POST')).toBe(true),
    );
    const call = calls.find((c) => c.url === `/api/v1/courses/${COURSE_ID}/quizzes`);
    expect(call?.body).toEqual({ sectionId: SECTION_ID, name: 'Kiểm tra 15 phút' });
    // Không còn đường tạo module bằng chuỗi component cho quiz.
    expect(calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/modules` && c.method === 'POST')).toBe(false);
  });

  it('đặt trạng thái Mở theo lịch cho module gửi visible=true kèm openAt qua PATCH', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderCourseBuilder();

    const row = await screen.findByTestId(`module-builder-${MODULE_ID}`);
    await userEvent.selectOptions(within(row).getByLabelText('Trạng thái'), 'scheduled');
    const dateInput = within(row).getByLabelText('Ngày mở');
    await userEvent.clear(dateInput);
    await userEvent.type(dateInput, '2026-11-02');
    await userEvent.click(within(row).getByRole('button', { name: 'Lưu module' }));

    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url === `/api/v1/courses/${COURSE_ID}/modules/${MODULE_ID}` &&
            c.method === 'PATCH' &&
            (c.body as { openAt?: unknown })?.openAt != null,
        ),
      ).toBe(true),
    );
    const patch = calls.find(
      (c) =>
        c.url === `/api/v1/courses/${COURSE_ID}/modules/${MODULE_ID}` &&
        c.method === 'PATCH' &&
        (c.body as { openAt?: unknown })?.openAt != null,
    );
    const body = patch?.body as { visible: boolean; openAt: string };
    expect(body.visible).toBe(true);
    expect(body.openAt.slice(0, 10)).toBe('2026-11-02');
  });
});

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

/** Học liệu trong Kho (CB-1) mà panel "Thêm từ kho" của builder liệt kê. */
const BANK_ITEM_LECTURE = {
  id: '01900000-0000-7000-8000-00000000ba01',
  name: 'Bài giảng video: Dao động điều hoà',
  contentType: 'file-based',
  contextId: '01900000-0000-7000-8000-0000000000c1',
  creatorId: TEACHER_ID,
  visibility: 'public',
  fileId: '01900000-0000-7000-8000-00000000f101',
  resourceType: 'multimedia_lecture',
  scope: 'personal',
  spaceId: null,
  subjectId: null,
  grade: 11,
  level: 'upper_secondary',
  curriculumNodeId: null,
  outcomeIds: null,
  questionCategoryId: null,
  externalUrl: null,
  description: 'Video bài giảng chương Dao động',
  keywords: ['dao động', 'video'],
  targetAudience: 'students',
  lessonPosition: 'new_knowledge',
  techFormat: 'mp4',
  sizeBytes: 1024,
  durationSeconds: 600,
  language: 'vi',
  originalAuthor: 'Nguyễn Lan Anh',
  sourceKind: 'self',
  sourceCitation: null,
  license: null,
  derivedFromId: null,
  reviewStatus: 'approved',
  reviewedBy: null,
  reviewNote: null,
  reviewChecklist: null,
};

const BANK_ITEM_QUESTION_SET = {
  ...BANK_ITEM_LECTURE,
  id: '01900000-0000-7000-8000-00000000ba02',
  name: 'Bộ câu hỏi trắc nghiệm chương 1',
  fileId: null,
  resourceType: 'question_set',
  scope: 'org',
  spaceId: '01900000-0000-7000-8000-00000000cc01',
  questionCategoryId: '01900000-0000-7000-8000-00000000ca01',
  description: 'Tham chiếu ngân hàng câu hỏi',
  keywords: ['trắc nghiệm'],
  techFormat: null,
};

const BANK_ITEMS = [BANK_ITEM_LECTURE, BANK_ITEM_QUESTION_SET];

const FORBIDDEN = { type: 'about:blank', title: 'Forbidden', status: 403, code: 'access.capability_denied' };

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** Stub fetch ghi lại mọi lời gọi; giáo viên có editingteacher tại context khoá kèm course:update + completion:manage. */
function stubFetch(calls: RecordedCall[], content: unknown = CONTENT, bankItems: unknown = BANK_ITEMS) {
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
      if (url === `/api/v1/courses/${COURSE_ID}/exam-pins` && method === 'POST')
        return respond({ id: '01900000-0000-7000-8000-00000000aa01', course: COURSE_ID, name: 'Quiz mới' });
      if (url === `/api/v1/courses/${COURSE_ID}/assignments` && method === 'POST')
        return respond({ id: '01900000-0000-7000-8000-00000000aa02', courseId: COURSE_ID, name: 'Bài tập mới' });
      if (url === `/api/v1/courses/${COURSE_ID}/groupings`) return respond([]);
      if (url === `/api/v1/courses/${COURSE_ID}/groups`) return respond([]);
      if (url === `/api/v1/courses/${COURSE_ID}/grades/items`) return respond([]);
      if (url === `/api/v1/courses/${COURSE_ID}/completion/criteria`) {
        if (init?.method === 'PUT') return respond({ method: 1, criteria: [] });
        return respond({ method: 1, criteria: [] });
      }
      if (url === `/api/v1/courses/${COURSE_ID}/completion/recalculate` && init?.method === 'POST')
        return respond({ courseId: COURSE_ID, enrolled: 1, evaluated: 1, completed: 0 });
      if (url === '/api/v1/contentbank' && method === 'GET') return respond(bankItems);
      if (url.startsWith('/api/v1/contentbank/') && url.endsWith('/insert') && method === 'POST')
        return respond({
          cmId: '01900000-0000-7000-8000-0000000010ff',
          courseId: COURSE_ID,
          sectionId: SECTION_ID,
          fileId: '01900000-0000-7000-8000-00000000f1ff',
          sourceContentId: url.split('/')[4],
        });
      return respond({}, 404);
    }),
  );
}

/** Render trang builder trong đúng khung provider của ứng dụng thật. */
function renderCourseBuilder() {
  const router = createMemoryRouter(
    [
      { path: '/courses/:id/builder', element: <CourseBuilderPage /> },
      { path: '/courses/:id/exams/:pinId', element: <p>quiz-editor</p> },
      { path: '/courses/:id/assignments/:assignmentId', element: <p>assignment-editor</p> },
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

  it('does not offer the course-grade criterion (the per-activity model has no course total); the date criterion still saves', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderCourseBuilder();

    const box = await screen.findByTestId('completion-criteria');
    await userEvent.click(within(box).getByRole('button', { name: 'Thêm tiêu chí' }));

    const typeSelect = within(box).getByLabelText('Loại tiêu chí') as HTMLSelectElement;
    expect(Array.from(typeSelect.options).map((o) => o.value)).toEqual(['module', 'date']);
    // Tiêu chí mới thêm mặc định là hoàn thành hoạt động, không còn loại điểm tổng khoá.
    expect(typeSelect.value).toBe('module');

    await userEvent.selectOptions(typeSelect, 'date');
    fireEvent.change(within(box).getByLabelText('Ngày'), { target: { value: '2027-01-31' } });
    await userEvent.click(within(box).getByRole('button', { name: 'Lưu tiêu chí hoàn thành' }));

    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/completion/criteria` && c.method === 'PUT'),
      ).toBe(true),
    );
    const put = calls.find((c) => c.url === `/api/v1/courses/${COURSE_ID}/completion/criteria` && c.method === 'PUT');
    expect(put?.body).toEqual({ method: 1, criteria: [{ criteriaType: 'date', date: '2027-01-31' }] });
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
    // Trình sửa điều kiện truy cập nay dùng Select của @lms/ui (không còn
    // select native): bấm trigger rồi chọn option theo nhãn hiển thị.
    await userEvent.click(within(availabilityBox).getByLabelText('Loại điều kiện mới'));
    await userEvent.click(await screen.findByRole('option', { name: 'Ngày' }));
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

  it('thêm nội dung bằng menu chọn loại Quiz gọi POST /courses/:id/exam-pins (tạo đề + ghim) thay vì gõ component', async () => {
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
      expect(calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/exam-pins` && c.method === 'POST')).toBe(true),
    );
    const call = calls.find((c) => c.url === `/api/v1/courses/${COURSE_ID}/exam-pins`);
    expect(call?.body).toEqual({ sectionId: SECTION_ID, newExam: { name: 'Kiểm tra 15 phút' } });
    // Không còn đường tạo module bằng chuỗi component cho quiz.
    expect(calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/modules` && c.method === 'POST')).toBe(false);
  });

  it('thêm nội dung bằng menu chọn loại Bài tập gọi POST /courses/:id/assignments và mở trang hoạt động (issue #179)', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderCourseBuilder();

    const sectionBox = await screen.findByTestId(`section-builder-${SECTION_ID}`);
    await userEvent.selectOptions(within(sectionBox).getByLabelText('Loại nội dung'), 'mod_assign');
    const nameInput = sectionBox.querySelector<HTMLInputElement>(`#module-new-name-${SECTION_ID}`);
    await userEvent.type(nameInput!, 'Bài tập về nhà');
    await userEvent.click(within(sectionBox).getByRole('button', { name: 'Thêm module' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/assignments` && c.method === 'POST')).toBe(true),
    );
    const call = calls.find((c) => c.url === `/api/v1/courses/${COURSE_ID}/assignments`);
    expect(call?.body).toEqual({ sectionId: SECTION_ID, name: 'Bài tập về nhà' });
    expect(calls.some((c) => c.url === `/api/v1/courses/${COURSE_ID}/modules` && c.method === 'POST')).toBe(false);
    // Tạo xong điều hướng thẳng tới trang hoạt động bài tập để GV cài đặt tiếp.
    expect(await screen.findByText('assignment-editor')).toBeTruthy();
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

describe('Builder — Thêm từ kho học liệu (CB-1, issue #107)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('mở panel trong section, lọc theo từ khoá và cắm học liệu qua POST /contentbank/:id/insert', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderCourseBuilder();

    const sectionBox = await screen.findByTestId(`section-builder-${SECTION_ID}`);
    await userEvent.click(within(sectionBox).getByRole('button', { name: 'Thêm từ kho' }));

    // Panel liệt kê cả hai học liệu lấy từ GET /contentbank.
    const lectureRow = await screen.findByTestId(`bank-item-${BANK_ITEM_LECTURE.id}`);
    expect(within(lectureRow).getByText('Bài giảng video: Dao động điều hoà')).toBeTruthy();
    expect(screen.getByTestId(`bank-item-${BANK_ITEM_QUESTION_SET.id}`)).toBeTruthy();
    expect(calls.some((c) => c.url === '/api/v1/contentbank' && c.method === 'GET')).toBe(true);

    // Lọc theo từ khoá "video": chỉ còn bài giảng, bộ câu hỏi biến mất.
    await userEvent.type(within(sectionBox).getByLabelText('Tìm học liệu trong kho'), 'video');
    await waitFor(() => expect(screen.queryByTestId(`bank-item-${BANK_ITEM_QUESTION_SET.id}`)).toBeNull());
    await userEvent.clear(within(sectionBox).getByLabelText('Tìm học liệu trong kho'));

    await userEvent.click(within(lectureRow).getByRole('button', { name: 'Thêm vào section' }));

    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/contentbank/${BANK_ITEM_LECTURE.id}/insert` && c.method === 'POST'),
      ).toBe(true),
    );
    const insert = calls.find((c) => c.url === `/api/v1/contentbank/${BANK_ITEM_LECTURE.id}/insert`);
    expect(insert?.body).toEqual({ courseId: COURSE_ID, sectionId: SECTION_ID });
    expect(await screen.findByText('Đã thêm học liệu "Bài giảng video: Dao động điều hoà" từ kho vào section.')).toBeTruthy();
  });

  it('bộ câu hỏi tham chiếu (question_set không file) không có nút Thêm — chỉ hiện ghi chú, không gọi insert', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderCourseBuilder();

    const sectionBox = await screen.findByTestId(`section-builder-${SECTION_ID}`);
    await userEvent.click(within(sectionBox).getByRole('button', { name: 'Thêm từ kho' }));

    const qsetRow = await screen.findByTestId(`bank-item-${BANK_ITEM_QUESTION_SET.id}`);
    expect(within(qsetRow).getByText('Bộ câu hỏi tham chiếu — dùng từ ngân hàng câu hỏi')).toBeTruthy();
    expect(within(qsetRow).queryByRole('button', { name: 'Thêm vào section' })).toBeNull();
    expect(calls.some((c) => c.url.endsWith('/insert') && c.method === 'POST')).toBe(false);
  });
});

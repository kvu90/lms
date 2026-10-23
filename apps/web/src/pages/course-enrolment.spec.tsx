import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoursePage } from './course';

/**
 * Spec ghi danh tự phục vụ trên trang khoá học: panel tự ghi danh cho
 * người chưa ghi danh, đường thanh toán phí (chỉ tạo payment, không tự
 * ghi danh) và nút tự đánh dấu hoàn thành thủ công. Stub fetch ghi lại
 * mọi lời gọi để khẳng định đúng endpoint/phương thức/body thật.
 */
const COURSE_ID = '01900000-0000-7000-8000-000000000010';
const USER_ID = '01900000-0000-7000-8000-0000000000a3';
const SELF_ID = '01900000-0000-7000-8000-000000000201';
const FEE_ID = '01900000-0000-7000-8000-000000000202';
const CM_MANUAL_ID = '01900000-0000-7000-8000-000000001000';

const COURSE = {
  id: COURSE_ID,
  category: '01900000-0000-7000-8000-000000000002',
  fullName: 'Physics 101',
  shortName: 'PHY101',
  idNumber: '',
  summary: '',
  format: 'topics',
  visible: true,
  startDate: null,
  endDate: null,
  groupMode: 0,
  enableCompletion: true,
};

const INSTANCES = [
  {
    id: SELF_ID,
    courseId: COURSE_ID,
    enrol: 'self',
    status: 0,
    name: 'Tự ghi danh',
    roleId: null,
    customInt1: null,
    customInt2: null,
    customText1: '',
    cost: 0,
    currency: '',
  },
  {
    id: FEE_ID,
    courseId: COURSE_ID,
    enrol: 'fee',
    status: 0,
    name: 'Ghi danh có phí',
    roleId: null,
    customInt1: null,
    customInt2: null,
    customText1: '',
    cost: 150000,
    currency: 'VND',
  },
  {
    id: '01900000-0000-7000-8000-000000000203',
    courseId: COURSE_ID,
    enrol: 'manual',
    status: 0,
    name: 'Ghi danh thủ công',
    roleId: null,
    customInt1: null,
    customInt2: null,
    customText1: '',
    cost: 0,
    currency: '',
  },
  {
    id: '01900000-0000-7000-8000-000000000204',
    courseId: COURSE_ID,
    enrol: 'self',
    status: 1,
    name: 'Tự ghi danh đã tắt',
    roleId: null,
    customInt1: null,
    customInt2: null,
    customText1: '',
    cost: 0,
    currency: '',
  },
];

const CONTENT = {
  course: COURSE,
  contextId: '01900000-0000-7000-8000-000000000055',
  customFields: [],
  sections: [
    {
      id: '01900000-0000-7000-8000-000000000100',
      course: COURSE_ID,
      section: 0,
      name: 'General',
      summary: '',
      visible: true,
      availability: null,
      availabilityResult: { available: true, visible: true, failedDescriptions: [] },
      modules: [
        {
          id: CM_MANUAL_ID,
          course: COURSE_ID,
          section: '01900000-0000-7000-8000-000000000100',
          component: 'mod_page',
          instanceId: '01900000-0000-7000-8000-000000000001',
          name: 'Welcome page',
          visible: true,
          groupMode: 0,
          availability: null,
          completion: 1,
          completionView: false,
          completionManual: true,
          availabilityResult: { available: true, visible: true, failedDescriptions: [] },
        },
        {
          id: '01900000-0000-7000-8000-000000001001',
          course: COURSE_ID,
          section: '01900000-0000-7000-8000-000000000100',
          component: 'mod_page',
          instanceId: '01900000-0000-7000-8000-000000000002',
          name: 'Reading page',
          visible: true,
          groupMode: 0,
          availability: null,
          completion: 0,
          completionView: false,
          completionManual: false,
          availabilityResult: { available: true, visible: true, failedDescriptions: [] },
        },
      ],
    },
  ],
};

const FORBIDDEN = { type: 'about:blank', title: 'Forbidden', status: 403, code: 'course.not_enrolled' };

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** Handler có trạng thái: ghi danh lật cờ để content/completion mở ra như server thật. */
function makeHandler(state: { enrolled: boolean; cmState: number; payments: unknown[] }, calls: RecordedCall[]) {
  return (url: string, init?: RequestInit): { status: number; body: unknown } | undefined => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === `/api/v1/courses/${COURSE_ID}`) return { status: 200, body: COURSE };
    if (url === `/api/v1/courses/${COURSE_ID}/enrol/instances`) return { status: 200, body: INSTANCES };
    if (url === `/api/v1/courses/${COURSE_ID}/enrolments/me`) {
      return {
        status: 200,
        body: { courseId: COURSE_ID, userId: USER_ID, enrolled: state.enrolled, active: state.enrolled },
      };
    }
    if (url === `/api/v1/courses/${COURSE_ID}/content`) {
      return state.enrolled ? { status: 200, body: CONTENT } : { status: 403, body: FORBIDDEN };
    }
    if (url === `/api/v1/courses/${COURSE_ID}/completion/me`) {
      if (!state.enrolled) return { status: 403, body: FORBIDDEN };
      return {
        status: 200,
        body: {
          activities: [{ cmId: CM_MANUAL_ID, state: state.cmState, viewed: false }],
          course: {
            id: '01900000-0000-7000-8000-000000000301',
            userId: USER_ID,
            course: COURSE_ID,
            status: 'in_progress',
            timeCompleted: null,
          },
        },
      };
    }
    if (url === '/api/v1/payments/me') return { status: 200, body: state.payments };
    if (url === `/api/v1/courses/${COURSE_ID}/enrol/instances/${SELF_ID}/self-enrol` && method === 'POST') {
      state.enrolled = true;
      return {
        status: 200,
        body: { id: '01900000-0000-7000-8000-000000000401', enrolId: SELF_ID, userId: USER_ID, status: 0 },
      };
    }
    if (url === `/api/v1/payments/fee/${FEE_ID}` && method === 'POST') {
      const payment = {
        id: '01900000-0000-7000-8000-000000000501',
        accountId: '01900000-0000-7000-8000-000000000601',
        userId: USER_ID,
        amount: 150000,
        currency: 'VND',
        status: 'pending',
        gateway: 'manual',
        component: 'enrol_fee',
        itemId: FEE_ID,
      };
      state.payments = [payment];
      return { status: 200, body: payment };
    }
    if (url === `/api/v1/courses/${COURSE_ID}/modules/${CM_MANUAL_ID}/completion/manual` && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { complete: boolean };
      state.cmState = body.complete ? 1 : 0;
      return { status: 200, body: { cmId: CM_MANUAL_ID, userId: USER_ID, state: state.cmState } };
    }
    return undefined;
  };
}

/** Stub fetch kiểu dashboard.spec: handler trả {status, body} hoặc undefined (404). */
function stubFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown } | undefined) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const result = handler(url, init);
      if (!result) return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

/** Render trang khoá học tại đúng route /courses/:id. */
function renderCourse() {
  const router = createMemoryRouter([{ path: '/courses/:id', element: <CoursePage /> }], {
    initialEntries: [`/courses/${COURSE_ID}`],
  });
  render(<RouterProvider router={router} />);
}

describe('Course page — self enrolment and fee payment', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the self-enrol panel to a non-enrolled user and enrols via self-enrol on click', async () => {
    const state = { enrolled: false, cmState: 0, payments: [] as unknown[] };
    const calls: RecordedCall[] = [];
    stubFetch(makeHandler(state, calls));
    renderCourse();

    // Panel ghi danh hiện ra (không còn lỗi access denied trơ trọi), chỉ
    // gồm instance self/fee đang bật: manual và instance đã tắt bị lọc.
    expect(await screen.findByRole('button', { name: 'Ghi danh' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Thanh toán phí ghi danh' })).toBeInTheDocument();
    expect(screen.getByText(/Phí:/)).toHaveTextContent('VND');
    expect(screen.queryByText('Ghi danh thủ công')).not.toBeInTheDocument();
    expect(screen.queryByText('Tự ghi danh đã tắt')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Ghi danh' }));

    await waitFor(() => expect(screen.getByText('Welcome page')).toBeInTheDocument());
    const selfEnrolCalls = calls.filter((c) => c.url.endsWith('/self-enrol'));
    expect(selfEnrolCalls).toHaveLength(1);
    expect(selfEnrolCalls[0]?.method).toBe('POST');
    expect(selfEnrolCalls[0]?.url).toBe(`/api/v1/courses/${COURSE_ID}/enrol/instances/${SELF_ID}/self-enrol`);
    expect(selfEnrolCalls[0]?.body).toBeUndefined();
  });

  it('creates a fee payment via /payments/fee/:id and never calls self-enrol for the fee instance', async () => {
    const state = { enrolled: false, cmState: 0, payments: [] as unknown[] };
    const calls: RecordedCall[] = [];
    stubFetch(makeHandler(state, calls));
    renderCourse();

    expect(await screen.findByRole('button', { name: 'Thanh toán phí ghi danh' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Thanh toán phí ghi danh' }));

    // Trạng thái thật từ /payments/me: pending = đang chờ cổng xác nhận,
    // và người dùng vẫn chưa được vào nội dung khoá.
    await waitFor(() => expect(screen.getByText(/Thanh toán của tôi:/)).toBeInTheDocument());
    expect(screen.getByText(/Thanh toán của tôi:/)).toHaveTextContent('đang chờ xác nhận');
    expect(screen.getByText(/Đang chờ xác nhận từ cổng thanh toán/)).toBeInTheDocument();
    expect(screen.queryByText('Welcome page')).not.toBeInTheDocument();

    const feeCalls = calls.filter((c) => c.url === `/api/v1/payments/fee/${FEE_ID}`);
    expect(feeCalls).toHaveLength(1);
    expect(feeCalls[0]?.method).toBe('POST');
    expect(calls.some((c) => c.url.includes('self-enrol'))).toBe(false);
  });

  it('lets an enrolled learner toggle manual completion for a manual module only', async () => {
    const state = { enrolled: true, cmState: 0, payments: [] as unknown[] };
    const calls: RecordedCall[] = [];
    stubFetch(makeHandler(state, calls));
    renderCourse();

    const toggle = await screen.findByRole('button', { name: 'Đánh dấu hoàn thành' });
    // Module không bật theo dõi hoàn thành (completion = 0) không có nút.
    expect(screen.getAllByRole('button', { name: /hoàn thành/ })).toHaveLength(1);

    await userEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bỏ đánh dấu hoàn thành' })).toBeInTheDocument());

    const manualCalls = calls.filter((c) => c.url.includes('/completion/manual'));
    expect(manualCalls).toHaveLength(1);
    expect(manualCalls[0]?.method).toBe('POST');
    expect(manualCalls[0]?.url).toBe(`/api/v1/courses/${COURSE_ID}/modules/${CM_MANUAL_ID}/completion/manual`);
    expect(manualCalls[0]?.body).toEqual({ userId: USER_ID, complete: true });
  });
});

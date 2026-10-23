import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CalendarPage } from './calendar';

/**
 * Spec lịch theo endpoint thật: tạo sự kiện qua POST /calendar/events với
 * đúng DTO, subscription qua POST /calendar/subscriptions và nhập ngay qua
 * POST /calendar/subscriptions/:id/import.
 */
const EVENT_ID = '01900000-0000-7000-8000-000000000031';
const SUB_ID = '01900000-0000-7000-8000-000000000032';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** Stub fetch ghi lời gọi; sự kiện/subscription mới tạo xuất hiện ở lần GET sau. */
function stubFetch(calls: RecordedCall[]) {
  const state = {
    events: [] as Record<string, unknown>[],
    subs: [] as Record<string, unknown>[],
    exportToken: null as { token: string; url: string } | null,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });
      const respond = (payload: unknown) =>
        new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/v1/calendar/events?')) return respond(state.events);
      if (url === '/api/v1/calendar/events' && method === 'POST') {
        const event = {
          id: EVENT_ID,
          name: body?.name,
          description: body?.description ?? '',
          eventType: body?.eventType,
          timeStart: body?.timeStart,
          timeDuration: body?.timeDuration ?? 0,
          repeatId: EVENT_ID,
          isException: false,
        };
        state.events = [event];
        return respond({ event, occurrences: [event] });
      }
      if (url === '/api/v1/calendar/subscriptions' && method === 'GET') return respond(state.subs);
      if (url === '/api/v1/calendar/subscriptions' && method === 'POST') {
        const sub = {
          id: SUB_ID,
          name: body?.name,
          url: body?.url ?? null,
          eventType: body?.eventType ?? 'user',
          pollInterval: 604800,
        };
        state.subs = [sub];
        return respond(sub);
      }
      if (url === `/api/v1/calendar/subscriptions/${SUB_ID}/import` && method === 'POST')
        return respond({ queued: true, subscriptionId: SUB_ID });
      // Xuất lịch: token bắt đầu chưa có; POST tạo, GET đọc lại, DELETE thu hồi.
      if (url === '/api/v1/calendar/export-token' && method === 'GET') return respond(state.exportToken);
      if (url === '/api/v1/calendar/export-token' && method === 'POST') {
        state.exportToken = {
          token: 'tok123',
          url: 'https://lms.example/api/v1/calendar/export/01900000-0000-7000-8000-000000000033-tok123.ics',
        };
        return respond(state.exportToken);
      }
      if (url === '/api/v1/calendar/export-token' && method === 'DELETE') {
        state.exportToken = null;
        return respond({ revoked: true });
      }
      if (url === '/api/v1/calendar/export.ics')
        return new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR', {
          status: 200,
          headers: { 'Content-Type': 'text/calendar' },
        });
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

/** Chuỗi datetime-local của thời điểm hiện tại (để sự kiện nằm trong tháng đang xem). */
function localNowInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

describe('Calendar page — export', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('creates a subscription URL via POST /calendar/export-token and revokes it via DELETE', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    render(<CalendarPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Tạo đường dẫn đăng ký' }));
    const urlInput = (await screen.findByLabelText('Đường dẫn đăng ký')) as HTMLInputElement;
    expect(urlInput.value).toContain('tok123.ics');
    expect(calls.some((c) => c.url === '/api/v1/calendar/export-token' && c.method === 'POST')).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Thu hồi đường dẫn' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/calendar/export-token' && c.method === 'DELETE')).toBe(true),
    );
    expect(await screen.findByText('Chưa có đường dẫn đăng ký nào.')).toBeInTheDocument();
  });

  it('downloads the ICS file through the authenticated GET /calendar/export.ics endpoint', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(<CalendarPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Tải tệp .ics' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/calendar/export.ics' && c.method === 'GET')).toBe(true),
    );
    expect(createObjectURL).toHaveBeenCalled();
    clickSpy.mockRestore();
  });
});

describe('Calendar page — create events and subscriptions', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('creates an event via POST /calendar/events with the DTO shape', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    render(<CalendarPage />);

    await userEvent.type(await screen.findByLabelText('Tên sự kiện'), 'Họp nhóm');
    fireEvent.change(screen.getByLabelText('Thời gian bắt đầu'), { target: { value: localNowInput() } });
    await userEvent.click(screen.getByRole('button', { name: 'Tạo sự kiện' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/calendar/events' && c.method === 'POST')).toBe(true),
    );
    const createCall = calls.find((c) => c.url === '/api/v1/calendar/events' && c.method === 'POST');
    expect(createCall?.body).toMatchObject({ name: 'Họp nhóm', eventType: 'user', timeDuration: 3600 });
    expect(typeof (createCall?.body as { timeStart?: unknown }).timeStart).toBe('string');
    expect(await screen.findByText('Họp nhóm')).toBeInTheDocument();
    expect(await screen.findByText('Đã tạo sự kiện.')).toBeInTheDocument();
  });

  it('adds a subscription via POST /calendar/subscriptions and imports it', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    render(<CalendarPage />);

    await userEvent.type(await screen.findByLabelText('Tên subscription'), 'Lịch trường');
    await userEvent.type(screen.getByLabelText('URL nguồn ICS'), 'https://example.com/cal.ics');
    await userEvent.click(screen.getByRole('button', { name: 'Thêm subscription' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/calendar/subscriptions' && c.method === 'POST')).toBe(true),
    );
    const createCall = calls.find((c) => c.url === '/api/v1/calendar/subscriptions' && c.method === 'POST');
    expect(createCall?.body).toEqual({ name: 'Lịch trường', url: 'https://example.com/cal.ics', eventType: 'user' });

    await userEvent.click(await screen.findByRole('button', { name: 'Nhập ngay' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === `/api/v1/calendar/subscriptions/${SUB_ID}/import` && c.method === 'POST'),
      ).toBe(true),
    );
    expect(await screen.findByText('Đã đưa subscription vào hàng đợi nhập.')).toBeInTheDocument();
  });
});

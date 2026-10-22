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

interface RecordedCall { url: string; method: string; body: unknown }

/** Stub fetch ghi lời gọi; sự kiện/subscription mới tạo xuất hiện ở lần GET sau. */
function stubFetch(calls: RecordedCall[]) {
  const state = {
    events: [] as Record<string, unknown>[],
    subs: [] as Record<string, unknown>[],
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ url, method, body });
    const respond = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('/api/v1/calendar/events?')) return respond(state.events);
    if (url === '/api/v1/calendar/events' && method === 'POST') {
      const event = {
        id: EVENT_ID, name: body?.name, description: body?.description ?? '', eventtype: body?.eventtype,
        timestart: body?.timestart, timeduration: body?.timeduration ?? 0, repeatid: EVENT_ID, isexception: false,
      };
      state.events = [event];
      return respond({ event, occurrences: [event] });
    }
    if (url === '/api/v1/calendar/subscriptions' && method === 'GET') return respond(state.subs);
    if (url === '/api/v1/calendar/subscriptions' && method === 'POST') {
      const sub = { id: SUB_ID, name: body?.name, url: body?.url ?? null, eventtype: body?.eventtype ?? 'user', pollinterval: 604800 };
      state.subs = [sub];
      return respond(sub);
    }
    if (url === `/api/v1/calendar/subscriptions/${SUB_ID}/import` && method === 'POST') return respond({ queued: true, subscriptionId: SUB_ID });
    return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  }));
}

/** Chuỗi datetime-local của thời điểm hiện tại (để sự kiện nằm trong tháng đang xem). */
function localNowInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

describe('Calendar page — create events and subscriptions', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('creates an event via POST /calendar/events with the DTO shape', async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    render(<CalendarPage />);

    await userEvent.type(await screen.findByLabelText('Tên sự kiện'), 'Họp nhóm');
    fireEvent.change(screen.getByLabelText('Thời gian bắt đầu'), { target: { value: localNowInput() } });
    await userEvent.click(screen.getByRole('button', { name: 'Tạo sự kiện' }));

    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/calendar/events' && c.method === 'POST')).toBe(true));
    const createCall = calls.find((c) => c.url === '/api/v1/calendar/events' && c.method === 'POST');
    expect(createCall?.body).toMatchObject({ name: 'Họp nhóm', eventtype: 'user', timeduration: 3600 });
    expect(typeof (createCall?.body as { timestart?: unknown }).timestart).toBe('string');
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

    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/calendar/subscriptions' && c.method === 'POST')).toBe(true));
    const createCall = calls.find((c) => c.url === '/api/v1/calendar/subscriptions' && c.method === 'POST');
    expect(createCall?.body).toEqual({ name: 'Lịch trường', url: 'https://example.com/cal.ics', eventtype: 'user' });

    await userEvent.click(await screen.findByRole('button', { name: 'Nhập ngay' }));
    await waitFor(() => expect(calls.some((c) => c.url === `/api/v1/calendar/subscriptions/${SUB_ID}/import` && c.method === 'POST')).toBe(true));
    expect(await screen.findByText('Đã đưa subscription vào hàng đợi nhập.')).toBeInTheDocument();
  });
});

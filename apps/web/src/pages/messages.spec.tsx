import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '#lib/auth';
import { MessagesPage } from './messages';

/**
 * Kênh realtime được mock ở đúng biên lib `#lib/messaging-socket`:
 * test cũ (chặn liên lạc, hợp đồng tạo conversation) không cần socket
 * thật; test realtime bên dưới điều khiển handlers mà trang đăng ký
 * để giả lập sự kiện server đẩy xuống.
 */
const realtime = vi.hoisted(() => ({
  handlers: null as null | Record<string, (payload: never) => void>,
  handle: {
    sync: vi.fn(async () => ({})),
    joinConversation: vi.fn(),
    typing: vi.fn(),
    disconnect: vi.fn(),
  },
}));
vi.mock('#lib/messaging-socket', () => ({
  connectMessagingRealtime: (handlers: Record<string, (payload: never) => void>) => {
    realtime.handlers = handlers;
    return realtime.handle;
  },
}));

/**
 * Spec chặn liên lạc theo endpoint thật của messaging: chặn qua
 * POST /messages/contacts/:userId/block, danh sách đã chặn qua
 * GET /messages/contacts/blocked, bỏ chặn qua DELETE trên cùng đường block.
 * Kèm spec hợp đồng tạo conversation: web phải gửi `memberIds` (đúng schema
 * phía API/contracts) để người được chỉ định thật sự thành thành viên.
 */
const ME_ID = '01900000-0000-7000-8000-0000000000a1';
const OTHER_ID = '01900000-0000-7000-8000-0000000000b2';
const CONV_ID = '01900000-0000-7000-8000-0000000000c3';

const PROFILE = {
  id: ME_ID,
  username: 'me',
  firstName: 'Tôi',
  lastName: 'Đây',
  email: 'me@example.com',
  suspended: false,
  deleted: false,
  isGuest: false,
  forcePasswordChange: false,
  lastLogin: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  customFields: [],
};

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** Stub fetch ghi lời gọi; trạng thái chặn thay đổi theo POST/DELETE block. */
function stubFetch(calls: RecordedCall[]) {
  const state = { blocked: [] as string[] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const respond = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/messages/conversations' && method === 'POST')
        return respond({ id: CONV_ID, type: 1, name: null, members: [ME_ID, OTHER_ID] });
      if (url === '/api/v1/messages/conversations')
        return respond([{ id: CONV_ID, type: 1, name: null, members: [ME_ID, OTHER_ID] }]);
      if (url === '/api/v1/messages/unread-count') return respond({ conversations: 0, notifications: 0 });
      if (url === '/api/v1/messages/contacts/blocked') return respond({ blocked: state.blocked });
      if (url === `/api/v1/messages/contacts/${OTHER_ID}/block` && method === 'POST') {
        state.blocked = [OTHER_ID];
        return respond({ blocked: state.blocked });
      }
      if (url === `/api/v1/messages/contacts/${OTHER_ID}/block` && method === 'DELETE') {
        state.blocked = [];
        return respond({ blocked: state.blocked });
      }
      if (url === `/api/v1/messages/conversations/${CONV_ID}`)
        return respond({ id: CONV_ID, type: 1, name: null, members: [ME_ID, OTHER_ID], messages: [] });
      if (url === `/api/v1/messages/conversations/${CONV_ID}/read`) return respond({});
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

/** Render trang tin nhắn trong AuthProvider như ứng dụng thật. */
function renderMessages() {
  const router = createMemoryRouter([{ path: '/messages', element: <MessagesPage /> }], {
    initialEntries: ['/messages'],
  });
  render(
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>,
  );
}

describe('Messages page — block and unblock contacts', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('blocks the conversation partner via POST contacts/:userId/block and unblocks via DELETE', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderMessages();

    const convButton = await screen.findByRole('button', { name: new RegExp(OTHER_ID) });
    await userEvent.click(convButton);

    await userEvent.click(await screen.findByRole('button', { name: 'Chặn liên lạc' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/messages/contacts/${OTHER_ID}/block` && c.method === 'POST')).toBe(
        true,
      ),
    );

    const blockedRow = await screen.findByTestId(`blocked-${OTHER_ID}`);
    expect(blockedRow).toHaveTextContent(OTHER_ID);
    expect(await screen.findByText('Đã chặn liên hệ này.')).toBeInTheDocument();
    // Trong cuộc trò chuyện, nút chặn đã thay bằng trạng thái đã chặn + bỏ chặn.
    expect(screen.queryByRole('button', { name: 'Chặn liên lạc' })).not.toBeInTheDocument();

    await userEvent.click(within(blockedRow).getByRole('button', { name: 'Bỏ chặn' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/v1/messages/contacts/${OTHER_ID}/block` && c.method === 'DELETE')).toBe(
        true,
      ),
    );
    await waitFor(() => expect(screen.queryByTestId(`blocked-${OTHER_ID}`)).not.toBeInTheDocument());
  });
});

const CONV2_ID = '01900000-0000-7000-8000-0000000000d4';
const FIRST_MESSAGE = {
  id: '01900000-0000-7000-8000-0000000000e5',
  conversationId: CONV_ID,
  userIdFrom: OTHER_ID,
  subject: '',
  fullMessage: 'tin đầu tiên',
  createdAt: '2026-01-01T00:00:00.000Z',
  seq: 1,
  clientMessageId: null,
};

/** Stub fetch cho các test realtime: gửi tin trả bản server có seq + clientMessageId đã nhận. */
function stubRealtimeFetch(calls: RecordedCall[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });
      const respond = (payload: unknown) =>
        new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/v1/users/me') return respond(PROFILE);
      if (url === '/api/v1/messages/conversations')
        return respond([
          {
            id: CONV_ID, type: 2, name: 'Nhóm một', members: [ME_ID, OTHER_ID],
            unread: 1, lastReadSeq: 0, lastMessageSeq: 1, lastMessage: FIRST_MESSAGE,
          },
          {
            id: CONV2_ID, type: 2, name: 'Nhóm hai', members: [ME_ID, OTHER_ID],
            unread: 0, lastReadSeq: 0, lastMessageSeq: 0, lastMessage: null,
          },
        ]);
      if (url === '/api/v1/messages/contacts/blocked') return respond({ blocked: [] });
      if (url === `/api/v1/messages/conversations/${CONV_ID}`)
        return respond({
          id: CONV_ID, type: 2, name: 'Nhóm một', members: [ME_ID, OTHER_ID],
          messages: [FIRST_MESSAGE], hasMoreBefore: false,
          memberReadMarkers: [
            { userId: ME_ID, lastReadSeq: 1 },
            { userId: OTHER_ID, lastReadSeq: 0 },
          ],
        });
      if (url === `/api/v1/messages/conversations/${CONV_ID}/read`) return respond({ marked: 1, lastReadSeq: 1 });
      if (url === `/api/v1/messages/conversations/${CONV_ID}/messages` && method === 'POST')
        return respond({
          id: '01900000-0000-7000-8000-0000000000f6',
          conversationId: CONV_ID,
          userIdFrom: ME_ID,
          subject: '',
          fullMessage: body?.text,
          createdAt: '2026-01-01T00:01:00.000Z',
          seq: 2,
          clientMessageId: body?.clientMessageId ?? null,
        });
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

describe('Messages page — optimistic send and realtime updates', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    realtime.handlers = null;
  });

  it('sends with a clientMessageId and dedupes the socket echo of its own message', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubRealtimeFetch(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Nhóm một/ }));
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin đầu tiên')).toBeInTheDocument();

    const input = screen.getByLabelText('Nội dung tin nhắn');
    await userEvent.type(input, 'xin chào lạc quan');
    await userEvent.click(screen.getByRole('button', { name: 'Gửi' }));

    // Lời gọi gửi tin phải mang clientMessageId để server chống trùng.
    await waitFor(() => {
      const send = calls.find((c) => c.url === `/api/v1/messages/conversations/${CONV_ID}/messages` && c.method === 'POST');
      expect(send).toBeDefined();
      expect(typeof (send?.body as { clientMessageId?: unknown }).clientMessageId).toBe('string');
      expect((send?.body as { text?: unknown }).text).toBe('xin chào lạc quan');
    });
    expect(await screen.findByText('xin chào lạc quan')).toBeInTheDocument();

    // Echo của chính tin đó qua socket (cùng id + clientMessageId) không nhân đôi.
    const sendCall = calls.find((c) => c.url === `/api/v1/messages/conversations/${CONV_ID}/messages` && c.method === 'POST');
    const clientMessageId = (sendCall?.body as { clientMessageId: string }).clientMessageId;
    act(() => {
      realtime.handlers?.onNewMessage({
        conversationId: CONV_ID,
        message: {
          id: '01900000-0000-7000-8000-0000000000f6',
          conversationId: CONV_ID,
          userIdFrom: ME_ID,
          subject: '',
          fullMessage: 'xin chào lạc quan',
          createdAt: '2026-01-01T00:01:00.000Z',
          seq: 2,
          clientMessageId,
        },
      } as never);
    });
    expect(screen.getAllByText('xin chào lạc quan')).toHaveLength(1);
  });

  it('appends a realtime message from the peer and updates unread from conversation.updated', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubRealtimeFetch(calls);
    renderMessages();

    await userEvent.click(await screen.findByRole('button', { name: /Nhóm một/ }));
    const thread = await screen.findByLabelText('Tin nhắn');
    expect(await within(thread).findByText('tin đầu tiên')).toBeInTheDocument();
    const detailCallsBefore = calls.filter((c) => c.url === `/api/v1/messages/conversations/${CONV_ID}`).length;

    act(() => {
      realtime.handlers?.onNewMessage({
        conversationId: CONV_ID,
        message: {
          id: '01900000-0000-7000-8000-0000000000f7',
          conversationId: CONV_ID,
          userIdFrom: OTHER_ID,
          subject: '',
          fullMessage: 'tin realtime đến',
          createdAt: '2026-01-01T00:02:00.000Z',
          seq: 2,
          clientMessageId: null,
        },
      } as never);
      realtime.handlers?.onConversationUpdated({
        conversationId: CONV2_ID,
        message: {
          id: '01900000-0000-7000-8000-0000000000f8',
          conversationId: CONV2_ID,
          userIdFrom: OTHER_ID,
          subject: '',
          fullMessage: 'tin ở nhóm hai',
          createdAt: '2026-01-01T00:03:00.000Z',
          seq: 1,
          clientMessageId: null,
        },
        unreadCount: 3,
      } as never);
    });

    // Tin realtime hiện ngay trong cuộc trò chuyện đang mở, không tải lại chi tiết.
    expect(await within(thread).findByText('tin realtime đến')).toBeInTheDocument();
    expect(calls.filter((c) => c.url === `/api/v1/messages/conversations/${CONV_ID}`).length).toBe(detailCallsBefore);
    // Conversation khác nhận số chưa đọc theo sự kiện.
    expect(await screen.findByRole('button', { name: /Nhóm hai.*3 chưa đọc/ })).toBeInTheDocument();
  });

  it('ignores a stale conversation.updated with an older seq than the applied one', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubRealtimeFetch(calls);
    renderMessages();

    await screen.findByRole('button', { name: /Nhóm một/ });
    const updatedPayload = (seq: number, text: string, unreadCount: number) => ({
      conversationId: CONV2_ID,
      message: {
        id: `01900000-0000-7000-8000-0000000000f${seq}`,
        conversationId: CONV2_ID,
        userIdFrom: OTHER_ID,
        subject: '',
        fullMessage: text,
        createdAt: '2026-01-01T00:05:00.000Z',
        seq,
        clientMessageId: null,
      },
      unreadCount,
    }) as never;

    // Sự kiện mới (seq 2) áp bình thường: huy hiệu 5, xem trước là tin seq 2.
    act(() => {
      realtime.handlers?.onConversationUpdated(updatedPayload(2, 'tin mới nhất nhóm hai', 5));
    });
    expect(await screen.findByRole('button', { name: /Nhóm hai.*5 chưa đọc/ })).toBeInTheDocument();
    expect(await screen.findByText('tin mới nhất nhóm hai')).toBeInTheDocument();

    // Sự kiện cũ hơn (seq 1) đến muộn: bị bỏ qua — huy hiệu không nhảy
    // lùi lên 9 theo số của thời điểm cũ, xem trước giữ nguyên tin seq 2.
    act(() => {
      realtime.handlers?.onConversationUpdated(updatedPayload(1, 'tin cũ nhóm hai', 9));
    });
    expect(screen.getByRole('button', { name: /Nhóm hai.*5 chưa đọc/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Nhóm hai.*9 chưa đọc/ })).not.toBeInTheDocument();
    expect(screen.getByText('tin mới nhất nhóm hai')).toBeInTheDocument();
    expect(screen.queryByText('tin cũ nhóm hai')).not.toBeInTheDocument();
  });
});

describe('Messages page — create conversation contract', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('posts memberIds when starting a conversation and opens it with the designated user as a member', async () => {
    localStorage.setItem('lms.accessToken', 'test-token');
    const calls: RecordedCall[] = [];
    stubFetch(calls);
    renderMessages();

    const input = await screen.findByLabelText('Hội thoại mới với ID người dùng');
    await userEvent.type(input, OTHER_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Bắt đầu' }));

    // Lời gọi tạo conversation phải mang đúng trường hợp đồng phía API
    // (`memberIds`); gửi tên trường khác là thành viên bị rơi ở tầng validate.
    await waitFor(() => {
      const create = calls.find((c) => c.url === '/api/v1/messages/conversations' && c.method === 'POST');
      expect(create).toBeDefined();
      expect(create?.body).toEqual({ memberIds: [OTHER_ID] });
    });

    // Conversation vừa tạo mở ra với người được chỉ định là một thành viên:
    // nút chặn dành cho thành viên đó xuất hiện trong khung trò chuyện.
    expect(await screen.findByRole('button', { name: 'Chặn liên lạc' })).toBeInTheDocument();
  });
});

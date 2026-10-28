import { describe, expect, it, vi } from 'vitest';
import { MESSAGING_SOCKET_EVENTS } from '@lms/contracts';
import { MessagingRealtimeService } from './messaging-realtime.service';
import type { MessageRow } from './messaging.repository';

/**
 * Cổng chặn cặp hội thoại 1–1 ở tầng phân phối realtime — kỷ luật
 * FAIL-CLOSED khi không xác minh được quan hệ chặn:
 *
 * - Tra danh sách chặn LỖI (cơ sở dữ liệu lỗi đúng lúc phân phối)
 *   thì toàn bộ lượt phân phối bị NÉN: không một sự kiện nào
 *   (message.new, conversation.updated) được phát cho cặp 1–1, vì
 *   không xác minh được quan hệ chặn thì không được phát.
 * - Tra cứu THÀNH CÔNG giữ nguyên hành vi cũ: cặp đang chặn thì
 *   không phát; cặp không chặn thì phát bình thường.
 *
 * Đổi kỷ luật (nuốt lỗi tra cứu thành danh sách rỗng) thì ca đầu
 * tiên phải đỏ: lỗi tra cứu sẽ làm sự kiện lộ sang phía đang bị
 * chặn đúng như antipattern đã sửa.
 */
describe('MessagingRealtimeService — cổng chặn 1–1 fail-closed khi phân phối tin mới', () => {
  const CONVERSATION_ID = 'conv-1';
  const TENANT_ID = 'tenant-1';
  const USER_A = 'user-a';
  const USER_B = 'user-b';

  const messageRow = {
    id: 'msg-1',
    conversationId: CONVERSATION_ID,
    userIdFrom: USER_A,
    subject: null,
    fullMessage: 'xin chào',
    createdAt: new Date('2026-10-28T00:00:00.000Z'),
    seq: 1,
    clientMessageId: 'client-1',
    deletedAt: null,
    deletedBy: null,
    recalledAt: null,
    recalledBy: null,
    replyToMessageId: null,
  } as unknown as MessageRow;

  function build(opts: { blockedLookup: () => Promise<string[]> }) {
    const emits: { room: string; event: string }[] = [];
    const fakeServer = {
      to: (room: string) => ({
        emit: (event: string) => {
          emits.push({ room, event });
          return true;
        },
      }),
      in: () => ({ fetchSockets: async () => [] as never[] }),
    };
    const repo = {
      getConversation: vi.fn(async () => ({ id: CONVERSATION_ID, type: 1, tenantId: TENANT_ID })),
      listBlockedCounterpartIds: vi.fn(opts.blockedLookup),
      attachQuotes: vi.fn(async (rows: MessageRow[]) => rows),
      countUnreadForConversation: vi.fn(async () => 0),
    };
    const config = {
      getOrThrow: vi.fn(() => 'redis://localhost:6379'),
      get: vi.fn(() => undefined),
    };
    const service = new MessagingRealtimeService(config as never, repo as never);
    (service as unknown as { server: unknown }).server = fakeServer;
    return { service, repo, emits };
  }

  it('tra danh sách chặn lỗi: nén toàn bộ lượt phân phối, không phát sự kiện nào', async () => {
    const { service, emits } = build({
      blockedLookup: async () => {
        throw new Error('database connection lost');
      },
    });

    await service.distributeNewMessage(messageRow, [USER_A, USER_B]);

    expect(emits).toEqual([]);
  });

  it('cặp đang chặn (tra cứu thành công): không phát sự kiện nào', async () => {
    const { service, emits } = build({ blockedLookup: async () => [USER_B] });

    await service.distributeNewMessage(messageRow, [USER_A, USER_B]);

    expect(emits).toEqual([]);
  });

  it('cặp không chặn (tra cứu thành công): phát message.new vào room hội thoại và conversation.updated cho từng thành viên', async () => {
    const { service, emits } = build({ blockedLookup: async () => [] });

    await service.distributeNewMessage(messageRow, [USER_A, USER_B]);

    const events = emits.map((e) => e.event);
    expect(events).toContain(MESSAGING_SOCKET_EVENTS.newMessage);
    expect(events.filter((e) => e === MESSAGING_SOCKET_EVENTS.conversationUpdated)).toHaveLength(2);
  });
});

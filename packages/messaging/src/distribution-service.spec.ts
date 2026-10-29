import { describe, expect, it, vi } from 'vitest';
import { MESSAGING_SOCKET_EVENTS } from '@lms/contracts';
import { createMessagingDistributionService } from './distribution-service.js';
import type { MessagingDistributionStore } from './distribution-store.js';
import type { RealtimeEmitter } from './distribution-service.js';
import type { MessageRow } from './message-wire.js';
import { conversationRoom, userRoom } from './realtime-rooms.js';

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
 *
 * Spec này chuyển nguyên vẹn từ `messaging-realtime-block.spec.ts`
 * phía API khi tầng phân phối chuyển nhà sang package dùng chung
 * (issue #521) — cùng khẳng định, chỉ đổi bề mặt giả lập từ
 * Socket.IO server sang cổng phát {@link RealtimeEmitter}.
 */
describe('Tầng phân phối realtime — cổng chặn 1–1 fail-closed khi phân phối tin mới', () => {
  const CONVERSATION_ID = 'conv-1';
  const TENANT_ID = 'tenant-1';
  const USER_A = 'user-a';
  const USER_B = 'user-b';

  const messageRow = {
    id: 'msg-1',
    conversationId: CONVERSATION_ID,
    userIdFrom: USER_A,
    subject: '',
    fullMessage: 'xin chào',
    smallMessage: 'xin chào',
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
    const emits: { room: string; event: string; payload: unknown }[] = [];
    const emitter: RealtimeEmitter = {
      emitToRoom: (room, event, payload) => {
        emits.push({ room, event, payload });
      },
      fetchSocketsInRoom: async () => [],
    };
    const store = {
      getMessage: vi.fn(async () => messageRow),
      listMembers: vi.fn(async () => [USER_A, USER_B]),
      getConversation: vi.fn(async () => ({ id: CONVERSATION_ID, type: 1, tenantId: TENANT_ID })),
      getConversationTenantId: vi.fn(async () => TENANT_ID),
      listBlockedCounterpartIds: vi.fn(opts.blockedLookup),
      attachQuotes: vi.fn(async (rows: MessageRow[]) => rows.map((r) => ({ ...r, replyTo: null }))),
      countUnreadForConversation: vi.fn(async () => 0),
      listMessages: vi.fn(async () => [] as MessageRow[]),
    } as unknown as MessagingDistributionStore;
    const logger = { warn: vi.fn(), error: vi.fn() };
    const service = createMessagingDistributionService({ store, emitter, logger });
    return { service, store, emits };
  }

  it('tra danh sách chặn lỗi thì nén toàn bộ lượt phân phối, không phát sự kiện nào', async () => {
    const { service, emits } = build({
      blockedLookup: async () => {
        throw new Error('database connection lost');
      },
    });

    await service.distributeNewMessage(messageRow, [USER_A, USER_B]);

    expect(emits).toEqual([]);
  });

  it('cặp đang chặn (tra cứu thành công) thì không phát sự kiện nào', async () => {
    const { service, emits } = build({ blockedLookup: async () => [USER_B] });

    await service.distributeNewMessage(messageRow, [USER_A, USER_B]);

    expect(emits).toEqual([]);
  });

  it('cặp không chặn (tra cứu thành công) thì phát message.new vào room hội thoại và conversation.updated cho từng thành viên', async () => {
    const { service, emits } = build({ blockedLookup: async () => [] });

    await service.distributeNewMessage(messageRow, [USER_A, USER_B]);

    const events = emits.map((e) => e.event);
    expect(events).toContain(MESSAGING_SOCKET_EVENTS.newMessage);
    expect(events.filter((e) => e === MESSAGING_SOCKET_EVENTS.conversationUpdated)).toHaveLength(2);
    expect(emits.find((e) => e.event === MESSAGING_SOCKET_EVENTS.newMessage)?.room)
      .toBe(conversationRoom(TENANT_ID, CONVERSATION_ID));
  });

  it('sự kiện message_sent thiếu messageId trong payload thì bị bỏ qua, không đọc dữ kiện và không phát gì', async () => {
    const { service, store, emits } = build({ blockedLookup: async () => [] });

    await service.distributeEvent('message_sent', { conversationId: CONVERSATION_ID });

    expect(store.getMessage).not.toHaveBeenCalled();
    expect(emits).toEqual([]);
  });

  it('sự kiện message_sent mà tin đã bị thu hồi trước lúc phân phối thì phát như một lần thu hồi, không lộ nội dung qua message.new', async () => {
    const { service, store, emits } = build({ blockedLookup: async () => [] });
    const recalledRow = { ...messageRow, recalledAt: new Date('2026-10-28T00:01:00.000Z'), recalledBy: USER_A } as unknown as MessageRow;
    (store.getMessage as ReturnType<typeof vi.fn>).mockResolvedValue(recalledRow);

    await service.distributeEvent('message_sent', { messageId: recalledRow.id, conversationId: CONVERSATION_ID });

    const events = emits.map((e) => e.event);
    expect(events).not.toContain(MESSAGING_SOCKET_EVENTS.newMessage);
    expect(events).toContain(MESSAGING_SOCKET_EVENTS.messageDeleted);
    expect(events).toContain(MESSAGING_SOCKET_EVENTS.conversationInvalidate);
  });

  it('sự kiện message_deleted_for_me chỉ phát vào room riêng của chính người xoá, không phát vào room hội thoại và không phát cho phía kia', async () => {
    const { service, emits } = build({ blockedLookup: async () => [] });

    await service.distributeEvent('message_deleted_for_me', {
      conversationId: CONVERSATION_ID, messageId: 'msg-1', seq: 1, actorId: USER_A,
    });

    expect(emits.length).toBeGreaterThan(0);
    expect(emits.every((e) => e.room === userRoom(TENANT_ID, USER_A))).toBe(true);
    expect(emits.some((e) => e.room === conversationRoom(TENANT_ID, CONVERSATION_ID))).toBe(false);
    expect(emits.some((e) => e.room === userRoom(TENANT_ID, USER_B))).toBe(false);
  });
});

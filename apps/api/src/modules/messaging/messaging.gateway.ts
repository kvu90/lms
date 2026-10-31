import { Logger } from '@nestjs/common';
import {
  ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit,
  SubscribeMessage, WebSocketGateway, WebSocketServer,
} from '@nestjs/websockets';
import {
  MESSAGING_SOCKET_EVENTS,
  type MessagingSyncRequest, type MessagingSyncResult,
} from '@lms/contracts';
import type { Server, Socket } from 'socket.io';
import { Public } from '../../common/public.decorator';
import { blankRecalledContent, MessagingRepository } from './messaging.repository';
import { MessagingSocketAuth } from './messaging-socket-auth';
import { conversationRoom, toWireMessage, userRoom } from '@lms/messaging';
import { MessagingRealtimeService } from './messaging-realtime.service';

/** Số tin tối đa trả cho mỗi conversation trong một lần đồng bộ (client xin tiếp nếu còn thiếu). */
const SYNC_LIMIT_PER_CONVERSATION = 100;
/** Số conversation tối đa trong một payload đồng bộ. */
const SYNC_MAX_CONVERSATIONS = 50;

/**
 * Gateway realtime của messaging (issue #33, chặng A1) — Socket.IO,
 * namespace `/messaging`, chạy cùng HTTP server với REST.
 *
 * Xác thực handshake qua lớp mỏng {@link MessagingSocketAuth} (điểm
 * chạm duy nhất với cơ chế auth): cookie phiên Better Auth đi kèm
 * request bắt tay được ưu tiên như chuỗi guard HTTP (GĐ5 của issue
 * #7), access token (`handshake.auth.token` hoặc header Authorization
 * Bearer) là đường dự phòng cho tới cutover. Kết nối không xác thực
 * được thì ngắt ngay.
 *
 * Khi nối, socket vào room riêng của mình và room của mọi
 * conversation mình là thành viên. Sự kiện tin mới/đã đọc KHÔNG phát
 * từ đây cũng không phát từ service ghi DB — chúng đi đường outbox →
 * relay duy nhất → hàng đợi ở worker → consumer phân phối theo luật
 * ở `@lms/messaging`, phát qua Redis emitter về adapter của gateway
 * này (issue #521). Gateway chỉ xử lý các tương tác theo kết nối:
 * join/leave room, `sync` (xin tin còn thiếu theo seq khi nối lại)
 * và `typing`.
 */
// @Public ở đây KHÔNG có nghĩa là không cần đăng nhập: nó chỉ tắt
// JwtAuthGuard toàn cục (guard HTTP đọc header Authorization qua
// passport — không áp được cho context WebSocket và sẽ ném lỗi trên
// mọi message handler). Xác thực của kênh này nằm ở handleConnection:
// không qua được lớp auth mỏng là kết nối bị ngắt trước khi bất kỳ
// handler nào chạy.
@Public()
@WebSocketGateway({ namespace: '/messaging', cors: { origin: true } })
export class MessagingGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(MessagingGateway.name);

  @WebSocketServer()
  private readonly server!: Server;

  constructor(
    private readonly auth: MessagingSocketAuth,
    private readonly repo: MessagingRepository,
    private readonly realtime: MessagingRealtimeService,
  ) {}

  afterInit(server: Server): void {
    this.realtime.attachServer(server);
  }

  async handleConnection(client: Socket): Promise<void> {
    // Cờ "xác thực lúc nối đã xong": client nhận gói connect là emit được
    // ngay, trong khi handleConnection vẫn đang chờ DB/Redis — các handler
    // phải chờ cờ này rồi mới đọc client.data.userId, nếu không handler
    // chạy khi userId còn trống và trả rỗng (lỗi sync {} từng làm đỏ test
    // reconnect của realtime-flow khi máy tải nặng).
    let resolveAuth!: () => void;
    client.data.authSettled = new Promise<void>((resolve) => {
      resolveAuth = resolve;
    });
    try {
      const identity = await this.auth.authenticateHandshake(client.handshake);
      if (!identity) {
        client.disconnect(true);
        return;
      }
      client.data.userId = identity.userId;
      client.data.username = identity.username;
      client.data.tenantId = identity.tenantId;
      await client.join(userRoom(identity.tenantId, identity.userId));
      const conversations = await this.repo.listConversationsForUser(identity.userId);
      // Danh sách chặn của user là MỘT dữ kiện duy nhất, không đổi
      // theo hội thoại: tải lười một lần ở hội thoại 1–1 đầu tiên cần
      // kiểm rồi dùng lại cho cả vòng lặp, thay vì tải lại theo từng
      // hội thoại như trước.
      let blockedIds: string[] | undefined;
      const blockedIdsOnce = async (): Promise<string[]> => {
        blockedIds ??= await this.repo.listBlockedCounterpartIds(identity.userId);
        return blockedIds;
      };
      for (const conversation of conversations) {
        // Lớp phòng thủ thứ hai (việc nối tiếp #33, siết sau PR #94
        // vòng 1): socket mới nối KHÔNG vào room của hội thoại 1–1
        // đang chặn — cùng luật với isBlockedDirectConversation của
        // join/sync/typing. Socket nối từ TRƯỚC khi chặn vẫn nằm
        // trong room cũ, nhưng mọi điểm sinh sự kiện trong lúc chặn
        // đã bị cổng (gửi 403, xoá/đọc 404) nên không còn sự kiện
        // nào của hội thoại đó để lộ; tầng phân phối xoá tin còn
        // chặn nốt trường hợp outbox tới muộn (xem distributeMessageDeleted).
        if (await this.isBlockedDirectConversation(conversation.id, identity.userId, blockedIdsOnce)) continue;
        await client.join(conversationRoom(conversation.tenantId, conversation.id));
      }
      await this.realtime.markConnected(identity.tenantId, identity.userId, client.id);
      // Ảnh chụp presence lúc nối (sự kiện presence.snapshot): sự
      // kiện presence.changed chỉ phát khi trạng thái THAY ĐỔI nên
      // người đã trực tuyến từ trước lúc socket này nối không phát
      // sinh sự kiện nào — không có ảnh chụp này, phía khách không
      // bao giờ học được họ đang trực tuyến cho tới khi họ ngắt/nối
      // lại. Ảnh chụp chỉ gửi cho CHÍNH socket vừa nối (không phát
      // vào room) và phạm vi người được liệt kê do tầng realtime gác
      // theo quan hệ hội thoại chung (xem listOnlineCoMemberIds).
      // Phát SAU markConnected để presence của chính người nối đã
      // được ghi trước khi đọc (dù chủ thể tự loại khỏi danh sách).
      const onlineCoMemberIds = await this.realtime.listOnlineCoMemberIds(identity.userId);
      client.emit(MESSAGING_SOCKET_EVENTS.presenceSnapshot, { onlineUserIds: onlineCoMemberIds });
    } catch (error) {
      this.logger.warn(`Kết nối realtime của messaging bị ngắt do lỗi: ${(error as Error).message}`);
      client.disconnect(true);
    } finally {
      resolveAuth();
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const userId = client.data.userId as string | undefined;
    const tenantId = (client.data.tenantId as string | null | undefined) ?? null;
    if (userId) await this.realtime.markDisconnected(tenantId, userId, client.id);
  }

  /**
   * Hội thoại 1–1 đang có quan hệ chặn (bất kỳ chiều nào) thì đối
   * với user này nó KHÔNG TỒN TẠI ở mọi bề mặt realtime theo id —
   * cùng luật với cổng đọc REST ở tầng service (việc nối tiếp của
   * issue #33): `sync` không trả lịch sử, `join` room bị từ chối,
   * `typing` không chuyển tiếp. Hội thoại nhóm không bị chạm.
   */
  /**
   * @param blockedIdsSource - Nguồn danh sách chặn dùng thay cho tra
   *   trực tiếp: `handleConnection` truyền vào một hàm tải-lười-một-
   *   lần để cả vòng lặp vào room dùng chung đúng một lượt tra; các
   *   đường theo-từng-sự-kiện (join/sync/typing) không truyền thì tra
   *   trực tiếp như cũ.
   */
  private async isBlockedDirectConversation(
    conversationId: string,
    userId: string,
    blockedIdsSource?: () => Promise<string[]>,
  ): Promise<boolean> {
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation || conversation.type !== 1) return false;
    const members = await this.repo.listMembers(conversationId);
    const other = members.find((id) => id !== userId);
    if (!other) return false;
    const blockedIds = blockedIdsSource
      ? await blockedIdsSource()
      : await this.repo.listBlockedCounterpartIds(userId);
    return blockedIds.includes(other);
  }

  /**
   * Xin vào room của một conversation (vd conversation mới tạo khi
   * socket đã nối từ trước): server kiểm tra tư cách thành viên thật
   * ở DB, không tin claim của client. Đồng bộ thành viên group chạy ở
   * các đường REST/service — nếu chưa là thành viên conversation thì
   * yêu cầu bị từ chối êm (trả joined=false), client vẫn nhận tin qua
   * room riêng theo user khi mở conversation bằng REST.
   */
  @SubscribeMessage(MESSAGING_SOCKET_EVENTS.joinConversation)
  async joinConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId?: unknown },
  ): Promise<{ joined: boolean }> {
    const userId = await awaitConnectionUser(client);
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : null;
    if (!userId || !conversationId) return { joined: false };
    if (!(await this.repo.isMember(conversationId, userId))) return { joined: false };
    if (await this.isBlockedDirectConversation(conversationId, userId)) return { joined: false };
    const conversation = await this.repo.getConversation(conversationId);
    await client.join(conversationRoom(conversation?.tenantId ?? null, conversationId));
    return { joined: true };
  }

  /** Rời room của một conversation (giữ room riêng theo user). */
  @SubscribeMessage(MESSAGING_SOCKET_EVENTS.leaveConversation)
  async leaveConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId?: unknown },
  ): Promise<{ left: boolean }> {
    await awaitConnectionUser(client);
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : null;
    if (!conversationId) return { left: false };
    const conversation = await this.repo.getConversation(conversationId);
    await client.leave(conversationRoom(conversation?.tenantId ?? null, conversationId));
    return { left: true };
  }

  /**
   * Đồng bộ thiếu hụt khi nối lại: client gửi map conversationId →
   * seq cao nhất đã thấy; server trả (qua ack) các tin có seq lớn hơn
   * cho từng conversation mà user thật sự là thành viên. Đây là đường
   * bắt kịp chuẩn sau reconnect — Socket.IO tự nối lại, còn dữ liệu
   * thiếu trong thời gian mất nối được bù ở đây theo seq, không tải
   * lại toàn bộ lịch sử.
   */
  @SubscribeMessage(MESSAGING_SOCKET_EVENTS.sync)
  async sync(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: MessagingSyncRequest,
  ): Promise<MessagingSyncResult> {
    const userId = await awaitConnectionUser(client);
    const result: MessagingSyncResult = {};
    if (!userId || !body || typeof body !== 'object') return result;
    const entries = Object.entries(body).slice(0, SYNC_MAX_CONVERSATIONS);
    for (const [conversationId, lastSeq] of entries) {
      if (typeof lastSeq !== 'number' || !Number.isFinite(lastSeq) || lastSeq < 0) continue;
      if (!(await this.repo.isMember(conversationId, userId))) continue;
      // Hội thoại 1–1 đang chặn: bỏ qua êm như không phải thành viên
      // — không trả lịch sử, không join room (xem isBlockedDirectConversation).
      if (await this.isBlockedDirectConversation(conversationId, userId)) continue;
      // Nối vào room luôn thể: conversation tạo sau khi socket nối
      // (hoặc membership mới đồng bộ) thì từ nay nhận realtime trực tiếp.
      const conversation = await this.repo.getConversation(conversationId);
      await client.join(conversationRoom(conversation?.tenantId ?? null, conversationId));
      // Đồng bộ là đường đọc của CHÍNH người xin: lọc tin họ đã
      // xoá-phía-mình và vô hiệu nội dung tin đã thu hồi — cùng luật
      // với đường đọc REST, không để kênh này thành đường vòng lộ
      // nội dung (vòng đời tin nhắn theo vai, issue #33).
      const missing = await this.repo.listMessages(conversationId, {
        afterSeq: Math.floor(lastSeq),
        limit: SYNC_LIMIT_PER_CONVERSATION,
        viewerId: userId,
      });
      if (missing.length) {
        // Khối trích dẫn (lát M3) dựng theo ĐÚNG người xin đồng bộ —
        // cùng luật cá nhân hoá với đường đọc REST, kênh này không
        // thành đường vòng lộ nội dung của tin gốc đã xoá/thu hồi.
        const withQuotes = await this.repo.attachQuotes(missing, { privileged: false, viewerId: userId });
        result[conversationId] = withQuotes.map((row) => toWireMessage(blankRecalledContent(row), row.replyTo));
      }
    }
    return result;
  }

  /** Tín hiệu "đang nhập": chỉ chuyển tiếp cho thành viên của conversation, đã throttle ở tầng Redis. */
  @SubscribeMessage(MESSAGING_SOCKET_EVENTS.typing)
  async typing(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId?: unknown },
  ): Promise<{ ok: boolean }> {
    const userId = await awaitConnectionUser(client);
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : null;
    if (!userId || !conversationId) return { ok: false };
    if (!(await this.repo.isMember(conversationId, userId))) return { ok: false };
    if (await this.isBlockedDirectConversation(conversationId, userId)) return { ok: false };
    await this.realtime.noteTyping(conversationId, userId);
    return { ok: true };
  }
}

/**
 * Chờ xác thực lúc nối xong rồi mới trả userId: handler chạy trước khi
 * handleConnection hoàn tất sẽ thấy userId trống. Socket nối từ client
 * cũ (không có cờ này) thì trả ngay userId hiện có, giữ tương thích.
 */
async function awaitConnectionUser(client: Socket): Promise<string | undefined> {
  const settled = client.data.authSettled as Promise<void> | undefined;
  if (settled) await settled;
  return client.data.userId as string | undefined;
}

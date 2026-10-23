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
import { MessagingRepository } from './messaging.repository';
import { JwtMessagingSocketAuth } from './messaging-socket-auth';
import { conversationRoom, MessagingRealtimeService, toWireMessage, userRoom } from './messaging-realtime.service';

/** Số tin tối đa trả cho mỗi conversation trong một lần đồng bộ (client xin tiếp nếu còn thiếu). */
const SYNC_LIMIT_PER_CONVERSATION = 100;
/** Số conversation tối đa trong một payload đồng bộ. */
const SYNC_MAX_CONVERSATIONS = 50;

/**
 * Gateway realtime của messaging (issue #33, chặng A1) — Socket.IO,
 * namespace `/messaging`, chạy cùng HTTP server với REST.
 *
 * Xác thực handshake bằng access token đăng nhập hiện tại, qua lớp
 * mỏng {@link JwtMessagingSocketAuth} (điểm chạm duy nhất với cơ chế
 * auth — khi issue #7 đổi authn chỉ sửa lớp đó). Token lấy từ
 * `handshake.auth.token` (client chính thức) hoặc header
 * Authorization Bearer. Kết nối không xác thực được thì ngắt ngay.
 *
 * Khi nối, socket vào room riêng `user:<id>` và room của mọi
 * conversation mình là thành viên. Sự kiện tin mới/đã đọc KHÔNG phát
 * từ đây cũng không phát từ service ghi DB — chúng đi đường outbox →
 * {@link MessagingOutboxConsumer} → {@link MessagingRealtimeService}.
 * Gateway chỉ xử lý các tương tác theo kết nối: join/leave room,
 * `sync` (xin tin còn thiếu theo seq khi nối lại) và `typing`.
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
    private readonly auth: JwtMessagingSocketAuth,
    private readonly repo: MessagingRepository,
    private readonly realtime: MessagingRealtimeService,
  ) {}

  afterInit(server: Server): void {
    this.realtime.attachServer(server);
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = extractHandshakeToken(client);
      const identity = await this.auth.authenticate(token);
      if (!identity) {
        client.disconnect(true);
        return;
      }
      client.data.userId = identity.userId;
      client.data.username = identity.username;
      await client.join(userRoom(identity.userId));
      const conversations = await this.repo.listConversationsForUser(identity.userId);
      for (const conversation of conversations) {
        await client.join(conversationRoom(conversation.id));
      }
      await this.realtime.markConnected(identity.userId, client.id);
    } catch (error) {
      this.logger.warn(`Kết nối realtime của messaging bị ngắt do lỗi: ${(error as Error).message}`);
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const userId = client.data.userId as string | undefined;
    if (userId) await this.realtime.markDisconnected(userId, client.id);
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
    const userId = client.data.userId as string | undefined;
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : null;
    if (!userId || !conversationId) return { joined: false };
    if (!(await this.repo.isMember(conversationId, userId))) return { joined: false };
    await client.join(conversationRoom(conversationId));
    return { joined: true };
  }

  /** Rời room của một conversation (giữ room riêng theo user). */
  @SubscribeMessage(MESSAGING_SOCKET_EVENTS.leaveConversation)
  async leaveConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId?: unknown },
  ): Promise<{ left: boolean }> {
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : null;
    if (!conversationId) return { left: false };
    await client.leave(conversationRoom(conversationId));
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
    const userId = client.data.userId as string | undefined;
    const result: MessagingSyncResult = {};
    if (!userId || !body || typeof body !== 'object') return result;
    const entries = Object.entries(body).slice(0, SYNC_MAX_CONVERSATIONS);
    for (const [conversationId, lastSeq] of entries) {
      if (typeof lastSeq !== 'number' || !Number.isFinite(lastSeq) || lastSeq < 0) continue;
      if (!(await this.repo.isMember(conversationId, userId))) continue;
      // Nối vào room luôn thể: conversation tạo sau khi socket nối
      // (hoặc membership mới đồng bộ) thì từ nay nhận realtime trực tiếp.
      await client.join(conversationRoom(conversationId));
      const missing = await this.repo.listMessages(conversationId, { afterSeq: Math.floor(lastSeq), limit: SYNC_LIMIT_PER_CONVERSATION });
      if (missing.length) result[conversationId] = missing.map(toWireMessage);
    }
    return result;
  }

  /** Tín hiệu "đang nhập": chỉ chuyển tiếp cho thành viên của conversation, đã throttle ở tầng Redis. */
  @SubscribeMessage(MESSAGING_SOCKET_EVENTS.typing)
  async typing(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId?: unknown },
  ): Promise<{ ok: boolean }> {
    const userId = client.data.userId as string | undefined;
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : null;
    if (!userId || !conversationId) return { ok: false };
    if (!(await this.repo.isMember(conversationId, userId))) return { ok: false };
    await this.realtime.noteTyping(conversationId, userId);
    return { ok: true };
  }
}

/** Token từ handshake: ưu tiên `auth.token` (socket.io client chính thức), dự phòng header Bearer. */
function extractHandshakeToken(client: Socket): string | undefined {
  const authToken = (client.handshake.auth as { token?: unknown } | undefined)?.token;
  if (typeof authToken === 'string' && authToken.length > 0) return authToken;
  const header = client.handshake.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice('Bearer '.length);
  return undefined;
}

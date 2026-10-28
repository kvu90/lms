import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OutboxService } from '../../infra/events/outbox.service';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { SiteConfigService } from '../site-config/site-config.service';
import { UsersService } from '../users/users.service';
import { blankRecalledContent, MessagingRepository, searchExcerptOf, type ConversationRow, type MessageRow, type MessageWithQuoteRow, type ReportRow } from './messaging.repository';
import { MessagingSendThrottleService } from './messaging-send-throttle.service';
import { MessagingContactsService } from './messaging-contacts.service';
import { MessagingConversationsService } from './messaging-conversations.service';
import { MessagingMembershipSyncService } from './messaging-membership-sync.service';
import { MessagingNotificationsService } from './messaging-notifications.service';

/**
 * Đếm ký tự NGƯỜI DÙNG THẤY (grapheme cluster) của một đoạn văn bản —
 * cách đếm của trần độ dài tin (lát M2, issue #212): một emoji đơn,
 * một emoji ghép ZWJ (vd biểu tượng gia đình) hay một chữ cái kèm dấu
 * tổ hợp đều tính là MỘT ký tự, tuyệt đối không đếm byte UTF-8 hay đơn
 * vị UTF-16 (hai cách đếm đó phạt oan tiếng Việt và emoji nhiều lần).
 * `Intl.Segmenter` là API chuẩn của Node ≥ 16; môi trường thiếu nó thì
 * lùi về đếm theo code point Unicode ([...text]) — vẫn đúng hơn byte.
 */
export function countUserVisibleCharacters(text: string): number {
  const SegmenterCtor = (Intl as unknown as {
    Segmenter?: new (locales?: string, options?: { granularity: 'grapheme' }) => {
      segment(input: string): Iterable<unknown>;
    };
  }).Segmenter;
  if (SegmenterCtor) {
    const segmenter = new SegmenterCtor(undefined, { granularity: 'grapheme' });
    let count = 0;
    for (const _segment of segmenter.segment(text)) count += 1;
    return count;
  }
  return [...text].length;
}

/** Lỗi vi phạm ràng buộc duy nhất của Postgres (kể cả khi drizzle bọc lỗi gốc trong `cause`). */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Tin có còn nằm trong CỬA SỔ THU HỒI hay không (vòng đời tin nhắn
 * theo vai, issue #33): thuần hàm thời gian để kiểm chứng đơn vị
 * tách khỏi DB — `windowMinutes <= 0` nghĩa là thu hồi đã TẮT (không
 * tin nào thu hồi được, kể cả tin vừa gửi); mốc biên ĐÚNG bằng cửa
 * sổ vẫn được tính là trong cửa sổ.
 */
export function isWithinRecallWindow(createdAt: Date, now: Date, windowMinutes: number): boolean {
  if (windowMinutes <= 0) return false;
  return now.getTime() - createdAt.getTime() <= windowMinutes * 60_000;
}

/**
 * TIN NHẮN + KIỂM DUYỆT của MessagingModule (cụm ca sử dụng
 * "tin nhắn/kiểm duyệt").
 *
 * Luồng nghiệp vụ: sau khi gửi, quyền sở hữu của một MESSAGE chuyển
 * cho hệ thống — không endpoint nào sửa nội dung tin; vòng đời tin
 * theo vai (issue #33) gồm ba lớp tách bạch: xoá-phía-mình (chỉ tác
 * giả, mọi lúc, chỉ ẩn khỏi tầm nhìn của chính người xoá), thu hồi
 * (chỉ tác giả, trong cửa sổ site-config, nội dung bị vô hiệu với
 * mọi thành viên thường nhưng còn truy vết kiểm duyệt) và xoá cứng/gỡ
 * hàng loạt (chỉ người có thẩm quyền kiểm duyệt trong phạm vi
 * conversation, lý do bắt buộc, luôn ghi moderator_action trước khi
 * xoá vật lý). Gửi tin qua cổng thành viên + cổng liên lạc (với hội
 * thoại 1-1) + trần độ dài đếm theo ký tự người dùng thấy + chống
 * spam theo người gửi (MessagingSendThrottleService); gửi trùng theo
 * clientMessageId là an toàn (idempotent). Báo cáo conversation vào
 * hàng đợi của giáo viên phụ trách khoá liên quan và quản trị viên,
 * kèm thông báo trong app ngay khi tạo.
 *
 * Các cổng thẩm quyền theo conversation (thành viên, kiểm duyệt,
 * quản lý, khoá/lớp liên quan) dùng lại của MessagingConversationsService
 * — cụm này không định nghĩa lại.
 *
 * Cách lắp ráp (issue #295): service này là một CỤM của MessagingModule,
 * tách từ MessagingService cũ theo cụm ca sử dụng — tách cấu trúc thuần,
 * không đổi hành vi. MessagingService nay là facade giữ nguyên bề mặt
 * công khai và chữ ký constructor, tự lắp ráp các service cụm trong
 * constructor của nó (các test đơn vị hiện hữu khởi tạo trực tiếp
 * `new MessagingService(...)` với đúng các phụ thuộc hạ tầng cũ nên
 * facade là điểm lắp ráp để giữ nguyên hợp đồng khởi tạo đó); các
 * service cụm không đăng ký provider riêng trong module và module
 * wiring giữ nguyên như trước khi tách.
 */
export class MessagingMessagesService {
  constructor(
    private readonly repo: MessagingRepository,
    private readonly users: UsersService,
    private readonly evaluator: PermissionEvaluator,
    private readonly contexts: ContextsService,
    private readonly outbox: OutboxService,
    private readonly siteConfig: SiteConfigService,
    private readonly sendThrottle: MessagingSendThrottleService,
    private readonly conversations: MessagingConversationsService,
    private readonly contacts: MessagingContactsService,
    private readonly notifications: MessagingNotificationsService,
    private readonly membershipSync: MessagingMembershipSyncService,
  ) {}

  /**
   * Một cửa sổ tin theo cursor seq của conversation (tải lịch sử cũ
   * bằng beforeSeq, đồng bộ phần thiếu bằng afterSeq) — đầu REST cho
   * phân trang/đồng bộ, cùng ngữ nghĩa cursor với kênh realtime.
   */
  async listConversationMessages(userId: string, conversationId: string, query: {
    beforeSeq?: number; afterSeq?: number; limit?: number;
  }): Promise<{ messages: MessageWithQuoteRow[]; hasMoreBefore: boolean }> {
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    await this.membershipSync.syncGroupConversationIfLinked(conversation);
    await this.conversations.assertConversationMember(userId, conversation);
    await this.conversations.assertDirectConversationVisible(userId, conversation);
    // Cùng luật tầm nhìn với getConversation: chỉ người có thẩm quyền
    // kiểm duyệt mới nhận được tin đã xoá mềm trong cửa sổ đồng bộ;
    // người xem thường bị lọc tin đã xoá-phía-mình và nhận nội dung
    // rỗng cho tin đã thu hồi.
    const canModerate = await this.conversations.canModerateConversation(userId, conversation);
    const rawMessages = await this.repo.listMessages(conversationId, {
      ...query,
      includeDeleted: canModerate,
      viewerId: canModerate ? undefined : userId,
    });
    // Khối trích dẫn (lát M3): cùng luật dựng với getConversation —
    // theo quyền của người xem trên tin gốc thô, độc lập với việc vô
    // hiệu nội dung thu hồi của chính cửa sổ này.
    const withQuotes = await this.repo.attachQuotes(rawMessages, {
      privileged: canModerate,
      viewerId: canModerate ? undefined : userId,
    });
    const messages = canModerate ? withQuotes : withQuotes.map((m) => ({ ...blankRecalledContent(m), replyTo: m.replyTo }));
    return {
      messages,
      hasMoreBefore: messages.length > 0 && query.afterSeq === undefined
        ? await this.repo.hasMessagesBefore(conversationId, messages[0]!.seq, canModerate, canModerate ? undefined : userId)
        : false,
    };
  }

  /**
   * Tìm nội dung tin TRONG một conversation (lát M4, issue #237):
   * cùng cổng với các đường đọc tin — chỉ thành viên, hội thoại 1–1
   * đang bị chặn hành xử như không tồn tại, người có thẩm quyền kiểm
   * duyệt tìm theo tầm nhìn truy vết. Kết quả mang excerpt quanh chỗ
   * khớp + seq để client nhảy tới đúng tin; kết quả chỉ chứa tin còn
   * hiển thị được với chính người tìm (luật chi tiết ở repository).
   * Truy vấn rỗng sau khi cắt khoảng trắng → 400 xác định
   * `messaging.search_query_empty` (schema route chỉ chặn chuỗi
   * rỗng hẳn; truy vấn toàn khoảng trắng lọt tới đây).
   */
  async searchConversationMessages(userId: string, conversationId: string, query: {
    q: string; limit?: number;
  }): Promise<{ results: { id: string; conversationId: string; userIdFrom: string; seq: number; excerpt: string; createdAt: Date }[] }> {
    const q = query.q.trim();
    if (q.length === 0) {
      throw new BadRequestException({ message: 'Search query must not be empty', code: 'messaging.search_query_empty' });
    }
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    await this.membershipSync.syncGroupConversationIfLinked(conversation);
    await this.conversations.assertConversationMember(userId, conversation);
    await this.conversations.assertDirectConversationVisible(userId, conversation);
    const canModerate = await this.conversations.canModerateConversation(userId, conversation);
    const rows = await this.repo.searchMessages(conversationId, {
      query: q,
      limit: query.limit,
      privileged: canModerate,
      viewerId: canModerate ? undefined : userId,
      excludedAuthorIds: canModerate ? undefined : await this.repo.listBlockedCounterpartIds(userId),
    });
    return {
      results: rows.map((row) => ({
        id: row.id,
        conversationId: row.conversationId,
        userIdFrom: row.userIdFrom,
        seq: row.seq,
        excerpt: searchExcerptOf(row.fullMessage, q),
        createdAt: row.createdAt,
      })),
    };
  }

  /**
   * Gửi một message user-tới-user. Luật phân phối (report §2#12): mọi thành viên khác
   * phải liên lạc được — không bị suspended, và không được đã chặn
   * người gửi. Khi đã lưu, message bất biến qua API.
   */
  /**
   * Gửi tin nhắn: kiểm tra thành viên và quan hệ chặn. Nếu client kèm
   * `clientMessageId` (gửi lạc quan/thử lại), lần gửi trùng khoá trả
   * chính tin đã lưu — không tạo tin thứ hai, không phát sự kiện mới.
   * Tin mới nhận seq đơn điệu của conversation trong cùng transaction
   * với outbox `message_sent`; realtime đến client qua consumer của
   * outbox, service KHÔNG tự phát socket.
   */
  async sendMessage(actorId: string, conversationId: string, input: { text: string; subject?: string; clientMessageId?: string; replyToMessageId?: string }): Promise<MessageWithQuoteRow> {
    const systemCtx = await this.contexts.ensureSystemContext();
    const senderCtx = await this.contexts.getByLevelInstance(30, actorId);
    await this.evaluator.requireCapability(actorId, 'site:sendmessage', senderCtx?.id ?? systemCtx.id);
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    // Conversation gắn group: đồng bộ thành viên theo group trước khi kiểm
    // tra tư cách thành viên (người mới vào group gửi được ngay, người rời
    // group bị chặn ở kiểm tra ngay dưới đây).
    await this.membershipSync.syncGroupConversationIfLinked(conversation);
    await this.conversations.assertConversationMember(actorId, conversation);
    // Cột `enabled` phải được tôn trọng THẬT ở đường gửi (Lớp B):
    // giáo viên tắt chat của nhóm lớp thì thành viên thường dừng gửi
    // tại đây; người có thẩm quyền quản lý vẫn gửi được — đó là đường
    // thông báo một chiều của giáo viên khi lớp đã tắt chat.
    if (!conversation.enabled && !(await this.conversations.canManageConversation(actorId, conversation))) {
      throw new ForbiddenException({
        message: 'Chat is disabled for this conversation',
        code: 'messaging.conversation_disabled',
      });
    }
    const members = await this.repo.listMembers(conversationId);
    for (const memberId of members) {
      if (memberId === actorId) continue;
      const recipient = await this.users.getByIdOrUndefined(memberId);
      if (!recipient || recipient.suspended || recipient.deleted) {
        throw new ForbiddenException({ message: `User ${memberId} cannot receive messages (suspended)`, code: 'messaging.recipient_suspended' });
      }
      if (await this.repo.isBlocked(memberId, actorId)) {
        throw new ForbiddenException({ message: `User ${memberId} has blocked you`, code: 'messaging.contact_blocked' });
      }
    }
    // Cổng liên lạc chỉ áp cho conversation cá nhân (type 1): kiểm ở
    // MỖI lần gửi — hội thoại riêng có từ trước khi hai người thành
    // liên hệ (hoặc sau khi gỡ liên hệ) vẫn đọc được lịch sử nhưng gửi
    // mới bị chặn tới khi quan hệ được (tái) lập; conversation nhóm
    // thì thành viên gửi tự do. Kiểm sau luật suspended/blocked để
    // giữ nguyên mã lỗi đã có của hai luật đó.
    if (conversation.type === 1) {
      const other = members.find((id) => id !== actorId);
      if (other) {
        // Chiều chặn còn lại: chính người gửi đã chặn người nhận thì
        // cũng không gửi được (phải bỏ chặn trước) — vòng lặp phía
        // trên mới chỉ bắt chiều người nhận chặn người gửi.
        if (await this.repo.isBlocked(actorId, other)) {
          throw new ForbiddenException({ message: 'You have blocked this user', code: 'messaging.contact_blocked' });
        }
        await this.contacts.assertCanContact(actorId, other);
      }
    }
    // Kết quả trả về luôn mang khối trích dẫn đã dựng cho chính
    // người gửi (lát M3): client thay bản lạc quan bằng bản thật mà
    // không phải tải lại cửa sổ.
    const withQuote = async (row: MessageRow): Promise<MessageWithQuoteRow> =>
      (await this.repo.attachQuotes([row], { privileged: false, viewerId: actorId }))[0]!;
    if (input.clientMessageId) {
      const existing = await this.repo.getMessageByClientId(conversationId, actorId, input.clientMessageId);
      if (existing) return withQuote(existing);
    }
    // Gác TRÍCH DẪN (lát M3, issue #229): tin gốc phải thuộc ĐÚNG
    // conversation đang gửi. Tin không tồn tại và tin của conversation
    // khác nhận CÙNG một 400 — không lộ tồn tại tin của hội thoại
    // khác. Đặt trước cổng độ dài/throttle như mọi lỗi nội dung: yêu
    // cầu sai không đốt quota gửi. Phần trích dẫn KHÔNG tính vào
    // trần độ dài (chỉ `text` bị đếm ở assertMessageLengthAllowed).
    if (input.replyToMessageId) {
      const original = await this.repo.getMessage(input.replyToMessageId);
      if (!original || original.conversationId !== conversationId) {
        throw new BadRequestException({
          message: 'Quoted message not found in this conversation',
          code: 'messaging.reply_target_not_found',
        });
      }
    }
    // Chặn lạm dụng đường gửi (lát M2, issue #212) — đặt SAU điểm trả
    // trùng clientMessageId và sau mọi cổng tư cách/liên lạc: lượt gửi
    // lại của tin đã nhận không tốn quota throttle, tin bị từ chối ở
    // cổng trước cũng không; thứ tự hai cổng là độ dài TRƯỚC (400,
    // lỗi nội dung không đốt quota) rồi mới throttle (429).
    await this.assertMessageLengthAllowed(input.text);
    await this.sendThrottle.consume(actorId);
    try {
      const saved = await this.repo.dbHandle.transaction(async (tx) => {
        const seq = await this.repo.allocateNextSeq(conversationId, tx);
        const msg = await this.repo.insertMessage({
          conversationId: conversationId, userIdFrom: actorId,
          subject: input.subject ?? '', fullMessage: input.text, smallMessage: input.text.slice(0, 200),
          seq, clientMessageId: input.clientMessageId ?? null,
          replyToMessageId: input.replyToMessageId ?? null,
        }, tx);
        // Lát M5: tin mới làm hội thoại ĐÃ LƯU của các thành viên còn
        // lại tự hiện lại (bỏ lưu trong cùng transaction — xem
        // clearArchivedForIncomingMessage ở repository).
        await this.repo.clearArchivedForIncomingMessage(conversationId, actorId, tx);
        await this.outbox.enqueue(tx, {
          aggregate: 'messaging', type: 'message_sent',
          payload: {
            conversationId, messageId: msg.id, seq, fromUserId: actorId,
            memberIds: members, clientMessageId: input.clientMessageId ?? null,
            replyToMessageId: input.replyToMessageId ?? null,
          },
        });
        return msg;
      });
      return await withQuote(saved);
    } catch (err) {
      // Hai lần gửi trùng khoá chạy đồng thời: một lần thắng ở ràng buộc
      // duy nhất, lần còn lại nhận lỗi 23505 sau khi transaction đã huỷ —
      // đọc lại tin thắng và trả như một lần gửi thành công.
      if (input.clientMessageId && isUniqueViolation(err)) {
        const existing = await this.repo.getMessageByClientId(conversationId, actorId, input.clientMessageId);
        if (existing) return withQuote(existing);
      }
      throw err;
    }
  }

  /**
   * Sửa tin nhắn vẫn bị từ chối (chính sách đã chốt chỉ nới XOÁ, theo
   * mô hình xoá mềm có truy vết — sửa nội dung tin đã gửi không nằm
   * trong chính sách).
   */
  /**
   * Sửa tin nhắn của chính mình.
   */
  async updateMessage(): Promise<never> {
    throw new ForbiddenException({
      message: 'A sent message cannot be modified: ownership passed to core_message when it was sent',
      code: 'messaging.message_immutable',
    });
  }

  // --- vòng đời tin nhắn theo vai (issue #33, bổ sung PR #94) ---------------
  //
  // Ba lớp thao tác, tách bạch theo vai — thay mô hình xoá mềm toàn
  // cục cũ (một lần DELETE là tin biến mất với mọi người):
  //   (a) XOÁ-PHÍA-MÌNH (DELETE /messages/:id): chỉ TÁC GIẢ, mọi lúc
  //       không điều kiện cửa sổ — đặt cờ cá nhân
  //       `message_user_deletions`, tin chỉ ẩn khỏi tầm nhìn của
  //       chính người xoá; phía kia và đường truy vết không đổi.
  //   (b) THU HỒI (POST /messages/:id/recall): chỉ TÁC GIẢ, chỉ
  //       trong cửa sổ site-config `core/messagingrecallwindowminutes`
  //       (mặc định 15 phút từ lúc gửi) — nội dung bị vô hiệu với
  //       mọi thành viên thường, ghi dấu moderator_action 'recall'.
  //       Ngoài cửa sổ người thường không còn thao tác này.
  //   (c) XOÁ CỨNG / GỠ HÀNG LOẠT (POST /messages/:id/hard-delete,
  //       POST /messages/bulk-remove): chỉ người có capability
  //       `moderation:manage` trong phạm vi conversation, không
  //       giới hạn thời gian, lý do BẮT BUỘC và luôn ghi
  //       moderator_action trước khi dòng tin bị xoá vật lý.
  // Cổng chặn hội thoại 1–1 (assertDirectConversationVisible) vẫn đặt
  // TRƯỚC (a) và (b) như mọi đường theo id của người dùng thường;
  // đường (c) là đường kiểm duyệt có thẩm quyền riêng — như đường
  // xem báo cáo — nên KHÔNG qua cổng chặn: kiểm duyệt phải xử lý
  // được cả nội dung trong hội thoại đang bị chặn.

  /**
   * Cổng trần độ dài tin (lát M2, issue #212; chính sách P2 ở #33):
   * trần đọc từ site-config `core/messagingmaxmessagelength` (mặc
   * định 10.000 theo registry; 0 = tắt trần), đếm theo ký tự người
   * dùng thấy qua {@link countUserVisibleCharacters}. Vượt trần →
   * 400 `messaging.message_too_long`. Chỉ áp cho đường gửi tin của
   * người dùng (`sendMessage`) — tin hệ thống qua `notify()` không
   * qua cổng này.
   */
  private async assertMessageLengthAllowed(text: string): Promise<void> {
    const value = await this.siteConfig.getValue<number>('core', 'messagingmaxmessagelength');
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    const max = Math.floor(value);
    if (max <= 0) return;
    const count = countUserVisibleCharacters(text);
    if (count > max) {
      throw new BadRequestException({
        message: `Message is too long: ${count} characters (maximum ${max})`,
        code: 'messaging.message_too_long',
      });
    }
  }

  /** Cửa sổ thu hồi hiện hành (phút) đọc từ site-config; giá trị lỗi/thiếu → mặc định 15. */
  private async recallWindowMinutes(): Promise<number> {
    const value = await this.siteConfig.getValue<number>('core', 'messagingrecallwindowminutes');
    if (typeof value !== 'number' || !Number.isFinite(value)) return 15;
    return Math.max(0, Math.floor(value));
  }

  /**
   * Cổng thẩm quyền XOÁ CỨNG: phải có thẩm quyền kiểm duyệt TRÊN
   * conversation (staff khoá/quản trị — canModerateConversation) VÀ
   * capability `moderation:manage` tại context khoá của conversation.
   * Conversation CẤP LỚP đi cùng khuôn tại context lớp (MSG-T2).
   * Conversation không thuộc khoá/lớp nào thì chỉ quản trị viên toàn
   * site qua được (canModerate đã là admin-only ở trường hợp đó và
   * evaluator cho admin qua mọi kiểm tra capability).
   */
  private async assertCanHardDelete(actorId: string, conversation: ConversationRow): Promise<void> {
    const forbidden = () => new ForbiddenException({
      message: 'Only a moderator with the moderation:manage capability in this conversation scope can permanently remove messages',
      code: 'messaging.message_moderation_forbidden',
    });
    if (!(await this.conversations.canModerateConversation(actorId, conversation))) throw forbidden();
    const courseId = await this.conversations.resolveConversationCourseId(conversation);
    if (!courseId) {
      // Conversation CẤP LỚP: cùng khuôn ở context lớp (lát MSG-T2).
      const classId = await this.conversations.resolveConversationClassId(conversation);
      if (classId) {
        const classCtx = await this.contexts.getByLevelInstance(45, classId);
        const allowedClass = classCtx
          ? await this.evaluator.hasCapability(actorId, 'moderation:manage', classCtx.id)
          : await this.evaluator.isSiteAdmin(actorId);
        if (!allowedClass) throw forbidden();
        return;
      }
      if (!(await this.evaluator.isSiteAdmin(actorId))) throw forbidden();
      return;
    }
    const courseCtx = await this.contexts.getByLevelInstance(50, courseId);
    const allowed = courseCtx
      ? await this.evaluator.hasCapability(actorId, 'moderation:manage', courseCtx.id)
      : await this.evaluator.isSiteAdmin(actorId);
    if (!allowed) throw forbidden();
  }

  /**
   * Lớp (a) — XOÁ-PHÍA-MÌNH: tác giả ẩn tin của chính mình khỏi tầm
   * nhìn của mình, mọi lúc. KHÔNG đổi dòng tin, KHÔNG ảnh hưởng phía
   * kia; sự kiện `message_deleted_for_me` chỉ phân phối tới CHÍNH
   * người xoá (đồng bộ các thiết bị của họ). Người không phải tác
   * giả → 403 (kể cả moderator: gỡ cho mọi người là việc của lớp
   * (c), không mượn đường này). Idempotent: xoá lại là no-op 200.
   */
  async deleteMessage(actorId: string, messageId: string): Promise<MessageRow> {
    const existing = await this.repo.getMessage(messageId);
    if (!existing) throw new NotFoundException({ message: `Message ${messageId} not found`, code: 'messaging.message_not_found' });
    const conversation = await this.repo.getConversation(existing.conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${existing.conversationId} not found`, code: 'messaging.conversation_not_found' });
    await this.membershipSync.syncGroupConversationIfLinked(conversation);
    // Cổng hiển thị khi chặn (việc nối tiếp #33, siết sau PR #94):
    // hội thoại 1–1 đang chặn hành xử như KHÔNG TỒN TẠI ở mọi đường
    // theo id — kể cả xoá-phía-mình. Đặt TRƯỚC kiểm tra tác giả để
    // phía bị chặn nhận 404 thay vì 403 và không sự kiện nào phát ra.
    await this.conversations.assertDirectConversationVisible(actorId, conversation);
    if (existing.userIdFrom !== actorId) {
      throw new ForbiddenException({
        message: 'Only the author can delete this message for themselves; permanent removal belongs to moderators',
        code: 'messaging.message_delete_forbidden',
      });
    }
    // Tin đã bị xoá mềm toàn cục (dữ liệu từ mô hình cũ): không còn
    // hiển thị với ai — không còn gì để ẩn thêm, trả nguyên trạng.
    if (existing.deletedAt) return existing;
    if (!(await this.repo.isDeletedForUser(messageId, actorId))) {
      await this.repo.markDeletedForUser(messageId, actorId);
      const courseId = await this.conversations.resolveConversationCourseId(conversation);
      await this.outbox.enqueueStandalone({
        aggregate: 'messaging', type: 'message_deleted_for_me',
        payload: {
          actorId, conversationId: conversation.id, messageId, seq: existing.seq,
          authorId: existing.userIdFrom, courseId: courseId ?? undefined,
        },
      });
    }
    return existing;
  }

  /**
   * Lớp (b) — THU HỒI cho mọi người: chỉ tác giả, chỉ trong cửa sổ
   * cấu hình kể từ lúc gửi. Thu hồi thành công: set dấu
   * `recalled_at`/`recalled_by`, ghi moderator_action 'recall'
   * TRƯỚC khi đổi trạng thái, phát `message_recalled` (phía kia gỡ
   * nội dung + vô hiệu cache danh sách). Ngoài cửa sổ → 403
   * `messaging.recall_window_expired` — người thường chỉ còn lớp
   * (a). Thu hồi lại tin đã thu hồi là idempotent (giữ dấu đầu).
   */
  async recallMessage(actorId: string, messageId: string): Promise<MessageRow> {
    const existing = await this.repo.getMessage(messageId);
    if (!existing) throw new NotFoundException({ message: `Message ${messageId} not found`, code: 'messaging.message_not_found' });
    const conversation = await this.repo.getConversation(existing.conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${existing.conversationId} not found`, code: 'messaging.conversation_not_found' });
    await this.membershipSync.syncGroupConversationIfLinked(conversation);
    // Cùng cổng chặn như lớp (a): đang chặn thì hội thoại như không
    // tồn tại — không thu hồi được và không phát sự kiện nào.
    await this.conversations.assertDirectConversationVisible(actorId, conversation);
    if (existing.userIdFrom !== actorId) {
      throw new ForbiddenException({
        message: 'Only the author can recall this message',
        code: 'messaging.message_recall_forbidden',
      });
    }
    if (existing.recalledAt) return existing;
    if (existing.deletedAt) {
      throw new BadRequestException({
        message: 'This message is already deleted and can no longer be recalled',
        code: 'messaging.message_already_deleted',
      });
    }
    const windowMinutes = await this.recallWindowMinutes();
    if (!isWithinRecallWindow(existing.createdAt, new Date(), windowMinutes)) {
      throw new ForbiddenException({
        message: `The recall window of ${windowMinutes} minutes has expired for this message`,
        code: 'messaging.recall_window_expired',
      });
    }
    await this.repo.insertModeratorAction({
      messageId, conversationId: conversation.id, actorId, authorId: existing.userIdFrom,
      action: 'recall', reason: null, messageSeq: existing.seq,
    });
    const recalled = await this.repo.applyRecall(messageId, actorId);
    const courseId = await this.conversations.resolveConversationCourseId(conversation);
    await this.outbox.enqueueStandalone({
      aggregate: 'messaging', type: 'message_recalled',
      payload: {
        actorId, conversationId: conversation.id, messageId, seq: existing.seq,
        recalledBy: actorId, authorId: existing.userIdFrom, courseId: courseId ?? undefined,
      },
    });
    return recalled!;
  }

  /**
   * Lớp (c) — XOÁ CỨNG một tin: chỉ moderator có `moderation:manage`
   * trong phạm vi, lý do bắt buộc (chốt ở DTO), không giới hạn thời
   * gian. Dấu vết moderator_action ghi TRƯỚC, dòng tin xoá vật lý
   * SAU — sau thao tác này nội dung không còn ở bất kỳ đường đọc
   * nào, kể cả truy vết; căn cứ duy nhất còn lại là dòng hành động.
   */
  async hardDeleteMessage(actorId: string, messageId: string, input: { reason: string }): Promise<{ deleted: true; messageId: string; conversationId: string }> {
    const existing = await this.repo.getMessage(messageId);
    if (!existing) throw new NotFoundException({ message: `Message ${messageId} not found`, code: 'messaging.message_not_found' });
    const conversation = await this.repo.getConversation(existing.conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${existing.conversationId} not found`, code: 'messaging.conversation_not_found' });
    await this.membershipSync.syncGroupConversationIfLinked(conversation);
    await this.assertCanHardDelete(actorId, conversation);
    await this.repo.insertModeratorAction({
      messageId, conversationId: conversation.id, actorId, authorId: existing.userIdFrom,
      action: 'hard_delete', reason: input.reason, messageSeq: existing.seq,
    });
    await this.repo.hardDeleteMessage(messageId);
    const courseId = await this.conversations.resolveConversationCourseId(conversation);
    await this.outbox.enqueueStandalone({
      aggregate: 'messaging', type: 'message_removed',
      payload: {
        actorId, conversationId: conversation.id, messageId, seq: existing.seq,
        removedBy: actorId, authorId: existing.userIdFrom, courseId: courseId ?? undefined,
      },
    });
    return { deleted: true, messageId, conversationId: conversation.id };
  }

  /**
   * Lớp (c) — GỠ HÀNG LOẠT: cùng cổng thẩm quyền và lý do bắt buộc
   * như xoá cứng một tin. Toàn bộ danh sách được kiểm tra (tồn tại +
   * thẩm quyền trên TỪNG conversation liên quan) TRƯỚC khi bất kỳ
   * tin nào bị gỡ — một tin hỏng là cả yêu cầu bị từ chối, không gỡ
   * một phần. Mỗi tin một dòng moderator_action 'bulk_hard_delete'
   * và một sự kiện `message_removed` riêng.
   */
  async bulkRemoveMessages(actorId: string, input: { messageIds: string[]; reason: string }): Promise<{ removed: number; messageIds: string[] }> {
    const uniqueIds = [...new Set(input.messageIds)];
    const rows = await this.repo.getMessagesByIds(uniqueIds);
    if (rows.length !== uniqueIds.length) {
      throw new NotFoundException({ message: 'One or more messages were not found', code: 'messaging.message_not_found' });
    }
    const conversations = new Map<string, ConversationRow>();
    for (const row of rows) {
      let conversation = conversations.get(row.conversationId);
      if (!conversation) {
        conversation = (await this.repo.getConversation(row.conversationId)) ?? undefined;
        if (!conversation) throw new NotFoundException({ message: `Conversation ${row.conversationId} not found`, code: 'messaging.conversation_not_found' });
        await this.membershipSync.syncGroupConversationIfLinked(conversation);
        conversations.set(row.conversationId, conversation);
      }
      await this.assertCanHardDelete(actorId, conversation);
    }
    for (const row of rows) {
      await this.repo.insertModeratorAction({
        messageId: row.id, conversationId: row.conversationId, actorId, authorId: row.userIdFrom,
        action: 'bulk_hard_delete', reason: input.reason, messageSeq: row.seq,
      });
    }
    for (const row of rows) {
      await this.repo.hardDeleteMessage(row.id);
    }
    for (const row of rows) {
      const conversation = conversations.get(row.conversationId)!;
      const courseId = await this.conversations.resolveConversationCourseId(conversation);
      await this.outbox.enqueueStandalone({
        aggregate: 'messaging', type: 'message_removed',
        payload: {
          actorId, conversationId: row.conversationId, messageId: row.id, seq: row.seq,
          removedBy: actorId, authorId: row.userIdFrom, bulk: true, courseId: courseId ?? undefined,
        },
      });
    }
    return { removed: rows.length, messageIds: rows.map((row) => row.id) };
  }

  // --- báo cáo conversation (Lớp B) -------------------------------------------

  /**
   * Báo cáo một conversation: chỉ THÀNH VIÊN của conversation báo cáo
   * được. Báo cáo vào hàng đợi của giáo viên phụ trách lớp/khoá liên
   * quan + quản trị viên toàn site — hai tập này nhận notification
   * trong ứng dụng ngay khi báo cáo được tạo (trừ chính người báo cáo
   * nếu họ thuộc hai tập đó). Việc XEM lại nội dung đi đường riêng có
   * ghi vết ({@link getReportConversation}).
   */
  async reportConversation(actorId: string, conversationId: string, reason?: string): Promise<ReportRow> {
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    await this.membershipSync.syncGroupConversationIfLinked(conversation);
    await this.conversations.assertConversationMember(actorId, conversation);
    const report = await this.repo.insertReport({
      conversationId, reporterId: actorId, reason: (reason ?? '').trim(),
    });
    const courseId = await this.conversations.resolveConversationCourseId(conversation);
    await this.outbox.enqueueStandalone({
      aggregate: 'messaging', type: 'message_conversation_reported',
      payload: { actorId, conversationId, reportId: report.id, courseId: courseId ?? undefined },
    });
    const recipients = new Set<string>(await this.evaluator.listSiteAdmins());
    if (courseId) {
      for (const staffId of await this.repo.listCourseStaffUserIds(courseId)) recipients.add(staffId);
    }
    recipients.delete(actorId);
    for (const recipientId of recipients) {
      await this.notifications.notify(recipientId, 'conversation_reported', {
        subject: 'A conversation was reported',
        body: 'A conversation was reported and is waiting in the moderation queue. Open the reports list in Messages to review it.',
        fromUserId: actorId,
        // Nguồn của thông báo là khoá của conversation bị báo cáo
        // (NB-4): người nhận đã tắt tiếng khoá đó thì ghi đè theo
        // khoá áp dụng như mọi thông báo gắn khoá khác.
        courseId: courseId ?? undefined,
      }).catch(() => undefined);
    }
    return report;
  }

  /**
   * Hàng đợi báo cáo TRONG THẨM QUYỀN của người gọi: quản trị viên
   * thấy tất cả; giáo viên chỉ thấy báo cáo của các conversation thuộc
   * khoá mình phụ trách; người khác thấy danh sách rỗng. Quyền xem
   * theo từng conversation được chốt tại đây (không tin client).
   */
  async listReports(actorId: string): Promise<ReportRow[]> {
    const reports = await this.repo.listReports();
    const admin = await this.evaluator.isSiteAdmin(actorId);
    if (admin) return reports;
    const cache = new Map<string, boolean>();
    const out: ReportRow[] = [];
    for (const report of reports) {
      let allowed = cache.get(report.conversationId);
      if (allowed === undefined) {
        const conversation = await this.repo.getConversation(report.conversationId);
        allowed = conversation ? await this.conversations.canModerateConversation(actorId, conversation) : false;
        cache.set(report.conversationId, allowed);
      }
      if (allowed) out.push(report);
    }
    return out;
  }

  /**
   * Xem lại nội dung của ĐÚNG conversation bị báo cáo — đường truy vết
   * có thẩm quyền của Lớp B: chỉ quản trị viên hoặc giáo viên phụ trách
   * khoá của conversation đó. Nội dung trả về GỒM cả tin đã xoá mềm
   * (mục đích của việc xem lại là truy vết). MỌI lần xem đều ghi một
   * sự kiện outbox `message_conversation_report_viewed` — relay của
   * logstore (issue #22) phản chiếu nó vào event_log với actor là
   * người xem, object là conversation, kèm id báo cáo làm căn cứ.
   */
  async getReportConversation(actorId: string, reportId: string): Promise<{
    report: ReportRow;
    conversation: ConversationRow & { members: string[]; messages: MessageRow[] };
  }> {
    const report = await this.repo.getReport(reportId);
    if (!report) throw new NotFoundException({ message: `Report ${reportId} not found`, code: 'messaging.report_not_found' });
    const conversation = await this.repo.getConversation(report.conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${report.conversationId} not found`, code: 'messaging.conversation_not_found' });
    if (!(await this.conversations.canModerateConversation(actorId, conversation))) {
      throw new ForbiddenException({
        message: 'Only an administrator or the teacher in charge of this conversation\'s course can review a reported conversation',
        code: 'messaging.report_review_forbidden',
      });
    }
    const courseId = await this.conversations.resolveConversationCourseId(conversation);
    await this.outbox.enqueueStandalone({
      aggregate: 'messaging', type: 'message_conversation_report_viewed',
      payload: { actorId, conversationId: conversation.id, reportId: report.id, courseId: courseId ?? undefined },
    });
    const messages = await this.repo.listMessages(conversation.id, { limit: 100, includeDeleted: true });
    return {
      report,
      conversation: {
        ...conversation,
        members: await this.repo.listMembers(conversation.id),
        messages,
      },
    };
  }

  /**
   * Đổi trạng thái xử lý của một báo cáo (open/resolved/dismissed) —
   * cùng phạm vi thẩm quyền với đường xem lại nội dung.
   */
  async updateReportStatus(actorId: string, reportId: string, status: string): Promise<ReportRow> {
    const report = await this.repo.getReport(reportId);
    if (!report) throw new NotFoundException({ message: `Report ${reportId} not found`, code: 'messaging.report_not_found' });
    const conversation = await this.repo.getConversation(report.conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${report.conversationId} not found`, code: 'messaging.conversation_not_found' });
    if (!(await this.conversations.canModerateConversation(actorId, conversation))) {
      throw new ForbiddenException({
        message: 'Only an administrator or the teacher in charge of this conversation\'s course can handle its reports',
        code: 'messaging.report_review_forbidden',
      });
    }
    const updated = await this.repo.updateReportStatus(reportId, status, actorId);
    return updated!;
  }

  /**
   * Đánh dấu đã đọc conversation: chỉ nâng mốc đã đọc của CHÍNH user
   * này (thành viên khác giữ nguyên số chưa đọc của họ). Mốc tăng thì
   * ghi outbox `message_conversation_read` để consumer phân phối biên
   * đã-đọc ("đã xem tới seq N") cho các thành viên còn lại.
   */
  async markConversationRead(userId: string, conversationId: string): Promise<{ marked: number; lastReadSeq: number }> {
    const conversation = await this.repo.getConversation(conversationId);
    if (conversation) {
      // Cổng thành viên (conversation cấp khoá → 404 với người ngoài)
      // + cùng cổng chặn với đường đọc: hội thoại 1–1 đang chặn thì
      // đánh dấu đã đọc cũng 404 như không tồn tại — không phát biên
      // đã-đọc cho phía bên kia qua outbox.
      await this.conversations.assertConversationMember(userId, conversation);
      await this.conversations.assertDirectConversationVisible(userId, conversation);
    } else if (!(await this.repo.isMember(conversationId, userId))) {
      throw new ForbiddenException({ message: 'You are not a member of this conversation', code: 'messaging.not_member' });
    }
    const before = (await this.repo.getMemberLastReadSeq(conversationId, userId)) ?? 0;
    const result = await this.repo.markConversationRead(conversationId, userId);
    if (result.lastReadSeq > before) {
      await this.outbox.enqueueStandalone({
        aggregate: 'messaging', type: 'message_conversation_read',
        payload: { conversationId, userId, lastReadSeq: result.lastReadSeq },
      });
    }
    return result;
  }

  /**
   * Số conversation chưa đọc và số notification chưa đọc (cho huy hiệu trên giao diện).
   */
  async unreadCounts(userId: string): Promise<{ conversations: number; notifications: number }> {
    return {
      conversations: await this.repo.countUnreadConversations(userId),
      notifications: await this.repo.countUnreadNotifications(userId),
    };
  }
}

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import '../i18n';
import { MESSAGING_MAX_MESSAGE_LENGTH_DEFAULT } from '@lms/contracts';
import { apiJson, ApiError } from '#lib/api';
import { useAuth } from '#lib/auth';
import { connectMessagingRealtime, type MessagingRealtimeHandle } from '#lib/messaging-socket';
import { queryKeys } from '#lib/query-keys';
import { ChatPanel } from '../components/messages/chat-panel';
import { ConversationSidebar } from '../components/messages/conversation-sidebar';
import type {
  ContactRelationship,
  ContactRequestView,
  ConversationDetailView,
  ConversationView,
  MessageView,
  MessagingCourse,
  PersonSummary,
  RosterMember,
} from '../components/messages/types';
import { countMessageCharacters, mergeMessages } from '../components/messages/utils';

/**
 * Messages: conversation list with unread count, message thread and
 * sending. Tin nhắn hiển thị/gửi theo mô hình mới (issue #33): seq
 * đơn điệu theo conversation là mốc phân trang/đồng bộ; gửi LẠC QUAN
 * với clientMessageId (server chống trùng — thử lại không nhân đôi);
 * tin mới/đã đọc đến qua WebSocket (sự kiện được server phân phối từ
 * outbox), huy hiệu chưa đọc cập nhật theo sự kiện thay vì tải lại
 * toàn bộ; mất nối thì khi nối lại trang xin phần thiếu theo seq.
 * Trang còn quản lý chặn liên lạc: chặn/bỏ chặn người đối thoại trong
 * cuộc trò chuyện đang mở và xem danh sách đã chặn
 * (GET/POST/DELETE /messages/contacts...). Deep-link
 * ?conversation=<id> (contextUrl của thông báo message_new, #49) mở
 * đúng cuộc trò chuyện khi trang nạp — việc nối tiếp của #33.
 */
export function MessagesPage() {
  const { t } = useTranslation('app');
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const myId = user?.id;
  const [conversations, setConversations] = useState<ConversationView[]>([]);
  /** Đã nạp xong danh sách conversation ít nhất một lần — mốc cho deep-link mở đúng cuộc trò chuyện. */
  const [listLoaded, setListLoaded] = useState(false);
  const [unread, setUnread] = useState(0);
  const [active, setActive] = useState<ConversationView | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [readMarkers, setReadMarkers] = useState<Record<string, number>>({});
  const [typingUsers, setTypingUsers] = useState<Record<string, boolean>>({});
  const [onlineUsers, setOnlineUsers] = useState<Record<string, boolean>>({});
  /**
   * Nháp soạn tin THEO TỪNG conversation (lát M1, issue #204): map
   * theo conversationId, giữ trong bộ nhớ trang — chuyển qua
   * conversation khác rồi quay lại vẫn còn nguyên nháp của conversation
   * đó; gửi thành công thì chỉ xoá nháp của đúng conversation đã gửi.
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [blockMessage, setBlockMessage] = useState<string | null>(null);
  // Lớp B (issue #33): danh bạ ĐÃ DUYỆT + hàng chờ kết bạn (đến/đi),
  // thay danh bạ một chiều cũ.
  const [contacts, setContacts] = useState<string[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<ContactRequestView[]>([]);
  const [outgoingRequests, setOutgoingRequests] = useState<ContactRequestView[]>([]);
  const [contactMessage, setContactMessage] = useState<string | null>(null);
  /**
   * Lỗi gửi phải nói rõ lý do (lát M2, issue #212): vượt trần ký tự
   * (400) hay gửi quá nhanh (429) hiện thành thông báo cạnh composer
   * thay vì chỉ để tin rơi vào trạng thái failed câm như trước.
   */
  const [sendError, setSendError] = useState<string | null>(null);
  // Tên hiển thị gom từ mọi response của API (profiles/memberProfiles).
  const [people, setPeople] = useState<Record<string, PersonSummary>>({});
  // Tìm bạn theo KHOÁ (mô hình chốt lại 24/10/2026): khoá của tôi →
  // chọn khoá → roster thành viên (phân trang con trỏ phía server).
  const [myCourses, setMyCourses] = useState<MessagingCourse[]>([]);
  const [rosterCourseId, setRosterCourseId] = useState<string | null>(null);
  const [rosterMembers, setRosterMembers] = useState<RosterMember[]>([]);
  const [rosterCursor, setRosterCursor] = useState<string | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [reportMessage, setReportMessage] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  /** Tin đã chọn để gỡ hàng loạt (chỉ moderator) — chọn bằng checkbox ở từng dòng tin. */
  const [selectedForBulk, setSelectedForBulk] = useState<Set<string>>(new Set());

  /** Deep-link ?conversation= chỉ xử lý một lần khi trang vừa nạp (không giành cuộc trò chuyện đang mở ở các lần nạp lại sau). */
  const deepLinkHandledRef = useRef(false);
  const realtimeRef = useRef<MessagingRealtimeHandle | null>(null);
  const activeRef = useRef<ConversationView | null>(null);
  activeRef.current = active;
  /** Seq cao nhất đã thấy của từng conversation — mốc xin đồng bộ khi nối lại. */
  const lastSeqRef = useRef<Map<string, number>>(new Map());
  const typingTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastTypingSentRef = useRef(0);

  /**
   * Số conversation chưa đọc suy từ danh sách (mỗi mục mang unread
   * của chính user). Mỗi lần đếm lại cũng làm mới truy vấn huy hiệu
   * Tin nhắn của sidebar (lát M1, issue #204): sidebar tự làm tươi
   * mỗi 30 giây, nhưng khi người dùng đang ở chính trang này thì số
   * trên huy hiệu phải khớp ngay với số trang vừa đếm qua realtime
   * thay vì chờ chu kỳ — làm mới bằng invalidate để server vẫn là
   * nguồn số đếm cuối cùng.
   */
  const recountUnread = useCallback((list: ConversationView[]) => {
    setUnread(list.filter((c) => (c.unread ?? 0) > 0).length);
    void queryClient.invalidateQueries({ queryKey: queryKeys.messageUnreadCount });
  }, [queryClient]);

  /** Gom tên hiển thị từ một response (profiles/memberProfiles) vào bản đồ tên dùng chung của trang. */
  const mergePeople = useCallback((profiles: Record<string, PersonSummary> | undefined) => {
    if (!profiles) return;
    setPeople((prev) => ({ ...prev, ...profiles }));
  }, []);

  /** Tên hiển thị của một user; chưa tra được thông tin thì lùi về chính id như trước. */
  const nameOf = useCallback((userId: string) => people[userId]?.displayName ?? userId, [people]);

  const reload = useCallback(async () => {
    const [list, blockedRes] = await Promise.all([
      apiJson<ConversationView[]>('/api/v1/messages/conversations'),
      apiJson<{ blocked: string[]; profiles?: Record<string, PersonSummary> }>('/api/v1/messages/contacts/blocked'),
    ]);
    setConversations(list);
    recountUnread(list);
    setBlocked(blockedRes.blocked);
    setListLoaded(true);
    mergePeople(blockedRes.profiles);
    for (const c of list) mergePeople(c.memberProfiles);
    // Danh bạ + hàng chờ kết bạn (Lớp B): lỗi ở hai đường này không
    // được phép làm hỏng danh sách cuộc trò chuyện ở trên.
    try {
      const [contactsRes, requestsRes] = await Promise.all([
        apiJson<{ contacts: string[]; profiles?: Record<string, PersonSummary> }>('/api/v1/messages/contacts'),
        apiJson<{
          incoming: ContactRequestView[];
          outgoing: ContactRequestView[];
        }>('/api/v1/messages/contacts/requests'),
      ]);
      setContacts(contactsRes.contacts);
      mergePeople(contactsRes.profiles);
      setIncomingRequests(requestsRes.incoming);
      setOutgoingRequests(requestsRes.outgoing);
    } catch {
      // Giữ trạng thái danh bạ gần nhất.
    }
    // Khoá của tôi (luồng tìm bạn theo khoá): đường riêng, lỗi thì
    // giữ danh sách khoá gần nhất như danh bạ.
    try {
      const coursesRes = await apiJson<{ courses: MessagingCourse[] }>('/api/v1/messages/courses');
      setMyCourses(coursesRes.courses);
    } catch {
      // Giữ danh sách khoá gần nhất.
    }
    for (const c of list) {
      if (c.lastMessageSeq !== undefined) {
        const seen = lastSeqRef.current.get(c.id) ?? 0;
        if (c.lastMessageSeq > seen) lastSeqRef.current.set(c.id, c.lastMessageSeq);
      }
    }
  }, [mergePeople, recountUnread]);

  /** Đánh dấu đã đọc ở server và phản ánh ngay vào state (mốc của mình + unread của conversation). */
  const markRead = useCallback(async (conversationId: string) => {
    try {
      const res = await apiJson<{ marked: number; lastReadSeq: number }>(
        `/api/v1/messages/conversations/${conversationId}/read`,
        { method: 'POST', body: '{}' },
      );
      if (myId) setReadMarkers((prev) => ({ ...prev, [myId]: res.lastReadSeq }));
      setConversations((prev) => {
        const next = prev.map((c) => (c.id === conversationId ? { ...c, unread: 0, lastReadSeq: res.lastReadSeq } : c));
        recountUnread(next);
        return next;
      });
    } catch {
      // Đánh dấu đã đọc lỗi thì để lần mở/đọc sau thử lại — không chặn đọc tin.
    }
  }, [myId, recountUnread]);

  /** Chặn một liên hệ; server trả về danh sách đã chặn mới để hiển thị ngay. */
  async function blockContact(userId: string) {
    setBlockMessage(null);
    try {
      const res = await apiJson<{ blocked: string[] }>(`/api/v1/messages/contacts/${userId}/block`, {
        method: 'POST',
        body: '{}',
      });
      setBlocked(res.blocked);
      setBlockMessage(t('contactBlocked'));
    } catch {
      setBlockMessage(t('blockFailed'));
    }
  }

  /** Bỏ chặn một liên hệ; server trả về danh sách đã chặn mới để hiển thị ngay. */
  async function unblockContact(userId: string) {
    setBlockMessage(null);
    try {
      const res = await apiJson<{ blocked: string[] }>(`/api/v1/messages/contacts/${userId}/block`, {
        method: 'DELETE',
      });
      setBlocked(res.blocked);
      setBlockMessage(t('contactUnblocked'));
    } catch {
      setBlockMessage(t('unblockFailed'));
    }
  }

  useEffect(() => {
    void reload().catch(() => setError(t('messagesLoadFailed')));
  }, [reload]);

  // Deep-link từ thông báo (việc nối tiếp của #33): thông báo
  // message_new của #49 trỏ contextUrl = /messages?conversation=<id>.
  // Danh sách nạp xong thì mở đúng conversation đó — có sẵn trong
  // danh sách thì mở như cú bấm của người dùng; chưa có (danh sách
  // nạp thiếu/trễ) thì lấy chi tiết thẳng theo id bằng đúng endpoint
  // trang vẫn dùng để mở, chèn vào danh sách rồi mở. Server là nơi
  // thực thi quyền thành viên: không phải thành viên/không tồn tại
  // thì bỏ qua deep-link, trang giữ nguyên như không có tham số.
  const deepLinkId = searchParams.get('conversation');
  useEffect(() => {
    if (!deepLinkId || !listLoaded || deepLinkHandledRef.current) return;
    deepLinkHandledRef.current = true;
    const found = conversations.find((c) => c.id === deepLinkId);
    if (found) {
      void open(found);
      return;
    }
    void (async () => {
      try {
        const detail = await apiJson<ConversationDetailView>(`/api/v1/messages/conversations/${deepLinkId}`);
        const summary: ConversationView = {
          id: detail.id,
          type: detail.type,
          name: detail.name,
          members: detail.members,
          unread: detail.unread,
          lastReadSeq: detail.lastReadSeq,
          lastMessageSeq: detail.lastMessageSeq,
          lastMessage: detail.lastMessage,
        };
        setConversations((prev) => (prev.some((c) => c.id === summary.id) ? prev : [summary, ...prev]));
        await open(summary);
      } catch {
        // Không phải thành viên hoặc conversation không tồn tại: bỏ qua deep-link.
      }
    })();
    // `open` là hàm của chính trang (định nghĩa dưới đây), không phải
    // dependency cần theo dõi — mốc chạy một lần do deepLinkHandledRef gác.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkId, listLoaded, conversations]);

  // Kênh realtime: nối một lần khi trang mở; handlers đọc state mới
  // nhất qua ref nên không phải nối lại khi state đổi.
  useEffect(() => {
    if (!myId) return;
    const noteSeq = (conversationId: string, seq: number) => {
      const seen = lastSeqRef.current.get(conversationId) ?? 0;
      if (seq > seen) lastSeqRef.current.set(conversationId, seq);
    };
    const handle = connectMessagingRealtime({
      onNewMessage: ({ conversationId, message }) => {
        noteSeq(conversationId, message.seq);
        if (activeRef.current?.id === conversationId) {
          setMessages((prev) => mergeMessages(prev, [message]));
          // Đang mở cuộc trò chuyện thì tin của người khác được đọc ngay.
          if (message.userIdFrom !== myId) void markRead(conversationId);
        }
      },
      onConversationUpdated: ({ conversationId, message, unreadCount }) => {
        // Sự kiện mang seq CŨ hơn seq đã áp cho conversation này (một
        // sự kiện outbox trước bị consumer phân phối muộn hơn sự kiện
        // sau): bỏ qua để huy hiệu chưa đọc và tin cuối không nhảy lùi
        // theo số của thời điểm cũ — số đúng luôn có qua REST (quan sát
        // nhẹ của review Lớp A). Sự kiện trùng seq là phân phối lại của
        // cùng một sự kiện, vẫn áp như thường và vô hại.
        if (message.seq < (lastSeqRef.current.get(conversationId) ?? 0)) return;
        noteSeq(conversationId, message.seq);
        setConversations((prev) => {
          const target = prev.find((c) => c.id === conversationId);
          if (!target) {
            recountUnread(prev);
            return prev;
          }
          // Danh sách tự sắp xếp lại theo hoạt động mới nhất (lát M1,
          // issue #204): conversation vừa có tin mới được đưa lên đầu
          // — cùng thứ tự server trả khi tải lại (updated_at giảm
          // dần) nên realtime và reload không bao giờ lệch nhau.
          const next = [
            {
              ...target,
              unread: activeRef.current?.id === conversationId ? 0 : unreadCount,
              lastMessage: message,
              lastMessageSeq: message.seq,
            },
            ...prev.filter((c) => c.id !== conversationId),
          ];
          recountUnread(next);
          return next;
        });
      },
      onMessageDeleted: ({ conversationId, messageId, deletedBy }) => {
        if (activeRef.current?.id !== conversationId) return;
        // Xoá mềm (Lớp B): đánh dấu ngay trong khung — phía học sinh
        // không còn thấy tin (lọc ở bước render), phía có thẩm quyền
        // kiểm duyệt thấy dấu vết ai đã xoá. Payload không kèm nội
        // dung nên không có đường nào nội dung bị lộ lại qua realtime.
        setMessages((prev) => prev.map((m) => (m.id === messageId
          ? { ...m, deletedAt: new Date().toISOString(), deletedBy }
          : m)));
      },
      onConversationInvalidate: ({ conversationId }) => {
        // Vòng đời tin nhắn theo vai (issue #33): thu hồi phát
        // message.deleted trước, invalidate sau — chỉ tải lại cửa sổ
        // tin mới phân biệt được "đã thu hồi" (recalledAt, nội dung
        // rỗng) với "đã xoá", và tin bị xoá cứng mới biến mất khỏi
        // khung. Danh sách luôn tải lại vì tin cuối/số chưa đọc đã đổi.
        if (activeRef.current?.id === conversationId) {
          void (async () => {
            try {
              const detail = await apiJson<ConversationDetailView>(`/api/v1/messages/conversations/${conversationId}`);
              setMessages(detail.messages);
              setHasMoreBefore(detail.hasMoreBefore ?? false);
              const markers: Record<string, number> = {};
              for (const marker of detail.memberReadMarkers ?? []) markers[marker.userId] = marker.lastReadSeq;
              setReadMarkers(markers);
            } catch {
              // Giữ khung cũ; lần tải lại sau sẽ đồng bộ.
            }
          })();
        }
        void reload().catch(() => undefined);
      },
      onReadReceipt: ({ conversationId, userId, lastReadSeq }) => {
        if (activeRef.current?.id === conversationId) {
          setReadMarkers((prev) => ({ ...prev, [userId]: Math.max(prev[userId] ?? 0, lastReadSeq) }));
        }
      },
      onTyping: ({ conversationId, userId }) => {
        if (activeRef.current?.id !== conversationId || userId === myId) return;
        setTypingUsers((prev) => ({ ...prev, [userId]: true }));
        const timeouts = typingTimeoutsRef.current;
        const existing = timeouts.get(userId);
        if (existing) clearTimeout(existing);
        timeouts.set(userId, setTimeout(() => {
          setTypingUsers((prev) => {
            const next = { ...prev };
            delete next[userId];
            return next;
          });
        }, 4500));
      },
      onPresence: ({ userId, online }) => {
        setOnlineUsers((prev) => ({ ...prev, [userId]: online }));
      },
      onReconnect: () => {
        // Nối lại: danh sách lấy tươi bằng REST (truy vấn tổng hợp đã
        // rẻ), conversation đang mở xin đúng phần thiếu theo seq.
        void reload().catch(() => undefined);
        const current = activeRef.current;
        if (current) {
          const lastSeq = lastSeqRef.current.get(current.id) ?? 0;
          void handle.sync({ [current.id]: lastSeq }).then((missing) => {
            const missed = missing[current.id];
            if (missed && missed.length) {
              for (const m of missed) noteSeq(current.id, m.seq);
              setMessages((prev) => mergeMessages(prev, missed));
            }
          });
        }
      },
    });
    realtimeRef.current = handle;
    return () => {
      handle.disconnect();
      realtimeRef.current = null;
      for (const timeout of typingTimeoutsRef.current.values()) clearTimeout(timeout);
      typingTimeoutsRef.current.clear();
    };
  }, [myId, markRead, recountUnread, reload]);

  async function open(conv: ConversationView) {
    setActive(conv);
    setTypingUsers({});
    setReportMessage(null);
    setActionMessage(null);
    setSendError(null);
    const detail = await apiJson<ConversationDetailView>(`/api/v1/messages/conversations/${conv.id}`);
    // Chi tiết mang theo enabled + thẩm quyền của chính user (Lớp B):
    // gộp vào conversation đang mở để header/khung soạn biết đường hiển thị.
    const { messages: _detailMessages, ...detailView } = detail;
    setActive({ ...conv, ...detailView });
    mergePeople(detail.memberProfiles);
    setMessages(detail.messages);
    setHasMoreBefore(detail.hasMoreBefore ?? false);
    const markers: Record<string, number> = {};
    for (const marker of detail.memberReadMarkers ?? []) markers[marker.userId] = marker.lastReadSeq;
    setReadMarkers(markers);
    const newest = detail.messages.length ? detail.messages[detail.messages.length - 1]!.seq : (detail.lastMessageSeq ?? 0);
    if (newest) lastSeqRef.current.set(conv.id, newest);
    realtimeRef.current?.joinConversation(conv.id);
    await markRead(conv.id);
  }

  /** Tải cửa sổ tin cũ hơn (cursor beforeSeq = seq nhỏ nhất đang có). */
  async function loadOlder() {
    if (!active) return;
    const oldest = messages.find((m) => !m.localStatus);
    if (!oldest) return;
    const page = await apiJson<{ messages: MessageView[]; hasMoreBefore: boolean }>(
      `/api/v1/messages/conversations/${active.id}/messages?beforeSeq=${oldest.seq}&limit=50`,
    );
    setMessages((prev) => mergeMessages(page.messages, prev));
    setHasMoreBefore(page.hasMoreBefore);
  }

  /** Đẩy một tin lạc quan lên cuối và gửi thật; xác nhận của server (REST hoặc socket) thay bản tạm theo clientMessageId. */
  async function deliver(conversationId: string, text: string, clientMessageId: string) {
    if (!myId) return;
    setMessages((prev) => mergeMessages(prev, [{
      id: `temp-${clientMessageId}`,
      conversationId,
      userIdFrom: myId,
      fullMessage: text,
      createdAt: new Date().toISOString(),
      seq: 0,
      clientMessageId,
      localStatus: 'sending',
    }]));
    try {
      const saved = await apiJson<MessageView>(`/api/v1/messages/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text, clientMessageId }),
      });
      const seen = lastSeqRef.current.get(conversationId) ?? 0;
      if (saved.seq > seen) lastSeqRef.current.set(conversationId, saved.seq);
      setMessages((prev) => mergeMessages(prev, [saved]));
      // Tin mình vừa gửi cũng là hoạt động mới nhất (lát M1, issue
      // #204): cập nhật xem trước và đưa conversation lên đầu danh
      // sách ngay tại chỗ, không chờ sự kiện conversation.updated
      // phản hồi về qua socket.
      setConversations((prev) => {
        const target = prev.find((c) => c.id === conversationId);
        if (!target) return prev;
        return [
          { ...target, lastMessage: saved, lastMessageSeq: saved.seq },
          ...prev.filter((c) => c.id !== conversationId),
        ];
      });
    } catch (err) {
      // Hai lỗi có mã riêng của lát M2 phải hiện thành câu chữ rõ
      // ràng cạnh composer (kèm trạng thái failed để thử lại được);
      // lỗi khác giữ hành vi cũ (chỉ đánh dấu failed).
      if (err instanceof ApiError && err.problem.code === 'messaging.message_too_long') {
        setSendError(t('messageTooLong', { max: MESSAGING_MAX_MESSAGE_LENGTH_DEFAULT }));
      } else if (err instanceof ApiError && err.problem.code === 'messaging.rate_limited') {
        setSendError(t('messageRateLimited'));
      }
      setMessages((prev) => prev.map((m) => (m.clientMessageId === clientMessageId && m.localStatus
        ? { ...m, localStatus: 'failed' as const }
        : m)));
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!active) return;
    const text = drafts[active.id] ?? '';
    if (!text.trim()) return;
    // Áp trần ở client theo ĐÚNG cách đếm của server (lát M2): vượt
    // trần thì giữ nguyên nháp + báo rõ, không bắn request chắc chắn
    // bị 400. Trần hiển thị là giá trị mặc định dùng chung ở
    // contracts; server vẫn là nguồn sự thật (quản trị đổi
    // site-config thì lỗi 400 của server cũng được dịch rõ ở deliver).
    if (countMessageCharacters(text) > MESSAGING_MAX_MESSAGE_LENGTH_DEFAULT) {
      setSendError(t('messageTooLong', { max: MESSAGING_MAX_MESSAGE_LENGTH_DEFAULT }));
      return;
    }
    setSendError(null);
    // Chỉ xoá nháp của đúng conversation vừa gửi (lát M1, issue
    // #204) — nháp của các conversation khác giữ nguyên.
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[active.id];
      return next;
    });
    await deliver(active.id, text, crypto.randomUUID());
  }

  /** Thử gửi lại một tin đã lỗi — dùng lại đúng clientMessageId nên server không tạo trùng kể cả khi lần trước đã tới nơi. */
  async function retrySend(message: MessageView) {
    if (!active || !message.clientMessageId) return;
    setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, localStatus: 'sending' as const } : m)));
    await deliver(active.id, message.fullMessage, message.clientMessageId);
  }

  /** Phát tín hiệu đang nhập, throttle 3 giây ở client (server còn throttle thêm theo cửa sổ Redis). */
  function noteTyping() {
    if (!active) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current < 3000) return;
    lastTypingSentRef.current = now;
    realtimeRef.current?.typing(active.id);
  }

  /** Cập nhật trạng thái quan hệ của một dòng roster ngay tại chỗ (không chờ tải lại). */
  const patchRosterRelationship = useCallback((userId: string, relationship: ContactRelationship) => {
    setRosterMembers((prev) => prev.map((m) => (m.userId === userId ? { ...m, relationship } : m)));
  }, []);

  /**
   * Gửi yêu cầu kết bạn tới một user (Lớp B: luồng yêu cầu–chấp nhận
   * thay danh bạ một chiều) — điểm vào là dòng ROSTER thành viên khoá
   * và hàng chờ kết bạn, không còn tìm theo tên hay form nhập UUID thô.
   */
  async function sendContactRequestTo(userId: string) {
    setContactMessage(null);
    try {
      const res = await apiJson<{ status: 'pending' | 'accepted' }>(`/api/v1/messages/contacts/${userId}`, {
        method: 'POST',
        body: '{}',
      });
      setContactMessage(res.status === 'accepted' ? t('contactRequestAccepted') : t('contactRequestSent'));
      // Phản ánh ngay lên dòng roster đang hiện, rồi đồng bộ lại toàn bộ.
      patchRosterRelationship(userId, res.status === 'accepted' ? 'contact' : 'pending_outgoing');
      await reload();
    } catch {
      setContactMessage(t('contactRequestFailed'));
    }
  }

  /** Mở roster của một khoá: tải trang đầu (phân trang con trỏ phía server). */
  async function openRoster(courseId: string) {
    setRosterCourseId(courseId);
    setRosterMembers([]);
    setRosterCursor(null);
    setRosterError(null);
    try {
      const res = await apiJson<{ members: RosterMember[]; nextCursor: string | null }>(
        `/api/v1/messages/courses/${courseId}/members?limit=50`,
      );
      setRosterMembers(res.members);
      setRosterCursor(res.nextCursor);
      mergePeople(Object.fromEntries(res.members.map((m) => [m.userId, m])));
    } catch {
      setRosterError(t('rosterLoadFailed'));
    }
  }

  /** Tải trang roster tiếp theo theo con trỏ server đã phát hành. */
  async function loadMoreRoster() {
    if (!rosterCourseId || !rosterCursor) return;
    try {
      const res = await apiJson<{ members: RosterMember[]; nextCursor: string | null }>(
        `/api/v1/messages/courses/${rosterCourseId}/members?limit=50&cursor=${encodeURIComponent(rosterCursor)}`,
      );
      setRosterMembers((prev) => [...prev, ...res.members]);
      setRosterCursor(res.nextCursor);
      mergePeople(Object.fromEntries(res.members.map((m) => [m.userId, m])));
    } catch {
      setRosterError(t('rosterLoadFailed'));
    }
  }

  /** Chấp nhận/từ chối một yêu cầu kết bạn đang chờ. */
  async function respondContactRequest(userId: string, action: 'accept' | 'decline') {
    setContactMessage(null);
    try {
      await apiJson(`/api/v1/messages/contacts/requests/${userId}/${action}`, { method: 'POST', body: '{}' });
      patchRosterRelationship(userId, action === 'accept' ? 'contact' : 'none');
      await reload();
    } catch {
      setContactMessage(t('contactRequestFailed'));
    }
  }

  /** Mở cuộc trò chuyện 1-1 với một liên hệ đã duyệt. */
  async function messageContact(userId: string) {
    const conv = await apiJson<ConversationView>('/api/v1/messages/conversations', {
      method: 'POST',
      body: JSON.stringify({ memberIds: [userId] }),
    });
    await reload();
    await open(conv);
  }

  /** Báo cáo cuộc trò chuyện đang mở — về giáo viên phụ trách + quản trị viên (Lớp B). */
  async function reportActiveConversation() {
    if (!active) return;
    setReportMessage(null);
    try {
      await apiJson(`/api/v1/messages/conversations/${active.id}/report`, { method: 'POST', body: '{}' });
      setReportMessage(t('conversationReported'));
    } catch {
      setReportMessage(t('reportFailed'));
    }
  }

  /** Bật/tắt chat của cuộc trò chuyện đang mở (chỉ hiện khi canManage). */
  async function toggleActiveChat() {
    if (!active) return;
    const updated = await apiJson<ConversationView>(`/api/v1/messages/conversations/${active.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !(active.enabled ?? true) }),
    });
    setActive((prev) => (prev ? { ...prev, enabled: updated.enabled } : prev));
    setConversations((prev) => prev.map((c) => (c.id === active.id ? { ...c, enabled: updated.enabled } : c)));
  }

  /**
   * Xoá-phía-mình một tin nhắn (vòng đời tin nhắn theo vai, issue #33):
   * chỉ tác giả, mọi lúc — tin chỉ ẩn khỏi tầm nhìn của chính người
   * xoá, phía kia không đổi. Server trả dòng tin kèm dấu vết — áp ngay
   * vào khung; phía học sinh tin biến mất ở bước render.
   */
  async function deleteMessage(message: MessageView) {
    setActionMessage(null);
    try {
      const deleted = await apiJson<MessageView>(`/api/v1/messages/messages/${message.id}`, { method: 'DELETE' });
      setMessages((prev) => prev.map((m) => (m.id === message.id
        ? { ...m, deletedAt: deleted.deletedAt ?? new Date().toISOString(), deletedBy: deleted.deletedBy ?? myId ?? null }
        : m)));
    } catch {
      setActionMessage(t('deleteMessageFailed'));
    }
  }

  /**
   * Cửa sổ thu hồi mặc định (phút) theo site-config
   * `core/messagingrecallwindowminutes`: server là thẩm quyền cuối
   * (ngoài cửa sổ trả 403) — client chỉ dùng mốc này để ẨN nút thu
   * hồi khi tin đã cũ, không tự quyết cho phép thu hồi.
   */
  const RECALL_WINDOW_MINUTES = 15;
  function canRecall(message: MessageView): boolean {
    if (message.userIdFrom !== myId || message.localStatus || message.recalledAt || message.deletedAt) return false;
    return Date.now() - new Date(message.createdAt).getTime() < RECALL_WINDOW_MINUTES * 60 * 1000;
  }

  /** Thu hồi tin của mình cho mọi người (chỉ trong cửa sổ): nội dung bị vô hiệu, khung hiện dòng đã thu hồi. */
  async function recallMessage(message: MessageView) {
    setActionMessage(null);
    try {
      const recalled = await apiJson<MessageView>(`/api/v1/messages/messages/${message.id}/recall`, { method: 'POST', body: '{}' });
      setMessages((prev) => prev.map((m) => (m.id === message.id
        ? { ...m, fullMessage: '', recalledAt: recalled.recalledAt ?? new Date().toISOString(), recalledBy: recalled.recalledBy ?? myId ?? null }
        : m)));
    } catch {
      setActionMessage(t('recallMessageFailed'));
    }
  }

  /** Xoá cứng một tin (chỉ moderator có moderation:manage): lý do bắt buộc, tin biến mất khỏi khung ngay. */
  async function hardDeleteMessage(message: MessageView) {
    setActionMessage(null);
    if (!window.confirm(t('hardDeleteConfirm'))) return;
    const reason = window.prompt(t('hardDeleteReasonPrompt'));
    if (!reason || !reason.trim()) return;
    try {
      await apiJson(`/api/v1/messages/messages/${message.id}/hard-delete`, {
        method: 'POST', body: JSON.stringify({ reason: reason.trim() }),
      });
      setMessages((prev) => prev.filter((m) => m.id !== message.id));
      setSelectedForBulk((prev) => {
        const next = new Set(prev);
        next.delete(message.id);
        return next;
      });
    } catch {
      setActionMessage(t('hardDeleteMessageFailed'));
    }
  }

  /** Gỡ hàng loạt các tin đã chọn (chỉ moderator): toàn bộ danh sách kiểm tra thẩm quyền trước, một tin ngoài phạm vi là cả lượt bị từ chối. */
  async function bulkRemoveSelected() {
    setActionMessage(null);
    const messageIds = [...selectedForBulk];
    if (messageIds.length === 0) return;
    if (!window.confirm(t('bulkRemoveConfirm', { count: messageIds.length }))) return;
    const reason = window.prompt(t('bulkRemoveReasonPrompt'));
    if (!reason || !reason.trim()) return;
    try {
      await apiJson('/api/v1/messages/messages/bulk-remove', {
        method: 'POST', body: JSON.stringify({ messageIds, reason: reason.trim() }),
      });
      setMessages((prev) => prev.filter((m) => !selectedForBulk.has(m.id)));
      setSelectedForBulk(new Set());
    } catch {
      setActionMessage(t('bulkRemoveMessageFailed'));
    }
  }

  const lastOwnMessage = [...messages].reverse().find((m) => m.userIdFrom === myId && !m.localStatus);
  const seenByAllOthers = Boolean(
    active && lastOwnMessage
      && active.members.filter((memberId) => memberId !== myId)
        .every((memberId) => (readMarkers[memberId] ?? 0) >= lastOwnMessage.seq),
  );
  const typingNames = Object.keys(typingUsers).filter((userId) => typingUsers[userId]);
  // Tầm nhìn xoá mềm ở phía client (server đã chốt theo vai trò):
  // tin đã xoá chỉ còn hiện với người có thẩm quyền kiểm duyệt.
  const visibleMessages = messages.filter((m) => !m.deletedAt || active?.canModerate);
  /** Nháp đang hiện ở composer: nháp của conversation đang mở (lát M1). */
  const draft = active ? (drafts[active.id] ?? '') : '';

  return (
    <main className="@container/main grid flex-1 gap-4 px-4 py-4 md:grid-cols-3 md:gap-6 md:py-6 lg:px-6">
      <ConversationSidebar
        conversations={conversations}
        active={active}
        unread={unread}
        error={error}
        onOpenConversation={open}
        nameOf={nameOf}
        myCourses={myCourses}
        rosterCourseId={rosterCourseId}
        rosterMembers={rosterMembers}
        rosterError={rosterError}
        rosterCursor={rosterCursor}
        onOpenRoster={openRoster}
        onLoadMoreRoster={loadMoreRoster}
        onMessageContact={messageContact}
        onSendContactRequest={sendContactRequestTo}
        onRespondContactRequest={respondContactRequest}
        contacts={contacts}
        contactMessage={contactMessage}
        incomingRequests={incomingRequests}
        outgoingRequests={outgoingRequests}
        blocked={blocked}
        blockMessage={blockMessage}
        onUnblockContact={unblockContact}
      />
      <ChatPanel
        active={active}
        myId={myId}
        onlineUsers={onlineUsers}
        blocked={blocked}
        onUnblockContact={unblockContact}
        onBlockContact={blockContact}
        onReportConversation={reportActiveConversation}
        onToggleChat={toggleActiveChat}
        reportMessage={reportMessage}
        actionMessage={actionMessage}
        hasMoreBefore={hasMoreBefore}
        onLoadOlder={loadOlder}
        selectedForBulk={selectedForBulk}
        setSelectedForBulk={setSelectedForBulk}
        onBulkRemove={bulkRemoveSelected}
        visibleMessages={visibleMessages}
        nameOf={nameOf}
        onRetrySend={retrySend}
        onDeleteMessage={deleteMessage}
        canRecall={canRecall}
        onRecallMessage={recallMessage}
        onHardDeleteMessage={hardDeleteMessage}
        seenByAllOthers={seenByAllOthers}
        typingNames={typingNames}
        draft={draft}
        setDrafts={setDrafts}
        onNoteTyping={noteTyping}
        onSend={send}
        sendError={sendError}
      />
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default MessagesPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('navMessages');
}

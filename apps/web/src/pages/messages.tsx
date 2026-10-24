import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '#lib/api';
import { useAuth } from '#lib/auth';
import { connectMessagingRealtime, type MessagingRealtimeHandle } from '#lib/messaging-socket';

interface MessageView {
  id: string;
  conversationId: string;
  userIdFrom: string;
  fullMessage: string;
  createdAt: string;
  seq: number;
  clientMessageId: string | null;
  /**
   * Dấu vết xoá mềm (Lớp B, issue #33): tin đã xoá chỉ còn xuất hiện
   * trong cửa sổ của người có thẩm quyền kiểm duyệt; phía học sinh
   * không bao giờ nhận được tin có hai trường này khác null.
   */
  deletedAt?: string | null;
  deletedBy?: string | null;
  /** Trạng thái cục bộ của tin gửi lạc quan; tin từ server không có trường này. */
  localStatus?: 'sending' | 'failed';
}
/** Tóm tắt hiển thị của một user do API trả kèm (tên thật thay cho UUID thô). */
interface PersonSummary {
  userId: string;
  displayName: string;
  username: string;
}
/** Trạng thái quan hệ của một kết quả tìm người so với chính mình. */
type ContactRelationship = 'contact' | 'pending_incoming' | 'pending_outgoing' | 'blocked' | 'none';
interface PeopleSearchResult extends PersonSummary {
  relationship: ContactRelationship;
}
/** Một yêu cầu kết bạn trong hàng chờ: API đã kèm tên hiển thị của phía kia. */
interface ContactRequestView {
  userId: string;
  createdAt: string;
  displayName?: string;
  username?: string;
}
interface ConversationView {
  id: string;
  type: number;
  name: string | null;
  members: string[];
  /** Tên hiển thị của từng thành viên (API trả kèm) — client tra tên từ đây. */
  memberProfiles?: Record<string, PersonSummary>;
  unread?: number;
  lastReadSeq?: number;
  lastMessageSeq?: number;
  lastMessage?: MessageView | null;
  /** Chat đang bật hay không — giáo viên tắt được (Lớp B); vắng mặt coi như đang bật. */
  enabled?: boolean;
  createdBy?: string | null;
  /** Thẩm quyền của CHÍNH user trên conversation (chỉ chi tiết conversation mới mang): kiểm duyệt / quản lý. */
  canModerate?: boolean;
  canManage?: boolean;
}
/** Chi tiết conversation theo API: conversation kèm một cửa sổ tin + mốc đã đọc của từng thành viên. */
interface ConversationDetailView extends ConversationView {
  messages: MessageView[];
  hasMoreBefore?: boolean;
  memberReadMarkers?: { userId: string; lastReadSeq: number }[];
}

/** Gộp tin vào danh sách hiện có: chống trùng theo id và clientMessageId, sắp theo seq (tin lạc quan chưa có seq thật nằm cuối). */
function mergeMessages(existing: MessageView[], incoming: MessageView[]): MessageView[] {
  const byId = new Map<string, MessageView>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) {
    // Tin lạc quan của chính lần gửi này đã được server xác nhận: bỏ
    // bản tạm, dùng bản thật (khớp theo clientMessageId).
    if (m.clientMessageId) {
      for (const [id, local] of byId) {
        if (local.localStatus && local.clientMessageId === m.clientMessageId) byId.delete(id);
      }
    }
    byId.set(m.id, m);
  }
  return [...byId.values()].sort((a, b) => (a.seq || Number.MAX_SAFE_INTEGER) - (b.seq || Number.MAX_SAFE_INTEGER));
}

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
 * (GET/POST/DELETE /messages/contacts...).
 */
export function MessagesPage() {
  const { t } = useTranslation('app');
  const { user } = useAuth();
  const myId = user?.id;
  const [conversations, setConversations] = useState<ConversationView[]>([]);
  const [unread, setUnread] = useState(0);
  const [active, setActive] = useState<ConversationView | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [readMarkers, setReadMarkers] = useState<Record<string, number>>({});
  const [typingUsers, setTypingUsers] = useState<Record<string, boolean>>({});
  const [onlineUsers, setOnlineUsers] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [blockMessage, setBlockMessage] = useState<string | null>(null);
  // Lớp B (issue #33): danh bạ ĐÃ DUYỆT + hàng chờ kết bạn (đến/đi),
  // thay danh bạ một chiều cũ.
  const [contacts, setContacts] = useState<string[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<ContactRequestView[]>([]);
  const [outgoingRequests, setOutgoingRequests] = useState<ContactRequestView[]>([]);
  const [contactMessage, setContactMessage] = useState<string | null>(null);
  // Tìm bạn theo TÊN (việc nối tiếp Lớp B): bản đồ tên hiển thị gom từ
  // mọi response của API (profiles/memberProfiles) + trạng thái ô tìm.
  const [people, setPeople] = useState<Record<string, PersonSummary>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PeopleSearchResult[] | null>(null);
  const [reportMessage, setReportMessage] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const realtimeRef = useRef<MessagingRealtimeHandle | null>(null);
  const activeRef = useRef<ConversationView | null>(null);
  activeRef.current = active;
  /** Bộ đếm lượt tìm người: phản hồi của một lượt tìm cũ về muộn bị bỏ qua. */
  const searchSeqRef = useRef(0);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Seq cao nhất đã thấy của từng conversation — mốc xin đồng bộ khi nối lại. */
  const lastSeqRef = useRef<Map<string, number>>(new Map());
  const typingTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastTypingSentRef = useRef(0);

  /** Số conversation chưa đọc suy từ danh sách (mỗi mục mang unread của chính user). */
  const recountUnread = useCallback((list: ConversationView[]) => {
    setUnread(list.filter((c) => (c.unread ?? 0) > 0).length);
  }, []);

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
          const next = prev.map((c) => (c.id === conversationId
            ? {
                ...c,
                unread: activeRef.current?.id === conversationId ? 0 : unreadCount,
                lastMessage: message,
                lastMessageSeq: message.seq,
              }
            : c));
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
    } catch {
      setMessages((prev) => prev.map((m) => (m.clientMessageId === clientMessageId && m.localStatus
        ? { ...m, localStatus: 'failed' as const }
        : m)));
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!active || !draft.trim()) return;
    const text = draft;
    setDraft('');
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

  /**
   * Gửi yêu cầu kết bạn tới một user (Lớp B: luồng yêu cầu–chấp nhận
   * thay danh bạ một chiều) — điểm vào duy nhất là kết quả TÌM THEO
   * TÊN, không còn form nhập UUID thô.
   */
  async function sendContactRequestTo(userId: string) {
    setContactMessage(null);
    try {
      const res = await apiJson<{ status: 'pending' | 'accepted' }>(`/api/v1/messages/contacts/${userId}`, {
        method: 'POST',
        body: '{}',
      });
      setContactMessage(res.status === 'accepted' ? t('contactRequestAccepted') : t('contactRequestSent'));
      // Phản ánh ngay lên kết quả tìm đang hiện, rồi đồng bộ lại toàn bộ.
      setSearchResults((prev) => (prev
        ? prev.map((r) => (r.userId === userId
          ? { ...r, relationship: res.status === 'accepted' ? 'contact' : 'pending_outgoing' }
          : r))
        : prev));
      await reload();
    } catch {
      setContactMessage(t('contactRequestFailed'));
    }
  }

  /**
   * Tìm người theo tên/username: gõ tới đâu tìm tới đó (chờ gõ xong
   * 300ms), chỉ tìm khi đủ 2 ký tự như luật phía server; phản hồi của
   * lượt gõ cũ về muộn bị bỏ qua theo bộ đếm lượt.
   */
  function onSearchQueryChange(value: string) {
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    const q = value.trim();
    if (q.length < 2) {
      searchSeqRef.current += 1;
      setSearchResults(null);
      return;
    }
    searchTimerRef.current = setTimeout(() => {
      const seq = (searchSeqRef.current += 1);
      void apiJson<{ results: PeopleSearchResult[] }>(
        `/api/v1/messages/people/search?q=${encodeURIComponent(q)}`,
      ).then((res) => {
        if (searchSeqRef.current !== seq) return;
        setSearchResults(res.results);
        setPeople((prev) => {
          const next = { ...prev };
          for (const r of res.results) next[r.userId] = { userId: r.userId, displayName: r.displayName, username: r.username };
          return next;
        });
      }).catch(() => {
        if (searchSeqRef.current === seq) setSearchResults([]);
      });
    }, 300);
  }

  /** Chấp nhận/từ chối một yêu cầu kết bạn đang chờ. */
  async function respondContactRequest(userId: string, action: 'accept' | 'decline') {
    setContactMessage(null);
    try {
      await apiJson(`/api/v1/messages/contacts/requests/${userId}/${action}`, { method: 'POST', body: '{}' });
      setSearchResults((prev) => (prev
        ? prev.map((r) => (r.userId === userId
          ? { ...r, relationship: action === 'accept' ? 'contact' : 'none' }
          : r))
        : prev));
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
   * Xoá mềm một tin nhắn (tin của mình, hoặc mọi tin khi canModerate):
   * server trả dòng tin kèm dấu vết — áp ngay vào khung; phía học sinh
   * tin biến mất ở bước render, phía kiểm duyệt thấy dấu đã xoá.
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

  return (
    <main className="@container/main grid flex-1 gap-4 px-4 py-4 md:grid-cols-3 md:gap-6 md:py-6 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>
            {t('messagesTitle')} {unread > 0 ? t('unreadSuffix', { count: unread }) : ''}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {error ? <p role="alert">{error}</p> : null}
          <ul className="space-y-1">
            {conversations.map((c) => (
              <li key={c.id}>
                <Button
                  type="button"
                  variant={active?.id === c.id ? 'default' : 'outline'}
                  onClick={() => void open(c)}
                >
                  {c.name ?? t('conversationWithUser', { members: c.members.map((id) => nameOf(id)).join(', ') })}
                  {(c.unread ?? 0) > 0 ? t('unreadSuffix', { count: c.unread }) : ''}
                </Button>
                {c.lastMessage ? (
                  <p className="truncate text-xs text-muted-foreground">{c.lastMessage.fullMessage}</p>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="space-y-2">
            <Label htmlFor="people-search">{t('searchPeopleLabel')}</Label>
            <Input
              id="people-search"
              value={searchQuery}
              placeholder={t('searchPeoplePlaceholder')}
              onChange={(e) => onSearchQueryChange(e.target.value)}
            />
            {searchQuery.trim().length === 1 ? (
              <p className="text-sm text-muted-foreground">{t('searchTooShort')}</p>
            ) : null}
            {searchResults !== null ? (
              searchResults.length > 0 ? (
                <ul className="space-y-1">
                  {searchResults.map((r) => (
                    <li key={r.userId} data-testid={`search-result-${r.userId}`} className="flex items-center gap-2">
                      <span className="text-sm">
                        {r.displayName} <span className="text-muted-foreground">@{r.username}</span>
                      </span>
                      {r.relationship === 'none' ? (
                        <Button type="button" variant="outline" onClick={() => void sendContactRequestTo(r.userId)}>
                          {t('addContact')}
                        </Button>
                      ) : null}
                      {r.relationship === 'pending_outgoing' ? (
                        <span className="text-sm text-muted-foreground">{t('contactRequestPendingSuffix')}</span>
                      ) : null}
                      {r.relationship === 'pending_incoming' ? (
                        <>
                          <Button type="button" variant="outline" onClick={() => void respondContactRequest(r.userId, 'accept')}>
                            {t('acceptContactRequest')}
                          </Button>
                          <Button type="button" variant="outline" onClick={() => void respondContactRequest(r.userId, 'decline')}>
                            {t('declineContactRequest')}
                          </Button>
                        </>
                      ) : null}
                      {r.relationship === 'contact' ? (
                        <Button type="button" variant="outline" onClick={() => void messageContact(r.userId)}>
                          {t('messageWithContact')}
                        </Button>
                      ) : null}
                      {r.relationship === 'blocked' ? (
                        <span className="text-sm text-muted-foreground">{t('relationshipBlocked')}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{t('searchNoResults')}</p>
              )
            ) : null}
          </div>
          <div className="space-y-2">
            <h3 className="font-medium">{t('contactsTitle')}</h3>
            {contactMessage ? <p role="status">{contactMessage}</p> : null}
            <ul className="space-y-1">
              {contacts.map((userId) => (
                <li key={userId} data-testid={`contact-${userId}`} className="flex items-center gap-2">
                  <span className="text-sm">{nameOf(userId)}</span>
                  <Button type="button" variant="outline" onClick={() => void messageContact(userId)}>
                    {t('messageWithContact')}
                  </Button>
                </li>
              ))}
            </ul>
            {contacts.length === 0 ? <p className="text-sm text-muted-foreground">{t('noContacts')}</p> : null}
            {incomingRequests.length > 0 ? (
              <>
                <h4 className="text-sm font-medium">{t('incomingRequestsTitle')}</h4>
                <ul className="space-y-1">
                  {incomingRequests.map((r) => (
                    <li key={r.userId} data-testid={`incoming-request-${r.userId}`} className="flex items-center gap-2">
                      <span className="text-sm">{r.displayName ?? nameOf(r.userId)}</span>
                      <Button type="button" variant="outline" onClick={() => void respondContactRequest(r.userId, 'accept')}>
                        {t('acceptContactRequest')}
                      </Button>
                      <Button type="button" variant="outline" onClick={() => void respondContactRequest(r.userId, 'decline')}>
                        {t('declineContactRequest')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {outgoingRequests.length > 0 ? (
              <>
                <h4 className="text-sm font-medium">{t('outgoingRequestsTitle')}</h4>
                <ul className="space-y-1">
                  {outgoingRequests.map((r) => (
                    <li key={r.userId} className="text-sm">
                      {r.displayName ?? nameOf(r.userId)} {t('contactRequestPendingSuffix')}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
          <div className="space-y-2">
            <h3 className="font-medium">{t('blockedContactsTitle')}</h3>
            {blockMessage ? <p role="status">{blockMessage}</p> : null}
            <ul className="space-y-1">
              {blocked.map((userId) => (
                <li key={userId} data-testid={`blocked-${userId}`} className="flex items-center gap-2">
                  <span className="text-sm">{nameOf(userId)}</span>
                  <Button type="button" variant="outline" onClick={() => void unblockContact(userId)}>
                    {t('unblockContact')}
                  </Button>
                </li>
              ))}
            </ul>
            {blocked.length === 0 ? <p className="text-sm text-muted-foreground">{t('noBlockedContacts')}</p> : null}
          </div>
        </CardContent>
      </Card>
      <Card className="md:col-span-2">
        <CardHeader>
          <CardTitle>{active ? (active.name ?? t('conversationFallback')) : t('selectConversation')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {active ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {active.members
                  .filter((memberId) => memberId !== user?.id)
                  .map((memberId) => (
                    <span key={memberId} className="flex items-center gap-2">
                      {onlineUsers[memberId] ? (
                        <span className="text-xs text-muted-foreground">● {t('onlineNow')}</span>
                      ) : null}
                      {blocked.includes(memberId) ? (
                        <span className="flex items-center gap-2 text-sm">
                          {nameOf(memberId)} {t('blockedSuffix')}
                          <Button type="button" variant="outline" onClick={() => void unblockContact(memberId)}>
                            {t('unblockContact')}
                          </Button>
                        </span>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => void blockContact(memberId)}
                        >
                          {t('blockContact')}
                        </Button>
                      )}
                    </span>
                  ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" onClick={() => void reportActiveConversation()}>
                  {t('reportConversation')}
                </Button>
                {active.canManage ? (
                  <Button type="button" variant="outline" onClick={() => void toggleActiveChat()}>
                    {(active.enabled ?? true) ? t('disableChat') : t('enableChat')}
                  </Button>
                ) : null}
                {reportMessage ? <p role="status">{reportMessage}</p> : null}
                {actionMessage ? <p role="alert">{actionMessage}</p> : null}
              </div>
              {hasMoreBefore ? (
                <Button type="button" variant="outline" onClick={() => void loadOlder()}>
                  {t('loadOlderMessages')}
                </Button>
              ) : null}
              <ul className="space-y-2" aria-label={t('messagesListLabel')}>
                {visibleMessages.map((m) => (
                  <li key={m.id} className={m.deletedAt ? 'rounded border p-2 opacity-70' : 'rounded border p-2'}>
                    <p className="text-xs text-muted-foreground">
                      {t('messageFromUser', { userId: nameOf(m.userIdFrom), time: new Date(m.createdAt).toLocaleString() })}
                    </p>
                    <p>{m.fullMessage}</p>
                    {m.deletedAt ? (
                      <p className="text-xs italic text-muted-foreground">
                        {t('messageDeletedBy', { userId: m.deletedBy ? nameOf(m.deletedBy) : '' })}
                      </p>
                    ) : null}
                    {m.localStatus === 'sending' ? (
                      <p className="text-xs text-muted-foreground">{t('messageSending')}</p>
                    ) : null}
                    {m.localStatus === 'failed' ? (
                      <p className="flex items-center gap-2 text-xs">
                        <span>{t('messageSendFailed')}</span>
                        <Button type="button" variant="outline" onClick={() => void retrySend(m)}>
                          {t('retrySend')}
                        </Button>
                      </p>
                    ) : null}
                    {!m.deletedAt && !m.localStatus && (m.userIdFrom === myId || active.canModerate) ? (
                      <Button type="button" variant="outline" onClick={() => void deleteMessage(m)}>
                        {t('deleteMessage')}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {seenByAllOthers ? (
                <p data-testid="seen-status" className="text-xs text-muted-foreground">{t('seenByMembers')}</p>
              ) : null}
              {typingNames.map((userId) => (
                <p key={userId} data-testid="typing-indicator" className="text-xs text-muted-foreground">
                  {t('typingIndicator', { userId: nameOf(userId) })}
                </p>
              ))}
              {active.enabled === false && !active.canManage ? (
                <p role="status" className="text-sm text-muted-foreground">{t('chatDisabledNotice')}</p>
              ) : (
                <>
                  {active.enabled === false ? (
                    <p role="status" className="text-sm text-muted-foreground">{t('chatDisabledForMembers')}</p>
                  ) : null}
                  <form onSubmit={(e) => void send(e)} className="flex gap-2">
                    <Input
                      aria-label={t('messageText')}
                      value={draft}
                      onChange={(e) => {
                        setDraft(e.target.value);
                        noteTyping();
                      }}
                    />
                    <Button type="submit">{t('send')}</Button>
                  </form>
                </>
              )}
            </>
          ) : (
            <p>{t('pickConversation')}</p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default MessagesPage;

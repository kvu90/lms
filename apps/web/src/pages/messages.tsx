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
  /** Trạng thái cục bộ của tin gửi lạc quan; tin từ server không có trường này. */
  localStatus?: 'sending' | 'failed';
}
interface ConversationView {
  id: string;
  type: number;
  name: string | null;
  members: string[];
  unread?: number;
  lastReadSeq?: number;
  lastMessageSeq?: number;
  lastMessage?: MessageView | null;
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
  const [newUserId, setNewUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [blockMessage, setBlockMessage] = useState<string | null>(null);

  const realtimeRef = useRef<MessagingRealtimeHandle | null>(null);
  const activeRef = useRef<ConversationView | null>(null);
  activeRef.current = active;
  /** Seq cao nhất đã thấy của từng conversation — mốc xin đồng bộ khi nối lại. */
  const lastSeqRef = useRef<Map<string, number>>(new Map());
  const typingTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastTypingSentRef = useRef(0);

  /** Số conversation chưa đọc suy từ danh sách (mỗi mục mang unread của chính user). */
  const recountUnread = useCallback((list: ConversationView[]) => {
    setUnread(list.filter((c) => (c.unread ?? 0) > 0).length);
  }, []);

  const reload = useCallback(async () => {
    const [list, blockedRes] = await Promise.all([
      apiJson<ConversationView[]>('/api/v1/messages/conversations'),
      apiJson<{ blocked: string[] }>('/api/v1/messages/contacts/blocked'),
    ]);
    setConversations(list);
    recountUnread(list);
    setBlocked(blockedRes.blocked);
    for (const c of list) {
      if (c.lastMessageSeq !== undefined) {
        const seen = lastSeqRef.current.get(c.id) ?? 0;
        if (c.lastMessageSeq > seen) lastSeqRef.current.set(c.id, c.lastMessageSeq);
      }
    }
  }, [recountUnread]);

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
    const detail = await apiJson<ConversationDetailView>(`/api/v1/messages/conversations/${conv.id}`);
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

  async function startConversation(event: FormEvent) {
    event.preventDefault();
    const conv = await apiJson<ConversationView>('/api/v1/messages/conversations', {
      method: 'POST',
      body: JSON.stringify({ memberIds: [newUserId] }),
    });
    setNewUserId('');
    await reload();
    await open(conv);
  }

  const lastOwnMessage = [...messages].reverse().find((m) => m.userIdFrom === myId && !m.localStatus);
  const seenByAllOthers = Boolean(
    active && lastOwnMessage
      && active.members.filter((memberId) => memberId !== myId)
        .every((memberId) => (readMarkers[memberId] ?? 0) >= lastOwnMessage.seq),
  );
  const typingNames = Object.keys(typingUsers).filter((userId) => typingUsers[userId]);

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
                  {c.name ?? t('conversationWithUser', { members: c.members.join(', ') })}
                  {(c.unread ?? 0) > 0 ? t('unreadSuffix', { count: c.unread }) : ''}
                </Button>
                {c.lastMessage ? (
                  <p className="truncate text-xs text-muted-foreground">{c.lastMessage.fullMessage}</p>
                ) : null}
              </li>
            ))}
          </ul>
          <form onSubmit={(e) => void startConversation(e)} className="space-y-2">
            <Label htmlFor="new-user">{t('newConversationWith')}</Label>
            <Input id="new-user" value={newUserId} onChange={(e) => setNewUserId(e.target.value)} />
            <Button type="submit">{t('start')}</Button>
          </form>
          <div className="space-y-2">
            <h3 className="font-medium">{t('blockedContactsTitle')}</h3>
            {blockMessage ? <p role="status">{blockMessage}</p> : null}
            <ul className="space-y-1">
              {blocked.map((userId) => (
                <li key={userId} data-testid={`blocked-${userId}`} className="flex items-center gap-2">
                  <span className="text-sm">{userId}</span>
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
                          {memberId} {t('blockedSuffix')}
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
              {hasMoreBefore ? (
                <Button type="button" variant="outline" onClick={() => void loadOlder()}>
                  {t('loadOlderMessages')}
                </Button>
              ) : null}
              <ul className="space-y-2" aria-label={t('messagesListLabel')}>
                {messages.map((m) => (
                  <li key={m.id} className="rounded border p-2">
                    <p className="text-xs text-muted-foreground">
                      {t('messageFromUser', { userId: m.userIdFrom, time: new Date(m.createdAt).toLocaleString() })}
                    </p>
                    <p>{m.fullMessage}</p>
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
                  </li>
                ))}
              </ul>
              {seenByAllOthers ? (
                <p data-testid="seen-status" className="text-xs text-muted-foreground">{t('seenByMembers')}</p>
              ) : null}
              {typingNames.map((userId) => (
                <p key={userId} data-testid="typing-indicator" className="text-xs text-muted-foreground">
                  {t('typingIndicator', { userId })}
                </p>
              ))}
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

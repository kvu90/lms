import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '#lib/api';
import { useAuth } from '#lib/auth';

interface ConversationView {
  id: string;
  type: number;
  name: string | null;
  members: string[];
}
interface MessageView {
  id: string;
  userIdFrom: string;
  fullMessage: string;
  createdAt: string;
}
/** Chi tiết conversation theo API: conversation kèm danh sách tin nhắn. */
interface ConversationDetailView extends ConversationView {
  messages: MessageView[];
}

/**
 * Messages: conversation list with unread count, message thread and
 * sending. Messages are immutable once sent — the API rejects edits, and
 * this UI offers no edit affordance at all. Trang còn quản lý chặn liên
 * lạc: chặn/bỏ chặn người đối thoại trong cuộc trò chuyện đang mở và xem
 * danh sách đã chặn (GET/POST/DELETE /messages/contacts...).
 */
export function MessagesPage() {
  const { t } = useTranslation('app');
  const { user } = useAuth();
  const [conversations, setConversations] = useState<ConversationView[]>([]);
  const [unread, setUnread] = useState(0);
  const [active, setActive] = useState<ConversationView | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [draft, setDraft] = useState('');
  const [newUserId, setNewUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [blockMessage, setBlockMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [list, count, blockedRes] = await Promise.all([
      apiJson<ConversationView[]>('/api/v1/messages/conversations'),
      apiJson<{ conversations: number; notifications: number }>('/api/v1/messages/unread-count'),
      apiJson<{ blocked: string[] }>('/api/v1/messages/contacts/blocked'),
    ]);
    setConversations(list);
    setUnread(count.conversations);
    setBlocked(blockedRes.blocked);
  }, []);

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

  async function open(conv: ConversationView) {
    setActive(conv);
    const detail = await apiJson<ConversationDetailView>(`/api/v1/messages/conversations/${conv.id}`);
    setMessages(detail.messages);
    await apiJson(`/api/v1/messages/conversations/${conv.id}/read`, { method: 'POST', body: '{}' }).catch(
      () => undefined,
    );
    await reload().catch(() => undefined);
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!active || !draft.trim()) return;
    await apiJson(`/api/v1/messages/conversations/${active.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text: draft }),
    });
    setDraft('');
    await open(active);
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
                </Button>
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
                  .map((memberId) =>
                    blocked.includes(memberId) ? (
                      <span key={memberId} className="flex items-center gap-2 text-sm">
                        {memberId} {t('blockedSuffix')}
                        <Button type="button" variant="outline" onClick={() => void unblockContact(memberId)}>
                          {t('unblockContact')}
                        </Button>
                      </span>
                    ) : (
                      <Button
                        key={memberId}
                        type="button"
                        variant="outline"
                        onClick={() => void blockContact(memberId)}
                      >
                        {t('blockContact')}
                      </Button>
                    ),
                  )}
              </div>
              <ul className="space-y-2" aria-label={t('messagesListLabel')}>
                {messages.map((m) => (
                  <li key={m.id} className="rounded border p-2">
                    <p className="text-xs text-muted-foreground">
                      {t('messageFromUser', { userId: m.userIdFrom, time: new Date(m.createdAt).toLocaleString() })}
                    </p>
                    <p>{m.fullMessage}</p>
                  </li>
                ))}
              </ul>
              <form onSubmit={(e) => void send(e)} className="flex gap-2">
                <Input aria-label={t('messageText')} value={draft} onChange={(e) => setDraft(e.target.value)} />
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

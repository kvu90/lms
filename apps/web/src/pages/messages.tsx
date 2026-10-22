import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiJson } from '@/lib/api';

interface ConversationView { id: number; type: number; name: string | null; members: number[] }
interface MessageView { id: number; useridfrom: number; fullmessage: string; timecreated: string }

/**
 * Messages (P4): conversation list with unread count, message thread and
 * sending. Messages are immutable once sent — the API rejects edits, and
 * this UI offers no edit affordance at all.
 */
export function MessagesPage() {
  const [conversations, setConversations] = useState<ConversationView[]>([]);
  const [unread, setUnread] = useState(0);
  const [active, setActive] = useState<ConversationView | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [draft, setDraft] = useState('');
  const [newUserId, setNewUserId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [list, count] = await Promise.all([
      apiJson<ConversationView[]>('/api/v1/messages/conversations'),
      apiJson<{ unread: number }>('/api/v1/messages/unread-count'),
    ]);
    setConversations(list);
    setUnread(count.unread);
  }, []);

  useEffect(() => { void reload().catch(() => setError('Could not load conversations')); }, [reload]);

  async function open(conv: ConversationView) {
    setActive(conv);
    const msgs = await apiJson<MessageView[]>(`/api/v1/messages/conversations/${conv.id}/messages`);
    setMessages(msgs);
    await apiJson(`/api/v1/messages/conversations/${conv.id}/read`, { method: 'POST', body: '{}' }).catch(() => undefined);
    await reload().catch(() => undefined);
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!active || !draft.trim()) return;
    await apiJson(`/api/v1/messages/conversations/${active.id}/messages`, {
      method: 'POST', body: JSON.stringify({ fullmessage: draft }),
    });
    setDraft('');
    await open(active);
  }

  async function startConversation(event: FormEvent) {
    event.preventDefault();
    const conv = await apiJson<ConversationView>('/api/v1/messages/conversations', {
      method: 'POST', body: JSON.stringify({ userids: [Number(newUserId)] }),
    });
    setNewUserId('');
    await reload();
    await open(conv);
  }

  return (
    <main className="mx-auto grid max-w-5xl gap-6 p-8 md:grid-cols-[1fr_2fr]">
      <Card>
        <CardHeader>
          <CardTitle>Messages {unread > 0 ? `(${unread} unread)` : ''}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {error ? <p role="alert">{error}</p> : null}
          <ul className="space-y-1">
            {conversations.map((c) => (
              <li key={c.id}>
                <Button type="button" variant={active?.id === c.id ? 'default' : 'outline'} onClick={() => void open(c)}>
                  {c.name ?? `Conversation with user ${c.members.join(', ')}`}
                </Button>
              </li>
            ))}
          </ul>
          <form onSubmit={(e) => void startConversation(e)} className="space-y-2">
            <Label htmlFor="new-user">New conversation with user id</Label>
            <Input id="new-user" value={newUserId} onChange={(e) => setNewUserId(e.target.value)} />
            <Button type="submit">Start</Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{active ? (active.name ?? 'Conversation') : 'Select a conversation'}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {active ? (
            <>
              <ul className="space-y-2" aria-label="Messages">
                {messages.map((m) => (
                  <li key={m.id} className="rounded border p-2">
                    <p className="text-xs text-muted-foreground">User {m.useridfrom} · {new Date(m.timecreated).toLocaleString()}</p>
                    <p>{m.fullmessage}</p>
                  </li>
                ))}
              </ul>
              <form onSubmit={(e) => void send(e)} className="flex gap-2">
                <Input aria-label="Message text" value={draft} onChange={(e) => setDraft(e.target.value)} />
                <Button type="submit">Send</Button>
              </form>
            </>
          ) : <p>Pick a conversation on the left to read and reply.</p>}
        </CardContent>
      </Card>
    </main>
  );
}

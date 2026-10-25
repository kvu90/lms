import { useState, type FormEvent } from 'react';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Input } from '@lms/ui/components/input';
import { useTranslation } from 'react-i18next';
import { apiJson } from '#lib/api';
import { dateLabel } from './shared';

/** Hội thoại phản hồi trên bài đã trả (học sinh ↔ giáo viên của bài đó). */
export function FeedbackMessages({
  assignmentId,
  userId,
  messages,
  onPosted,
}: {
  assignmentId: string;
  userId: string;
  messages: { id: string; authorId: string; body: string; createdAt: string }[];
  onPosted: () => Promise<void>;
}) {
  const { t } = useTranslation('app');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/api/v1/assignments/${assignmentId}/submissions/${userId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body: draft.trim() }),
      });
      setDraft('');
      await onPosted();
    } catch {
      setError(t('assignActionFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">{t('assignMessagesTitle')}</h4>
      {messages.length === 0 ? <p className="text-sm text-muted-foreground">{t('assignNoMessages')}</p> : null}
      <ul className="space-y-2">
        {messages.map((m) => (
          <li key={m.id} className="rounded bg-muted p-2 text-sm">
            <p>{m.body}</p>
            <p className="text-xs text-muted-foreground">{dateLabel(m.createdAt)}</p>
          </li>
        ))}
      </ul>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <form onSubmit={(e) => void send(e)} className="flex gap-2">
        <Input
          aria-label={t('assignMessagesTitle')}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('assignMessagePlaceholder')}
        />
        <Button type="submit" size="sm" disabled={busy}>
          {t('assignSendMessage')}
        </Button>
      </form>
    </div>
  );
}

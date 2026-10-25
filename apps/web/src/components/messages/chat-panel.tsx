import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { Avatar, AvatarFallback } from '@lms/ui/components/avatar';
import { Bubble, BubbleContent } from '@lms/ui/components/bubble';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Textarea } from '@lms/ui/components/textarea';
import {
  Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader,
} from '@lms/ui/components/message';
import {
  MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem,
  MessageScrollerProvider, MessageScrollerViewport,
} from '@lms/ui/components/message-scroller';
import { useTranslation } from 'react-i18next';
import { MESSAGING_MAX_MESSAGE_LENGTH_DEFAULT } from '@lms/contracts';
import type { ConversationView, MessageView } from './types';
import { countMessageCharacters, initialsOf } from './utils';

interface ChatPanelProps {
  active: ConversationView | null;
  myId: string | undefined;
  onlineUsers: Record<string, boolean>;
  blocked: string[];
  onUnblockContact: (userId: string) => void;
  onBlockContact: (userId: string) => void;
  onReportConversation: () => void;
  onToggleChat: () => void;
  reportMessage: string | null;
  actionMessage: string | null;
  hasMoreBefore: boolean;
  onLoadOlder: () => void;
  selectedForBulk: Set<string>;
  setSelectedForBulk: Dispatch<SetStateAction<Set<string>>>;
  onBulkRemove: () => void;
  visibleMessages: MessageView[];
  nameOf: (userId: string) => string;
  onRetrySend: (message: MessageView) => void;
  onDeleteMessage: (message: MessageView) => void;
  canRecall: (message: MessageView) => boolean;
  onRecallMessage: (message: MessageView) => void;
  onHardDeleteMessage: (message: MessageView) => void;
  seenByAllOthers: boolean;
  typingNames: string[];
  draft: string;
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  onNoteTyping: () => void;
  onSend: (event: FormEvent) => void;
  sendError: string | null;
}

/** Cột phải trang Tin nhắn: khung hội thoại đang mở (thành viên, luồng tin, soạn tin). */
export function ChatPanel({
  active, myId, onlineUsers, blocked, onUnblockContact, onBlockContact, onReportConversation,
  onToggleChat, reportMessage, actionMessage, hasMoreBefore, onLoadOlder, selectedForBulk,
  setSelectedForBulk, onBulkRemove, visibleMessages, nameOf, onRetrySend, onDeleteMessage,
  canRecall, onRecallMessage, onHardDeleteMessage, seenByAllOthers, typingNames, draft,
  setDrafts, onNoteTyping, onSend, sendError,
}: ChatPanelProps) {
  const { t } = useTranslation('app');
  const unblockContact = onUnblockContact;
  const blockContact = onBlockContact;
  const reportActiveConversation = onReportConversation;
  const toggleActiveChat = onToggleChat;
  const loadOlder = onLoadOlder;
  const bulkRemoveSelected = onBulkRemove;
  const retrySend = onRetrySend;
  const deleteMessage = onDeleteMessage;
  const recallMessage = onRecallMessage;
  const hardDeleteMessage = onHardDeleteMessage;
  const noteTyping = onNoteTyping;
  const send = onSend;
  return (
      <Card className="md:col-span-2">
        <CardHeader>
          <CardTitle>{active ? (active.name ?? t('conversationFallback')) : t('selectConversation')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {active ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {active.members
                  .filter((memberId) => memberId !== myId)
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
              {active.canModerate && selectedForBulk.size > 0 ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">{t('bulkSelectedCount', { count: selectedForBulk.size })}</span>
                  <Button type="button" variant="destructive" onClick={() => void bulkRemoveSelected()}>
                    {t('bulkRemoveMessages')}
                  </Button>
                </div>
              ) : null}
              <MessageScrollerProvider key={active.id} autoScroll defaultScrollPosition="end">
                <MessageScroller className="h-[30rem] rounded-md border">
                  <MessageScrollerViewport aria-label={t('messagesListLabel')}>
                    <MessageScrollerContent className="gap-4 p-4">
                      {visibleMessages.map((m) => {
                        const mine = m.userIdFrom === myId;
                        return (
                          <MessageScrollerItem key={m.id} messageId={m.id} scrollAnchor={mine}>
                            <Message align={mine ? 'end' : 'start'}>
                              <MessageAvatar>
                                <Avatar>
                                  <AvatarFallback>{initialsOf(nameOf(m.userIdFrom))}</AvatarFallback>
                                </Avatar>
                              </MessageAvatar>
                              <MessageContent>
                                {!mine ? <MessageHeader>{nameOf(m.userIdFrom)}</MessageHeader> : null}
                                <Bubble
                                  variant={m.deletedAt || m.recalledAt ? 'destructive' : mine ? 'default' : 'muted'}
                                  align={mine ? 'end' : 'start'}
                                >
                                  <BubbleContent>{m.recalledAt ? t('messageRecalled') : m.fullMessage}</BubbleContent>
                                </Bubble>
                                <MessageFooter className="flex-wrap gap-2">
                                  <span>{new Date(m.createdAt).toLocaleString()}</span>
                                  {m.deletedAt ? (
                                    <span className="italic">
                                      {t('messageDeletedBy', { userId: m.deletedBy ? nameOf(m.deletedBy) : '' })}
                                    </span>
                                  ) : null}
                                  {m.recalledAt ? (
                                    <span className="italic">
                                      {t('messageRecalledBy', { userId: m.recalledBy ? nameOf(m.recalledBy) : '' })}
                                    </span>
                                  ) : null}
                                  {m.localStatus === 'sending' ? <span>{t('messageSending')}</span> : null}
                                  {m.localStatus === 'failed' ? (
                                    <span className="flex items-center gap-2">
                                      <span>{t('messageSendFailed')}</span>
                                      <Button type="button" variant="outline" onClick={() => void retrySend(m)}>
                                        {t('retrySend')}
                                      </Button>
                                    </span>
                                  ) : null}
                                  {!m.deletedAt && !m.localStatus && m.userIdFrom === myId ? (
                                    <Button type="button" variant="outline" onClick={() => void deleteMessage(m)}>
                                      {t('deleteMessage')}
                                    </Button>
                                  ) : null}
                                  {canRecall(m) ? (
                                    <Button type="button" variant="outline" onClick={() => void recallMessage(m)}>
                                      {t('recallMessage')}
                                    </Button>
                                  ) : null}
                                  {active.canModerate && !m.localStatus ? (
                                    <>
                                      <input
                                        type="checkbox"
                                        aria-label={t('selectMessageForBulk')}
                                        checked={selectedForBulk.has(m.id)}
                                        onChange={() => setSelectedForBulk((prev) => {
                                          const next = new Set(prev);
                                          if (next.has(m.id)) next.delete(m.id);
                                          else next.add(m.id);
                                          return next;
                                        })}
                                      />
                                      <Button type="button" variant="destructive" onClick={() => void hardDeleteMessage(m)}>
                                        {t('hardDeleteMessage')}
                                      </Button>
                                    </>
                                  ) : null}
                                </MessageFooter>
                              </MessageContent>
                            </Message>
                          </MessageScrollerItem>
                        );
                      })}
                    </MessageScrollerContent>
                  </MessageScrollerViewport>
                  <MessageScrollerButton />
                </MessageScroller>
              </MessageScrollerProvider>
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
                    <Textarea
                      aria-label={t('messageText')}
                      value={draft}
                      onChange={(e) => {
                        // Nháp ghi theo conversation đang mở (lát M1,
                        // issue #204) — soạn dở ở conversation này
                        // không lẫn sang conversation khác.
                        setDrafts((prev) => ({ ...prev, [active.id]: e.target.value }));
                        noteTyping();
                      }}
                      onKeyDown={(e) => {
                        // Enter gửi, Shift+Enter xuống dòng (lát M1,
                        // issue #204) — ngữ nghĩa chuẩn app nhắn tin
                        // cho composer nhiều dòng.
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          e.currentTarget.form?.requestSubmit();
                        }
                      }}
                    />
                    <Button type="submit">{t('send')}</Button>
                  </form>
                  <div className="flex items-center justify-between gap-2">
                    {sendError ? (
                      <p role="alert" className="text-sm text-destructive">{sendError}</p>
                    ) : (
                      <span />
                    )}
                    <p
                      data-testid="message-char-count"
                      className={countMessageCharacters(draft) > MESSAGING_MAX_MESSAGE_LENGTH_DEFAULT
                        ? 'text-xs text-destructive'
                        : 'text-xs text-muted-foreground'}
                    >
                      {countMessageCharacters(draft)}/{MESSAGING_MAX_MESSAGE_LENGTH_DEFAULT}
                    </p>
                  </div>
                </>
              )}
            </>
          ) : (
            <p>{t('pickConversation')}</p>
          )}
        </CardContent>
      </Card>
  );
}

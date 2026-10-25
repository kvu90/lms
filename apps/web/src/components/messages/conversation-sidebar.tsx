import { Avatar, AvatarFallback } from '@lms/ui/components/avatar';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { useTranslation } from 'react-i18next';
import type {
  ContactRequestView,
  ConversationView,
  MessagingCourse,
  RosterMember,
} from './types';
import { initialsOf, relativeTime } from './utils';

interface ConversationSidebarProps {
  conversations: ConversationView[];
  active: ConversationView | null;
  unread: number;
  error: string | null;
  onOpenConversation: (conversation: ConversationView) => void;
  nameOf: (userId: string) => string;
  myCourses: MessagingCourse[];
  rosterCourseId: string | null;
  rosterMembers: RosterMember[];
  rosterError: string | null;
  rosterCursor: string | null;
  onOpenRoster: (courseId: string) => void;
  onLoadMoreRoster: () => void;
  onMessageContact: (userId: string) => void;
  onSendContactRequest: (userId: string) => void;
  onRespondContactRequest: (userId: string, action: 'accept' | 'decline') => void;
  contacts: string[];
  contactMessage: string | null;
  incomingRequests: ContactRequestView[];
  outgoingRequests: ContactRequestView[];
  blocked: string[];
  blockMessage: string | null;
  onUnblockContact: (userId: string) => void;
}

/** Cột trái trang Tin nhắn: danh sách cuộc trò chuyện + tìm bạn theo khoá + danh bạ + đã chặn. */
export function ConversationSidebar({
  conversations, active, unread, error, onOpenConversation, nameOf, myCourses, rosterCourseId,
  rosterMembers, rosterError, rosterCursor, onOpenRoster, onLoadMoreRoster, onMessageContact,
  onSendContactRequest, onRespondContactRequest, contacts, contactMessage, incomingRequests,
  outgoingRequests, blocked, blockMessage, onUnblockContact,
}: ConversationSidebarProps) {
  const { t } = useTranslation('app');
  const open = onOpenConversation;
  const openRoster = onOpenRoster;
  const loadMoreRoster = onLoadMoreRoster;
  const messageContact = onMessageContact;
  const sendContactRequestTo = onSendContactRequest;
  const respondContactRequest = onRespondContactRequest;
  const unblockContact = onUnblockContact;
  return (
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
                  <p className="flex items-baseline gap-2 text-xs text-muted-foreground">
                    <span className="truncate">{c.lastMessage.fullMessage}</span>
                    <span className="shrink-0" data-testid={`conversation-last-time-${c.id}`}>
                      {relativeTime(c.lastMessage.createdAt, t)}
                    </span>
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="space-y-2">
            <h3 className="font-medium">{t('findFriendsTitle')}</h3>
            <p className="text-sm text-muted-foreground">{t('findFriendsHint')}</p>
            {myCourses.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('myCoursesEmpty')}</p>
            ) : (
              <ul className="space-y-1">
                {myCourses.map((c) => (
                  <li key={c.courseId}>
                    <Button
                      type="button"
                      variant={rosterCourseId === c.courseId ? 'default' : 'outline'}
                      onClick={() => void openRoster(c.courseId)}
                    >
                      {c.fullName}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {rosterError ? <p role="alert">{rosterError}</p> : null}
            {rosterCourseId ? (
              rosterMembers.length > 0 ? (
                <ul className="space-y-1">
                  {rosterMembers.map((m) => (
                    <li key={m.userId} data-testid={`roster-member-${m.userId}`} className="flex items-center gap-2">
                      <Avatar>
                        <AvatarFallback>{initialsOf(m.displayName)}</AvatarFallback>
                      </Avatar>
                      <span className="text-sm">
                        {m.displayName} <span className="text-muted-foreground">@{m.username}</span>
                      </span>
                      <Badge variant="secondary">
                        {m.role === 'teacher' ? t('rosterTeacher') : t('rosterStudent')}
                      </Badge>
                      {m.canDirectMessage && m.relationship !== 'contact' ? (
                        <Button type="button" variant="outline" onClick={() => void messageContact(m.userId)}>
                          {t('messageWithContact')}
                        </Button>
                      ) : null}
                      {m.relationship === 'none' ? (
                        <Button type="button" variant="outline" onClick={() => void sendContactRequestTo(m.userId)}>
                          {t('addContact')}
                        </Button>
                      ) : null}
                      {m.relationship === 'pending_outgoing' ? (
                        <span className="text-sm text-muted-foreground">{t('contactRequestPendingSuffix')}</span>
                      ) : null}
                      {m.relationship === 'pending_incoming' ? (
                        <>
                          <Button type="button" variant="outline" onClick={() => void respondContactRequest(m.userId, 'accept')}>
                            {t('acceptContactRequest')}
                          </Button>
                          <Button type="button" variant="outline" onClick={() => void respondContactRequest(m.userId, 'decline')}>
                            {t('declineContactRequest')}
                          </Button>
                        </>
                      ) : null}
                      {m.relationship === 'contact' ? (
                        <Button type="button" variant="outline" onClick={() => void messageContact(m.userId)}>
                          {t('messageWithContact')}
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{t('rosterEmpty')}</p>
              )
            ) : null}
            {rosterCourseId && rosterCursor ? (
              <Button type="button" variant="outline" onClick={() => void loadMoreRoster()}>
                {t('rosterLoadMore')}
              </Button>
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
  );
}

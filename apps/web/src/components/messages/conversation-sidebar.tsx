import { useState } from 'react';
import { BellOff, Pin } from 'lucide-react';
import { Avatar, AvatarFallback } from '@lms/ui/components/avatar';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@lms/ui/components/dropdown-menu';
import { Input } from '@lms/ui/components/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@lms/ui/components/tabs';
import { cn } from '@lms/ui/lib/utils';
import { useTranslation } from 'react-i18next';
import type {
  ContactRequestView,
  ConversationStatePatch,
  ConversationView,
  MessagingCourse,
  RosterMember,
} from './types';
import { initialsOf, relativeTime } from './utils';

interface ConversationSidebarProps {
  conversations: ConversationView[];
  /** Mục ĐÃ LƯU (lát M5): danh sách riêng của server, nạp khi mở tab. */
  archivedConversations: ConversationView[];
  /** Nạp (lại) mục đã lưu từ server — gọi mỗi khi người dùng mở tab Đã lưu trữ. */
  onRequestArchived: () => void;
  active: ConversationView | null;
  unread: number;
  error: string | null;
  myId: string | undefined;
  onlineUsers: Record<string, boolean>;
  onOpenConversation: (conversation: ConversationView) => void;
  /** Đặt một cờ trạng thái cá nhân (ghim/lưu/tắt tiếng) cho một cuộc trò chuyện (lát M5). */
  onUpdateConversationState: (conversation: ConversationView, patch: ConversationStatePatch) => void;
  /** Lỗi của lần đổi trạng thái gần nhất (lát M5); null khi không có. */
  stateError: string | null;
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

type ConversationFilterChip = 'all' | 'unread' | 'groups';

/**
 * Khung trái màn Tin nhắn (issue #256): ba tab theo chuẩn app nhắn
 * tin — Trò chuyện (danh sách hội thoại + chip lọc), Danh bạ (liên
 * hệ, yêu cầu chờ, roster khoá/lớp, đã chặn) và Đã lưu trữ. Danh sách
 * chính và mục đã lưu là hai danh sách riêng của server (lát M5);
 * chuyển tab Đã lưu trữ là xin nạp lại mục đó cho tươi.
 */
export function ConversationSidebar({
  conversations, archivedConversations, onRequestArchived, active, unread, error, myId, onlineUsers,
  onOpenConversation, onUpdateConversationState, stateError, nameOf, myCourses, rosterCourseId,
  rosterMembers, rosterError, rosterCursor, onOpenRoster, onLoadMoreRoster, onMessageContact,
  onSendContactRequest, onRespondContactRequest, contacts, contactMessage, incomingRequests,
  outgoingRequests, blocked, blockMessage, onUnblockContact,
}: ConversationSidebarProps) {
  const { t } = useTranslation('app');
  const open = onOpenConversation;
  const openRoster = onOpenRoster;
  const loadMoreRoster = onLoadMoreRoster;
  /** Nhắn tin từ Danh bạ thì khung trái tự về tab Trò chuyện để thấy hội thoại vừa mở. */
  const messageContact = (userId: string) => {
    setTab('chats');
    onMessageContact(userId);
  };
  const sendContactRequestTo = onSendContactRequest;
  const respondContactRequest = onRespondContactRequest;
  const unblockContact = onUnblockContact;
  const [tab, setTab] = useState('chats');
  const [chip, setChip] = useState<ConversationFilterChip>('all');
  /**
   * Lọc danh sách hội thoại theo TÊN HIỂN THỊ (lát M4, issue #237):
   * lọc ngay tại client trên danh sách đã tải — tên hiển thị là đúng
   * chuỗi người dùng thấy (tên hội thoại hoặc tên các thành viên),
   * khớp chuỗi con không phân biệt hoa thường. Chỉ lọc hội thoại ĐÃ
   * CÓ — không phải tìm người theo tên.
   */
  const [conversationFilter, setConversationFilter] = useState('');
  const labelOf = (c: ConversationView) =>
    c.name ?? t('conversationWithUser', { members: c.members.map((id) => nameOf(id)).join(', ') });
  const filterNeedle = conversationFilter.trim().toLocaleLowerCase('vi');
  const matchesFilter = (c: ConversationView) =>
    !filterNeedle || labelOf(c).toLocaleLowerCase('vi').includes(filterNeedle);
  const visibleConversations = conversations.filter(matchesFilter).filter((c) => {
    if (chip === 'unread') return (c.unread ?? 0) > 0;
    if (chip === 'groups') return c.type === 2;
    return true;
  });
  const visibleArchived = archivedConversations.filter(matchesFilter);

  /** Một dòng hội thoại chuẩn app nhắn tin: avatar + tên + trích đoạn/giờ + huy hiệu + menu trạng thái M5. */
  const renderConversationItem = (c: ConversationView) => {
    const isActive = active?.id === c.id;
    const otherId = c.type === 1 ? c.members.find((id) => id !== myId) : undefined;
    const otherOnline = otherId ? Boolean(onlineUsers[otherId]) : false;
    const avatarLabel = c.name ?? (otherId ? nameOf(otherId) : labelOf(c));
    const unreadCount = c.unread ?? 0;
    return (
      <li key={c.id}>
        <div className={cn('flex items-start gap-0.5 rounded-lg', isActive && 'bg-muted')}>
          <button
            type="button"
            aria-current={isActive || undefined}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-muted"
            onClick={() => void open(c)}
          >
            <span className="relative shrink-0">
              <Avatar>
                <AvatarFallback>{initialsOf(avatarLabel)}</AvatarFallback>
              </Avatar>
              {otherOnline ? (
                <span className="absolute right-0 bottom-0 size-2.5 rounded-full bg-emerald-500 ring-2 ring-background" />
              ) : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className={cn('min-w-0 flex-1 truncate text-sm', unreadCount > 0 && !c.muted && 'font-semibold')}>
                  {labelOf(c)}
                </span>
                {c.lastMessage ? (
                  <span className="shrink-0 text-xs text-muted-foreground" data-testid={`conversation-last-time-${c.id}`}>
                    {relativeTime(c.lastMessage.createdAt, t)}
                  </span>
                ) : null}
              </span>
              <span className="mt-0.5 flex items-center gap-1.5">
                {c.lastMessage ? (
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {c.lastMessage.userIdFrom === myId ? `${t('lastMessageOwnPrefix')} ` : ''}
                    {c.lastMessage.fullMessage}
                  </span>
                ) : (
                  <span className="min-w-0 flex-1" />
                )}
                {c.pinnedAt ? (
                  <Pin data-testid={`conversation-pinned-${c.id}`} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                ) : null}
                {c.muted ? (
                  <BellOff data-testid={`conversation-muted-${c.id}`} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                ) : null}
                {unreadCount > 0
                  ? c.muted
                    ? <span className="shrink-0 text-xs opacity-60">{t('unreadSuffix', { count: unreadCount })}</span>
                    : (
                      <>
                        <Badge className="shrink-0">{unreadCount}</Badge>
                        <span className="sr-only">{t('unreadSuffix', { count: unreadCount })}</span>
                      </>
                    )
                  : null}
              </span>
            </span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('conversationActionsLabel')}
                  data-testid={`conversation-actions-${c.id}`}
                />
              }
            >
              …
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={4}>
              <DropdownMenuItem onClick={() => onUpdateConversationState(c, { pinned: !c.pinnedAt })}>
                {c.pinnedAt ? t('unpinConversation') : t('pinConversation')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onUpdateConversationState(c, { archived: !c.archivedAt })}>
                {c.archivedAt ? t('unarchiveConversation') : t('archiveConversation')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onUpdateConversationState(c, { muted: !c.muted })}>
                {c.muted ? t('unmuteConversation') : t('muteConversation')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </li>
    );
  };

  const chips: { key: ConversationFilterChip; label: string }[] = [
    { key: 'all', label: t('messagesFilterAll') },
    { key: 'unread', label: t('messagesFilterUnread') },
    { key: 'groups', label: t('messagesFilterGroups') },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-4 pt-3">
        <h2 className="text-base font-semibold">
          {t('messagesTitle')} {unread > 0 ? t('unreadSuffix', { count: unread }) : ''}
        </h2>
      </div>
      {error ? <p role="alert" className="px-4 pt-2 text-sm">{error}</p> : null}
      {stateError ? <p role="alert" className="px-4 pt-2 text-sm">{stateError}</p> : null}
      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value);
          if (value === 'archived') onRequestArchived();
        }}
        className="min-h-0 flex-1 px-2 pt-2"
      >
        <TabsList className="w-full">
          <TabsTrigger value="chats">{t('messagesTabChats')}</TabsTrigger>
          <TabsTrigger value="contacts">{t('messagesTabContacts')}</TabsTrigger>
          <TabsTrigger value="archived">{t('archivedConversationsTitle')}</TabsTrigger>
        </TabsList>
        <TabsContent value="chats" className="flex min-h-0 flex-1 flex-col">
          <div className="space-y-2 px-2 pt-1">
            <Input
              type="search"
              aria-label={t('conversationSearchLabel')}
              placeholder={t('conversationSearchPlaceholder')}
              value={conversationFilter}
              onChange={(e) => setConversationFilter(e.target.value)}
            />
            <div className="flex flex-wrap gap-1.5">
              {chips.map(({ key, label }) => (
                <Button
                  key={key}
                  type="button"
                  size="sm"
                  variant={chip === key ? 'default' : 'outline'}
                  aria-pressed={chip === key}
                  className="rounded-full"
                  onClick={() => setChip(key)}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1 py-2">
            {visibleConversations.length === 0 ? (
              <p className="px-2 text-sm text-muted-foreground">
                {filterNeedle
                  ? t('conversationSearchNoResults')
                  : chip === 'unread'
                    ? t('conversationsUnreadEmpty')
                    : chip === 'groups'
                      ? t('conversationsGroupsEmpty')
                      : t('conversationsEmpty')}
              </p>
            ) : (
              <ul className="space-y-0.5">{visibleConversations.map(renderConversationItem)}</ul>
            )}
          </div>
        </TabsContent>
        <TabsContent value="contacts" className="min-h-0 flex-1 overflow-y-auto">
          <div className="space-y-5 px-2 py-2">
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
          </div>
        </TabsContent>
        <TabsContent value="archived" className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-1 py-2">
            {visibleArchived.length === 0 ? (
              <p className="px-2 text-sm text-muted-foreground">{t('archivedEmpty')}</p>
            ) : (
              <ul className="space-y-0.5">{visibleArchived.map(renderConversationItem)}</ul>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

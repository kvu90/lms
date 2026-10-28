import { useEffect, useState, type Dispatch, type FormEvent, type ReactNode, type RefObject, type SetStateAction } from 'react';
import { ArrowLeft, Ellipsis, Eraser, Info, MessageCircle, Reply, Search, Trash, Undo2 } from 'lucide-react';
import { Avatar, AvatarFallback } from '@lms/ui/components/avatar';
import { Bubble, BubbleContent } from '@lms/ui/components/bubble';
import { Button } from '@lms/ui/components/button';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger,
} from '@lms/ui/components/dropdown-menu';
import { Input } from '@lms/ui/components/input';
import { Textarea } from '@lms/ui/components/textarea';
import {
  Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader,
} from '@lms/ui/components/message';
import {
  MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem,
  MessageScrollerProvider, MessageScrollerViewport, useMessageScroller,
} from '@lms/ui/components/message-scroller';
import { useTranslation } from 'react-i18next';
import { MESSAGING_MAX_MESSAGE_LENGTH_DEFAULT } from '@lms/contracts';

import { formatDate, formatDateTime } from '#lib/date-format';
import type { ConversationView, MessageQuoteView, MessageSearchResultView, MessageView, ScrollerHandle } from './types';
import { MemberActionMenu, MemberPanel, MemberProfileSheet, useMemberProfile, type MemberPanelBundle } from './member-panel';
import { CHAT_MENU_CONTENT_CLASS, CHAT_MENU_ITEM_CLASS, countMessageCharacters, initialsOf, quoteExcerptOfText } from './utils';

/**
 * Cầu nối tới handle cuộn của MessageScroller: hook chỉ gọi được
 * trong cây của Provider nên một component con không-render giữ
 * handle vào ref của trang — nút trích dẫn ở bong bóng dùng ref này
 * để nhảy tới tin gốc (lát M3).
 */
function ScrollerBridge({ bridgeRef }: { bridgeRef: RefObject<ScrollerHandle | null> }) {
  const scroller = useMessageScroller();
  useEffect(() => {
    bridgeRef.current = scroller;
    return () => { bridgeRef.current = null; };
  }, [scroller, bridgeRef]);
  return null;
}

interface ChatPanelProps {
  active: ConversationView | null;
  myId: string | undefined;
  onlineUsers: Record<string, boolean>;
  /** Mốc đã đọc theo từng thành viên của conversation đang mở (memberReadMarkers của API) — nguồn cho panel thông tin "ai đã xem" (N7). */
  readMarkers: Record<string, number>;
  /** Quay lại danh sách hội thoại (chỉ hiện nút ở mobile, issue #256). */
  onBack: () => void;
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
  /** Conversation đang mở đang có lượt gửi bay (fix nhân đôi tin, issue #33): composer vô hiệu đường gửi trong lúc này. */
  sendInFlight: boolean;
  /** Lát M3 (issue #229): đích trích đang chờ gửi + các thao tác trích dẫn. */
  replyTarget: MessageView | null;
  onStartReply: (message: MessageView) => void;
  onCancelReply: () => void;
  onJumpToQuote: (quote: MessageQuoteView) => void;
  highlightedMessageId: string | null;
  scrollerRef: RefObject<ScrollerHandle | null>;
  /** Lát M4 (issue #237): tìm nội dung tin trong conversation đang mở. */
  messageSearch: {
    query: string;
    results: MessageSearchResultView[];
    loading: boolean;
    failed: boolean;
    submitted: boolean;
  };
  onSearchMessages: (query: string) => void;
  onClearMessageSearch: () => void;
  onJumpToSearchResult: (result: MessageSearchResultView) => void;
  /**
   * Gói PANEL THÀNH VIÊN (lát MSG-T4): ngữ cảnh roster + các dòng
   * thành viên trang đã nạp cho conversation đang mở, kèm các sự
   * kiện thao tác trên thành viên. Null khi conversation không phải
   * hội thoại nhóm hoặc trang chưa xác định được ngữ cảnh.
   */
  memberPanel: MemberPanelBundle | null;
}

/** Khung phải màn Tin nhắn (issue #256): header hội thoại + luồng tin + composer dính đáy. */
export function ChatPanel({
  active, myId, onlineUsers, readMarkers, onBack, blocked, onUnblockContact, onBlockContact, onReportConversation,
  onToggleChat, reportMessage, actionMessage, hasMoreBefore, onLoadOlder, selectedForBulk,
  setSelectedForBulk, onBulkRemove, visibleMessages, nameOf, onRetrySend, onDeleteMessage,
  canRecall, onRecallMessage, onHardDeleteMessage, seenByAllOthers, typingNames, draft,
  setDrafts, onNoteTyping, onSend, sendError, sendInFlight,
  replyTarget, onStartReply, onCancelReply, onJumpToQuote, highlightedMessageId, scrollerRef,
  messageSearch, onSearchMessages, onClearMessageSearch, onJumpToSearchResult, memberPanel,
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
  /** Ô nhập từ khoá tìm trong conversation (lát M4): nháp cục bộ của panel, gửi lên trang chạy tìm. */
  const [searchDraft, setSearchDraft] = useState('');
  /** Tìm trong hội thoại ẩn sau nút bật/tắt ở header (chuẩn app nhắn tin, issue #256). */
  const [searchOpen, setSearchOpen] = useState(false);
  /** Panel thông tin cuộc trò chuyện (thành viên + ai đã xem, N7) — bật/tắt ở header. */
  const [infoOpen, setInfoOpen] = useState(false);
  /** Hồ sơ rút gọn của thành viên đang xem từ menu avatar/tên (lát MSG-T4) — một sheet dùng chung cho cả panel và dòng tin. */
  const memberProfile = useMemberProfile();
  useEffect(() => {
    setSearchOpen(false);
    setInfoOpen(false);
    setSearchDraft('');
  }, [active?.id]);

  if (!active) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <MessageCircle className="size-10 text-muted-foreground" aria-hidden />
        <p className="font-medium">{t('selectConversation')}</p>
        <p className="text-sm text-muted-foreground">{t('pickConversation')}</p>
      </div>
    );
  }

  const others = active.members.filter((memberId) => memberId !== myId);
  const isGroup = active.type === 2;
  const otherId = !isGroup ? others[0] : undefined;
  const otherOnline = otherId ? Boolean(onlineUsers[otherId]) : false;
  const title = active.name ?? t('conversationWithUser', { members: active.members.map((id) => nameOf(id)).join(', ') });
  const avatarLabel = active.name ?? (otherId ? nameOf(otherId) : title);
  const subtitle = typingNames.length > 0
    ? t('typingIndicator', { userId: nameOf(typingNames[0]!) })
    : isGroup
      ? t('conversationMembersCount', { count: active.members.length })
      : otherOnline
        ? t('onlineNow')
        : '';
  /** Seq tin mới nhất đang có — mốc so "đã xem" của từng thành viên ở panel thông tin. */
  const newestSeq = visibleMessages.reduce((max, m) => Math.max(max, m.seq), 0) || active.lastMessageSeq || 0;
  /**
   * Dòng panel theo từng thành viên (lát MSG-T4): avatar trên dòng
   * tin tra ở đây để mở đúng menu quan hệ của tác giả tin; tác giả
   * không còn trong danh sách thành viên (đã rời nhóm…) thì avatar
   * giữ dạng tĩnh như trước.
   */
  const panelEntryById = new Map((memberPanel?.entries ?? []).map((entry) => [entry.userId, entry]));
  /**
   * Gói panel BỔ SUNG chặn/bỏ chặn (quyết định 23:16 ngày
   * 26/10/2026, sổ quyết định mục D): chặn là hành động theo từng
   * người — ở chat nhóm nó đi qua menu hành động của thành viên,
   * không còn nằm ở thanh header. Trang chỉ đưa handler chặn xuống
   * ChatPanel (props `blocked`/`onBlockContact`/`onUnblockContact`),
   * nên khung chat luồn chúng vào gói panel tại đây để MemberPanel
   * và menu trên avatar dòng tin dùng chung một đường, thay vì sửa
   * bề mặt dựng gói ở trang.
   */
  const memberPanelBundle: MemberPanelBundle | null = memberPanel
    ? {
      ...memberPanel,
      blockedIds: new Set(blocked),
      onBlockContact: blockContact,
      onUnblockContact: unblockContact,
    }
    : null;
  /**
   * Id tin CUỐI CÙNG trong danh sách đang xem — căn cứ cho quy tắc
   * "dòng thời gian chỉ hiện ở tin nhắn cuối" (cùng quyết 23:16 ở
   * trên): footer giờ chỉ render ở tin này; tin khác chỉ còn footer
   * khi mang ghi chú trạng thái gắn riêng của chính nó.
   */
  const lastVisibleMessageId = visibleMessages[visibleMessages.length - 1]?.id;

  const dayKeyOf = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  };
  const dayLabelOf = (iso: string) => {
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diffDays = Math.round((startOfDay(new Date()) - startOfDay(new Date(iso))) / 86_400_000);
    if (diffDays <= 0) return t('messagesToday');
    if (diffDays === 1) return t('messagesYesterday');
    return formatDate(iso);
  };
  /** Luồng tin kèm ngăn cách theo ngày (chuẩn app nhắn tin): pill ngày chèn trước tin đầu tiên của mỗi ngày. */
  const threadItems: ReactNode[] = [];
  let lastDayKey = '';
  for (const m of visibleMessages) {
    const dayKey = dayKeyOf(m.createdAt);
    if (dayKey !== lastDayKey) {
      lastDayKey = dayKey;
      threadItems.push(
        <div key={`day-${dayKey}`} className="flex justify-center">
          <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">{dayLabelOf(m.createdAt)}</span>
        </div>,
      );
    }
    const mine = m.userIdFrom === myId;
    /** Tin này có phải tin cuối đang xem — quyết định hiện dòng thời gian (xem `lastVisibleMessageId`). */
    const isLastMessage = m.id === lastVisibleMessageId;
    /**
     * Ghi chú trạng thái GẮN RIÊNG tin này (đã xoá/đã thu hồi bởi
     * ai, đang gửi/gửi lỗi): luôn ở tại tin đó bất kể vị trí — chỉ
     * phần GIỜ của footer mới tuân quy tắc tin cuối.
     */
    const hasOwnStatusNote = Boolean(m.deletedAt || m.recalledAt || m.localStatus);
    /** Dòng panel của tác giả tin này (lát MSG-T4) — có thì avatar dòng tin thành nút mở menu quan hệ. */
    const authorEntry = isGroup && !mine ? panelEntryById.get(m.userIdFrom) : undefined;
    // Cụm hành động trên tin (quyết định ngày 26/10, sổ quyết định mục D):
    // icon nhỏ hiện khi hover/focus tin thay cho hàng nút chữ luôn hiện
    // (dòng 11:20); cách ĐẶT đã thay theo dòng 23:16 — toolbar NỔI
    // cạnh bong bóng, bỏ hẳn khỏi luồng dọc (xem khối render dưới).
    // Điều kiện hiển thị từng hành động GIỮ NGUYÊN như trước — chỉ đổi
    // cách trình bày/kích hoạt.
    const showReplyAction = !m.deletedAt && !m.localStatus;
    const showRecallAction = canRecall(m);
    const showDeleteMineAction = showReplyAction && mine;
    const showModerateActions = active.canModerate && !m.localStatus;
    const showMoreMenu = showRecallAction || showDeleteMineAction || showModerateActions;
    threadItems.push(
      <MessageScrollerItem key={m.id} messageId={m.id} scrollAnchor={mine}>
        <Message align={mine ? 'end' : 'start'}>
          <MessageAvatar>
            {authorEntry && memberPanel ? (
              <MemberActionMenu
                entry={authorEntry}
                myId={myId}
                context={memberPanel.context}
                canManage={Boolean(active.canManage)}
                hasDirectConversation={memberPanel.directPartnerIds.has(authorEntry.userId)}
                triggerLabel={t('memberMenuLabel', { name: authorEntry.displayName })}
                triggerClassName="shrink-0 rounded-full"
                onMessageMember={memberPanel.onMessageMember}
                onSendContactRequest={memberPanel.onSendContactRequest}
                onRespondContactRequest={memberPanel.onRespondContactRequest}
                onRemoveMember={memberPanel.onRemoveMember}
                onViewProfile={memberProfile.open}
                isBlockedByMe={blocked.includes(authorEntry.userId)}
                onBlockContact={blockContact}
                onUnblockContact={unblockContact}
              >
                <Avatar>
                  <AvatarFallback>{initialsOf(authorEntry.displayName)}</AvatarFallback>
                </Avatar>
              </MemberActionMenu>
            ) : (
              <Avatar>
                <AvatarFallback>{initialsOf(nameOf(m.userIdFrom))}</AvatarFallback>
              </Avatar>
            )}
          </MessageAvatar>
          <MessageContent>
            {!mine ? <MessageHeader>{nameOf(m.userIdFrom)}</MessageHeader> : null}
            <Bubble
              variant={m.deletedAt || m.recalledAt ? 'destructive' : mine ? 'default' : 'muted'}
              align={mine ? 'end' : 'start'}
              className={m.id === highlightedMessageId ? 'rounded-lg ring-2 ring-primary ring-offset-1' : undefined}
            >
              {m.replyTo ? (
                <button
                  type="button"
                  data-testid={`quote-block-${m.id}`}
                  className="mx-1 mt-1 max-w-full cursor-pointer rounded-md border-l-4 border-primary/60 bg-background/60 px-2 py-1 text-left"
                  onClick={() => onJumpToQuote(m.replyTo!)}
                >
                  <span className="block text-xs font-medium">{nameOf(m.replyTo.userIdFrom)}</span>
                  <span className="block truncate text-xs opacity-80">
                    {m.replyTo.unavailable ? t('quotedMessageUnavailable') : m.replyTo.excerpt}
                  </span>
                </button>
              ) : null}
              <BubbleContent>{m.recalledAt ? t('messageRecalled') : m.fullMessage}</BubbleContent>
              {/*
                Toolbar hành động NỔI (quyết định 23:16 ngày
                26/10/2026, sổ quyết định mục D — theo cách
                Messenger): cụm icon nằm NGOÀI luồng dọc, định vị
                tuyệt đối theo chính bong bóng (Bubble là
                `relative`) và canh theo ĐẦU bong bóng — tin của
                mình nổi ở phía TRÁI bong bóng, tin người khác nổi
                ở phía PHẢI, tức luôn ở phía đối diện chiều căn
                lề. Lý do bỏ khỏi luồng: khi còn là một hàng
                trong MessageContent, cụm này chiếm chiều cao
                của MỌI dòng tin kể cả lúc opacity-0 chưa hover;
                ở dạng nổi nó không đẩy chiều cao dòng tin nữa.
                Bong bóng bị giới hạn max-w-[80%] nên phía nổi
                luôn còn khoảng trống của cột nội dung, không
                tràn mép khung cuộn. Điều kiện hiển thị (hover/
                focus-within cả dòng tin; thiết bị không hover
                thì mờ 60% như trước) và handler/quyền/testid
                giữ nguyên.
              */}
              {showReplyAction || showMoreMenu ? (
                <div
                  data-slot="message-actions"
                  data-placement="floating"
                  className={`absolute top-0 z-10 flex items-center gap-0.5 opacity-100 transition-opacity focus-within:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/message:opacity-100 [@media(hover:hover)]:focus-within:opacity-100 [@media(hover:none)]:opacity-60 ${mine ? 'right-full mr-1' : 'left-full ml-1'}`}
                >
                {showReplyAction ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('replyToMessage')}
                    data-testid={`message-reply-${m.id}`}
                    onClick={() => onStartReply(m)}
                  >
                    <Reply aria-hidden />
                  </Button>
                ) : null}
                {showMoreMenu ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('messageMoreActions')}
                          data-testid={`message-actions-${m.id}`}
                        />
                      }
                    >
                      <Ellipsis aria-hidden />
                    </DropdownMenuTrigger>
                    {/* Bề rộng + không xuống dòng theo hằng ở utils: mặc định của @lms/ui ghim bề rộng theo nút ⋯ hẹp làm nhãn bẻ nhiều dòng. */}
                    <DropdownMenuContent align={mine ? 'end' : 'start'} sideOffset={4} className={CHAT_MENU_CONTENT_CLASS}>
                      {showRecallAction ? (
                        <DropdownMenuItem className={CHAT_MENU_ITEM_CLASS} onClick={() => void recallMessage(m)}>
                          <Undo2 aria-hidden />
                          {t('recallMessage')}
                        </DropdownMenuItem>
                      ) : null}
                      {showDeleteMineAction ? (
                        <DropdownMenuItem className={CHAT_MENU_ITEM_CLASS} onClick={() => void deleteMessage(m)}>
                          <Trash aria-hidden />
                          {t('deleteMessage')}
                        </DropdownMenuItem>
                      ) : null}
                      {showModerateActions ? (
                        <DropdownMenuCheckboxItem
                          className={CHAT_MENU_ITEM_CLASS}
                          checked={selectedForBulk.has(m.id)}
                          onCheckedChange={() => setSelectedForBulk((prev) => {
                            const next = new Set(prev);
                            if (next.has(m.id)) next.delete(m.id);
                            else next.add(m.id);
                            return next;
                          })}
                        >
                          {t('selectMessageForBulk')}
                        </DropdownMenuCheckboxItem>
                      ) : null}
                      {showModerateActions ? (
                        <DropdownMenuItem variant="destructive" className={CHAT_MENU_ITEM_CLASS} onClick={() => void hardDeleteMessage(m)}>
                          <Eraser aria-hidden />
                          {t('hardDeleteMessage')}
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
                </div>
              ) : null}
            </Bubble>
            {/*
              Footer dòng tin: phần GIỜ chỉ ở tin cuối đang xem
              (quyết 23:16 — danh sách dài không còn lặp giờ dưới
              từng tin); các ghi chú trạng thái gắn riêng tin này
              thì render bất kể vị trí. Tin không phải tin cuối và
              không có ghi chú trạng thái thì KHÔNG render footer
              — tránh để lại một dòng trống trong luồng.
            */}
            {isLastMessage || hasOwnStatusNote ? (
              <MessageFooter className="flex-wrap gap-2">
                {isLastMessage ? <span>{formatDateTime(m.createdAt)}</span> : null}
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
              </MessageFooter>
            ) : null}
          </MessageContent>
        </Message>
      </MessageScrollerItem>,
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-label={t('messagesBackToList')}
          onClick={() => onBack()}
        >
          <ArrowLeft aria-hidden />
        </Button>
        <span className="relative shrink-0">
          <Avatar>
            <AvatarFallback>{initialsOf(avatarLabel)}</AvatarFallback>
          </Avatar>
          {otherOnline ? (
            <span className="absolute right-0 bottom-0 size-2.5 rounded-full bg-emerald-500 ring-2 ring-background" />
          ) : null}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{title}</p>
          {subtitle ? <p className="truncate text-xs text-muted-foreground">{subtitle}</p> : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('messageSearchLabel')}
          aria-pressed={searchOpen}
          onClick={() => setSearchOpen((prev) => !prev)}
        >
          <Search aria-hidden />
        </Button>
        {isGroup ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('conversationInfoTitle')}
            aria-pressed={infoOpen}
            onClick={() => setInfoOpen((prev) => !prev)}
          >
            <Info aria-hidden />
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        {/*
          Đoạn theo TỪNG NGƯỜI chỉ dành cho chat 1–1 (quyết Lão
          gia 23:16 ngày 26/10/2026, sổ quyết định mục D — sửa
          bug đã kiểm chứng): bản cũ map qua MỌI thành viên khác
          và render một nút "Chặn liên lạc" không kèm tên cho mỗi
          người, nên chat nhóm 4 người hiện 3 nút giống hệt nhau.
          Nay: 1–1 chỉ ĐÚNG MỘT nút chặn/bỏ chặn KÈM TÊN người
          đối thoại; chat nhóm bỏ hẳn đoạn này khỏi header —
          chặn/bỏ chặn từng thành viên đi qua menu hành động
          của thành viên (panel thông tin + menu trên avatar
          dòng tin), chấm trực tuyến của từng thành viên ở nhóm
          cũng xem tại panel đó.
        */}
        {!isGroup && otherId ? (
          <span className="flex items-center gap-2">
            {otherOnline ? (
              <span className="text-xs text-muted-foreground">● {t('onlineNow')}</span>
            ) : null}
            {blocked.includes(otherId) ? (
              <span className="flex items-center gap-2 text-sm">
                {nameOf(otherId)} {t('blockedSuffix')}
                <Button type="button" variant="outline" onClick={() => void unblockContact(otherId)}>
                  {t('unblockContact')} {nameOf(otherId)}
                </Button>
              </span>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={() => void blockContact(otherId)}
              >
                {t('blockContact')} {nameOf(otherId)}
              </Button>
            )}
          </span>
        ) : null}
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
      {isGroup && infoOpen && memberPanelBundle ? (
        <MemberPanel
          conversation={active}
          bundle={memberPanelBundle}
          myId={myId}
          onlineUsers={onlineUsers}
          readMarkers={readMarkers}
          newestSeq={newestSeq}
          onViewProfile={memberProfile.open}
        />
      ) : null}
      <MemberProfileSheet
        entry={memberProfile.entry}
        contextName={memberPanel?.context.name ?? title}
        online={memberProfile.entry ? Boolean(onlineUsers[memberProfile.entry.userId]) : false}
        onClose={memberProfile.close}
      />
      {searchOpen ? (
        <div className="space-y-2 border-b px-3 py-2">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onSearchMessages(searchDraft);
            }}
          >
            <Input
              type="search"
              aria-label={t('messageSearchLabel')}
              placeholder={t('messageSearchPlaceholder')}
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
            />
            <Button type="submit" variant="outline">{t('messageSearchButton')}</Button>
            {messageSearch.submitted ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setSearchDraft('');
                  onClearMessageSearch();
                }}
              >
                {t('messageSearchClear')}
              </Button>
            ) : null}
          </form>
          {messageSearch.loading ? (
            <p className="text-sm text-muted-foreground">{t('messageSearchLoading')}</p>
          ) : null}
          {messageSearch.failed ? (
            <p role="alert" className="text-sm">{t('messageSearchFailed')}</p>
          ) : null}
          {messageSearch.submitted && !messageSearch.loading && !messageSearch.failed
            && messageSearch.results.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('messageSearchNoResults')}</p>
            ) : null}
          {messageSearch.results.length > 0 ? (
            <ul className="space-y-1">
              {messageSearch.results.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    data-testid={`search-result-${r.id}`}
                    className="w-full rounded-md border px-2 py-1 text-left hover:bg-muted"
                    onClick={() => onJumpToSearchResult(r)}
                  >
                    <span className="block text-xs font-medium">{nameOf(r.userIdFrom)}</span>
                    <span className="block truncate text-sm">{r.excerpt}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {hasMoreBefore ? (
        <div className="px-3 pt-2">
          <Button type="button" variant="outline" onClick={() => void loadOlder()}>
            {t('loadOlderMessages')}
          </Button>
        </div>
      ) : null}
      {active.canModerate && selectedForBulk.size > 0 ? (
        <div className="flex items-center gap-2 px-3 pt-2">
          <span className="text-sm text-muted-foreground">{t('bulkSelectedCount', { count: selectedForBulk.size })}</span>
          <Button type="button" variant="destructive" onClick={() => void bulkRemoveSelected()}>
            {t('bulkRemoveMessages')}
          </Button>
        </div>
      ) : null}
      <MessageScrollerProvider key={active.id} autoScroll defaultScrollPosition="end">
        <ScrollerBridge bridgeRef={scrollerRef} />
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport aria-label={t('messagesListLabel')}>
            <MessageScrollerContent className="gap-4 p-4">
              {threadItems}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      <div className="space-y-2 border-t px-3 py-2">
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
            {replyTarget ? (
              <div
                data-testid="reply-chip"
                className="flex items-center gap-2 rounded-md border-l-4 border-primary/60 bg-muted px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm">
                  <span className="font-medium">{t('replyingTo', { user: nameOf(replyTarget.userIdFrom) })}</span>
                  {': '}
                  {replyTarget.recalledAt ? t('quotedMessageUnavailable') : quoteExcerptOfText(replyTarget.fullMessage)}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  aria-label={t('cancelReply')}
                  onClick={() => onCancelReply()}
                >
                  ✕
                </Button>
              </div>
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
                  // cho composer nhiều dòng. Đang có lượt gửi bay thì
                  // Enter không kích thêm lượt gửi nào (fix nhân đôi
                  // tin, issue #33); Shift+Enter vẫn xuống dòng.
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (!sendInFlight) e.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <Button type="submit" disabled={sendInFlight}>{t('send')}</Button>
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
      </div>
    </div>
  );
}

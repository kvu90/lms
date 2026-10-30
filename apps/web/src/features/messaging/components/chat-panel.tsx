import { useEffect, useState, type Dispatch, type FormEvent, type ReactNode, type RefObject, type SetStateAction } from 'react';
import {
  ArrowLeft, Ban, Bell, BellOff, Bold, Check, CheckCheck, Ellipsis, Eraser, Flag,
  Link2, MessageCircle, MessagesSquare, Paperclip, Pin, PinOff, Reply, Search,
  SendHorizontal, Smile, SmilePlus, Trash, Undo2, X,
} from 'lucide-react';
import { Avatar, AvatarFallback } from '@lms/ui/components/avatar';
import { Bubble, BubbleContent } from '@lms/ui/components/bubble';
import { Button } from '@lms/ui/components/button';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger,
} from '@lms/ui/components/dropdown-menu';
import {
  Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
} from '@lms/ui/components/empty';
import { Input } from '@lms/ui/components/input';
import { Skeleton } from '@lms/ui/components/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@lms/ui/components/tabs';
import { Textarea } from '@lms/ui/components/textarea';
import {
  Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader,
} from '@lms/ui/components/message';
import {
  MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem,
  MessageScrollerProvider, MessageScrollerViewport, useMessageScroller,
} from '@lms/ui/components/message-scroller';
import { useTranslation } from 'react-i18next';

import { formatDate, formatTime } from '#utils/date-format';
import { getPersonProfile, getSharedFiles, QUICK_REPLY_SHAPE_SAMPLES } from '../api/person-profile-adapter';
import type { ConversationStatePatch, ConversationView, MessageQuoteView, MessageSearchResultView, MessageView, PersonSummary, ScrollerHandle } from '../types/types';
import { MemberActionMenu, MemberPanel, MemberProfileSheet, useMemberProfile, type MemberPanelBundle } from './member-panel';
import { CHAT_MENU_CONTENT_CLASS, CHAT_MENU_ITEM_CLASS, initialsOf, quoteExcerptOfText } from '../utils/utils';

/**
 * Lưới emoji của bộ chọn ở ô soạn (issue #591): popover dạng
 * lưới 5 cột × 4 hàng như bản demo, thay danh sách dọc hẹp 6
 * biểu tượng trước đây. Chọn emoji vẫn chèn ký tự vào ô soạn
 * như hành vi hiện có; không thêm thư viện picker.
 */
const EMOJI_GRID_OPTIONS = [
  '👍', '❤️', '😂', '😀', '😍',
  '🎉', '👏', '🙏', '🔥', '😮',
  '😢', '🤔', '👌', '🙌', '💯',
  '✨', '😴', '🤗', '😎', '🙂',
];

/**
 * Bộ cảm xúc của bộ chọn reactions trên tin — CHỈ HÌNH DẠNG
 * (issue #591, xem khối render ở toolbar nổi của bong bóng):
 * reactions chưa có phán quyết chức năng nên lưới này chỉ để
 * trình bày, các mục đều vô hiệu.
 */
const REACTION_SHAPE_EMOJIS = ['❤️', '😂', '😮', '😢', '👍'];

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
  /**
   * Đặt một cờ trạng thái cá nhân (ghim / tắt tiếng) cho hội
   * thoại đang mở (issue #591): hành động tắt/bật thông báo và
   * ghim/bỏ ghim ở đầu khung và panel thông tin đi qua đây —
   * cùng một đường đổi trạng thái với menu trên hàng danh sách.
   */
  onUpdateConversationState: (conversation: ConversationView, patch: ConversationStatePatch) => void;
  /**
   * Bản đồ tóm tắt người dùng của trang (issue #591): panel
   * thông tin lấy tên đăng nhập thật của đối tác qua đây để
   * adapter hồ sơ dựng đúng trường đã có nguồn.
   */
  people: Record<string, PersonSummary>;
  /**
   * Trang đang nạp dữ kiện lần đầu (issue #591): khi chưa có
   * hội thoại đang mở thì hiện khung đang tải đúng hình dạng
   * thay cho trạng thái trống.
   */
  loading?: boolean;
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
  canRecall, onRecallMessage, onHardDeleteMessage, onUpdateConversationState, people, loading, typingNames, draft,
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
    // Đang nạp lần đầu (issue #591): khung phải hiện skeleton
    // đúng hình dạng (đầu khung + vài bong bóng) — không hiện
    // trạng thái trống giả rồi mới đầy dữ kiện; trạng thái
    // trống thật chỉ hiện khi đã nạp xong.
    if (loading) {
      return (
        <div data-testid="thread-loading" className="flex min-h-0 flex-1 flex-col" aria-label={t('conversationsLoading')}>
          <div className="flex items-center gap-3 border-b px-3 py-2">
            <Skeleton className="size-10 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
          <div className="flex-1 space-y-4 p-4">
            <Skeleton className="h-10 w-1/2 rounded-xl" />
            <Skeleton className="ml-auto h-10 w-2/5 rounded-xl" />
            <Skeleton className="h-10 w-3/5 rounded-xl" />
          </div>
          <div className="border-t px-3 py-2">
            <Skeleton className="h-9 w-full rounded-md" />
          </div>
        </div>
      );
    }
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageCircle aria-hidden />
          </EmptyMedia>
          <EmptyTitle>{t('selectConversation')}</EmptyTitle>
          <EmptyDescription>{t('pickConversation')}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const others = active.members.filter((memberId) => memberId !== myId);
  const isGroup = active.type === 2;
  const otherId = !isGroup ? others[0] : undefined;
  /**
   * Trạng thái hiện diện của đối tác có BA trạng thái theo dữ
   * kiện client: `true` khi đã có sự kiện hiện diện xác nhận
   * trực tuyến, `false` khi đã có sự kiện xác nhận ngoại tuyến,
   * `undefined` khi CHƯA BIẾT — chưa nhận sự kiện nào của đối
   * tác. Client không nhận được ảnh chụp hiện diện ban đầu từ
   * máy chủ: đối tác đã trực tuyến hay ngoại tuyến sẵn từ
   * trước khi trang tải thì bản đồ không có bản ghi của họ,
   * nên `undefined` tuyệt đối không được gộp thành ngoại
   * tuyến — bề mặt hiện chữ trạng thái chỉ được khẳng định
   * khi đã có sự kiện xác nhận. `otherOnline` (chấm/chữ "đang
   * trực tuyến") chỉ cần nhánh `true`: vắng chấm khi chưa
   * biết không khẳng định điều gì sai.
   */
  const otherPresence = otherId ? onlineUsers[otherId] : undefined;
  const otherOnline = otherPresence === true;
  /**
   * Tiêu đề đầu khung — panel thông tin dùng lại đúng biến này:
   * hội thoại có tên thì dùng tên; hội thoại 1–1 không có tên
   * (backend không đặt tên cho 1–1) thì hiện tên đối tác; chỉ khi
   * không xác định được đối tác mới rơi về nhãn dự phòng liệt kê
   * mọi thành viên.
   */
  const title = active.name !== null
    ? active.name
    : otherId
      ? nameOf(otherId)
      : t('conversationWithUser', { members: active.members.map((id) => nameOf(id)).join(', ') });
  const avatarLabel = active.name ?? (otherId ? nameOf(otherId) : title);
  /**
   * Dòng phụ đầu khung: đang nhập → nhóm hiện số thành viên →
   * 1–1 hiện trạng thái của đối tác theo đúng ba trạng thái
   * hiện diện: đã xác nhận trực tuyến thì hiện nhãn trực
   * tuyến, đã xác nhận ngoại tuyến thì hiện "Ngoại tuyến",
   * chưa biết (chưa có sự kiện nào của đối tác — gồm cả ca
   * đối tác đã ngoại tuyến sẵn từ trước khi trang tải) thì
   * KHÔNG hiện dòng trạng thái, vì client không có dữ kiện
   * để khẳng định.
   */
  const subtitle = typingNames.length > 0
    ? t('typingIndicator', { userId: nameOf(typingNames[0]!) })
    : isGroup
      ? t('conversationMembersCount', { count: active.members.length })
      : otherPresence === true
        ? t('onlineNow')
        : otherPresence === false
          ? t('messagesOfflineNow')
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
   * Mốc đã xem ở mức hội thoại (issue #591): seq lớn nhất mà
   * MỌI phía còn lại đều đã đọc qua — suy từ `memberReadMarkers`
   * (mốc đọc theo seq của từng thành viên): lấy mốc nhỏ nhất
   * trong các phía còn lại. Hai bề mặt dùng cùng mốc này:
   * (1) dấu đã xem trên bong bóng của chính người gửi — tin
   * của mình có seq không vượt mốc này thì mang dấu đã xem,
   * còn lại mang dấu đã gửi; (2) dòng "Đã xem" ở mức hội
   * thoại — dòng này gắn NGAY DƯỚI tin của mình cuối cùng
   * không vượt mốc (tin đã xem cuối cùng mà nó nói tới),
   * không trôi xuống đáy luồng khi đã có tin mới hơn chưa
   * được xem tới sau đó.
   */
  const seenThroughSeq = others.length > 0
    ? Math.min(...others.map((memberId) => readMarkers[memberId] ?? 0))
    : 0;
  /** Id của tin đã xem cuối cùng — dòng "Đã xem" render ngay dưới tin này; null khi chưa tin nào của mình được xem. */
  const seenLineAfterId = seenThroughSeq > 0
    ? [...visibleMessages].reverse().find(
      (m) => m.userIdFrom === myId && !m.localStatus && m.seq > 0 && m.seq <= seenThroughSeq,
    )?.id ?? null
    : null;

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
  /** Luồng tin kèm ngăn cách theo ngày: dải ngày là DÒNG CHỮ THƯỜNG ở giữa luồng như bản demo (issue #591), chèn trước tin đầu tiên của mỗi ngày — không dùng dạng viên như trước. */
  const threadItems: ReactNode[] = [];
  let lastDayKey = '';
  for (const m of visibleMessages) {
    const dayKey = dayKeyOf(m.createdAt);
    if (dayKey !== lastDayKey) {
      lastDayKey = dayKey;
      threadItems.push(
        <div key={`day-${dayKey}`} className="flex justify-center">
          <span className="text-xs text-muted-foreground">{dayLabelOf(m.createdAt)}</span>
        </div>,
      );
    }
    const mine = m.userIdFrom === myId;
    /** Tin của mình đã được mọi phía còn lại xem qua chưa (theo mốc `seenThroughSeq`) — quyết định dấu đã xem trong bong bóng. */
    const seenByOthers = mine && !m.localStatus && m.seq > 0 && m.seq <= seenThroughSeq;
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
              {/*
                Nội dung bong bóng (issue #591): khối trích dẫn
                nằm TRONG bong bóng như bản demo (trước đây nằm
                phía trên bong bóng), nội dung tin ở giữa, và
                mốc GIỜ của chính tin này ở góc dưới của bong
                bóng — mọi bong bóng đều mang giờ của nó, kèm
                dấu đã xem / đã gửi trên bong bóng của chính
                người gửi. Bấm khối trích dẫn vẫn nhảy tới tin
                gốc như trước.
              */}
              <BubbleContent>
                {m.replyTo ? (
                  <button
                    type="button"
                    data-testid={`quote-block-${m.id}`}
                    className="mb-1 block w-full max-w-full cursor-pointer rounded-md border-l-4 border-primary/60 bg-background/60 px-2 py-1 text-left"
                    onClick={() => onJumpToQuote(m.replyTo!)}
                  >
                    <span className="block text-xs font-medium">{nameOf(m.replyTo.userIdFrom)}</span>
                    <span className="block truncate text-xs opacity-80">
                      {m.replyTo.unavailable ? t('quotedMessageUnavailable') : m.replyTo.excerpt}
                    </span>
                  </button>
                ) : null}
                <span className="block">{m.recalledAt ? t('messageRecalled') : m.fullMessage}</span>
                <span
                  data-testid={`message-time-${m.id}`}
                  className="mt-1 flex items-center justify-end gap-1 text-[11px] leading-none opacity-70"
                >
                  {formatTime(m.createdAt)}
                  {mine && !m.localStatus && m.seq > 0 ? (
                    seenByOthers ? (
                      <>
                        <CheckCheck className="size-3.5" aria-hidden />
                        <span className="sr-only">{t('seenByMembers')}</span>
                      </>
                    ) : (
                      <Check className="size-3.5" aria-hidden />
                    )
                  ) : null}
                </span>
              </BubbleContent>
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
                {showReplyAction ? (
                  /*
                    Bộ chọn cảm xúc (reactions) — CHỈ HÌNH DẠNG
                    (issue #591): reactions là điểm chưa có phán
                    quyết về chức năng và chưa có dữ kiện ở mọi
                    tầng, nên nút và lưới cảm xúc chỉ hiện đúng
                    hình dạng của demo ở trạng thái vô hiệu —
                    không ghi cảm xúc nào, không phát sinh tác
                    dụng giả.
                  */
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('reactionPickerLabel')}
                          data-testid={`message-reaction-${m.id}`}
                        />
                      }
                    >
                      <SmilePlus aria-hidden />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align={mine ? 'end' : 'start'} sideOffset={4} className="grid w-56 grid-cols-5 gap-1 p-2">
                      {REACTION_SHAPE_EMOJIS.map((emoji) => (
                        <DropdownMenuItem key={emoji} disabled className="flex items-center justify-center text-lg">
                          {emoji}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
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
                      {/*
                        Mục Thảo luận (thread) — CHỈ HÌNH DẠNG
                        (issue #591): thread là điểm chưa có phán
                        quyết về chức năng, hệ chỉ có trích dẫn
                        một cấp — mục này hiện đúng hình dạng của
                        demo ở trạng thái vô hiệu, không mở bề
                        mặt thread nào.
                      */}
                      <DropdownMenuItem disabled className={CHAT_MENU_ITEM_CLASS}>
                        <MessagesSquare aria-hidden />
                        {t('threadAction')}
                      </DropdownMenuItem>
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
              Footer dòng tin (issue #591): GIỜ của tin đã
              chuyển vào trong bong bóng (mọi bong bóng đều
              mang giờ của chính nó như bản demo) nên footer
              chỉ còn các ghi chú trạng thái gắn riêng tin này
              (đã xoá / đã thu hồi / đang gửi / gửi lỗi), render
              bất kể vị trí; tin không có ghi chú trạng thái
              thì KHÔNG render footer — tránh để lại một dòng
              trống trong luồng.
            */}
            {hasOwnStatusNote ? (
              <MessageFooter className="flex-wrap gap-2">
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
    // Dòng "Đã xem" ở mức hội thoại (issue #591): gắn NGAY
    // DƯỚI tin đã xem cuối cùng mà nó nói tới (xem
    // `seenLineAfterId`) — không còn nằm ở cuối luồng như
    // trước, để không gây hiểu nhầm rằng tin mới hơn ở phía
    // dưới nó cũng đã được xem.
    if (m.id === seenLineAfterId) {
      threadItems.push(
        <div key={`seen-${m.id}`} className="flex justify-end px-3">
          <p data-testid="seen-status" className="text-xs text-muted-foreground">{t('seenByMembers')}</p>
        </div>,
      );
    }
  }

  /**
   * Cột thứ ba của khung chat (issue #564; dựng lại theo hình
   * dạng hồ sơ của bản demo ở issue #591): panel thông tin mở
   * theo yêu cầu, không chèn ép cột chính. Nhóm dùng nguyên
   * MemberPanel hiện có; chat 1–1 dùng panel HỒ SƠ NGƯỜI theo
   * đúng hình dạng demo — các trường hồ sơ backend chưa có đi
   * qua lớp adapter dữ kiện (xem `person-profile-adapter.ts`)
   * và hiện dấu gạch ngang ở đúng vị trí, thân PR ghi rõ
   * trường nào chờ đợt backend #592.
   */
  const showInfoAside = infoOpen && ((isGroup && memberPanelBundle !== null) || (!isGroup && otherId !== undefined));
  /**
   * Hồ sơ hiển thị của đối tác 1–1 qua lớp adapter (issue
   * #591): tên + tên đăng nhập là dữ kiện thật từ trang; các
   * trường hồ sơ mở rộng chờ đợt backend thay nguồn.
   */
  const partnerProfile = !isGroup && otherId
    ? getPersonProfile({
      userId: otherId,
      displayName: nameOf(otherId),
      username: people[otherId]?.username ?? '',
    })
    : null;
  /** Các tệp đã chia sẻ của hội thoại đang mở qua adapter — nguồn hiện tại rỗng (đính kèm chưa có phán quyết chức năng). */
  const sharedFiles = getSharedFiles(active.id);

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
        {/*
          Avatar header là nút mở panel duy nhất (theo mẫu demo:
          bấm avatar mở panel thông tin) — thay nút Info icon riêng
          của nhóm trước đây, để cả hai loại hội thoại chỉ có đúng
          một nút mang tên này. Tên truy cập cố ý KHÔNG chứa tiêu đề
          hội thoại để không đụng tên nút dòng hội thoại trong test.
        */}
        <button
          type="button"
          aria-label={t('conversationInfoTitle')}
          aria-pressed={infoOpen}
          className="relative shrink-0 rounded-full"
          onClick={() => setInfoOpen((prev) => !prev)}
        >
          <Avatar>
            <AvatarFallback>{initialsOf(avatarLabel)}</AvatarFallback>
          </Avatar>
          {otherOnline ? (
            <span className="absolute right-0 bottom-0 size-2.5 rounded-full bg-emerald-500 ring-2 ring-background" />
          ) : null}
        </button>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5">
            <span className="truncate font-medium">{title}</span>
            {/*
              Biểu tượng tắt thông báo ở đầu khung (issue
              #591): hội thoại đã tắt tiếng — gồm cả nhóm —
              hiện biểu tượng BellOff cạnh tiêu đề, khớp biểu
              tượng ở hàng danh sách.
            */}
            {active.muted ? (
              <>
                <BellOff data-testid="header-muted-icon" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="sr-only">{t('muteConversation')}</span>
              </>
            ) : null}
          </p>
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
        {/*
          Menu hành động của đầu khung (issue #591): đầu khung
          chỉ còn ĐÚNG MỘT HÀNG như bản demo — mọi hành động
          phụ trước đây nằm ở hàng nút thứ hai (chặn liên lạc,
          báo cáo, tắt/bật chat, tắt tiếng) nay vào menu này,
          theo cùng một luật ở mọi hội thoại:
          - Tắt/Bật tiếng: mọi hội thoại (trạng thái đã có dữ
            kiện ở backend, đổi qua cùng đường trạng thái với
            menu trên hàng danh sách).
          - Chặn/Bỏ chặn: chỉ chat 1–1, đúng một mục KÈM TÊN
            đối tác (giữ luật đã chốt: chặn ở nhóm đi qua menu
            hành động của từng thành viên, không nằm ở header).
          - Báo cáo cuộc trò chuyện: mọi hội thoại.
          - Tắt/Bật chat: chỉ khi người xem có thẩm quyền
            quản lý hội thoại.
          Trạng thái trực tuyến chỉ hiện một lần ở dòng phụ
          dưới tên — không lặp thành viên riêng trong menu.
        */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('conversationActionsLabel')}
                data-testid="header-actions"
              />
            }
          >
            <Ellipsis aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4} className={CHAT_MENU_CONTENT_CLASS}>
            <DropdownMenuItem
              className={CHAT_MENU_ITEM_CLASS}
              onClick={() => onUpdateConversationState(active, { muted: !active.muted })}
            >
              {active.muted ? <Bell aria-hidden /> : <BellOff aria-hidden />}
              {active.muted ? t('unmuteConversation') : t('muteConversation')}
            </DropdownMenuItem>
            {!isGroup && otherId ? (
              blocked.includes(otherId) ? (
                <DropdownMenuItem className={CHAT_MENU_ITEM_CLASS} onClick={() => void unblockContact(otherId)}>
                  <Ban aria-hidden />
                  {t('unblockContact')} {nameOf(otherId)}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem className={CHAT_MENU_ITEM_CLASS} onClick={() => void blockContact(otherId)}>
                  <Ban aria-hidden />
                  {t('blockContact')} {nameOf(otherId)}
                </DropdownMenuItem>
              )
            ) : null}
            <DropdownMenuItem className={CHAT_MENU_ITEM_CLASS} onClick={() => void reportActiveConversation()}>
              <Flag aria-hidden />
              {t('reportConversation')}
            </DropdownMenuItem>
            {active.canManage ? (
              <DropdownMenuItem className={CHAT_MENU_ITEM_CLASS} onClick={() => void toggleActiveChat()}>
                {(active.enabled ?? true) ? t('disableChat') : t('enableChat')}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {/*
        Dòng thông tin trạng thái dưới đầu khung (không phải
        hàng hành động): đối tác đã bị chặn thì ghi rõ kèm tên;
        thông báo kết quả báo cáo / hành động hiện ở đây như
        trước.
      */}
      {(!isGroup && otherId && blocked.includes(otherId)) || reportMessage || actionMessage ? (
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          {!isGroup && otherId && blocked.includes(otherId) ? (
            <p className="text-sm">
              {nameOf(otherId)} {t('blockedSuffix')}
            </p>
          ) : null}
          {reportMessage ? <p role="status">{reportMessage}</p> : null}
          {actionMessage ? <p role="alert">{actionMessage}</p> : null}
        </div>
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
            {/*
              Ô soạn theo bản demo (issue #591):
              - Tab Trả lời / Ghi chú nội bộ ở trên cùng: tab
                Ghi chú nội bộ là điểm CHƯA có phán quyết chức
                năng — chỉ dựng hình dạng, ở trạng thái vô hiệu.
              - Chip trả lời nhanh phía trên ô nhập: CHỈ HÌNH
                DẠNG từ lớp adapter, vô hiệu, không chèn nội
                dung nào (điểm chưa có phán quyết).
              - Hàng nhập gọn một dòng (tự giãn khi nhiều
                dòng): nút đính kèm + nút định dạng đậm + nút
                chèn liên kết là hình dạng vô hiệu (điểm chưa
                có phán quyết); nút emoji mở popover LƯỚI;
                nút Gửi là nút BIỂU TƯỢNG, vẫn vô hiệu khi
                nháp trống; KHÔNG còn bộ đếm ký tự và khung
                nhập phình to như trước (trần ký tự vẫn được
                cổng gửi chặn như cũ, lỗi hiện ở dòng báo lỗi
                dưới ô soạn).
            */}
            <Tabs value="reply">
              <TabsList>
                <TabsTrigger value="reply">{t('replyTabLabel')}</TabsTrigger>
                <TabsTrigger value="internal-note" disabled>{t('internalNoteTabLabel')}</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_REPLY_SHAPE_SAMPLES.map((sample) => (
                <Button key={sample} type="button" size="sm" variant="outline" className="rounded-full" disabled>
                  {sample}
                </Button>
              ))}
            </div>
            <form onSubmit={(e) => void send(e)} className="flex items-end gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('attachFileLabel')}
                disabled
              >
                <Paperclip aria-hidden />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t('emojiPickerLabel')}
                    />
                  }
                >
                  <Smile aria-hidden />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" sideOffset={4} className="grid w-72 grid-cols-5 gap-1 p-2">
                  {EMOJI_GRID_OPTIONS.map((emoji) => (
                    <DropdownMenuItem
                      key={emoji}
                      className="flex items-center justify-center text-lg"
                      onClick={() => { setDrafts((prev) => ({ ...prev, [active.id]: `${prev[active.id] ?? ''}${emoji}` })); noteTyping(); }}
                    >
                      {emoji}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('boldLabel')}
                disabled
              >
                <Bold aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('insertLinkLabel')}
                disabled
              >
                <Link2 aria-hidden />
              </Button>
              <Textarea
                aria-label={t('messageText')}
                rows={1}
                className="max-h-40 min-h-9 flex-1 resize-none"
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
              <Button
                type="submit"
                size="icon"
                aria-label={t('send')}
                disabled={sendInFlight || !draft.trim()}
              >
                <SendHorizontal aria-hidden />
              </Button>
            </form>
            {sendError ? (
              <p role="alert" className="text-sm text-destructive">{sendError}</p>
            ) : null}
          </>
        )}
      </div>
      </div>
      {showInfoAside ? (
        <aside
          data-testid="info-aside"
          className="absolute inset-y-0 right-0 z-20 flex w-[85vw] max-w-[320px] flex-col overflow-y-auto border-l bg-background shadow-xl md:static md:z-auto md:w-[320px] md:shrink-0 md:shadow-none"
        >
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <p className="truncate text-sm font-medium">{t('conversationInfoTitle')}</p>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('closeDialog')}
              onClick={() => setInfoOpen(false)}
            >
              <X aria-hidden />
            </Button>
          </div>
          {isGroup && memberPanelBundle ? (
            <>
              {/*
                Hàng hành động của panel nhóm (issue #591):
                Tắt/Bật tiếng và Ghim/Bỏ ghim là hành động
                THẬT trên trạng thái cá nhân của hội thoại —
                cùng đường đổi trạng thái với menu đầu khung —
                để trạng thái tắt tiếng hiện và đổi được nhất
                quán ở mọi bề mặt của nhóm.
              */}
              <div className="flex gap-2 border-b px-3 py-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onUpdateConversationState(active, { muted: !active.muted })}
                >
                  {active.muted ? <Bell aria-hidden /> : <BellOff aria-hidden />}
                  {active.muted ? t('unmuteConversation') : t('muteConversation')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onUpdateConversationState(active, { pinned: !active.pinnedAt })}
                >
                  {active.pinnedAt ? <PinOff aria-hidden /> : <Pin aria-hidden />}
                  {active.pinnedAt ? t('unpinConversation') : t('pinConversation')}
                </Button>
              </div>
              <MemberPanel
                conversation={active}
                bundle={memberPanelBundle}
                myId={myId}
                onlineUsers={onlineUsers}
                readMarkers={readMarkers}
                newestSeq={newestSeq}
                onViewProfile={memberProfile.open}
              />
            </>
          ) : null}
          {!isGroup && otherId && partnerProfile ? (
            /*
              Panel HỒ SƠ NGƯỜI của chat 1–1 (issue #591) —
              đúng hình dạng demo: avatar + tên + dòng vai
              trò, khối trường hồ sơ, các thẻ, hàng hành động
              Tắt thông báo / Bỏ ghim / Chặn / Xoá, và khối
              tệp đã chia sẻ. Dữ kiện đi qua lớp adapter
              (`partnerProfile`): trường nào backend chưa có
              thì hiện dấu "—" ở đúng vị trí của nó (không
              bịa giá trị), chờ đợt backend #592 thay nguồn.
              Ba hành động đầu là hành động thật (đổi trạng
              thái cá nhân của hội thoại / chặn liên lạc);
              hành động Xoá cuộc trò chuyện chưa có đường dữ
              kiện phía client nên chỉ dựng hình dạng ở
              trạng thái vô hiệu.
            */
            <div data-testid="partner-panel" className="space-y-4 px-3 py-3">
              <div className="flex flex-col items-center gap-2 text-center">
                <span className="relative shrink-0">
                  <Avatar className="size-16">
                    <AvatarFallback className="text-lg">{initialsOf(avatarLabel)}</AvatarFallback>
                  </Avatar>
                  {otherOnline ? (
                    <span className="absolute right-0 bottom-0 size-3 rounded-full bg-emerald-500 ring-2 ring-background" />
                  ) : null}
                </span>
                <div className="min-w-0">
                  <p className="font-semibold break-words">{title}</p>
                  {partnerProfile.roleLine ? (
                    <p className="text-sm text-muted-foreground">{partnerProfile.roleLine}</p>
                  ) : null}
                  {/*
                    Dòng trạng thái ở panel dùng cùng luật ba
                    trạng thái với đầu khung: chỉ hiện khi đã
                    có sự kiện hiện diện xác nhận; chưa biết
                    thì không hiện dòng nào.
                  */}
                  {otherPresence !== undefined ? (
                    <p className="text-sm text-muted-foreground">
                      {otherPresence ? t('onlineNow') : t('messagesOfflineNow')}
                    </p>
                  ) : null}
                  {blocked.includes(otherId) ? (
                    <p className="text-sm">
                      {nameOf(otherId)} {t('blockedSuffix')}
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="flex justify-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="flex-col gap-1 py-2"
                  onClick={() => onUpdateConversationState(active, { muted: !active.muted })}
                >
                  {active.muted ? <Bell aria-hidden /> : <BellOff aria-hidden />}
                  {active.muted ? t('unmuteConversation') : t('muteConversation')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="flex-col gap-1 py-2"
                  onClick={() => onUpdateConversationState(active, { pinned: !active.pinnedAt })}
                >
                  {active.pinnedAt ? <PinOff aria-hidden /> : <Pin aria-hidden />}
                  {active.pinnedAt ? t('unpinConversation') : t('pinConversation')}
                </Button>
                {blocked.includes(otherId) ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="flex-col gap-1 py-2"
                    onClick={() => void unblockContact(otherId)}
                  >
                    <Ban aria-hidden />
                    {t('unblockContact')}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="flex-col gap-1 py-2"
                    onClick={() => void blockContact(otherId)}
                  >
                    <Ban aria-hidden />
                    {t('blockContact')}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="flex-col gap-1 py-2"
                  disabled
                >
                  <Trash aria-hidden />
                  {t('deleteConversation')}
                </Button>
              </div>
              <dl className="space-y-2 text-sm">
                {partnerProfile.bio ? (
                  <div>
                    <dt className="text-muted-foreground">{t('profileBio')}</dt>
                    <dd className="break-words">{partnerProfile.bio}</dd>
                  </div>
                ) : (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{t('profileBio')}</dt>
                    <dd className="text-muted-foreground">—</dd>
                  </div>
                )}
                {([
                  ['profileEmail', partnerProfile.email],
                  ['profilePhone', partnerProfile.phone],
                  ['profileWebsite', partnerProfile.website],
                  ['profileCompany', partnerProfile.company],
                  ['profileCountry', partnerProfile.country],
                  ['profileTimezone', partnerProfile.timezone],
                  ['profileLocation', partnerProfile.location],
                  ['profileAvailability', partnerProfile.availability],
                ] as const).map(([key, value]) => (
                  <div key={key} className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{t(key)}</dt>
                    <dd className="min-w-0 font-medium break-words">{value ?? '—'}</dd>
                  </div>
                ))}
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t('profileTags')}</dt>
                  <dd className="font-medium">
                    {partnerProfile.tags.length > 0 ? partnerProfile.tags.join(', ') : '—'}
                  </dd>
                </div>
              </dl>
              <div className="space-y-2">
                <h4 className="text-sm font-medium">{t('sharedFilesTitle')}</h4>
                {sharedFiles.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('sharedFilesEmpty')}</p>
                ) : (
                  <ul className="space-y-1">
                    {sharedFiles.map((file) => (
                      <li key={file.id} className="rounded-md border px-2 py-1.5 text-sm">{file.name}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}

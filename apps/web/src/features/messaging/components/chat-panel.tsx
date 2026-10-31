import { useEffect, useState, type Dispatch, type FormEvent, type ReactNode, type RefObject, type SetStateAction } from 'react';
import {
  Bell, BellOff, Building2, Check, CheckCheck, ChevronLeft, Clock, Ellipsis, EllipsisVertical,
  Eraser, FileText, Flag, Globe, Link2, Mail, MapPin, MessageSquare, MessagesSquare, Paperclip,
  Phone, Pin, PinOff, Reply, Send, Smile, SmilePlus, Sparkles, Trash, Undo2, Video, X,
} from 'lucide-react';
import { Avatar, AvatarFallback } from '@lms/ui/components/avatar';
import { Badge } from '@lms/ui/components/badge';
import { Bubble, BubbleContent } from '@lms/ui/components/bubble';
import { Button } from '@lms/ui/components/button';
import { cn } from '@lms/ui/lib/utils';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@lms/ui/components/dropdown-menu';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@lms/ui/components/popover';
import { Input } from '@lms/ui/components/input';
import { Separator } from '@lms/ui/components/separator';
import { Skeleton } from '@lms/ui/components/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@lms/ui/components/tabs';
import { Textarea } from '@lms/ui/components/textarea';
import {
  Tooltip, TooltipContent, TooltipTrigger,
} from '@lms/ui/components/tooltip';
import {
  Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader,
} from '@lms/ui/components/message';
import {
  MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem,
  MessageScrollerProvider, MessageScrollerViewport, useMessageScroller,
} from '@lms/ui/components/message-scroller';
import { useTranslation } from 'react-i18next';

import { formatWithOptions } from '#utils/date-format';
import { getPersonProfile, getSharedFiles, QUICK_REPLY_SHAPE_SAMPLES } from '../api/person-profile-adapter';
import type { ConversationStatePatch, ConversationView, MessageQuoteView, MessageSearchResultView, MessageView, PersonSummary, ScrollerHandle } from '../types/types';
import { MemberActionMenu, MemberPanel, MemberProfileSheet, useMemberProfile, type MemberPanelBundle } from './member-panel';
import {
  CHAT_MENU_CONTENT_CLASS, CHAT_MENU_ITEM_CLASS, PRESENCE_DOT_CLASS, initialsOf,
  presenceLabelKey, presenceStatusOf, quoteExcerptOfText,
} from '../utils/utils';

/**
 * Lưới emoji của bộ chọn ở ô soạn (issue #591; tập và thứ tự
 * căn đúng theo bản demo ở issue #608 — trích nguyên mảng
 * emoji từ chunk JS của demo): dựng trên component Popover
 * của `@lms/ui` (vòng sửa PR #593 — bản trước dùng
 * DropdownMenu đã bị cả hai lớp review bác vì khác component
 * và khác ngữ nghĩa), dạng lưới 5 cột × 4 hàng. Chọn emoji
 * vẫn chèn ký tự vào ô soạn như hành vi hiện có; không thêm
 * thư viện picker.
 */
const EMOJI_GRID_OPTIONS = [
  '😀', '😂', '😊', '😍', '🥳',
  '👍', '👏', '🙏', '❤️', '🔥',
  '✅', '👋', '🎉', '💯', '🤔',
  '😅', '🙌', '💪', '✨', '🚀',
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
  const { t, i18n } = useTranslation('app');
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
  /** Bộ chọn emoji ở ô soạn đang mở hay không (vòng sửa PR #593): Popover được điều khiển tường minh để chọn xong một emoji là đóng lại như hành vi menu trước đây. */
  const [emojiOpen, setEmojiOpen] = useState(false);
  /** Hồ sơ rút gọn của thành viên đang xem từ menu avatar/tên (lát MSG-T4) — một sheet dùng chung cho cả panel và dòng tin. */
  const memberProfile = useMemberProfile();
  useEffect(() => {
    setSearchOpen(false);
    setInfoOpen(false);
    setEmojiOpen(false);
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
    /*
      Trạng thái chưa chọn hội thoại theo đúng khuôn của bản
      demo (issue #608): icon MessageSquare 48px trần màu
      muted ở 30%, tiêu đề 14px vừa màu muted, dòng phụ 12px
      màu muted ở 70%, khoảng 12px, căn giữa — dựng tại nơi
      dùng trong feature này, không sửa component Empty dùng
      chung cho các trang khác.
    */
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-12 text-center">
        <MessageSquare className="size-12 text-muted-foreground/30" aria-hidden />
        <p className="text-sm font-medium text-muted-foreground">{t('selectConversation')}</p>
        <p className="text-xs text-muted-foreground/70">{t('pickConversation')}</p>
      </div>
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
   * khi đã có sự kiện xác nhận. Chấm hiện diện trên avatar
   * (đầu khung và panel) bám đúng ba trạng thái này: xanh lá
   * khi `true`, xám khi `false`, vắng hẳn khi `undefined` —
   * vắng chấm khi chưa biết không khẳng định điều gì sai.
   */
  const otherPresence = otherId ? onlineUsers[otherId] : undefined;
  /**
   * Trạng thái hiện diện HIỂN THỊ của đối tác (issue #608):
   * ánh xạ từ dữ kiện ba trạng thái ở trên qua tầng hiển thị
   * bốn trạng thái — chấm hiện diện và dòng trạng thái ở mọi
   * bề mặt của khung chat đều lấy màu/nhãn từ bản đồ chung
   * này (dữ kiện hiện hành chỉ cho ra trực tuyến/ngoại
   * tuyến/chưa biết).
   */
  const otherStatus = presenceStatusOf(otherPresence);
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
      : otherStatus !== undefined
        ? t(presenceLabelKey(otherStatus))
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
   * trong các phía còn lại. Mốc này chỉ còn nuôi dấu đã xem
   * trên bong bóng của chính người gửi — tin của mình có seq
   * không vượt mốc thì mang dấu đã xem, còn lại mang dấu đã
   * gửi. Dòng "Đã xem" riêng ở mức hội thoại đã bỏ ở issue
   * #608: bản demo không có dòng đó, trạng thái xem chỉ nằm
   * ở dấu tích trong chân từng bong bóng; thông tin "ai đã
   * xem" chi tiết vẫn sống ở panel thành viên (mốc đọc của
   * từng thành viên), không mất đường vào.
   */
  const seenThroughSeq = others.length > 0
    ? Math.min(...others.map((memberId) => readMarkers[memberId] ?? 0))
    : 0;

  const dayKeyOf = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  };
  /**
   * Nhãn ngăn cách ngày theo đúng hàm phía bản demo (issue
   * #608, trích từ chunk JS của demo): hôm nay và hôm qua
   * dùng nhãn chữ; cũ hơn dùng ngày lịch dạng tháng viết tắt
   * + ngày theo ngôn ngữ hiển thị (ví dụ "Jun 5" / "5 thg
   * 6"), không kèm năm — thay khuôn ngày giờ đầy đủ trước
   * đây.
   */
  const dayLabelOf = (iso: string) => {
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diffDays = Math.round((startOfDay(new Date()) - startOfDay(new Date(iso))) / 86_400_000);
    if (diffDays <= 0) return t('messagesToday');
    if (diffDays === 1) return t('messagesYesterday');
    return formatWithOptions(iso, i18n.language, { month: 'short', day: 'numeric' });
  };
  /**
   * Luồng tin kèm ngăn cách theo ngày (issue #608): các nhóm
   * ngày cách nhau 24px; trong một ngày, tin đầu mỗi CỤM
   * (đổi người gửi hoặc sang ngày mới) cách 16px, các tin
   * tiếp trong cụm cách 4px — đúng nhịp cụm của bản demo.
   * Dấu phân ngày là hộp Badge variant ghost 20px ở giữa
   * luồng. Tên người gửi và avatar chỉ hiện ở tin đầu cụm
   * (tên chỉ ở chat nhóm — chat 1–1 không hiện tên phía trên
   * bong bóng như demo); các tin sau trong cụm giữ một
   * khoảng trống đúng bề ngang avatar để bong bóng thẳng
   * cột.
   */
  const threadItems: ReactNode[] = [];
  let lastDayKey = '';
  let prevMessage: MessageView | null = null;
  for (const m of visibleMessages) {
    const dayKey = dayKeyOf(m.createdAt);
    const isFirstDay = lastDayKey === '';
    if (dayKey !== lastDayKey) {
      lastDayKey = dayKey;
      threadItems.push(
        <div key={`day-${dayKey}`} className={cn('flex justify-center', !isFirstDay && 'mt-6')}>
          <Badge variant="ghost" className="h-5 px-2 py-0.5 font-normal text-muted-foreground hover:bg-transparent">
            {dayLabelOf(m.createdAt)}
          </Badge>
        </div>,
      );
    }
    /** Tin này có mở đầu một cụm mới không (đổi ngày hoặc đổi người gửi so với tin ngay trước). */
    const firstOfCluster = !prevMessage || prevMessage.userIdFrom !== m.userIdFrom || dayKeyOf(prevMessage.createdAt) !== dayKey;
    prevMessage = m;
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
      <MessageScrollerItem
        key={m.id}
        messageId={m.id}
        scrollAnchor={mine}
        className={firstOfCluster ? 'mt-4' : 'mt-1'}
      >
        <Message align={mine ? 'end' : 'start'}>
          {firstOfCluster ? (
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
                  <AvatarFallback className="bg-muted text-foreground">{initialsOf(authorEntry.displayName)}</AvatarFallback>
                </Avatar>
              </MemberActionMenu>
            ) : (
              <Avatar>
                {/*
                  Màu avatar chữ viết tắt trong luồng theo
                  phía như bản demo (issue #608): tin của
                  mình nền primary chữ primary-foreground,
                  tin đến nền muted chữ foreground.
                */}
                <AvatarFallback className={mine ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'}>
                  {initialsOf(nameOf(m.userIdFrom))}
                </AvatarFallback>
              </Avatar>
            )}
          </MessageAvatar>
          ) : (
            // Tin tiếp trong cụm: giữ khoảng trống đúng bề
            // ngang avatar để cột bong bóng thẳng hàng (issue
            // #608 — avatar chỉ hiện ở tin đầu cụm như demo).
            <div aria-hidden className="w-8 shrink-0" />
          )}
          <MessageContent>
            {!mine && isGroup && firstOfCluster ? (
              <MessageHeader className="px-1">{nameOf(m.userIdFrom)}</MessageHeader>
            ) : null}
            <Bubble
              variant={m.deletedAt || m.recalledAt ? 'destructive' : mine ? 'default' : 'muted'}
              align={mine ? 'end' : 'start'}
              className={cn('max-w-sm', m.id === highlightedMessageId && 'rounded-lg ring-2 ring-primary ring-offset-1')}
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
                    className={cn(
                      'mb-1 block w-full max-w-full cursor-pointer rounded-lg border-l-2 px-2.5 py-1.5 text-left',
                      // Màu khối trích dẫn theo phía như bản
                      // demo (issue #608): trong bong bóng của
                      // mình là lớp phủ primary-foreground, trong
                      // bong bóng đến là nền đặc + viền primary.
                      mine
                        ? 'border-primary-foreground/50 bg-primary-foreground/15'
                        : 'border-primary/70 bg-background',
                    )}
                    onClick={() => onJumpToQuote(m.replyTo!)}
                  >
                    <span className="block text-xs font-semibold">{nameOf(m.replyTo.userIdFrom)}</span>
                    <span className="block text-xs opacity-80">
                      {m.replyTo.unavailable ? t('quotedMessageUnavailable') : m.replyTo.excerpt}
                    </span>
                  </button>
                ) : null}
                <span className="block">{m.recalledAt ? t('messageRecalled') : m.fullMessage}</span>
                {/*
                  Mốc giờ + dấu trạng thái trong bong bóng
                  (vòng sửa PR #593, theo đúng giá trị demo):
                  giờ cỡ 10px; dấu trạng thái cỡ 12px và có BA
                  trạng thái như demo — đang gửi (chưa có seq
                  phía server) là dấu đơn mờ 70%, đã tới server
                  nhưng chưa ai xem là dấu đôi mờ 70%, đã được
                  mọi phía còn lại xem (`seenByOthers`) là dấu
                  đôi đủ độ đậm.
                */}
                <span
                  data-testid={`message-time-${m.id}`}
                  className="mt-1 flex items-center justify-end gap-1 text-[10px] leading-none"
                >
                  {formatWithOptions(m.createdAt, i18n.language, { hour: 'numeric', minute: '2-digit', hour12: true })}
                  {mine && m.localStatus === 'sending' ? (
                    <Check className="size-3 opacity-70" aria-hidden />
                  ) : mine && !m.localStatus && m.seq > 0 ? (
                    seenByOthers ? (
                      <>
                        <CheckCheck className="size-3" aria-hidden />
                        <span className="sr-only">{t('seenByMembers')}</span>
                      </>
                    ) : (
                      <CheckCheck className="size-3 opacity-70" aria-hidden />
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
                Bong bóng bị giới hạn max-w-sm (issue #608,
                theo trần 384px của demo) nên phía nổi luôn còn
                khoảng trống của cột nội dung, không tràn mép
                khung cuộn. Điều kiện hiển thị (hover/
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
  }
  /*
    Chỉ báo đang nhập nằm TRONG luồng tin ở cuối luồng
    (issue #608 — thay dòng chữ trần phía trên khung soạn
    trước đây): hàng giống một tin đến — avatar 32px của
    người đang nhập đầu tiên + bong bóng nền muted bo 14px
    chứa ba chấm 6px màu muted ở 60% nảy lệch nhịp
    0/150/300ms như bản demo. Dòng trạng thái ở đầu khung
    vẫn báo chữ "đang nhập" song song như hiện hành.
  */
  if (typingNames.length > 0) {
    const firstTyper = typingNames[0]!;
    const lastMessage = visibleMessages[visibleMessages.length - 1];
    threadItems.push(
      <div
        key="typing-indicator"
        data-testid="typing-indicator"
        className={cn(
          'flex items-end gap-2',
          lastMessage && lastMessage.userIdFrom !== myId ? 'mt-1' : 'mt-4',
        )}
      >
        <Avatar>
          <AvatarFallback className="bg-muted text-foreground">{initialsOf(nameOf(firstTyper))}</AvatarFallback>
        </Avatar>
        <div className="flex items-center gap-1 rounded-xl bg-muted px-4 py-3" aria-hidden>
          <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60" />
          <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:150ms]" />
          <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:300ms]" />
        </div>
        <span className="sr-only">{t('typingIndicator', { userId: nameOf(firstTyper) })}</span>
      </div>,
    );
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
      {/*
        Cột chính của khung chat theo nhịp demo (issue #608):
        các khối xếp dọc cách nhau 12px; thanh đầu khung
        không còn đường kẻ dưới và không đệm dưới — khoảng
        tách với luồng tin do nhịp dọc của cột và đệm trên
        của vùng cuộn gánh.
      */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <div className="flex items-center justify-between gap-4 px-2 pt-3">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="md:hidden"
          aria-label={t('messagesBackToList')}
          onClick={() => onBack()}
        >
          <ChevronLeft aria-hidden />
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
          {otherStatus !== undefined ? (
            <span
              className={cn(
                'absolute right-0 bottom-0 size-2.5 rounded-full ring-2 ring-background',
                PRESENCE_DOT_CLASS[otherStatus],
              )}
            />
          ) : null}
        </button>
        <div className="min-w-0 flex-1">
          {/*
            Tiêu đề đầu khung chỉ gồm tên như bản demo (issue
            #608): icon tắt tiếng từng đứng cạnh tiêu đề đã
            gỡ — phía demo icon tắt tiếng chỉ có ở ô cuối
            hàng danh sách và trạng thái tắt tiếng đọc được
            trong menu More actions; panel và menu vẫn mang
            hành động tắt/bật tiếng như cũ.
          */}
          <p className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{title}</span>
          </p>
          {subtitle ? <p className="truncate text-xs leading-3 text-muted-foreground">{subtitle}</p> : null}
        </div>
        {/*
          Cụm nút hành động ở đầu khung theo đúng demo
          (issue #608): ba nút ghost 32px — Call, Video call
          và More actions (EllipsisVertical). Call/Video là
          HÌNH DẠNG THUẦN ở trạng thái vô hiệu: chức năng
          gọi chưa có quyết định, không nối đường gọi nào.
          Đúng như demo, Call và Video call mang Tooltip
          thật (component `tooltip` của `@lms/ui`) hiện
          đúng nhãn của nút khi di chuột; riêng More
          actions KHÔNG có tooltip — ở demo nút này là
          trigger trần của menu thả xuống, thêm tooltip
          vào sẽ thành lệch mới (phán quyết điều phối
          trên PR #610). Trigger của tooltip KHÔNG gắn
          thẳng lên nút: class gốc của Button mang
          `disabled:pointer-events-none` nên nút vô hiệu
          không nhận được sự kiện di chuột nào — trigger
          gắn thẳng lên nút thì tooltip không bao giờ
          kích hoạt được. Trigger vì vậy là một phần tử
          bọc `inline-flex` nhận hover quanh nút; nút bên
          trong vẫn giữ nguyên trạng thái vô hiệu, kích
          thước và vị trí trong cụm (phán quyết điều phối
          vòng sửa 2 trên PR #610). Nút Tìm kiếm riêng
          từng đứng ở đây đã gỡ; chức năng tìm trong
          cuộc trò chuyện dời vào menu More actions bên
          dưới (vẫn một bấm tới được như demo đặt mọi
          hành động phụ vào menu).
        */}
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t('callAction')} disabled>
              <Phone aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('callAction')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t('videoCallAction')} disabled>
              <Video aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('videoCallAction')}</TooltipContent>
        </Tooltip>
        {/*
          Menu More actions của đầu khung (issue #591; cấu
          trúc và bề rộng căn theo menu demo ở issue #608 —
          trích từ chunk JS của demo): bề rộng cố định 192px,
          các mục chỉ chữ theo đúng thứ tự demo: Xem hồ sơ
          (chỉ 1–1) → Tắt/Bật thông báo → Separator →
          Ghim/Bỏ ghim → Thêm/Bỏ khỏi yêu thích (hình dạng
          thuần, vô hiệu — yêu thích chưa có phán quyết) →
          Separator → Xoá lịch sử trò chuyện (hình dạng
          thuần, vô hiệu) → Chặn/Bỏ chặn (destructive, chỉ
          1–1, kèm tên đối tác như luật đã chốt) → Xoá
          (destructive, hình dạng thuần, vô hiệu). Sau
          Separator cuối là các chức năng thật riêng của sản
          phẩm mà demo không có: Tìm trong cuộc trò chuyện
          (dời từ nút riêng ở đầu khung), Báo cáo cuộc trò
          chuyện, Tắt/Bật chat (chỉ khi có thẩm quyền quản
          lý) — giữ nguyên đường vào, liệt kê trong thân PR.
        */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('conversationActionsLabel')}
                data-testid="header-actions"
              />
            }
          >
            <EllipsisVertical aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4} className="w-48">
            {!isGroup && otherId ? (
              <DropdownMenuItem
                className={CHAT_MENU_ITEM_CLASS}
                onClick={() => setInfoOpen(true)}
              >
                {t('viewProfile')}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              className={CHAT_MENU_ITEM_CLASS}
              onClick={() => onUpdateConversationState(active, { muted: !active.muted })}
            >
              {active.muted ? t('unmuteConversation') : t('muteConversation')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className={CHAT_MENU_ITEM_CLASS}
              onClick={() => onUpdateConversationState(active, { pinned: !active.pinnedAt })}
            >
              {active.pinnedAt ? t('unpinConversation') : t('pinConversation')}
            </DropdownMenuItem>
            <DropdownMenuItem className={CHAT_MENU_ITEM_CLASS} disabled>
              {t('addToFavourites')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className={CHAT_MENU_ITEM_CLASS} disabled>
              {t('clearChat')}
            </DropdownMenuItem>
            {!isGroup && otherId ? (
              <>
                {blocked.includes(otherId) ? (
                  <DropdownMenuItem variant="destructive" className={CHAT_MENU_ITEM_CLASS} onClick={() => void unblockContact(otherId)}>
                    {t('unblockContact')} {nameOf(otherId)}
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem variant="destructive" className={CHAT_MENU_ITEM_CLASS} onClick={() => void blockContact(otherId)}>
                    {t('blockContact')} {nameOf(otherId)}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem variant="destructive" className={CHAT_MENU_ITEM_CLASS} disabled>
                  {t('deleteConversation')}
                </DropdownMenuItem>
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className={CHAT_MENU_ITEM_CLASS}
              aria-pressed={searchOpen}
              onClick={() => setSearchOpen((prev) => !prev)}
            >
              {t('messageSearchLabel')}
            </DropdownMenuItem>
            <DropdownMenuItem className={CHAT_MENU_ITEM_CLASS} onClick={() => void reportActiveConversation()}>
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
            {/*
              Đệm vùng cuộn theo demo (issue #608): ngang
              8px, dọc 32px. MessageScrollerContent mang
              gap-8 (32px) mặc định trong chính component,
              nên nơi dùng ghi đè gap-0 để triệt khoảng
              cách đều của vùng chứa — khoảng cách giữa
              các mục chỉ do chính từng mục mang (nhóm
              ngày 24px, cụm tin 16/4px). Thiếu ghi đè
              này thì gap mặc định cộng dồn vào margin
              của từng mục thành 36/48px (vòng sửa
              PR #610).
            */}
            <MessageScrollerContent className="gap-0 px-2 py-8">
              {threadItems}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      {/*
        Khung bọc khung soạn theo nhịp demo (issue #608):
        cột dọc khoảng 12px, đệm ngang 12px, đệm dưới 8px,
        không đường kẻ trên — chỉ báo đang nhập đã chuyển
        vào trong luồng tin (xem khối dựng `threadItems`).
      */}
      <div className="flex flex-col gap-3 px-3 pb-2">
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
                className="flex items-center gap-2 rounded-lg border-l-2 border-primary bg-muted/50 px-3 py-2"
              >
                {/*
                  Nội dung thanh xem trước trả lời xếp HAI
                  dòng như bản demo (issue #608): dòng tác
                  giả 12px vừa màu primary ở trên, dòng trích
                  12px màu muted cắt một dòng ở dưới.
                */}
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium text-primary">{t('replyingTo', { user: nameOf(replyTarget.userIdFrom) })}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {replyTarget.recalledAt ? t('quotedMessageUnavailable') : quoteExcerptOfText(replyTarget.fullMessage)}
                  </span>
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
              Ô soạn theo bản demo (issue #591; vòng sửa PR
              #593 đưa về đúng dạng XẾP CHỒNG của demo):
              - Tab Trả lời / Ghi chú nội bộ ở trên cùng: tab
                Ghi chú nội bộ là điểm CHƯA có phán quyết chức
                năng — chỉ dựng hình dạng, ở trạng thái vô hiệu.
              - Chip trả lời nhanh phía trên ô nhập: CHỈ HÌNH
                DẠNG từ lớp adapter, vô hiệu, không chèn nội
                dung nào (điểm chưa có phán quyết).
              - Ô nhập nằm PHÍA TRÊN, hàng công cụ nằm PHÍA
                DƯỚI (cột dọc như demo): hàng công cụ theo
                thứ tự Bold → Emoji → Attach → Link ở nhóm
                trái và nút Gửi ở phía phải (issue #608); nút
                định dạng đậm + đính kèm + chèn liên kết là
                hình dạng vô hiệu (điểm chưa có phán quyết);
                nút emoji mở POPOVER lưới (component Popover
                của `@lms/ui`); nút Gửi là nút BIỂU TƯỢNG, vẫn
                vô hiệu khi nháp trống; KHÔNG còn bộ đếm ký
                tự và khung nhập phình to như trước (trần ký tự
                vẫn được cổng gửi chặn như cũ, lỗi hiện ở dòng
                báo lỗi dưới ô soạn).
            */}
            {/*
              Thanh tab của khung soạn theo demo (issue
              #608): TabsList variant line — bề ngang đầy đủ,
              căn trái, khoảng 8px, đường kẻ dưới, cao 40px;
              các trigger không giãn đều. Tab Ghi chú nội bộ
              vẫn là hình dạng thuần vô hiệu như trước.
            */}
            <Tabs value="reply">
              <TabsList variant="line" className="h-10 w-full justify-start gap-2 border-b px-3">
                <TabsTrigger value="reply" className="flex-none">{t('replyTabLabel')}</TabsTrigger>
                <TabsTrigger value="internal-note" className="flex-none" disabled>{t('internalNoteTabLabel')}</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_REPLY_SHAPE_SAMPLES.map((sample) => (
                <Button
                  key={sample}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-auto rounded-full px-3 py-1 text-xs text-muted-foreground hover:bg-muted"
                  disabled
                >
                  {sample}
                </Button>
              ))}
            </div>
            <form onSubmit={(e) => void send(e)} className="flex flex-col gap-2">
              <Textarea
                aria-label={t('messageText')}
                rows={1}
                className="max-h-32 min-h-10 min-w-0 resize-none rounded-none border-0 px-0 py-2 text-sm shadow-none focus-visible:ring-0"
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
              {/*
                Hàng công cụ soạn theo đúng thứ tự và khuôn
                phía demo (issue #608): hàng tách hai phía —
                nhóm trái khoảng 4px gồm Bold (nút ghost chứa
                chữ "B" như demo), Emoji, Attach, Link; nút
                Send ở phía phải với glyph Send. Bold/Attach/
                Link vẫn là hình dạng vô hiệu như trước (điểm
                chưa có phán quyết); bộ chọn emoji dùng khuôn
                đã trích từ demo: PopoverContent `w-64 p-2`,
                lưới 5 cột khoảng 4px, nút emoji đệm 8px.
              */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('boldLabel')}
                    disabled
                  >
                    <span className="text-base leading-none font-medium">B</span>
                  </Button>
                  <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
                    <PopoverTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('emojiPickerLabel')}
                        />
                      }
                    >
                      <Smile aria-hidden />
                    </PopoverTrigger>
                    <PopoverContent
                      align="start"
                      sideOffset={4}
                      data-testid="emoji-picker-popover"
                      className="w-64 p-2"
                    >
                      <div className="grid grid-cols-5 gap-1">
                        {EMOJI_GRID_OPTIONS.map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            className="flex items-center justify-center rounded-md p-2 text-lg transition-colors hover:bg-muted"
                            onClick={() => {
                              setDrafts((prev) => ({ ...prev, [active.id]: `${prev[active.id] ?? ''}${emoji}` }));
                              noteTyping();
                              setEmojiOpen(false);
                            }}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('attachFileLabel')}
                    disabled
                  >
                    <Paperclip aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('insertLinkLabel')}
                    disabled
                  >
                    <Link2 aria-hidden />
                  </Button>
                </div>
                <Button
                  type="submit"
                  size="icon-sm"
                  aria-label={t('send')}
                  disabled={sendInFlight || !draft.trim()}
                >
                  <Send aria-hidden />
                </Button>
              </div>
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
          className="absolute inset-y-0 right-0 z-20 flex w-[85vw] max-w-[320px] min-w-0 flex-col overflow-x-hidden overflow-y-auto border-l bg-background shadow-xl md:static md:z-auto md:w-[320px] md:shrink-0 md:shadow-none"
        >
          {/*
            Panel không còn thanh tiêu đề riêng và nút đóng
            riêng như trước (issue #608): phía demo đầu panel
            là chính khối hồ sơ, panel là một cột của khung —
            đóng panel bằng nút avatar ở đầu khung. Riêng ở
            di động panel là lớp phủ che mất nút avatar đó
            nên giữ một nút đóng nhỏ chỉ hiện ở di động.
          */}
          {isGroup && memberPanelBundle ? (
            <>
              <div className="flex justify-end px-3 pt-2 md:hidden">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('closeDialog')}
                  onClick={() => setInfoOpen(false)}
                >
                  <X aria-hidden />
                </Button>
              </div>
              {/*
                Hàng hành động của panel nhóm (issue #591):
                Tắt/Bật tiếng và Ghim/Bỏ ghim là hành động
                THẬT trên trạng thái cá nhân của hội thoại —
                cùng đường đổi trạng thái với menu đầu khung —
                để trạng thái tắt tiếng hiện và đổi được nhất
                quán ở mọi bề mặt của nhóm.
              */}
              <div className="flex flex-wrap gap-2 border-b px-3 py-2">
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
              Panel HỒ SƠ NGƯỜI của chat 1–1 (issue #591;
              hình dạng căn lại theo demo ở issue #608) —
              đầu panel là khối hồ sơ dính trên cùng (avatar
              40px bên trái tên, các thẻ), danh sách hành
              động dọc bề ngang đầy đủ, các hàng trường kèm
              icon, đoạn giới thiệu riêng và khối tệp đã
              chia sẻ; nút Xoá nằm ở đáy panel. Dữ kiện đi
              qua lớp adapter (`partnerProfile`): trường nào
              backend chưa có thì KHÔNG dựng hàng tương ứng
              (luật của demo, thay luật hiện dấu "—" trước
              đây), không bịa giá trị, chờ đợt backend thay
              nguồn.
            */
            <div data-testid="partner-panel" className="flex min-h-full flex-col">
              {/*
                Đầu panel là CHÍNH khối hồ sơ, dính trên cùng
                khi cuộn (issue #608): avatar 40px ở bên trái
                tên, dòng vai trò và dòng trạng thái chỉ hiện
                khi có dữ kiện (trường trống không dựng hàng
                — cùng luật với các trường hồ sơ bên dưới),
                các thẻ là huy hiệu outline ở cuối khối.
              */}
              <div className="sticky top-0 z-10 flex items-start gap-3 bg-background px-4 py-4">
                <span className="relative shrink-0">
                  <Avatar size="lg">
                    <AvatarFallback>{initialsOf(avatarLabel)}</AvatarFallback>
                  </Avatar>
                  {otherStatus !== undefined ? (
                    <span
                      className={cn(
                        'absolute right-0 bottom-0 size-2.5 rounded-full ring-2 ring-background',
                        PRESENCE_DOT_CLASS[otherStatus],
                      )}
                    />
                  ) : null}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium break-words">{title}</p>
                  {partnerProfile.roleLine ? (
                    <p className="text-xs text-muted-foreground">{partnerProfile.roleLine}</p>
                  ) : null}
                  {otherStatus !== undefined ? (
                    <p className="text-xs text-muted-foreground">
                      {t(presenceLabelKey(otherStatus))}
                    </p>
                  ) : null}
                  {blocked.includes(otherId) ? (
                    <p className="text-sm">
                      {nameOf(otherId)} {t('blockedSuffix')}
                    </p>
                  ) : null}
                  {partnerProfile.tags.length > 0 ? (
                    <div className="mt-1 flex flex-wrap justify-end gap-1">
                      {partnerProfile.tags.map((tag) => (
                        <Badge key={tag} variant="outline">{tag}</Badge>
                      ))}
                    </div>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="md:hidden"
                  aria-label={t('closeDialog')}
                  onClick={() => setInfoOpen(false)}
                >
                  <X aria-hidden />
                </Button>
              </div>
              <div className="space-y-4 px-4 pb-4">
                <Separator />
                {/*
                  Danh sách hành động của panel theo đúng
                  hình dạng demo (issue #608, trích từ chunk
                  JS của demo): các nút outline bề ngang đầy
                  đủ, chữ căn trái, xếp dọc cách 8px, chỉ chữ.
                  Tắt tiếng / Ghim / Chặn là hành động THẬT
                  qua cùng đường đổi trạng thái và chặn liên
                  lạc như mọi bề mặt khác; Thêm vào yêu thích
                  và Xoá lịch sử trò chuyện là chức năng sản
                  phẩm chưa có — chỉ dựng hình dạng ở trạng
                  thái vô hiệu theo luật điểm chưa quyết, ghi
                  rõ trong thân PR.
                */}
                <div className="flex flex-col gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-start"
                    onClick={() => onUpdateConversationState(active, { muted: !active.muted })}
                  >
                    {active.muted ? t('unmuteConversation') : t('muteConversation')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-start"
                    onClick={() => onUpdateConversationState(active, { pinned: !active.pinnedAt })}
                  >
                    {active.pinnedAt ? t('unpinConversation') : t('pinConversation')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-start"
                    disabled
                  >
                    {t('addToFavourites')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-start"
                    disabled
                  >
                    {t('clearChat')}
                  </Button>
                  {blocked.includes(otherId) ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full justify-start"
                      onClick={() => void unblockContact(otherId)}
                    >
                      {t('unblockContact')}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full justify-start"
                      onClick={() => void blockContact(otherId)}
                    >
                      {t('blockContact')}
                    </Button>
                  )}
                </div>
                {/*
                  Đoạn giới thiệu (About) là một đoạn văn
                  riêng màu muted như demo — không còn là một
                  hàng trong bảng trường. Chỉ dựng khi adapter
                  có dữ kiện.
                */}
                {partnerProfile.bio ? (
                  <div className="space-y-1">
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      <FileText className="size-4" aria-hidden />
                      {t('profileBio')}
                    </p>
                    <p className="text-sm leading-relaxed text-muted-foreground">{partnerProfile.bio}</p>
                  </div>
                ) : null}
                {/*
                  Các hàng trường hồ sơ theo khuôn demo: nhãn
                  màu muted kèm icon 16px, giá trị đẩy phải
                  (`ml-auto`) và cắt đúng một dòng. Trường nào
                  adapter chưa có dữ kiện thì KHÔNG dựng hàng
                  (issue #608 — thay luật hiện dấu "—" trước
                  đây); dữ kiện vẫn đi qua lớp adapter như
                  cũ, không bịa giá trị.
                */}
                <dl className="space-y-2 text-sm">
                  {([
                    ['profileEmail', partnerProfile.email, Mail],
                    ['profilePhone', partnerProfile.phone, Phone],
                    ['profileWebsite', partnerProfile.website, Globe],
                    ['profileCompany', partnerProfile.company, Building2],
                    ['profileCountry', partnerProfile.country, Flag],
                    ['profileTimezone', partnerProfile.timezone, Clock],
                    ['profileLocation', partnerProfile.location, MapPin],
                    ['profileAvailability', partnerProfile.availability, Sparkles],
                  ] as const).filter(([, value]) => Boolean(value)).map(([key, value, Icon]) => (
                    <div key={key} className="flex items-center gap-2">
                      <dt className="flex items-center gap-2 text-muted-foreground">
                        <Icon className="size-4" aria-hidden />
                        {t(key)}
                      </dt>
                      <dd className="ml-auto min-w-0 truncate">{value}</dd>
                    </div>
                  ))}
                </dl>
                {/*
                  Khối tệp đã chia sẻ (giữ chức năng — điểm
                  chưa quyết về đính kèm, xem adapter): giữ
                  nguyên bề mặt và nguồn dữ kiện hiện tại,
                  liệt kê trong thân PR theo nhóm điểm giữ
                  chức năng.
                */}
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
              {/*
                Nút Xoá ở ĐÁY panel theo đúng vị trí demo
                (issue #608): nút destructive bề ngang đầy
                đủ, icon thùng rác 16px, bị đẩy xuống đáy
                bằng `mt-auto`. Chức năng xoá cuộc trò
                chuyện chưa có đường dữ kiện phía client
                nên chỉ dựng hình dạng ở trạng thái vô hiệu
                như trước.
              */}
              <div className="mt-auto px-4 pb-4 pt-2">
                <Button type="button" variant="destructive" className="w-full gap-2" disabled>
                  <Trash className="size-4" aria-hidden />
                  {t('deleteConversation')}
                </Button>
              </div>
            </div>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}

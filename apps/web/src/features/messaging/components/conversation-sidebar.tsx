import { useState, type ReactNode } from 'react';
import { BellOff, ChevronDown, Pin, Plus } from 'lucide-react';
import { Avatar, AvatarFallback } from '@lms/ui/components/avatar';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@lms/ui/components/collapsible';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@lms/ui/components/dropdown-menu';
import { Input } from '@lms/ui/components/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@lms/ui/components/tabs';
import { cn } from '@lms/ui/lib/utils';
import { useTranslation } from 'react-i18next';
import { CreateGroupSheet } from './create-group-sheet';
import { GroupTreeNav } from './group-tree-nav';
import { NewMessageSheet } from './new-message-sheet';
import type {
  ContactRequestView,
  ConversationGroupTreeView,
  ConversationStatePatch,
  ConversationView,
  MessagingCourse,
  PeoplePickerContext,
  RosterMember,
} from '../types/types';
import { CHAT_MENU_CONTENT_CLASS, CHAT_MENU_ITEM_CLASS, initialsOf, relativeTime } from '../utils/utils';

/**
 * Khung trái màn Tin nhắn (lát MSG-T3, issue #33) — tổ chức lại
 * theo cấu trúc đã chốt 11:36 ngày 26/10/2026 (hồ sơ
 * `messaging-structure-research-2026-10-26.md`), thay cấu trúc
 * #256 cũ (danh sách phẳng trộn mọi loại + tab Danh bạ làm đường
 * chính — cách tổ chức đã bị tuyên bố là sai phải thay):
 *
 * - Tab **Trò chuyện**: CHỈ hội thoại cá nhân 1–1 (`type === 1`),
 *   giữ ô tìm theo tên hiển thị (chỉ lọc hội thoại đã có — không
 *   phải tìm người) và chip Tất cả / Chưa đọc kèm số đếm trên toàn
 *   bộ hội thoại 1–1. Trong tab, danh sách chia thành các mục thu
 *   gọn **Ghim** (chỉ hiện khi có hội thoại đã ghim), **Gần đây**
 *   và **Đã lưu trữ** (issue #564 — thay tab Đã lưu trữ cũ; mục
 *   này giữ nguyên cơ chế M5: danh sách riêng của server, nạp khi
 *   mở mục lần đầu).
 * - Tab **Nhóm**: cây Lớp → Khoá → Nhóm con + Khoá ngoài lớp +
 *   Nhóm tự do do server dựng sẵn ({@link GroupTreeNav}); bấm một
 *   nút là mở ngay chat của nút đó ở khung phải. Tab mang huy hiệu
 *   tổng số chưa đọc của cả cây.
 * - Nút **Tin nhắn mới** cạnh tiêu đề mở sheet cùng tên ({@link
 *   NewMessageSheet}): nơi tab Danh bạ cũ bị hạ xuống — lời mời kết
 *   bạn (kèm huy hiệu số lượng trên chính nút này), chọn người từ
 *   liên hệ/roster lớp/khoá, và mục liên hệ đã chặn.
 * - Tiêu đề khung trái kèm avatar của chính người xem — ánh xạ nút
 *   Invite của bản demo (đường vào hộp thoại mời vẫn là nút Tin
 *   nhắn mới, giữ nhãn tiếng Việt hiện có).
 *
 * Tab đang chọn do TRANG chứa giữ (và lưu bền cùng hội thoại đang
 * mở) để quay lại màn Tin nhắn là gặp đúng ngữ cảnh gần nhất; các
 * trạng thái thoáng qua của riêng khung trái (chip lọc, từ khoá
 * tìm, sheet đang mở) ở lại component này.
 */
interface ConversationSidebarProps {
  /** Danh sách hội thoại CHƯA lưu của tôi (mọi loại — tab Trò chuyện tự lọc 1–1). */
  conversations: ConversationView[];
  /** Mục ĐÃ LƯU (lát M5): danh sách riêng của server, nạp khi mở mục Đã lưu trữ trong tab Trò chuyện. */
  archivedConversations: ConversationView[];
  /** Nạp (lại) mục đã lưu từ server — gọi khi người dùng mở mục Đã lưu trữ. */
  onRequestArchived: () => void;
  /** Cây nhóm của tôi do server dựng (lát MSG-T1) cho tab Nhóm. */
  groupTree: ConversationGroupTreeView | null;
  active: ConversationView | null;
  unread: number;
  error: string | null;
  myId: string | undefined;
  onlineUsers: Record<string, boolean>;
  onOpenConversation: (conversation: ConversationView) => void;
  /** Mở một conversation theo id (nút cây đã có conversationId). */
  onOpenConversationById: (conversationId: string) => void;
  /** Mở chat cấp lớp từ nút lớp của cây (trang chứa ensure). */
  onOpenClassChat: (classId: string) => void;
  /** Mở chat cấp khoá từ nút khoá của cây (trang chứa ensure). */
  onOpenCourseChat: (courseId: string) => void;
  /** Mở chat của một nhóm con chưa có conversation (trang chứa tạo/lấy). */
  onOpenGroupConversation: (groupId: string) => void;
  /** Người xem có vai dạy/staff trên cây — quyết định hiện nút tạo nhóm tự do. */
  canCreateFreeGroup: boolean;
  /** Tạo nhóm tự do (trang chứa gọi API); resolve true khi tạo thành công để khung trái đóng sheet. */
  onCreateFreeGroup: (name: string, memberIds: string[]) => Promise<boolean>;
  /** Lỗi tạo nhóm gần nhất (trang chứa dịch từ mã lỗi server); null khi không có. */
  groupCreateError: string | null;
  /** Đặt một cờ trạng thái cá nhân (ghim/lưu/tắt tiếng) cho một cuộc trò chuyện (lát M5). */
  onUpdateConversationState: (conversation: ConversationView, patch: ConversationStatePatch) => void;
  /** Lỗi của lần đổi trạng thái gần nhất (lát M5); null khi không có. */
  stateError: string | null;
  nameOf: (userId: string) => string;
  /** Tab đang chọn — trang chứa giữ để nhớ ngữ cảnh gần nhất. */
  tab: string;
  /** Đổi tab (trang chứa lưu bền giá trị mới). */
  onTabChange: (tab: string) => void;
  // --- Dữ kiện + sự kiện cho hai sheet (trang chứa giữ, khung trái trình bày) ---
  contacts: string[];
  contactMessage: string | null;
  incomingRequests: ContactRequestView[];
  outgoingRequests: ContactRequestView[];
  blocked: string[];
  blockMessage: string | null;
  onMessageContact: (userId: string) => void;
  onSendContactRequest: (userId: string) => void;
  onRespondContactRequest: (userId: string, action: 'accept' | 'decline') => void;
  onUnblockContact: (userId: string) => void;
  /** Ngữ cảnh chọn người đang chọn trong bộ chọn của hai sheet. */
  pickerContext: PeoplePickerContext;
  /** Đổi ngữ cảnh chọn người (trang chứa nạp roster tương ứng). */
  onSelectPickerContext: (context: PeoplePickerContext) => void;
  /** Các lớp của tôi cho ngữ cảnh theo lớp của bộ chọn. */
  pickerClasses: { classId: string; name: string }[];
  /** Các khoá của tôi cho ngữ cảnh theo khoá của bộ chọn. */
  pickerCourses: MessagingCourse[];
  /** Một trang roster của ngữ cảnh lớp/khoá đang chọn trong bộ chọn. */
  pickerMembers: RosterMember[];
  /** Lỗi nạp roster của bộ chọn; null khi không có. */
  pickerRosterError: string | null;
  /** Con trỏ trang roster kế của bộ chọn; null là đã hết trang. */
  pickerRosterCursor: string | null;
  /** Tải trang roster tiếp theo cho bộ chọn. */
  onLoadMorePicker: () => void;
}

type ConversationFilterChip = 'all' | 'unread';

/**
 * Trình bày khung trái Tin nhắn: tiêu đề + avatar người xem + nút
 * Tin nhắn mới, hai tab Trò chuyện / Nhóm (trong tab Trò chuyện là
 * các mục thu gọn Ghim / Gần đây / Đã lưu trữ), và hai sheet (Tin
 * nhắn mới, Tạo nhóm).
 *
 * @param props - Dữ kiện và sự kiện do trang Tin nhắn đưa xuống.
 * @returns Khung trái hoàn chỉnh của màn master–detail.
 */
export function ConversationSidebar({
  conversations, archivedConversations, onRequestArchived, groupTree, active, unread, error, myId, onlineUsers,
  onOpenConversation, onOpenConversationById, onOpenClassChat, onOpenCourseChat, onOpenGroupConversation,
  canCreateFreeGroup, onCreateFreeGroup, groupCreateError,
  onUpdateConversationState, stateError, nameOf, tab, onTabChange,
  contacts, contactMessage, incomingRequests, outgoingRequests, blocked, blockMessage,
  onMessageContact, onSendContactRequest, onRespondContactRequest, onUnblockContact,
  pickerContext, onSelectPickerContext, pickerClasses, pickerCourses, pickerMembers,
  pickerRosterError, pickerRosterCursor, onLoadMorePicker,
}: ConversationSidebarProps) {
  const { t } = useTranslation('app');
  const open = onOpenConversation;
  const [chip, setChip] = useState<ConversationFilterChip>('all');
  const [newMessageOpen, setNewMessageOpen] = useState(false);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  /**
   * Trạng thái mở của ba mục thu gọn trong tab Trò chuyện (issue
   * #564): Ghim và Gần đây mở mặc định để hội thoại đã ghim không
   * bị giấu sau một lần bấm thêm; Đã lưu trữ đóng mặc định vì nó
   * là danh sách riêng chỉ cần khi người dùng tìm lại.
   */
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [recentOpen, setRecentOpen] = useState(true);
  const [archivedOpen, setArchivedOpen] = useState(false);
  /**
   * Lọc danh sách hội thoại theo TÊN HIỂN THỊ (lát M4, issue #237):
   * lọc ngay tại client trên danh sách đã tải — tên hiển thị là đúng
   * chuỗi người dùng thấy (tên hội thoại hoặc tên các thành viên),
   * khớp chuỗi con không phân biệt hoa thường. Chỉ lọc hội thoại ĐÃ
   * CÓ — không phải tìm người theo tên.
   */
  const [conversationFilter, setConversationFilter] = useState('');
  /** Từ khoá lọc cây nhóm theo tên lớp/khoá/nhóm (chỉ lọc cây đã có — cùng luật M4). */
  const [groupFilter, setGroupFilter] = useState('');
  /**
   * Nhắn tin từ sheet Tin nhắn mới thì đóng sheet, khung trái về
   * tab Trò chuyện để thấy hội thoại 1–1 vừa mở ở khung phải.
   */
  const messageContact = (userId: string) => {
    setNewMessageOpen(false);
    onTabChange('chats');
    onMessageContact(userId);
  };
  /** Tạo nhóm thành công thì đóng sheet tạo nhóm và về tab Nhóm để thấy nhóm vừa tạo trong cây. */
  const createFreeGroup = async (name: string, memberIds: string[]) => {
    const created = await onCreateFreeGroup(name, memberIds);
    if (created) {
      setCreateGroupOpen(false);
      onTabChange('groups');
    }
  };
  /**
   * Tên hiển thị của hội thoại: hội thoại có tên (nhóm) dùng tên
   * đó. Hội thoại 1–1 không có tên — backend không đặt tên cho
   * 1–1 — thì hiện tên ĐỐI TÁC suy từ danh sách thành viên; chỉ
   * khi không xác định được đối tác mới rơi về nhãn dự phòng liệt
   * kê mọi thành viên. Ô lọc danh sách khớp trên chính nhãn này
   * nên tìm theo tên đối tác vẫn trúng sau thay đổi.
   */
  const labelOf = (c: ConversationView) => {
    if (c.name !== null) return c.name;
    const otherId = c.type === 1 ? c.members.find((id) => id !== myId) : undefined;
    return otherId
      ? nameOf(otherId)
      : t('conversationWithUser', { members: c.members.map((id) => nameOf(id)).join(', ') });
  };
  const filterNeedle = conversationFilter.trim().toLocaleLowerCase('vi');
  const matchesFilter = (c: ConversationView) =>
    !filterNeedle || labelOf(c).toLocaleLowerCase('vi').includes(filterNeedle);
  // Tab Trò chuyện CHỈ chứa hội thoại cá nhân 1–1 (cấu trúc MSG-T3):
  // mọi hội thoại type 2 (nhóm tự do/nhóm con/chat khoá/chat lớp)
  // đều thuộc tab Nhóm, không trộn vào đây theo bất kỳ chip nào.
  const visibleConversations = conversations
    .filter((c) => c.type === 1)
    .filter(matchesFilter)
    .filter((c) => (chip === 'unread' ? (c.unread ?? 0) > 0 : true));
  const visibleArchived = archivedConversations.filter(matchesFilter);
  /**
   * Tách danh sách đã lọc thành mục Ghim / Gần đây (issue #564):
   * hội thoại mang `pinnedAt` lên mục Ghim, còn lại về Gần đây.
   * Mục Ghim chỉ render khi có hội thoại đã ghim.
   */
  const pinnedConversations = visibleConversations.filter((c) => c.pinnedAt);
  const recentConversations = visibleConversations.filter((c) => !c.pinnedAt);
  /**
   * Số đếm trên chip lọc: tính trên TOÀN BỘ hội thoại 1–1 (không
   * chịu ô tìm hay chip đang chọn) để chip luôn cho biết quy mô
   * thật của từng tập; danh sách bên dưới vẫn lọc theo ô tìm +
   * chip như trước.
   */
  const allConversations = conversations.filter((c) => c.type === 1);
  const allCount = allConversations.length;
  const unreadCountTotal = allConversations.filter((c) => (c.unread ?? 0) > 0).length;
  // Tổng chưa đọc của cả cây — huy hiệu trên tab Nhóm (nút lớp đã
  // mang tổng của các nút con trong nó theo hợp đồng MSG-T1).
  const treeUnreadTotal = groupTree
    ? groupTree.classes.reduce((sum, c) => sum + c.unread, 0)
      + groupTree.coursesOutsideClasses.reduce((sum, c) => sum + c.unread, 0)
      + groupTree.freeGroups.reduce((sum, g) => sum + g.unread, 0)
    : 0;

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
            <DropdownMenuContent align="end" sideOffset={4} className={CHAT_MENU_CONTENT_CLASS}>
              <DropdownMenuItem className={CHAT_MENU_ITEM_CLASS} onClick={() => onUpdateConversationState(c, { pinned: !c.pinnedAt })}>
                {c.pinnedAt ? t('unpinConversation') : t('pinConversation')}
              </DropdownMenuItem>
              <DropdownMenuItem className={CHAT_MENU_ITEM_CLASS} onClick={() => onUpdateConversationState(c, { archived: !c.archivedAt })}>
                {c.archivedAt ? t('unarchiveConversation') : t('archiveConversation')}
              </DropdownMenuItem>
              <DropdownMenuItem className={CHAT_MENU_ITEM_CLASS} onClick={() => onUpdateConversationState(c, { muted: !c.muted })}>
                {c.muted ? t('unmuteConversation') : t('muteConversation')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </li>
    );
  };

  const chips: { key: ConversationFilterChip; label: string; count: number }[] = [
    { key: 'all', label: t('messagesFilterAll'), count: allCount },
    { key: 'unread', label: t('messagesFilterUnread'), count: unreadCountTotal },
  ];

  /**
   * Một mục thu gọn trong tab Trò chuyện (issue #564): tiêu đề
   * phẳng kiểu demo (nhãn + số đếm + chevron), dựng trên primitive
   * Collapsible của @lms/ui — KHÔNG dùng vỏ Card của
   * CollapsibleSection dùng chung (vỏ đó không khớp section phẳng
   * của demo) và không tự chế kiểu collapse riêng. Số đếm đặt
   * trong span `aria-hidden` để tên truy cập của nút vẫn đúng
   * nhãn của mục, như chip lọc bên dưới.
   *
   * @param title - Nhãn của mục.
   * @param count - Số dòng trong mục (hiện sau nhãn).
   * @param open - Mục đang mở hay đóng.
   * @param onOpenChange - Đổi trạng thái mở của mục.
   * @param children - Nội dung mục khi mở.
   * @returns Mục thu gọn hoàn chỉnh.
   */
  const renderSection = (
    title: string,
    count: number,
    open: boolean,
    onOpenChange: (next: boolean) => void,
    children: ReactNode,
  ) => (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium hover:bg-muted">
        <span>{title}</span>
        <span aria-hidden className="text-xs text-muted-foreground">{count}</span>
        <ChevronDown aria-hidden className={cn('ml-auto size-4 shrink-0 transition-transform', open && 'rotate-180')} />
      </CollapsibleTrigger>
      {/*
        Nội dung chỉ render khi mục mở: section đóng thì các dòng
        trong đó biến khỏi cây hoàn toàn (không chỉ ẩn bằng CSS),
        để hội thoại đã lưu/ghim không còn tính là "đang hiện" ở
        danh sách khi mục đóng.
      */}
      <CollapsibleContent>{open ? children : null}</CollapsibleContent>
    </Collapsible>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-4 pt-3">
        <div className="flex min-w-0 items-center gap-2">
          {myId ? (
            <Avatar>
              <AvatarFallback>{initialsOf(nameOf(myId))}</AvatarFallback>
            </Avatar>
          ) : null}
          <h2 className="text-base font-semibold">
            {t('messagesTitle')} {unread > 0 ? t('unreadSuffix', { count: unread }) : ''}
          </h2>
        </div>
        <Button type="button" size="sm" aria-label={t('newMessage')} onClick={() => setNewMessageOpen(true)}>
          <Plus className="size-4" />
          {t('newMessage')}
          {incomingRequests.length > 0 ? (
            <>
              <Badge className="shrink-0">{incomingRequests.length}</Badge>
              <span className="sr-only">{t('incomingRequestsTitle')}</span>
            </>
          ) : null}
        </Button>
      </div>
      {error ? <p role="alert" className="px-4 pt-2 text-sm">{error}</p> : null}
      {stateError ? <p role="alert" className="px-4 pt-2 text-sm">{stateError}</p> : null}
      <Tabs
        value={tab}
        onValueChange={(value) => {
          onTabChange(value);
        }}
        className="min-h-0 flex-1 px-2 pt-2"
      >
        <TabsList className="w-full">
          <TabsTrigger value="chats">{t('messagesTabChats')}</TabsTrigger>
          <TabsTrigger value="groups" aria-label={t('messagesTabGroups')}>
            {t('messagesTabGroups')}
            {treeUnreadTotal > 0 ? <Badge className="ml-1.5 shrink-0">{treeUnreadTotal}</Badge> : null}
          </TabsTrigger>
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
              {chips.map(({ key, label, count }) => (
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
                  <span aria-hidden>{count}</span>
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
                    : t('conversationsEmpty')}
              </p>
            ) : (
              <div className="space-y-1">
                {pinnedConversations.length > 0 ? renderSection(
                  t('messagesPinnedSection'),
                  pinnedConversations.length,
                  pinnedOpen,
                  setPinnedOpen,
                  <ul className="space-y-0.5">{pinnedConversations.map(renderConversationItem)}</ul>,
                ) : null}
                {recentConversations.length > 0 ? renderSection(
                  t('messagesRecentSection'),
                  recentConversations.length,
                  recentOpen,
                  setRecentOpen,
                  <ul className="space-y-0.5">{recentConversations.map(renderConversationItem)}</ul>,
                ) : null}
              </div>
            )}
            {renderSection(
              t('archivedConversationsTitle'),
              visibleArchived.length,
              archivedOpen,
              (next) => {
                // Cơ chế lười của M5 giữ nguyên: mở mục là nạp
                // (lại) danh sách riêng từ server.
                if (next) onRequestArchived();
                setArchivedOpen(next);
              },
              visibleArchived.length === 0 ? (
                <p className="px-2 text-sm text-muted-foreground">
                  {filterNeedle ? t('conversationSearchNoResults') : t('archivedEmpty')}
                </p>
              ) : (
                <ul className="space-y-0.5">{visibleArchived.map(renderConversationItem)}</ul>
              ),
            )}
          </div>
        </TabsContent>
        <TabsContent value="groups" className="flex min-h-0 flex-1 flex-col">
          <div className="px-2 pt-1">
            <Input
              type="search"
              aria-label={t('groupTreeSearchPlaceholder')}
              placeholder={t('groupTreeSearchPlaceholder')}
              value={groupFilter}
              onChange={(e) => setGroupFilter(e.target.value)}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1 py-2">
            <GroupTreeNav
              tree={groupTree}
              filter={groupFilter}
              activeConversationId={active?.id ?? null}
              onOpenConversationById={onOpenConversationById}
              onOpenClassChat={onOpenClassChat}
              onOpenCourseChat={onOpenCourseChat}
              onOpenGroupConversation={onOpenGroupConversation}
              canCreateFreeGroup={canCreateFreeGroup}
              onCreateFreeGroup={() => setCreateGroupOpen(true)}
            />
          </div>
        </TabsContent>
      </Tabs>
      <NewMessageSheet
        open={newMessageOpen}
        onOpenChange={setNewMessageOpen}
        incomingRequests={incomingRequests}
        outgoingRequests={outgoingRequests}
        contacts={contacts}
        contactMessage={contactMessage}
        blocked={blocked}
        blockMessage={blockMessage}
        nameOf={nameOf}
        onMessageContact={messageContact}
        onSendContactRequest={onSendContactRequest}
        onRespondContactRequest={onRespondContactRequest}
        onUnblockContact={onUnblockContact}
        pickerContext={pickerContext}
        onSelectPickerContext={onSelectPickerContext}
        pickerClasses={pickerClasses}
        pickerCourses={pickerCourses}
        pickerMembers={pickerMembers}
        pickerRosterError={pickerRosterError}
        pickerRosterCursor={pickerRosterCursor}
        onLoadMorePicker={onLoadMorePicker}
      />
      <CreateGroupSheet
        open={createGroupOpen}
        onOpenChange={setCreateGroupOpen}
        onCreateGroup={(name, memberIds) => void createFreeGroup(name, memberIds)}
        createError={groupCreateError}
        pickerContext={pickerContext}
        onSelectPickerContext={onSelectPickerContext}
        pickerClasses={pickerClasses}
        pickerCourses={pickerCourses}
        pickerMembers={pickerMembers}
        pickerRosterError={pickerRosterError}
        pickerRosterCursor={pickerRosterCursor}
        onLoadMorePicker={onLoadMorePicker}
        contactEntries={contacts.map((userId) => ({ userId, displayName: nameOf(userId) }))}
      />
    </div>
  );
}

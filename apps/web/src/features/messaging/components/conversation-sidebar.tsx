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
import { Skeleton } from '@lms/ui/components/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@lms/ui/components/tabs';
import { cn } from '@lms/ui/lib/utils';
import { useTranslation } from 'react-i18next';
import { CreateGroupSheet } from './create-group-sheet';
import { GroupListNav, countGroupListEntries } from './group-list-nav';
import { NewMessageDialog } from './new-message-dialog';
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
 * Khung trái màn Tin nhắn: một ô tìm kiếm duy nhất phía trên
 * một thanh tab gồm bốn tab lọc ngang hàng như bản demo — Tất
 * cả / Chưa đọc / Nhóm / Yêu thích (issue #606; cấu trúc hai
 * tab Trò chuyện / Nhóm kèm chip lọc của lát MSG-T3 đã được
 * thay bằng đúng hình dạng demo này):
 *
 * - Tab **Tất cả**: CHỈ hội thoại cá nhân 1–1 (`type === 1`).
 *   Trong tab, danh sách chia thành các mục thu gọn **Ghim**
 *   (chỉ hiện khi có hội thoại đã ghim), **Gần đây** và **Đã
 *   lưu trữ** (issue #564 — thay tab Đã lưu trữ cũ; mục này
 *   giữ nguyên cơ chế M5: danh sách riêng của server, nạp khi
 *   mở mục lần đầu).
 * - Tab **Chưa đọc**: cùng danh sách 1–1 đó nhưng chỉ gồm hội
 *   thoại có tin chưa đọc — đúng bộ lọc của chip Chưa đọc
 *   trước đây, nay là một tab ngang hàng như bản demo.
 * - Tab **Nhóm**: mọi mục nhóm của cây server (Lớp → Khoá →
 *   Nhóm con + Khoá ngoài lớp + Nhóm tự do) trình bày thành
 *   một danh sách phẳng ({@link GroupListNav}); bấm một hàng
 *   là mở ngay chat của hàng đó ở khung phải, kể cả hàng chưa
 *   có hội thoại (đi đường ensure của trang chứa như cây
 *   trước đây).
 * - Tab **Yêu thích**: chưa có dữ kiện yêu thích ở bất kỳ
 *   tầng nào và chức năng yêu thích chưa có phán quyết — tab
 *   chỉ có hình dạng bề mặt với trạng thái rỗng, không bịa dữ
 *   kiện và không gắn tác dụng giả.
 * - Mỗi tab hiện số đếm của chính tab đó trong ngoặc đơn ngay
 *   trên trigger (số hội thoại 1–1, số hội thoại 1–1 chưa
 *   đọc, số mục nhóm, 0 cho Yêu thích), tính trên toàn bộ tập
 *   của tab, không chịu ô tìm — như số đếm trên chip lọc
 *   trước đây. Ô tìm phía trên thanh tab lọc nội dung của tab
 *   đang mở theo tên hiển thị (chỉ lọc mục đã có — không phải
 *   tìm người).
 * - Nút **Tin nhắn mới** cạnh tiêu đề mở hộp thoại cùng tên
 *   ({@link NewMessageDialog} — hộp thoại nằm giữa màn hình như
 *   bản demo từ issue #591, thay ngăn kéo trượt bên phải trước
 *   đây): nơi tab Danh bạ cũ bị hạ xuống — lời mời kết
 *   bạn (kèm huy hiệu số lượng trên chính nút này), chọn người từ
 *   liên hệ/roster lớp/khoá, và mục liên hệ đã chặn.
 * - Tiêu đề khung trái kèm avatar của chính người xem — ánh xạ nút
 *   Invite của bản demo (đường vào hộp thoại mời vẫn là nút Tin
 *   nhắn mới, giữ nhãn tiếng Việt hiện có).
 *
 * Tab đang chọn do TRANG chứa giữ (và lưu bền cùng hội thoại đang
 * mở) để quay lại màn Tin nhắn là gặp đúng ngữ cảnh gần nhất; các
 * trạng thái thoáng qua của riêng khung trái (từ khoá tìm, trạng
 * thái mở của các mục thu gọn, sheet đang mở) ở lại component này.
 */
interface ConversationSidebarProps {
  /** Danh sách hội thoại CHƯA lưu của tôi (mọi loại — tab Tất cả và Chưa đọc tự lọc 1–1). */
  conversations: ConversationView[];
  /** Mục ĐÃ LƯU (lát M5): danh sách riêng của server, nạp khi mở mục Đã lưu trữ trong tab Tất cả. */
  archivedConversations: ConversationView[];
  /** Nạp (lại) mục đã lưu từ server — gọi khi người dùng mở mục Đã lưu trữ. */
  onRequestArchived: () => void;
  /** Cây nhóm của tôi do server dựng (lát MSG-T1) cho danh sách của tab Nhóm. */
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
  /**
   * Danh sách hội thoại đang nạp lần đầu (issue #591): khung
   * trái hiện khung đang tải (skeleton) đúng hình dạng trang
   * thay cho trạng thái rỗng giả; rỗng thật chỉ hiện sau khi
   * nạp xong và xác nhận không có dữ kiện.
   */
  loading?: boolean;
  /**
   * Cây nhóm đang nạp (vòng sửa PR #593): trạng thái tải của
   * cây lấy từ chính query cây nhóm của trang — khung trái
   * truyền thẳng xuống danh sách nhóm để nó hiện khung đang
   * tải theo nhịp của nó, không mượn cờ đang tải của danh sách
   * hội thoại (hai query về lệch nhịp nhau).
   */
  groupTreeLoading?: boolean;
  /**
   * Lỗi nạp cây nhóm lần đầu (vòng sửa 2 PR #593): khung trái
   * truyền thẳng xuống danh sách nhóm để nó hiện thông báo lỗi
   * thay cho câu rỗng giả; null khi cây đã có dữ kiện hoặc
   * chưa lỗi.
   */
  groupTreeError?: string | null;
}

/**
 * Trình bày khung trái Tin nhắn: tiêu đề + avatar người xem + nút
 * Tin nhắn mới, bốn tab Tất cả / Chưa đọc / Nhóm / Yêu thích dưới
 * một ô tìm kiếm duy nhất (trong tab Tất cả là các mục thu gọn
 * Ghim / Gần đây / Đã lưu trữ), hộp thoại Tin nhắn mới và sheet
 * Tạo nhóm.
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
  pickerRosterError, pickerRosterCursor, onLoadMorePicker, loading, groupTreeLoading, groupTreeError,
}: ConversationSidebarProps) {
  const { t } = useTranslation('app');
  const open = onOpenConversation;
  const [newMessageOpen, setNewMessageOpen] = useState(false);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  /**
   * Trạng thái mở của ba mục thu gọn trong tab Tất cả (issue
   * #564): Ghim và Gần đây mở mặc định để hội thoại đã ghim không
   * bị giấu sau một lần bấm thêm; Đã lưu trữ đóng mặc định vì nó
   * là danh sách riêng chỉ cần khi người dùng tìm lại.
   */
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [recentOpen, setRecentOpen] = useState(true);
  const [archivedOpen, setArchivedOpen] = useState(false);
  /**
   * Lọc theo TÊN HIỂN THỊ bằng ô tìm duy nhất phía trên thanh
   * tab (lát M4, issue #237; tính duy nhất và vị trí của ô từ
   * issue #606): lọc ngay tại client trên dữ kiện đã tải — tên
   * hiển thị là đúng chuỗi người dùng thấy (tên hội thoại hoặc
   * tên các thành viên), khớp chuỗi con không phân biệt hoa
   * thường. Chỉ lọc mục ĐÃ CÓ — không phải tìm người theo tên.
   * Cùng một từ khoá áp cho tab đang mở: danh sách hội thoại
   * 1–1 ở tab Tất cả / Chưa đọc; các mục nhóm ở tab Nhóm theo
   * luật lọc nút của {@link GroupListNav}.
   */
  const [searchText, setSearchText] = useState('');
  /**
   * Nhắn tin từ sheet Tin nhắn mới thì đóng sheet, khung trái về
   * tab Tất cả để thấy hội thoại 1–1 vừa mở ở khung phải.
   */
  const messageContact = (userId: string) => {
    setNewMessageOpen(false);
    onTabChange('all');
    onMessageContact(userId);
  };
  /** Tạo nhóm thành công thì đóng sheet tạo nhóm và về tab Nhóm để thấy nhóm vừa tạo trong danh sách. */
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
  const filterNeedle = searchText.trim().toLocaleLowerCase('vi');
  const matchesFilter = (c: ConversationView) =>
    !filterNeedle || labelOf(c).toLocaleLowerCase('vi').includes(filterNeedle);
  // Tab Tất cả và tab Chưa đọc CHỈ chứa hội thoại cá nhân 1–1:
  // mọi hội thoại type 2 (nhóm tự do/nhóm con/chat khoá/chat
  // lớp) đều thuộc tab Nhóm, không trộn vào hai tab này. Tab
  // Chưa đọc thêm đúng một điều kiện so với tab Tất cả: hội
  // thoại có tin chưa đọc — đúng bộ lọc của chip Chưa đọc
  // trước đây.
  const directConversations = (unreadOnly: boolean) => conversations
    .filter((c) => c.type === 1)
    .filter(matchesFilter)
    .filter((c) => (unreadOnly ? (c.unread ?? 0) > 0 : true));
  const visibleArchived = archivedConversations.filter(matchesFilter);
  /**
   * Số đếm trong ngoặc đơn trên thanh tab: tính trên TOÀN BỘ
   * tập của từng tab (không chịu ô tìm hay tab đang chọn) để
   * tab luôn cho biết quy mô thật của tập đó — như số đếm trên
   * chip lọc trước đây; danh sách bên dưới vẫn lọc theo ô tìm
   * như trước. Số của tab Nhóm là số hàng của danh sách nhóm
   * phẳng trên cây chưa lọc; số của tab Yêu thích là 0 vì hệ
   * chưa có dữ kiện yêu thích ở bất kỳ tầng nào (issue #606).
   */
  const allConversations = conversations.filter((c) => c.type === 1);
  const allCount = allConversations.length;
  const unreadCountTotal = allConversations.filter((c) => (c.unread ?? 0) > 0).length;
  const groupCount = groupTree ? countGroupListEntries(groupTree) : 0;
  const favouritesCount = 0;

  /** Một dòng hội thoại chuẩn app nhắn tin: avatar + tên + trích đoạn/giờ + huy hiệu + menu trạng thái M5. */
  const renderConversationItem = (c: ConversationView) => {
    const isActive = active?.id === c.id;
    const otherId = c.type === 1 ? c.members.find((id) => id !== myId) : undefined;
    /**
     * Hiện diện của đối tác trên hàng hội thoại giữ BA trạng
     * thái như ở đầu khung (vòng sửa PR #593): đã xác nhận
     * trực tuyến thì chấm xanh lá, đã xác nhận ngoại tuyến thì
     * chấm xám, chưa biết (chưa có sự kiện nào) thì không chấm
     * — không gộp chưa biết thành ngoại tuyến.
     */
    const otherPresence = otherId ? onlineUsers[otherId] : undefined;
    const avatarLabel = c.name ?? (otherId ? nameOf(otherId) : labelOf(c));
    const unreadCount = c.unread ?? 0;
    return (
      <li key={c.id}>
        <div className={cn('flex min-w-0 items-start gap-0.5 rounded-lg', isActive && 'bg-muted')}>
          <button
            type="button"
            aria-current={isActive || undefined}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2.5 py-2.5 text-left hover:bg-muted"
            onClick={() => void open(c)}
          >
            <span className="relative shrink-0">
              <Avatar>
                <AvatarFallback>{initialsOf(avatarLabel)}</AvatarFallback>
              </Avatar>
              {otherPresence !== undefined ? (
                <span
                  className={cn(
                    'absolute right-0 bottom-0 size-2.5 rounded-full ring-2 ring-background',
                    otherPresence ? 'bg-green-500' : 'bg-muted-foreground',
                  )}
                />
              ) : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className={cn('min-w-0 flex-1 truncate text-sm font-medium', unreadCount > 0 && !c.muted && 'font-semibold')}>
                  {labelOf(c)}
                </span>
                {c.lastMessage ? (
                  <span className="shrink-0 text-xs leading-5 text-muted-foreground tabular-nums" data-testid={`conversation-last-time-${c.id}`}>
                    {relativeTime(c.lastMessage.createdAt, t)}
                  </span>
                ) : null}
              </span>
              <span className="mt-0.5 flex items-center gap-1.5">
                {c.lastMessage ? (
                  <span className="min-w-0 flex-1 truncate text-xs leading-4 text-muted-foreground">
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

  /**
   * Bản đồ hội thoại theo id cho danh sách nhóm (issue #591):
   * hàng nhóm trong tab Nhóm tra hội thoại tương ứng ở đây để
   * hiện xem trước tin cuối + ngày + biểu tượng tắt tiếng như
   * các hàng còn lại.
   */
  const conversationsById = new Map(conversations.map((c) => [c.id, c]));
  /**
   * Đang nạp lần đầu và chưa có dữ kiện nào trong cache: khung
   * trái hiện skeleton thay cho mọi trạng thái rỗng (issue
   * #591 — cấm trạng thái rỗng giả lúc tải).
   */
  const initialLoading = Boolean(loading) && conversations.length === 0 && !error;

  /**
   * Một mục thu gọn trong tab Tất cả (issue #564): tiêu đề
   * phẳng kiểu demo (nhãn + số đếm + chevron), dựng trên primitive
   * Collapsible của @lms/ui — KHÔNG dùng vỏ Card của
   * CollapsibleSection dùng chung (vỏ đó không khớp section phẳng
   * của demo) và không tự chế kiểu collapse riêng. Số đếm đặt
   * trong span `aria-hidden` để tên truy cập của nút vẫn đúng
   * nhãn của mục, như số đếm trên thanh tab.
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
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-muted">
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

  /**
   * Nội dung cuộn của tab Tất cả / Chưa đọc: danh sách hội
   * thoại 1–1 đã lọc, tách thành mục Ghim / Gần đây (issue
   * #564: hội thoại mang `pinnedAt` lên mục Ghim, còn lại về
   * Gần đây; mục Ghim chỉ render khi có hội thoại đã ghim).
   * Riêng tab Tất cả có thêm mục Đã lưu trữ ở dưới cùng — mục
   * này thuộc về danh sách đầy đủ, còn tab Chưa đọc là một
   * danh sách lọc thuần như các tab lọc của bản demo nên
   * không mang mục đã lưu.
   *
   * @param unreadOnly - true ở tab Chưa đọc: chỉ hội thoại có tin chưa đọc.
   * @returns Khối cuộn của panel tab.
   */
  const renderDirectPanel = (unreadOnly: boolean) => {
    const visible = directConversations(unreadOnly);
    const pinned = visible.filter((c) => c.pinnedAt);
    const recent = visible.filter((c) => !c.pinnedAt);
    return (
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1 py-2">
        {initialLoading ? (
          /*
            Khung đang tải lần đầu (issue #591): các dòng
            skeleton giữ đúng hình dạng hàng hội thoại
            (avatar tròn + hai dòng chữ) để trang không nhảy
            hình khi dữ kiện về; trạng thái rỗng chỉ được
            hiện ở nhánh dưới, sau khi nạp xong.
          */
          <div data-testid="conversations-loading" className="space-y-3 px-2" aria-label={t('conversationsLoading')}>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="size-10 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : !error && visible.length === 0 ? (
          /*
            Nhánh rỗng chỉ hiện khi KHÔNG có lỗi tải (vòng
            sửa 2 PR #593): tải lần đầu lỗi thì chỉ banner
            lỗi ở trên hiện — câu "chưa có hội thoại" trên
            đường lỗi là trạng thái rỗng giả mà issue #591
            cấm (chưa tải xong, chưa xác nhận là rỗng thật).
          */
          <p className="px-2 text-sm text-muted-foreground">
            {filterNeedle
              ? t('conversationSearchNoResults')
              : unreadOnly
                ? t('conversationsUnreadEmpty')
                : t('conversationsEmpty')}
          </p>
        ) : (
          <div className="space-y-1">
            {pinned.length > 0 ? renderSection(
              t('messagesPinnedSection'),
              pinned.length,
              pinnedOpen,
              setPinnedOpen,
              <ul className="space-y-0.5">{pinned.map(renderConversationItem)}</ul>,
            ) : null}
            {recent.length > 0 ? renderSection(
              t('messagesRecentSection'),
              recent.length,
              recentOpen,
              setRecentOpen,
              <ul className="space-y-0.5">{recent.map(renderConversationItem)}</ul>,
            ) : null}
          </div>
        )}
        {unreadOnly || initialLoading ? null : renderSection(
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
    );
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-4 pt-3">
        <div className="flex min-w-0 items-center gap-2">
          {myId ? (
            <Avatar>
              <AvatarFallback>{initialsOf(nameOf(myId))}</AvatarFallback>
            </Avatar>
          ) : null}
          {/*
            Tiêu đề KHÔNG được cắt ba chấm: hậu tố số chưa đọc là
            một phần của tiêu đề và phải hiện trọn. Tiêu đề và hậu
            tố là hai khối không tách rời (whitespace-nowrap) xếp
            bằng flex-wrap — khi cột danh sách không đủ bề ngang
            cho cả hai trên một dòng, hậu tố xuống dòng nguyên
            khối thay vì bị truncate nuốt mất phần đuôi. (Bản
            trước mang class truncate nên khi có số chưa đọc,
            tiêu đề bị rút thành dạng "Tin nhắn (2 chưa…" dù nút
            cạnh nó đã shrink-0: bề ngang thật của cả dòng vượt
            bề ngang cột, phần thiếu dồn hết vào tiêu đề.)
          */}
          <h2 className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-lg font-semibold">
            <span className="whitespace-nowrap">{t('messagesTitle')}</span>
            {unread > 0 ? (
              <span className="whitespace-nowrap">{t('unreadSuffix', { count: unread })}</span>
            ) : null}
          </h2>
        </div>
        <Button type="button" size="sm" className="shrink-0" aria-label={t('newMessage')} onClick={() => setNewMessageOpen(true)}>
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
        className="min-h-0 min-w-0 flex-1 px-2 pt-2"
      >
        {/*
          Ô tìm DUY NHẤT phía trên thanh tab (issue #606 — đúng
          vị trí của bản demo): lọc nội dung của tab đang mở.
          Nhãn và gợi ý của ô đổi theo tab: tab Nhóm lọc các mục
          nhóm theo tên lớp/khoá/nhóm; các tab còn lại lọc danh
          sách hội thoại theo tên hiển thị.
        */}
        <div className="px-2">
          <Input
            type="search"
            aria-label={tab === 'groups' ? t('groupTreeSearchPlaceholder') : t('conversationSearchLabel')}
            placeholder={tab === 'groups' ? t('groupTreeSearchPlaceholder') : t('conversationSearchPlaceholder')}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
        </div>
        {/*
          Thanh tab bốn tab lọc ngang hàng như bản demo (issue
          #606): TabsList variant `line` của @lms/ui, mỗi trigger
          là nhãn chữ nhỏ độ đậm thường kèm số đếm của tab trong
          ngoặc đơn dạng chữ màu phụ — đúng dạng "Tất cả (3)"
          của demo. Số đếm nằm trong span `aria-hidden` và
          trigger mang `aria-label` là nhãn thuần, để tên truy
          cập của tab vẫn đúng nhãn của nó (như huy hiệu trên
          trigger Nhóm trước đây).
        */}
        <TabsList variant="line" className="w-full border-b">
          <TabsTrigger value="all" aria-label={t('messagesFilterAll')} className="gap-1 text-xs font-normal">
            {t('messagesFilterAll')}
            <span aria-hidden className="text-xs text-muted-foreground">({allCount})</span>
          </TabsTrigger>
          <TabsTrigger value="unread" aria-label={t('messagesFilterUnread')} className="gap-1 text-xs font-normal">
            {t('messagesFilterUnread')}
            <span aria-hidden className="text-xs text-muted-foreground">({unreadCountTotal})</span>
          </TabsTrigger>
          <TabsTrigger value="groups" aria-label={t('messagesTabGroups')} className="gap-1 text-xs font-normal">
            {t('messagesTabGroups')}
            <span aria-hidden className="text-xs text-muted-foreground">({groupCount})</span>
          </TabsTrigger>
          <TabsTrigger value="favourites" aria-label={t('messagesFilterFavourites')} className="gap-1 text-xs font-normal">
            {t('messagesFilterFavourites')}
            <span aria-hidden className="text-xs text-muted-foreground">({favouritesCount})</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="all" className="flex min-h-0 min-w-0 flex-1 flex-col">
          {renderDirectPanel(false)}
        </TabsContent>
        <TabsContent value="unread" className="flex min-h-0 min-w-0 flex-1 flex-col">
          {renderDirectPanel(true)}
        </TabsContent>
        <TabsContent value="groups" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1 py-2">
            <GroupListNav
              tree={groupTree}
              filter={searchText}
              activeConversationId={active?.id ?? null}
              onOpenConversationById={onOpenConversationById}
              onOpenClassChat={onOpenClassChat}
              onOpenCourseChat={onOpenCourseChat}
              onOpenGroupConversation={onOpenGroupConversation}
              canCreateFreeGroup={canCreateFreeGroup}
              onCreateFreeGroup={() => setCreateGroupOpen(true)}
              conversationsById={conversationsById}
              myId={myId}
              nameOf={nameOf}
              loading={initialLoading || Boolean(groupTreeLoading)}
              treeError={groupTreeError ?? null}
            />
          </div>
        </TabsContent>
        <TabsContent value="favourites" className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/*
            Tab Yêu thích (issue #606): chức năng yêu thích
            chưa có phán quyết và hệ chưa có dữ kiện yêu thích
            ở bất kỳ tầng nào — tab chỉ dựng đúng hình dạng bề
            mặt với trạng thái rỗng này; không dùng hội thoại
            đã ghim thay cho yêu thích và không gắn tác dụng
            giả nào.
          */}
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1 py-2">
            <p className="px-2 text-sm text-muted-foreground">{t('messagesFavouritesEmpty')}</p>
          </div>
        </TabsContent>
      </Tabs>
      <NewMessageDialog
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

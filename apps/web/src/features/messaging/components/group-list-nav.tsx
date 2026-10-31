import { useState, type ReactNode } from 'react';
import { BellOff, ChevronDown, Plus } from 'lucide-react';
import { Avatar, AvatarFallback } from '@lms/ui/components/avatar';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@lms/ui/components/collapsible';
import { Skeleton } from '@lms/ui/components/skeleton';
import { cn } from '@lms/ui/lib/utils';
import { useTranslation } from 'react-i18next';
import type {
  ConversationGroupTreeView,
  ConversationTreeClassView,
  ConversationTreeCourseView,
  ConversationTreeRoleView,
  ConversationView,
} from '../types/types';
import { initialsOf, relativeTime } from '../utils/utils';

/**
 * DANH SÁCH NHÓM của tab Nhóm — khung trái màn Tin nhắn (dữ kiện
 * cây do server dựng từ lát MSG-T1, issue #33; trình bày danh
 * sách phẳng từ issue #606).
 *
 * Flow tổng thể:
 *
 * 1. Dữ kiện vẫn là CÂY do SERVER dựng sẵn (GET
 *    /messages/group-tree, lát MSG-T1) theo đúng quan hệ thật:
 *    Lớp → Khoá trong lớp → Nhóm con trong khoá, cộng mục Khoá
 *    ngoài lớp và mục Nhóm tự do. Client không tự ghép quan hệ
 *    từ danh sách hội thoại phẳng và không đoán loại hội thoại
 *    theo tên — cây là nguồn quan hệ duy nhất.
 * 2. TRÌNH BÀY là một danh sách phẳng đúng dạng danh sách của
 *    bản demo (issue #606): mọi nút của cây thành một hàng trong
 *    cùng một danh sách, theo đúng thứ tự của cây (lớp, rồi các
 *    khoá trong lớp và các nhóm con của từng khoá, rồi khoá
 *    ngoài lớp, rồi nhóm tự do), không còn cây thu/mở bằng
 *    chevron. Vai của chính người xem tại từng nút (`myRole`)
 *    quyết định nhãn vai trên hàng khi hàng chưa có xem trước
 *    tin cuối — cây của giáo viên và của học sinh khác nhau từ
 *    dữ kiện server, không phải hai giao diện riêng.
 * 3. Bấm một hàng là mở ngay chat của hàng đó ở khung phải:
 *    hàng lớp/khoá đi đường ensure của trang chứa (trang chứa
 *    lấy/tạo conversation qua endpoint lớp/khoá), hàng nhóm con
 *    và nhóm tự do mở đúng conversation của chúng (nhóm con chưa
 *    có conversation thì trang chứa tạo/lấy). Mọi đường đều tối
 *    đa 2 thao tác tính từ tab Nhóm, như cây trước đây.
 * 4. Ô tìm phía trên thanh tab (ở khung trái) lọc danh sách
 *    theo tên lớp/khoá/nhóm: nút khớp thì hiện; nút cha khớp thì
 *    giữ nguyên các nút con của nó; nút khoá chỉ khớp qua nhóm
 *    con thì hiện kèm nhóm con đã lọc đó.
 * 5. Số chưa đọc trên từng hàng là số server tính cho chính nút
 *    đó (nút lớp = tổng của chat lớp + mọi nút con trong lớp
 *    theo hợp đồng MSG-T1) — nhìn lướt là biết lớp/khoá nào
 *    đang có tin. Nút "+ Tạo nhóm" đứng ngay trước các hàng
 *    nhóm tự do và CHỈ hiện khi trang chứa truyền
 *    `canCreateFreeGroup` (cờ server tính theo cổng tạo nhóm
 *    của API — chỉ quản trị viên hệ thống/chủ trung tâm); cổng
 *    chặn tạo nhóm nằm ở server, đây chỉ là trình bày.
 * 6. Mục **Ghim** như bản demo (điểm quan sát của phán quyết
 *    nghiệm thu preview PR #607): cây server KHÔNG mang trường
 *    ghim — trạng thái ghim là trạng thái cá nhân trên từng
 *    hội thoại, nằm ở danh sách hội thoại (`pinnedAt`), và
 *    hàng nhóm lấy nó qua đúng cơ chế tra hội thoại tương ứng
 *    (`conversationsById`) đang dùng cho xem trước tin cuối và
 *    biểu tượng tắt tiếng. Khi có ít nhất một hàng đã ghim,
 *    danh sách tách hai mục thu gọn **Ghim** (các hàng đã ghim,
 *    giữ thứ tự cây) và **Nhóm** (mọi hàng còn lại, giữ đúng
 *    thứ tự và vị trí nút Tạo nhóm như danh sách phẳng); khi
 *    chưa có hàng nào ghim, danh sách giữ nguyên dạng phẳng
 *    không tiêu đề mục như trước. Hàng chưa có hội thoại
 *    (chưa ensure) không có trạng thái ghim nên luôn ở mục
 *    Nhóm.
 *
 * Bất biến: component không tự gọi API; mọi hành động mở chat đi
 * lên trang chứa qua các callback — trang là nơi duy nhất biết
 * cách ensure conversation và nạp khung chat.
 */
interface GroupListNavProps {
  /** Cây nhóm của tôi do server dựng; null khi chưa nạp được. */
  tree: ConversationGroupTreeView | null;
  /** Từ khoá lọc danh sách theo tên (ô tìm phía trên thanh tab ở khung trái). */
  filter: string;
  /** Conversation đang mở ở khung phải — để tô sáng hàng tương ứng. */
  activeConversationId: string | null;
  /** Mở một conversation ĐÃ có id (nhóm con, nhóm tự do, hoặc chat đã ensure). */
  onOpenConversationById: (conversationId: string) => void;
  /** Mở chat cấp lớp (trang chứa ensure qua endpoint lớp). */
  onOpenClassChat: (classId: string) => void;
  /** Mở chat cấp khoá (trang chứa ensure qua endpoint khoá). */
  onOpenCourseChat: (courseId: string) => void;
  /** Mở chat của một nhóm con trong khoá (trang chứa tạo/lấy conversation nhóm). */
  onOpenGroupConversation: (groupId: string) => void;
  /** Người xem có được thấy nút tạo nhóm tự do hay không (cờ server theo cổng tạo nhóm — chỉ quản trị viên hệ thống/chủ trung tâm). */
  canCreateFreeGroup: boolean;
  /** Mở sheet tạo nhóm tự do. */
  onCreateFreeGroup: () => void;
  /**
   * Bản đồ hội thoại theo id từ danh sách hội thoại của trang
   * (issue #591): hàng của nút nào có hội thoại tương ứng thì
   * hiện xem trước tin cuối + ngày + biểu tượng tắt tiếng như
   * các hàng hội thoại còn lại, thay cho phụ đề vai trò.
   */
  conversationsById?: ReadonlyMap<string, ConversationView>;
  /** Id của chính người xem — căn cứ tiền tố "Bạn:" của xem trước tin cuối. */
  myId?: string;
  /**
   * Tra tên hiển thị của một user (issue #591): xem trước tin
   * cuối ở hàng nhóm mang tiền tố tên người gửi như bản demo
   * (tin của chính người xem thì tiền tố là "Bạn:").
   */
  nameOf?: (userId: string) => string;
  /**
   * Cây đang nạp lần đầu (issue #591): hiện khung đang tải thay
   * cho câu "chưa thuộc lớp/khoá/nhóm nào" — trạng thái rỗng giả
   * lúc tải bị cấm, rỗng thật chỉ hiện sau khi nạp xong.
   */
  loading?: boolean;
  /**
   * Lỗi nạp cây nhóm lần đầu (vòng sửa 2 PR #593): khi cây chưa
   * có dữ kiện mà query đã lỗi thì hiện thông báo lỗi thay cho
   * câu rỗng — câu rỗng trên đường lỗi là trạng thái rỗng giả
   * mà issue #591 cấm. Null khi cây đã có dữ kiện hoặc chưa lỗi.
   */
  treeError?: string | null;
}

/**
 * Đếm tổng số mục của danh sách nhóm phẳng (mọi nút lớp, khoá,
 * nhóm con, khoá ngoài lớp và nhóm tự do) — căn cứ số đếm trong
 * ngoặc đơn trên tab Nhóm ở khung trái (issue #606): số đếm của
 * tab là số hàng danh sách của tab chứa, tính trên cây chưa lọc.
 *
 * @param tree - Cây nhóm do server dựng.
 * @returns Tổng số hàng của danh sách nhóm.
 */
export function countGroupListEntries(tree: ConversationGroupTreeView): number {
  const countCourse = (course: ConversationTreeCourseView) => 1 + course.groups.length;
  return tree.classes.reduce((sum, cls) => sum + 1 + cls.courses.reduce((s, c) => s + countCourse(c), 0), 0)
    + tree.coursesOutsideClasses.reduce((sum, c) => sum + countCourse(c), 0)
    + tree.freeGroups.length;
}

/**
 * Huy hiệu số chưa đọc của một hàng nhóm: số do server tính cho
 * chính nút của hàng; kèm nhãn đọc màn hình như dòng hội thoại
 * thường.
 *
 * @param props - Số chưa đọc của nút.
 * @returns Huy hiệu, hoặc null khi không có tin chưa đọc.
 */
function GroupUnreadBadge({ count }: { count: number }) {
  const { t } = useTranslation('app');
  if (count <= 0) return null;
  return (
    <>
      <Badge className="shrink-0">{count}</Badge>
      <span className="sr-only">{t('unreadSuffix', { count })}</span>
    </>
  );
}

/** Một hàng của danh sách nhóm phẳng, đã gắn sẵn đích mở chat của nó. */
interface GroupListEntry {
  key: string;
  label: string;
  role: ConversationTreeRoleView;
  unread: number;
  /** Conversation tương ứng của nút; null khi nút chưa có conversation (mở qua đường ensure). */
  conversationId: string | null;
  onOpen: () => void;
}

/**
 * Trình bày danh sách nhóm phẳng của tab Nhóm.
 *
 * @param props - Cây server + từ khoá lọc + các sự kiện mở chat do trang chứa xử lý.
 * @returns Danh sách phẳng: lớp → khoá → nhóm con, khoá ngoài lớp, nút Tạo nhóm (nếu có quyền) và nhóm tự do.
 */
export function GroupListNav({
  tree, filter, activeConversationId, onOpenConversationById, onOpenClassChat,
  onOpenCourseChat, onOpenGroupConversation, canCreateFreeGroup, onCreateFreeGroup,
  conversationsById, myId, nameOf, loading, treeError,
}: GroupListNavProps) {
  const { t } = useTranslation('app');
  /**
   * Trạng thái mở của hai mục thu gọn Ghim / Nhóm khi danh
   * sách tách mục (mặc định mở cả hai, như các mục của tab
   * Tất cả — hàng đã ghim không bị giấu sau một lần bấm thêm).
   */
  const [pinnedSectionOpen, setPinnedSectionOpen] = useState(true);
  const [groupsSectionOpen, setGroupsSectionOpen] = useState(true);

  if (!tree) {
    // Lỗi tải lần đầu thì hiện thông báo lỗi thay cho câu rỗng
    // (vòng sửa 2 PR #593) — cây chưa có dữ kiện mà đã lỗi thì
    // câu rỗng là trạng thái rỗng giả; banner lỗi ở đây thay cho
    // banner lỗi của tab Tất cả vì danh sách không nhận prop lỗi
    // nào trước vòng này.
    if (treeError) {
      return <p role="alert" className="px-2 text-sm">{treeError}</p>;
    }
    // Đang nạp lần đầu thì hiện khung đang tải đúng hình dạng
    // hàng danh sách (issue #591) — không hiện câu rỗng giả rồi
    // mới đầy dữ kiện như trước.
    if (loading) {
      return (
        <div data-testid="group-list-loading" className="space-y-2 px-2" aria-label={t('conversationsLoading')}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-2.5">
              <Skeleton className="size-8 rounded-full" />
              <Skeleton className="h-4 flex-1" />
            </div>
          ))}
        </div>
      );
    }
    return <p className="px-2 text-sm text-muted-foreground">{t('groupTreeEmpty')}</p>;
  }

  const needle = filter.trim().toLocaleLowerCase('vi');
  const matches = (name: string) => !needle || name.toLocaleLowerCase('vi').includes(needle);
  /** Lọc một nút khoá theo từ khoá: giữ khoá khi tên khoá hoặc một nhóm con của nó khớp. */
  const filterCourse = (course: ConversationTreeCourseView): ConversationTreeCourseView | null => {
    if (matches(course.name)) return course;
    const groups = course.groups.filter((g) => matches(g.name));
    return groups.length > 0 ? { ...course, groups } : null;
  };
  /** Lọc một nút lớp theo từ khoá: tên lớp khớp thì giữ nguyên cây con; không thì lọc từng khoá con. */
  const filterClass = (cls: ConversationTreeClassView): ConversationTreeClassView | null => {
    if (matches(cls.name)) return cls;
    const courses = cls.courses.map(filterCourse).filter((c): c is ConversationTreeCourseView => c !== null);
    return courses.length > 0 ? { ...cls, courses } : null;
  };
  const classes = tree.classes.map(filterClass).filter((c): c is ConversationTreeClassView => c !== null);
  const outsideCourses = tree.coursesOutsideClasses
    .map(filterCourse)
    .filter((c): c is ConversationTreeCourseView => c !== null);
  const freeGroups = tree.freeGroups.filter((g) => matches(g.name));

  /**
   * Duỗi một nút khoá và các nhóm con của nó thành các hàng liên
   * tiếp: hàng khoá trước (mở qua ensure), rồi từng hàng nhóm
   * con (đã có conversation thì mở theo id, chưa có thì trang
   * chứa tạo/lấy qua đường nhóm con).
   */
  const courseEntries = (course: ConversationTreeCourseView): GroupListEntry[] => [
    {
      key: `course-${course.courseId}`,
      label: course.name,
      role: course.myRole,
      unread: course.unread,
      conversationId: course.conversationId,
      onOpen: () => onOpenCourseChat(course.courseId),
    },
    ...course.groups.map((g): GroupListEntry => ({
      key: `group-${g.groupId}`,
      label: g.name,
      role: g.myRole,
      unread: g.unread,
      conversationId: g.conversationId,
      onOpen: () => (g.conversationId ? onOpenConversationById(g.conversationId) : onOpenGroupConversation(g.groupId)),
    })),
  ];
  /** Các hàng thuộc các lớp: hàng lớp (mở qua ensure) rồi tới các khoá trong lớp và nhóm con của chúng. */
  const classEntries = classes.flatMap((cls): GroupListEntry[] => [
    {
      key: `class-${cls.classId}`,
      label: cls.name,
      role: cls.myRole,
      unread: cls.unread,
      conversationId: cls.conversationId,
      onOpen: () => onOpenClassChat(cls.classId),
    },
    ...cls.courses.flatMap(courseEntries),
  ]);
  /** Các hàng khoá ngoài lớp kèm nhóm con của chúng. */
  const outsideEntries = outsideCourses.flatMap(courseEntries);
  /** Các hàng nhóm tự do: luôn đã có conversation, mở thẳng theo id. */
  const freeEntries = freeGroups.map((g): GroupListEntry => ({
    key: `free-${g.conversationId}`,
    label: g.name,
    role: g.myRole,
    unread: g.unread,
    conversationId: g.conversationId,
    onOpen: () => onOpenConversationById(g.conversationId),
  }));
  const nothingVisible = classEntries.length === 0 && outsideEntries.length === 0 && freeEntries.length === 0;

  /** Nhãn vai của chính người xem tại một nút (server tính theo quan hệ dạy/học/staff). */
  const roleLabel = (role: ConversationTreeRoleView) => (role === 'teaching'
    ? t('treeRoleTeaching')
    : role === 'learning'
      ? t('treeRoleLearning')
      : t('treeRoleStaff'));

  /**
   * Một hàng của danh sách nhóm: avatar chữ + tên + dòng phụ +
   * huy hiệu chưa đọc; bấm là mở chat của hàng.
   *
   * Dòng phụ (issue #591): hàng nào đã có hội thoại tương ứng
   * trong danh sách của trang và hội thoại đó có tin cuối thì
   * hiện XEM TRƯỚC TIN CUỐI kèm tiền tố người gửi (tin của mình
   * mang tiền tố "Bạn:") như các hàng hội thoại còn lại và như
   * bản demo, kèm ngày ở cuối dòng tên; hàng chưa có hội thoại
   * hoặc chưa có tin nào thì giữ phụ đề vai trò như trước (chưa
   * có dữ kiện xem trước để hiện, không bịa). Biểu tượng tắt
   * tiếng nằm NGOÀI nhánh có tin cuối (vòng sửa PR #593): hội
   * thoại đã tắt tiếng thì hiện biểu tượng ở dòng phụ kể cả khi
   * chưa có tin cuối nào.
   */
  const renderEntry = (entry: GroupListEntry) => {
    const conversation = entry.conversationId ? conversationsById?.get(entry.conversationId) : undefined;
    const lastMessage = conversation?.lastMessage ?? null;
    const isActive = entry.conversationId !== null && entry.conversationId === activeConversationId;
    return (
      <button
        key={entry.key}
        type="button"
        aria-current={isActive || undefined}
        className={cn('flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left hover:bg-muted', isActive && 'bg-muted')}
        onClick={entry.onOpen}
      >
        <Avatar className="size-8">
          <AvatarFallback>{initialsOf(entry.label)}</AvatarFallback>
        </Avatar>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{entry.label}</span>
            {lastMessage ? (
              <span className="shrink-0 text-xs leading-5 text-muted-foreground tabular-nums">
                {relativeTime(lastMessage.createdAt, t)}
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5">
            {lastMessage ? (
              <span className="min-w-0 flex-1 truncate text-xs leading-4 text-muted-foreground">
                {lastMessage.userIdFrom === myId
                  ? `${t('lastMessageOwnPrefix')} `
                  : `${nameOf?.(lastMessage.userIdFrom) ?? lastMessage.userIdFrom}: `}
                {lastMessage.fullMessage}
              </span>
            ) : (
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{roleLabel(entry.role)}</span>
            )}
            {conversation?.muted ? (
              <BellOff data-testid={`conversation-muted-${conversation.id}`} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            ) : null}
          </span>
        </span>
        <GroupUnreadBadge count={entry.unread} />
      </button>
    );
  };

  /**
   * Trạng thái ghim của một hàng: tra hội thoại tương ứng của
   * nút trong danh sách hội thoại của trang — cùng cơ chế tra
   * đang dùng cho xem trước tin cuối và biểu tượng tắt tiếng ở
   * {@link renderEntry}. Hàng chưa có hội thoại hoặc hội thoại
   * không nằm trong danh sách chưa lưu thì không có trạng thái
   * ghim, coi như chưa ghim.
   */
  const isPinnedEntry = (entry: GroupListEntry): boolean => {
    const conversation = entry.conversationId ? conversationsById?.get(entry.conversationId) : undefined;
    return Boolean(conversation?.pinnedAt);
  };
  const pinnedClassEntries = classEntries.filter(isPinnedEntry);
  const pinnedOutsideEntries = outsideEntries.filter(isPinnedEntry);
  const pinnedFreeEntries = freeEntries.filter(isPinnedEntry);
  const pinnedEntries = [...pinnedClassEntries, ...pinnedOutsideEntries, ...pinnedFreeEntries];
  const restClassEntries = classEntries.filter((e) => !isPinnedEntry(e));
  const restOutsideEntries = outsideEntries.filter((e) => !isPinnedEntry(e));
  const restFreeEntries = freeEntries.filter((e) => !isPinnedEntry(e));
  const restCount = restClassEntries.length + restOutsideEntries.length + restFreeEntries.length;

  /** Nút Tạo nhóm tự do — giữ đúng vị trí ngay trước các hàng nhóm tự do như danh sách phẳng. */
  const renderCreateGroupButton = () => (canCreateFreeGroup ? (
    <div className="flex items-center justify-end px-2 pt-1">
      <Button type="button" size="sm" variant="outline" onClick={onCreateFreeGroup}>
        <Plus className="size-4" />
        {t('createGroupTitle')}
      </Button>
    </div>
  ) : null);

  /**
   * Một mục thu gọn của danh sách nhóm (mục Ghim / mục Nhóm
   * khi tách mục): tiêu đề phẳng kèm số đếm + chevron, dựng
   * trên primitive Collapsible của @lms/ui với đúng kiểu
   * trình bày của các mục trong tab Tất cả ở khung trái —
   * không tự chế kiểu thu/mở riêng. Nội dung chỉ render khi
   * mục mở, như các mục của tab Tất cả.
   */
  const renderGroupSection = (
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
      <CollapsibleContent>{open ? children : null}</CollapsibleContent>
    </Collapsible>
  );

  const emptyNotice = nothingVisible ? (
    <p className="px-2 text-sm text-muted-foreground">
      {needle ? t('groupTreeNoResults') : t('groupTreeEmpty')}
    </p>
  ) : null;

  // Chưa có hàng nào đã ghim: giữ nguyên danh sách phẳng
  // không tiêu đề mục như trước (hình dạng đã nghiệm thu).
  if (pinnedEntries.length === 0) {
    return (
      <div className="min-w-0 space-y-0.5">
        {classEntries.map(renderEntry)}
        {outsideEntries.map(renderEntry)}
        {renderCreateGroupButton()}
        {freeEntries.map(renderEntry)}
        {emptyNotice}
      </div>
    );
  }

  // Có hàng đã ghim: tách mục Ghim (giữ thứ tự cây) và mục
  // Nhóm (mọi hàng còn lại theo đúng thứ tự cũ, nút Tạo nhóm
  // vẫn ngay trước các hàng nhóm tự do trong mục này).
  return (
    <div className="min-w-0 space-y-0.5">
      {renderGroupSection(
        t('messagesPinnedSection'),
        pinnedEntries.length,
        pinnedSectionOpen,
        setPinnedSectionOpen,
        <div className="space-y-0.5">{pinnedEntries.map(renderEntry)}</div>,
      )}
      {restCount > 0 || canCreateFreeGroup ? renderGroupSection(
        t('messagesTabGroups'),
        restCount,
        groupsSectionOpen,
        setGroupsSectionOpen,
        <div className="space-y-0.5">
          {restClassEntries.map(renderEntry)}
          {restOutsideEntries.map(renderEntry)}
          {renderCreateGroupButton()}
          {restFreeEntries.map(renderEntry)}
        </div>,
      ) : null}
      {emptyNotice}
    </div>
  );
}

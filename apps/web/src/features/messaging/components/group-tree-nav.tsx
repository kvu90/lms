import { useEffect, useState } from 'react';
import { BellOff, ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { Avatar, AvatarFallback } from '@lms/ui/components/avatar';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
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
 * CÂY NHÓM của tab Nhóm — khung trái màn Tin nhắn (lát MSG-T3,
 * issue #33; thiết kế chốt 11:36 ngày 26/10/2026 theo hồ sơ
 * `messaging-structure-research-2026-10-26.md` mục 4.1).
 *
 * Flow tổng thể:
 *
 * 1. Cây do SERVER dựng sẵn (GET /messages/group-tree, lát MSG-T1)
 *    theo đúng quan hệ thật: Lớp → Khoá trong lớp → Nhóm con trong
 *    khoá, cộng mục Khoá ngoài lớp của tôi và mục Nhóm tự do.
 *    Client chỉ TRÌNH BÀY cây đó — không tự ghép từ danh sách hội
 *    thoại phẳng, không đoán loại hội thoại theo tên.
 * 2. Vai của chính người xem tại từng nút (`myRole`) quyết định
 *    nhãn vai cạnh tên nút (Đang dạy / Đang học / Nhân sự) — cây của
 *    giáo viên và của học sinh khác nhau từ dữ kiện server, không
 *    phải hai giao diện riêng.
 * 3. Bấm dòng LỚP là mở ngay CHAT LỚP ở khung phải (trang chứa
 *    ensure qua endpoint lớp), bấm dòng KHOÁ là mở CHAT KHOÁ, bấm
 *    nhóm con/nhóm tự do là mở đúng conversation của chúng — mọi
 *    đường đều tối đa 2 thao tác tính từ tab Nhóm. Nút chevron chỉ
 *    lo xổ/thu cây con, tách khỏi hành động mở chat. Cây mặc định
 *    THU GỌN ở cấp lớp; khi hội thoại đang mở nằm trong một nút con
 *    đang bị thu, cây tự mở các nút tổ tiên của nó để dòng đang chọn
 *    luôn nhìn thấy được.
 * 4. Ô tìm của tab (ở khung trái) lọc cây theo tên lớp/khoá/nhóm:
 *    nút khớp thì hiện kèm cây con đã lọc; nút cha khớp thì giữ
 *    nguyên cây con của nó.
 * 5. Số chưa đọc trên từng nút là số server tính cho chính người
 *    xem (nút lớp = tổng của chat lớp + mọi nút con trong lớp) —
 *    nhìn lướt là biết lớp/khoá nào đang có tin. Mục Nhóm tự do có
 *    nút "+ Tạo nhóm" CHỈ khi trang chứa truyền
 *    `canCreateFreeGroup` (cờ server tính theo cổng tạo nhóm của
 *    API — chỉ quản trị viên hệ thống/chủ trung tâm); cổng chặn
 *    tạo nhóm nằm ở server, đây chỉ là trình bày.
 *
 * Bất biến: component không tự gọi API; mọi hành động mở chat đi
 * lên trang chứa qua các callback — trang là nơi duy nhất biết cách
 * ensure conversation và nạp khung chat.
 */
interface GroupTreeNavProps {
  /** Cây nhóm của tôi do server dựng; null khi chưa nạp được. */
  tree: ConversationGroupTreeView | null;
  /** Từ khoá lọc cây theo tên (ô tìm của tab Nhóm ở khung trái). */
  filter: string;
  /** Conversation đang mở ở khung phải — để tô sáng dòng và tự mở nút tổ tiên. */
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
   * (issue #591): dòng của nút nào có hội thoại tương ứng thì
   * hiện xem trước tin cuối + ngày + biểu tượng tắt tiếng như
   * các hàng hội thoại còn lại, thay cho phụ đề vai trò.
   */
  conversationsById?: ReadonlyMap<string, ConversationView>;
  /** Id của chính người xem — căn cứ tiền tố "Bạn:" của xem trước tin cuối. */
  myId?: string;
  /**
   * Tra tên hiển thị của một user (issue #591): xem trước tin
   * cuối ở dòng nhóm mang tiền tố tên người gửi như bản demo
   * (tin của chính người xem thì tiền tố là "Bạn:").
   */
  nameOf?: (userId: string) => string;
  /**
   * Cây đang nạp lần đầu (issue #591): hiện khung đang tải thay
   * cho câu "chưa thuộc lớp/khoá/nhóm nào" — trạng thái rỗng giả
   * lúc tải bị cấm, rỗng thật chỉ hiện sau khi nạp xong.
   */
  loading?: boolean;
}

/**
 * Huy hiệu số chưa đọc của một nút cây: số do server tính cho
 * chính người xem; kèm nhãn đọc màn hình như dòng hội thoại thường.
 *
 * @param props - Số chưa đọc của nút.
 * @returns Huy hiệu, hoặc null khi không có tin chưa đọc.
 */
function TreeUnreadBadge({ count }: { count: number }) {
  const { t } = useTranslation('app');
  if (count <= 0) return null;
  return (
    <>
      <Badge className="shrink-0">{count}</Badge>
      <span className="sr-only">{t('unreadSuffix', { count })}</span>
    </>
  );
}

/**
 * Trình bày cây nhóm hoàn chỉnh của tab Nhóm.
 *
 * @param props - Cây server + từ khoá lọc + các sự kiện mở chat do trang chứa xử lý.
 * @returns Khối cây Lớp → Khoá → Nhóm con + Khoá ngoài lớp + Nhóm tự do.
 */
export function GroupTreeNav({
  tree, filter, activeConversationId, onOpenConversationById, onOpenClassChat,
  onOpenCourseChat, onOpenGroupConversation, canCreateFreeGroup, onCreateFreeGroup,
  conversationsById, myId, nameOf, loading,
}: GroupTreeNavProps) {
  const { t } = useTranslation('app');
  const [expandedClasses, setExpandedClasses] = useState<ReadonlySet<string>>(new Set());
  const [expandedCourses, setExpandedCourses] = useState<ReadonlySet<string>>(new Set());

  // Hội thoại đang mở nằm trong nút con đang thu gọn → tự mở các
  // nút tổ tiên của nó (một lần cho mỗi thay đổi của hội thoại đang
  // mở), để dòng đang chọn không bao giờ bị giấu trong cây đã thu.
  useEffect(() => {
    if (!tree || !activeConversationId) return;
    for (const cls of tree.classes) {
      if (cls.conversationId === activeConversationId) return;
      for (const course of cls.courses) {
        if (course.conversationId === activeConversationId || course.groups.some((g) => g.conversationId === activeConversationId)) {
          setExpandedClasses((prev) => new Set(prev).add(cls.classId));
          if (course.groups.some((g) => g.conversationId === activeConversationId)) {
            setExpandedCourses((prev) => new Set(prev).add(course.courseId));
          }
          return;
        }
      }
    }
  }, [tree, activeConversationId]);

  if (!tree) {
    // Đang nạp lần đầu thì hiện khung đang tải đúng hình dạng
    // dòng cây (issue #591) — không hiện câu rỗng giả rồi mới
    // đầy dữ kiện như trước.
    if (loading) {
      return (
        <div data-testid="group-tree-loading" className="space-y-2 px-2" aria-label={t('conversationsLoading')}>
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
  const nothingVisible = classes.length === 0 && outsideCourses.length === 0 && freeGroups.length === 0;

  /** Nhãn vai của chính người xem tại một nút (server tính theo quan hệ dạy/học/staff). */
  const roleLabel = (role: ConversationTreeRoleView) => (role === 'teaching'
    ? t('treeRoleTeaching')
    : role === 'learning'
      ? t('treeRoleLearning')
      : t('treeRoleStaff'));

  /** Nút chevron xổ/thu cây con — tách khỏi hành động mở chat của chính dòng đó. */
  const expandToggle = (expanded: boolean, onToggle: () => void, label: string) => (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7 shrink-0"
      aria-expanded={expanded}
      aria-label={`${expanded ? t('collapseGroup') : t('expandGroup')}: ${label}`}
      onClick={onToggle}
    >
      {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
    </Button>
  );

  /**
   * Một dòng nút của cây: avatar chữ + tên + dòng phụ + huy hiệu
   * chưa đọc; bấm là mở chat của nút.
   *
   * Dòng phụ (issue #591): nút nào đã có hội thoại tương ứng
   * trong danh sách của trang và hội thoại đó có tin cuối thì
   * hiện XEM TRƯỚC TIN CUỐI kèm tiền tố người gửi (tin của mình
   * mang tiền tố "Bạn:") như các hàng hội thoại còn lại và như
   * bản demo, kèm ngày ở cuối dòng tên; nút chưa có hội thoại
   * hoặc chưa có tin nào thì giữ phụ đề vai trò như trước
   * (chưa có dữ kiện xem trước để hiện, không bịa). Biểu tượng
   * tắt tiếng nằm NGOÀI nhánh có tin cuối (vòng sửa PR #593):
   * hội thoại đã tắt tiếng thì hiện biểu tượng ở dòng phụ kể
   * cả khi chưa có tin cuối nào.
   */
  const nodeRow = (
    key: string,
    label: string,
    role: ConversationTreeRoleView,
    unread: number,
    isActive: boolean,
    onOpen: () => void,
    conversationId?: string | null,
  ) => {
    const conversation = conversationId ? conversationsById?.get(conversationId) : undefined;
    const lastMessage = conversation?.lastMessage ?? null;
    return (
      <button
        key={key}
        type="button"
        aria-current={isActive || undefined}
        className={cn('flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left hover:bg-muted', isActive && 'bg-muted')}
        onClick={onOpen}
      >
        <Avatar className="size-8">
          <AvatarFallback>{initialsOf(label)}</AvatarFallback>
        </Avatar>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{label}</span>
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
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{roleLabel(role)}</span>
            )}
            {conversation?.muted ? (
              <BellOff data-testid={`conversation-muted-${conversation.id}`} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            ) : null}
          </span>
        </span>
        <TreeUnreadBadge count={unread} />
      </button>
    );
  };

  /** Nút KHOÁ kèm các nhóm con của nó (nhóm con bấm là mở đúng conversation của nhóm). */
  const renderCourse = (course: ConversationTreeCourseView) => {
    const expanded = expandedCourses.has(course.courseId);
    return (
      <div key={course.courseId}>
        <div className="flex min-w-0 items-center">
          {course.groups.length > 0
            ? expandToggle(expanded, () => {
              setExpandedCourses((prev) => {
                const next = new Set(prev);
                if (next.has(course.courseId)) next.delete(course.courseId);
                else next.add(course.courseId);
                return next;
              });
            }, course.name)
            : <span className="size-7 shrink-0" />}
          {nodeRow(
            `course-${course.courseId}`,
            course.name,
            course.myRole,
            course.unread,
            course.conversationId !== null && course.conversationId === activeConversationId,
            () => onOpenCourseChat(course.courseId),
            course.conversationId,
          )}
        </div>
        {expanded ? (
          <div className="mt-0.5 ml-9 space-y-0.5 border-l pl-2">
            {course.groups.map((g) => nodeRow(
              `group-${g.groupId}`,
              g.name,
              g.myRole,
              g.unread,
              g.conversationId !== null && g.conversationId === activeConversationId,
              () => (g.conversationId ? onOpenConversationById(g.conversationId) : onOpenGroupConversation(g.groupId)),
              g.conversationId,
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {classes.map((cls) => {
        const expanded = expandedClasses.has(cls.classId);
        return (
          <div key={cls.classId}>
            <div className="flex min-w-0 items-center">
              {cls.courses.length > 0
                ? expandToggle(expanded, () => {
                  setExpandedClasses((prev) => {
                    const next = new Set(prev);
                    if (next.has(cls.classId)) next.delete(cls.classId);
                    else next.add(cls.classId);
                    return next;
                  });
                }, cls.name)
                : <span className="size-7 shrink-0" />}
              {nodeRow(
                `class-${cls.classId}`,
                cls.name,
                cls.myRole,
                cls.unread,
                cls.conversationId !== null && cls.conversationId === activeConversationId,
                () => onOpenClassChat(cls.classId),
                cls.conversationId,
              )}
            </div>
            {expanded ? (
              <div className="mt-0.5 ml-4 space-y-0.5 border-l pl-1.5">
                {cls.courses.map(renderCourse)}
              </div>
            ) : null}
          </div>
        );
      })}
      {outsideCourses.length > 0 ? (
        <div className="space-y-0.5">
          <h3 className="px-2 pt-1 text-xs font-medium text-muted-foreground">
            {t('coursesOutsideClassesTitle')}
          </h3>
          {outsideCourses.map(renderCourse)}
        </div>
      ) : null}
      <div className="space-y-0.5">
        <div className="flex items-center justify-between px-2 pt-1">
          <h3 className="text-xs font-medium text-muted-foreground">{t('freeGroupsTitle')}</h3>
          {canCreateFreeGroup ? (
            <Button type="button" size="sm" variant="outline" onClick={onCreateFreeGroup}>
              <Plus className="size-4" />
              {t('createGroupTitle')}
            </Button>
          ) : null}
        </div>
        {freeGroups.map((g) => nodeRow(
          `free-${g.conversationId}`,
          g.name,
          g.myRole,
          g.unread,
          g.conversationId === activeConversationId,
          () => onOpenConversationById(g.conversationId),
          g.conversationId,
        ))}
        {freeGroups.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">{t('freeGroupsEmpty')}</p>
        ) : null}
      </div>
      {nothingVisible ? (
        <p className="px-2 text-sm text-muted-foreground">
          {needle ? t('groupTreeNoResults') : t('groupTreeEmpty')}
        </p>
      ) : null}
    </div>
  );
}

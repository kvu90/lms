/**
 * Hàm thuần cấp module của trang Tin nhắn (đợt C của issue #223):
 * lưu bền ngữ cảnh khung trái, áp số chưa đọc lên cây nhóm và suy
 * ngữ cảnh roster của panel thành viên. Đây là phần duy nhất của
 * file trang cũ không mang trạng thái React — di chuyển nguyên văn
 * từ `pages/messages.tsx` (dòng 92–239 trên main `85ef43e2`), không
 * đổi chữ ký hay hành vi, để các hook điều phối dùng chung mà
 * không phải phụ thuộc vào component trang.
 */
import type {
  ConversationGroupTreeView,
  ConversationTreeClassView,
  ConversationTreeCourseView,
  ConversationView,
  MemberPanelContext,
  MessagingCourse,
} from '../types/types';

/** Khoá localStorage của tab khung trái Tin nhắn gần nhất (lát MSG-T3). */
const MESSAGES_TAB_STORAGE_KEY = 'lms.messages.tab';
/** Khoá localStorage của hội thoại Tin nhắn đang mở gần nhất (lát MSG-T3). */
const MESSAGES_CONVERSATION_STORAGE_KEY = 'lms.messages.conversationId';
/**
 * Các tab khung trái hợp lệ — giá trị lưu hỏng thì lùi về tab
 * Tất cả. Từ issue #606, thanh tab là bốn tab lọc ngang hàng
 * thay cấu trúc hai tab cũ, nên giá trị lưu cũ "chats" rơi về
 * mặc định "all"; "groups" giữ nguyên nghĩa ở mọi cấu trúc.
 * Từ issue #623, tab Yêu thích bị bỏ và tab Lưu trữ quay lại
 * thành một tab của thanh tab (lưu trữ từng là tab riêng ở
 * cấu trúc cũ, rồi thành mục thu gọn trong tab danh sách
 * chính ở issue #564): giá trị "archived" là giá trị hợp lệ
 * hiện hành, còn giá trị lưu "favourites" của tab đã bỏ rơi
 * về mặc định "all" theo đúng luật này.
 */
const MESSAGES_TABS = ['all', 'unread', 'groups', 'archived'] as const;

/**
 * Đọc tab khung trái đã lưu bền; chưa lưu hoặc giá trị hỏng thì
 * về tab Tất cả như hành vi mặc định của thanh tab hiện hành.
 *
 * @returns Tên tab đã lưu, hoặc 'all'.
 */
export function readStoredMessagesTab(): string {
  if (typeof window === 'undefined') return 'all';
  try {
    const raw = window.localStorage.getItem(MESSAGES_TAB_STORAGE_KEY);
    return raw && (MESSAGES_TABS as readonly string[]).includes(raw) ? raw : 'all';
  } catch {
    return 'all';
  }
}

/**
 * Đọc id hội thoại đang mở đã lưu bền (ngữ cảnh gần nhất); chưa lưu
 * hoặc lưu hỏng thì null — trang mở ở trạng thái chưa chọn hội thoại.
 *
 * @returns Id hội thoại đã lưu, hoặc null.
 */
export function readStoredConversationId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(MESSAGES_CONVERSATION_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Lưu bền tab khung trái vừa chọn (bỏ qua êm khi localStorage không dùng được). */
export function storeMessagesTab(tab: string) {
  try {
    window.localStorage.setItem(MESSAGES_TAB_STORAGE_KEY, tab);
  } catch {
    // Lưu bền là tiện ích nhớ ngữ cảnh — không được làm hỏng luồng chính.
  }
}

/** Lưu bền hội thoại vừa mở; truyền null khi đóng hội thoại để lần sau không mở lại. */
export function storeConversationId(conversationId: string | null) {
  try {
    if (conversationId) window.localStorage.setItem(MESSAGES_CONVERSATION_STORAGE_KEY, conversationId);
    else window.localStorage.removeItem(MESSAGES_CONVERSATION_STORAGE_KEY);
  } catch {
    // Như trên: lỗi lưu bền không chặn luồng nhắn tin.
  }
}
/**
 * Áp số chưa đọc mới của MỘT conversation lên cây nhóm (lát MSG-T3):
 * nút lá mang conversation đó nhận số mới; số của nút khoá/lớp được
 * tính lại bằng số của chính nút cộng tổng các nút con — đúng quy tắc
 * cộng dồn phía server ghi ở contracts. Nhờ đó huy hiệu của tab Nhóm
 * sống theo sự kiện realtime như danh sách phẳng trước đây, không
 * phải chờ lần tải cây tiếp theo. Cây chưa nạp hoặc conversation
 * không thuộc nút nào thì trả nguyên cây.
 *
 * @param tree - Cây nhóm hiện tại (null khi chưa nạp).
 * @param conversationId - Conversation vừa có sự kiện cập nhật.
 * @param unreadCount - Số chưa đọc mới nhất của conversation đó.
 * @returns Cây mới đã áp số; trả lại chính `tree` khi không đổi.
 */
export function withTreeUnread(
  tree: ConversationGroupTreeView | null,
  conversationId: string,
  unreadCount: number,
): ConversationGroupTreeView | null {
  if (!tree) return tree;
  const patchCourse = (course: ConversationTreeCourseView): ConversationTreeCourseView => {
    const groups = course.groups.map((g) => (g.conversationId === conversationId ? { ...g, unread: unreadCount } : g));
    const own =
      course.conversationId === conversationId
        ? unreadCount
        : course.unread - course.groups.reduce((sum, g) => sum + g.unread, 0);
    return { ...course, groups, unread: own + groups.reduce((sum, g) => sum + g.unread, 0) };
  };
  const patchClass = (cls: ConversationTreeClassView): ConversationTreeClassView => {
    const courses = cls.courses.map(patchCourse);
    const own =
      cls.conversationId === conversationId
        ? unreadCount
        : cls.unread - cls.courses.reduce((sum, c) => sum + c.unread, 0);
    return { ...cls, courses, unread: own + courses.reduce((sum, c) => sum + c.unread, 0) };
  };
  return {
    classes: tree.classes.map(patchClass),
    coursesOutsideClasses: tree.coursesOutsideClasses.map(patchCourse),
    freeGroups: tree.freeGroups.map((g) => (g.conversationId === conversationId ? { ...g, unread: unreadCount } : g)),
    // Cờ tạo nhóm tự do là quyền do server cấp, không đổi theo số
    // chưa đọc — giữ nguyên khi vá cây.
    canCreateFreeGroup: tree.canCreateFreeGroup,
  };
}

/**
 * Dời một conversation lên đầu PHÂN MỤC của nó sau khi nó có hoạt
 * động mới nhất, sau khi áp phép biến đổi nội dung lên chính nó
 * (vòng sửa issue #623): thứ tự của server là hội thoại đã ghim
 * trước (trong nhóm ghim theo hoạt động gần nhất), còn lại theo
 * hoạt động gần nhất — nên hội thoại vừa có tin mới lên đầu nhóm
 * Gần đây nếu chưa ghim, và lên đầu nhóm Ghim (đầu danh sách) nếu
 * đã ghim; dời thẳng lên đầu toàn danh sách sẽ phá thứ tự ghim
 * của server khi hội thoại chưa ghim nhảy qua các hội thoại đã
 * ghim. Danh sách không có conversation đó thì trả nguyên danh
 * sách (cùng tham chiếu) để các tầng gọi không phải tự gác.
 *
 * @param list - Danh sách hội thoại đang có trong cache.
 * @param conversationId - Conversation vừa có hoạt động mới.
 * @param update - Phép biến đổi nội dung áp lên conversation đó (tin cuối, số chưa đọc…).
 * @returns Danh sách mới đã sắp lại; trả lại chính `list` khi conversation vắng mặt.
 */
export function withConversationMovedToSectionTop(
  list: ConversationView[],
  conversationId: string,
  update: (conversation: ConversationView) => ConversationView,
): ConversationView[] {
  const target = list.find((c) => c.id === conversationId);
  if (!target) return list;
  const updated = update(target);
  const rest = list.filter((c) => c.id !== conversationId);
  if (updated.pinnedAt) return [updated, ...rest];
  const pinnedCount = rest.filter((c) => c.pinnedAt).length;
  return [...rest.slice(0, pinnedCount), updated, ...rest.slice(pinnedCount)];
}

/**
 * Ngữ cảnh ROSTER cho panel thành viên của một conversation nhóm
 * (lát MSG-T4): phân loại CHỈ theo `itemType`/`itemId` do server
 * gắn (không đoán theo tên) — chat cấp lớp đọc roster lớp, chat cấp
 * khoá đọc roster khoá, chat nhóm con đọc roster của KHOÁ CHỨA
 * nhóm (tra trong cây nhóm của chính người xem) rồi lọc theo thành
 * viên conversation ở bước nạp; còn lại là nhóm tự do. `name` của
 * ngữ cảnh là tên thực thể mà thành viên CHUNG NHAU (hồ sơ rút gọn
 * ghi phạm vi này); tên hiển thị của chính conversation vẫn do
 * conversation mang. Không tra ra khoá chứa nhóm con thì trả null —
 * panel không dựng thay vì dựng sai nguồn.
 *
 * @param conv - Conversation đang mở.
 * @param tree - Cây nhóm của tôi (đã nạp từ MSG-T1) để tra khoá chứa nhóm con + tên lớp/khoá.
 * @param courses - Các khoá của tôi (nguồn tên khoá dự phòng khi cây chưa có nút).
 * @returns Ngữ cảnh roster, hoặc null khi không phải hội thoại nhóm / không xác định được.
 */
export function memberPanelContextOf(
  conv: ConversationView,
  tree: ConversationGroupTreeView | null,
  courses: MessagingCourse[],
): MemberPanelContext | null {
  if (conv.type !== 2) return null;
  if (conv.itemType === 'class' && conv.itemId) {
    const node = tree?.classes.find((c) => c.classId === conv.itemId);
    return { kind: 'class', id: conv.itemId, name: node?.name ?? conv.name ?? '' };
  }
  if (conv.itemType === 'course' && conv.itemId) {
    for (const cls of tree?.classes ?? []) {
      const node = cls.courses.find((c) => c.courseId === conv.itemId);
      if (node) return { kind: 'course', id: conv.itemId, name: node.name, parentName: cls.name };
    }
    const outside = tree?.coursesOutsideClasses.find((c) => c.courseId === conv.itemId);
    if (outside) return { kind: 'course', id: conv.itemId, name: outside.name };
    const course = courses.find((c) => c.courseId === conv.itemId);
    return { kind: 'course', id: conv.itemId, name: course?.fullName ?? conv.name ?? '' };
  }
  if (conv.itemType === 'groups' && conv.itemId) {
    const classes = tree?.classes ?? [];
    for (const cls of classes) {
      for (const course of cls.courses) {
        if (course.groups.some((g) => g.groupId === conv.itemId)) {
          return { kind: 'course', id: course.courseId, name: course.name, parentName: cls.name, subgroup: true };
        }
      }
    }
    for (const course of tree?.coursesOutsideClasses ?? []) {
      if (course.groups.some((g) => g.groupId === conv.itemId)) {
        return { kind: 'course', id: course.courseId, name: course.name, subgroup: true };
      }
    }
    return null;
  }
  return { kind: 'free', name: conv.name ?? '' };
}

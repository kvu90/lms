import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import '../i18n';
import { MESSAGING_MAX_MESSAGE_LENGTH_DEFAULT } from '@lms/contracts';
import { apiJson, ApiError } from '#lib/api';
import { useAuth } from '#lib/auth';
import { connectMessagingRealtime, type MessagingRealtimeHandle } from '#lib/messaging-socket';
import { queryKeys } from '#lib/query-keys';
import { PageShell } from '../components/page-shell';
import { ChatPanel } from '../components/messages/chat-panel';
import { ConversationSidebar } from '../components/messages/conversation-sidebar';
import type {
  ContactRelationship,
  ContactRequestView,
  ConversationDetailView,
  ConversationGroupTreeView,
  ConversationStatePatch,
  ConversationTreeClassView,
  ConversationTreeCourseView,
  ConversationStateView,
  ConversationView,
  MessageQuoteView,
  MessageSearchResultView,
  MessageView,
  MessagingCourse,
  PeoplePickerContext,
  PersonSummary,
  RosterMember,
  ScrollerHandle,
} from '../components/messages/types';
import { countMessageCharacters, localQuoteOf, mergeMessages } from '../components/messages/utils';

/**
 * Messages: conversation list with unread count, message thread and
 * sending. Tin nhắn hiển thị/gửi theo mô hình mới (issue #33): seq
 * đơn điệu theo conversation là mốc phân trang/đồng bộ; gửi LẠC QUAN
 * với clientMessageId (server chống trùng — thử lại không nhân đôi);
 * tin mới/đã đọc đến qua WebSocket (sự kiện được server phân phối từ
 * outbox), huy hiệu chưa đọc cập nhật theo sự kiện thay vì tải lại
 * toàn bộ; mất nối thì khi nối lại trang xin phần thiếu theo seq.
 * Trang còn quản lý chặn liên lạc: chặn/bỏ chặn người đối thoại trong
 * cuộc trò chuyện đang mở và xem danh sách đã chặn
 * (GET/POST/DELETE /messages/contacts...). Deep-link
 * ?conversation=<id> (contextUrl của thông báo message_new, #49) mở
 * đúng cuộc trò chuyện khi trang nạp — việc nối tiếp của #33.
 *
 * Cấu trúc khung trái theo MSG-T3: tab Trò chuyện chỉ 1–1, tab Nhóm
 * là cây Lớp → Khoá → Nhóm con dựng từ API cây của MSG-T1, Danh bạ
 * hạ thành sheet "Tin nhắn mới". Tab đang chọn + hội thoại đang mở
 * được LƯU BỀN ở localStorage (hai khoá ngay dưới đây) để quay lại
 * màn Tin nhắn là gặp đúng ngữ cảnh gần nhất; deep-link có mặt thì
 * thắng ngữ cảnh đã lưu.
 */

/** Khoá localStorage của tab khung trái Tin nhắn gần nhất (lát MSG-T3). */
const MESSAGES_TAB_STORAGE_KEY = 'lms.messages.tab';
/** Khoá localStorage của hội thoại Tin nhắn đang mở gần nhất (lát MSG-T3). */
const MESSAGES_CONVERSATION_STORAGE_KEY = 'lms.messages.conversationId';
/** Các tab khung trái hợp lệ — giá trị lưu hỏng thì lùi về tab Trò chuyện. */
const MESSAGES_TABS = ['chats', 'groups', 'archived'] as const;

/**
 * Đọc tab khung trái đã lưu bền; chưa lưu hoặc giá trị hỏng thì về
 * tab Trò chuyện như hành vi mặc định trước MSG-T3.
 *
 * @returns Tên tab đã lưu, hoặc 'chats'.
 */
function readStoredMessagesTab(): string {
  if (typeof window === 'undefined') return 'chats';
  try {
    const raw = window.localStorage.getItem(MESSAGES_TAB_STORAGE_KEY);
    return raw && (MESSAGES_TABS as readonly string[]).includes(raw) ? raw : 'chats';
  } catch {
    return 'chats';
  }
}

/**
 * Đọc id hội thoại đang mở đã lưu bền (ngữ cảnh gần nhất); chưa lưu
 * hoặc lưu hỏng thì null — trang mở ở trạng thái chưa chọn hội thoại.
 *
 * @returns Id hội thoại đã lưu, hoặc null.
 */
function readStoredConversationId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(MESSAGES_CONVERSATION_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Lưu bền tab khung trái vừa chọn (bỏ qua êm khi localStorage không dùng được). */
function storeMessagesTab(tab: string) {
  try {
    window.localStorage.setItem(MESSAGES_TAB_STORAGE_KEY, tab);
  } catch {
    // Lưu bền là tiện ích nhớ ngữ cảnh — không được làm hỏng luồng chính.
  }
}

/** Lưu bền hội thoại vừa mở; truyền null khi đóng hội thoại để lần sau không mở lại. */
function storeConversationId(conversationId: string | null) {
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
function withTreeUnread(
  tree: ConversationGroupTreeView | null,
  conversationId: string,
  unreadCount: number,
): ConversationGroupTreeView | null {
  if (!tree) return tree;
  const patchCourse = (course: ConversationTreeCourseView): ConversationTreeCourseView => {
    const groups = course.groups.map((g) => (g.conversationId === conversationId ? { ...g, unread: unreadCount } : g));
    const own = course.conversationId === conversationId ? unreadCount : course.unread - course.groups.reduce((sum, g) => sum + g.unread, 0);
    return { ...course, groups, unread: own + groups.reduce((sum, g) => sum + g.unread, 0) };
  };
  const patchClass = (cls: ConversationTreeClassView): ConversationTreeClassView => {
    const courses = cls.courses.map(patchCourse);
    const own = cls.conversationId === conversationId ? unreadCount : cls.unread - cls.courses.reduce((sum, c) => sum + c.unread, 0);
    return { ...cls, courses, unread: own + courses.reduce((sum, c) => sum + c.unread, 0) };
  };
  return {
    classes: tree.classes.map(patchClass),
    coursesOutsideClasses: tree.coursesOutsideClasses.map(patchCourse),
    freeGroups: tree.freeGroups.map((g) => (g.conversationId === conversationId ? { ...g, unread: unreadCount } : g)),
  };
}

export function MessagesPage() {
  const { t } = useTranslation('app');
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const myId = user?.id;
  const [conversations, setConversations] = useState<ConversationView[]>([]);
  /**
   * Mục ĐÃ LƯU (lát M5, issue #240): danh sách riêng nạp bằng
   * `?archived=true` khi người dùng mở mục; hai danh sách không trộn
   * nhau — server là nguồn sự thật của từng mục.
   */
  const [archivedConversations, setArchivedConversations] = useState<ConversationView[]>([]);
  /** Lỗi của lần đổi trạng thái hội thoại gần nhất (lát M5). */
  const [stateError, setStateError] = useState<string | null>(null);
  /** Đã nạp xong danh sách conversation ít nhất một lần — mốc cho deep-link mở đúng cuộc trò chuyện. */
  const [listLoaded, setListLoaded] = useState(false);
  const [unread, setUnread] = useState(0);
  const [active, setActive] = useState<ConversationView | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [readMarkers, setReadMarkers] = useState<Record<string, number>>({});
  const [typingUsers, setTypingUsers] = useState<Record<string, boolean>>({});
  const [onlineUsers, setOnlineUsers] = useState<Record<string, boolean>>({});
  /**
   * Nháp soạn tin THEO TỪNG conversation (lát M1, issue #204): map
   * theo conversationId, giữ trong bộ nhớ trang — chuyển qua
   * conversation khác rồi quay lại vẫn còn nguyên nháp của conversation
   * đó; gửi thành công thì chỉ xoá nháp của đúng conversation đã gửi.
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /**
   * Đích TRẢ LỜI TRÍCH DẪN theo từng conversation (lát M3, issue
   * #229): bấm "Trả lời" trên một tin thì ô soạn hiện chip trích dẫn
   * của conversation đó; gửi xong (hoặc bấm ✕) thì xoá — cùng kỷ luật
   * theo-conversation như nháp của M1.
   */
  const [replyTargets, setReplyTargets] = useState<Record<string, MessageView | null>>({});
  /** Tin gốc vừa được nhảy tới từ một khối trích dẫn — tô sáng tạm để mắt bắt được vị trí. */
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  /**
   * Tìm nội dung tin trong conversation đang mở (lát M4, issue
   * #237): trạng thái của MỘT lượt tìm — từ khoá đã gửi, kết quả
   * server trả (chỉ tin còn hiển thị được với mình), cờ đang tải và
   * cờ lỗi. Đổi conversation là xoá trắng (xử lý ở `open`).
   */
  const [messageSearch, setMessageSearch] = useState<{
    query: string;
    results: MessageSearchResultView[];
    loading: boolean;
    failed: boolean;
    submitted: boolean;
  }>({ query: '', results: [], loading: false, failed: false, submitted: false });
  /** Handle cuộn của MessageScroller (component con trong ChatPanel giữ vào đây). */
  const scrollerRef = useRef<ScrollerHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [blockMessage, setBlockMessage] = useState<string | null>(null);
  // Lớp B (issue #33): danh bạ ĐÃ DUYỆT + hàng chờ kết bạn (đến/đi),
  // thay danh bạ một chiều cũ.
  const [contacts, setContacts] = useState<string[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<ContactRequestView[]>([]);
  const [outgoingRequests, setOutgoingRequests] = useState<ContactRequestView[]>([]);
  const [contactMessage, setContactMessage] = useState<string | null>(null);
  /**
   * Lỗi gửi phải nói rõ lý do (lát M2, issue #212): vượt trần ký tự
   * (400) hay gửi quá nhanh (429) hiện thành thông báo cạnh composer
   * thay vì chỉ để tin rơi vào trạng thái failed câm như trước.
   */
  const [sendError, setSendError] = useState<string | null>(null);
  // Tên hiển thị gom từ mọi response của API (profiles/memberProfiles).
  const [people, setPeople] = useState<Record<string, PersonSummary>>({});
  // Tìm bạn theo KHOÁ (mô hình chốt lại 24/10/2026): khoá của tôi →
  // chọn khoá → roster thành viên (phân trang con trỏ phía server).
  const [myCourses, setMyCourses] = useState<MessagingCourse[]>([]);
  /**
   * CÂY NHÓM của tôi (lát MSG-T1 dựng ở server, MSG-T3 trình bày ở
   * tab Nhóm): nạp cùng nhịp với danh sách hội thoại; lỗi thì giữ
   * cây gần nhất như các đường phụ khác của trang.
   */
  const [groupTree, setGroupTree] = useState<ConversationGroupTreeView | null>(null);
  /**
   * Tab khung trái đang chọn (lát MSG-T3): giữ ở trang và LƯU BỀN
   * cùng hội thoại đang mở — quay lại màn Tin nhắn (kể cả sau khi
   * tải lại trang) là gặp đúng ngữ cảnh gần nhất.
   */
  const [sidebarTab, setSidebarTabState] = useState<string>(() => readStoredMessagesTab());
  /**
   * Bộ CHỌN NGƯỜI dùng chung của hai sheet Tin nhắn mới / Tạo nhóm
   * (lát MSG-T3): ngữ cảnh đang chọn + một trang roster của ngữ
   * cảnh đó. Roster lớp và roster khoá dùng chung một hình dạng
   * dòng nên một bộ trạng thái phục vụ cả hai sheet (chỉ một sheet
   * mở tại một thời điểm).
   */
  const [pickerContext, setPickerContext] = useState<PeoplePickerContext>({ kind: 'contacts' });
  const [pickerMembers, setPickerMembers] = useState<RosterMember[]>([]);
  const [pickerCursor, setPickerCursor] = useState<string | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  /** Lỗi tạo nhóm tự do gần nhất (đã dịch từ mã lỗi server); null khi không có. */
  const [groupCreateError, setGroupCreateError] = useState<string | null>(null);
  const [reportMessage, setReportMessage] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  /** Tin đã chọn để gỡ hàng loạt (chỉ moderator) — chọn bằng checkbox ở từng dòng tin. */
  const [selectedForBulk, setSelectedForBulk] = useState<Set<string>>(new Set());

  /** Deep-link ?conversation= chỉ xử lý một lần khi trang vừa nạp (không giành cuộc trò chuyện đang mở ở các lần nạp lại sau). */
  const deepLinkHandledRef = useRef(false);
  const realtimeRef = useRef<MessagingRealtimeHandle | null>(null);
  const activeRef = useRef<ConversationView | null>(null);
  activeRef.current = active;
  /** Seq cao nhất đã thấy của từng conversation — mốc xin đồng bộ khi nối lại. */
  const lastSeqRef = useRef<Map<string, number>>(new Map());
  const typingTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastTypingSentRef = useRef(0);
  /**
   * Khoá idempotency của BẢN NHÁP hiện tại theo conversation (fix
   * nhân đôi tin, issue #33): sinh một lần cho một bản nháp và giữ
   * nguyên qua mọi lượt submit lặp của cùng bản nháp — server chống
   * trùng theo (conversation, người gửi, clientMessageId) nên hai POST
   * lặp mang CÙNG khoá chỉ thành một tin. Chỉ bỏ khoá khi lượt gửi đã
   * có kết quả từ server; lượt gửi lỗi thì tin failed tự giữ khoá của
   * nó cho đường retrySend, bản nháp sau đó phải là khoá mới.
   */
  const draftClientIdRef = useRef<Map<string, string>>(new Map());
  /**
   * Conversation đang có lượt send() bay (fix nhân đôi tin, issue
   * #33): lượt gọi trùng cho cùng conversation bị bỏ qua ngay tại ref
   * — không chờ setState nên hai submit trong cùng một nhịp render
   * cũng không lọt cả hai.
   */
  const sendInFlightRef = useRef<Set<string>>(new Set());
  /** Conversation đang gửi — chỉ để ChatPanel vô hiệu nút Gửi/Enter của conversation đang mở. */
  const [sendingConversationIds, setSendingConversationIds] = useState<ReadonlySet<string>>(new Set());

  /**
   * Số conversation chưa đọc suy từ danh sách (mỗi mục mang unread
   * của chính user). Mỗi lần đếm lại cũng làm mới truy vấn huy hiệu
   * Tin nhắn của sidebar (lát M1, issue #204): sidebar tự làm tươi
   * mỗi 30 giây, nhưng khi người dùng đang ở chính trang này thì số
   * trên huy hiệu phải khớp ngay với số trang vừa đếm qua realtime
   * thay vì chờ chu kỳ — làm mới bằng invalidate để server vẫn là
   * nguồn số đếm cuối cùng.
   */
  const recountUnread = useCallback((list: ConversationView[]) => {
    setUnread(list.filter((c) => (c.unread ?? 0) > 0).length);
    void queryClient.invalidateQueries({ queryKey: queryKeys.messageUnreadCount });
  }, [queryClient]);

  /** Gom tên hiển thị từ một response (profiles/memberProfiles) vào bản đồ tên dùng chung của trang. */
  const mergePeople = useCallback((profiles: Record<string, PersonSummary> | undefined) => {
    if (!profiles) return;
    setPeople((prev) => ({ ...prev, ...profiles }));
  }, []);

  /** Tên hiển thị của một user; chưa tra được thông tin thì lùi về chính id như trước. */
  const nameOf = useCallback((userId: string) => people[userId]?.displayName ?? userId, [people]);

  /** Nạp cây nhóm cho tab Nhóm (lát MSG-T3): đường riêng, lỗi thì giữ cây gần nhất. */
  const loadGroupTree = useCallback(async () => {
    try {
      const tree = await apiJson<ConversationGroupTreeView>('/api/v1/messages/group-tree');
      setGroupTree(tree);
    } catch {
      // Giữ cây gần nhất.
    }
  }, []);

  /** Đổi tab khung trái (lát MSG-T3): cập nhật state + lưu bền để lần quay lại vẫn gặp tab này. */
  const setSidebarTab = useCallback((value: string) => {
    setSidebarTabState(value);
    storeMessagesTab(value);
  }, []);

  const reload = useCallback(async () => {
    const [list, blockedRes] = await Promise.all([
      apiJson<ConversationView[]>('/api/v1/messages/conversations'),
      apiJson<{ blocked: string[]; profiles?: Record<string, PersonSummary> }>('/api/v1/messages/contacts/blocked'),
    ]);
    setConversations(list);
    recountUnread(list);
    setBlocked(blockedRes.blocked);
    setListLoaded(true);
    mergePeople(blockedRes.profiles);
    for (const c of list) mergePeople(c.memberProfiles);
    // Danh bạ + hàng chờ kết bạn (Lớp B): lỗi ở hai đường này không
    // được phép làm hỏng danh sách cuộc trò chuyện ở trên.
    try {
      const [contactsRes, requestsRes] = await Promise.all([
        apiJson<{ contacts: string[]; profiles?: Record<string, PersonSummary> }>('/api/v1/messages/contacts'),
        apiJson<{
          incoming: ContactRequestView[];
          outgoing: ContactRequestView[];
        }>('/api/v1/messages/contacts/requests'),
      ]);
      setContacts(contactsRes.contacts);
      mergePeople(contactsRes.profiles);
      setIncomingRequests(requestsRes.incoming);
      setOutgoingRequests(requestsRes.outgoing);
    } catch {
      // Giữ trạng thái danh bạ gần nhất.
    }
    // Khoá của tôi (luồng tìm bạn theo khoá): đường riêng, lỗi thì
    // giữ danh sách khoá gần nhất như danh bạ.
    try {
      const coursesRes = await apiJson<{ courses: MessagingCourse[] }>('/api/v1/messages/courses');
      setMyCourses(coursesRes.courses);
    } catch {
      // Giữ danh sách khoá gần nhất.
    }
    for (const c of list) {
      if (c.lastMessageSeq !== undefined) {
        const seen = lastSeqRef.current.get(c.id) ?? 0;
        if (c.lastMessageSeq > seen) lastSeqRef.current.set(c.id, c.lastMessageSeq);
      }
    }
    // Cây nhóm đi cùng nhịp nạp (tab Nhóm luôn tươi như danh sách).
    await loadGroupTree();
  }, [loadGroupTree, mergePeople, recountUnread]);

  /** Nạp mục ĐÃ LƯU (lát M5): danh sách riêng của server, lỗi thì giữ bản gần nhất. */
  const loadArchived = useCallback(async () => {
    try {
      const list = await apiJson<ConversationView[]>('/api/v1/messages/conversations?archived=true');
      setArchivedConversations(list);
      for (const c of list) mergePeople(c.memberProfiles);
    } catch {
      // Giữ mục đã lưu gần nhất.
    }
  }, [mergePeople]);

  /**
   * Đặt một cờ trạng thái cá nhân trên một cuộc trò chuyện (lát M5):
   * server trả trạng thái đầy đủ sau khi đặt; client phản ánh ngay —
   * lưu thì cuộc trò chuyện rời danh sách chính sang mục đã lưu, bỏ
   * lưu thì đi chiều ngược lại, ghim/tắt tiếng cập nhật tại chỗ.
   */
  const updateConversationState = useCallback(async (conversation: ConversationView, patch: ConversationStatePatch) => {
    setStateError(null);
    try {
      const res = await apiJson<ConversationStateView>(
        `/api/v1/messages/conversations/${conversation.id}/state`,
        { method: 'PATCH', body: JSON.stringify(patch) },
      );
      const applyState = (c: ConversationView): ConversationView => (c.id === conversation.id
        ? { ...c, pinnedAt: res.pinnedAt, archivedAt: res.archivedAt, muted: res.muted }
        : c);
      if (res.archived) {
        setConversations((prev) => prev.filter((c) => c.id !== conversation.id));
        setArchivedConversations((prev) => [applyState(conversation), ...prev.filter((c) => c.id !== conversation.id)]);
      } else if (conversation.archivedAt) {
        setArchivedConversations((prev) => prev.filter((c) => c.id !== conversation.id));
        void reload();
      } else {
        setConversations((prev) => prev.map(applyState));
        setArchivedConversations((prev) => prev.map(applyState));
        // Ghim đổi THỨ TỰ danh sách (server xếp đã ghim lên đầu):
        // nạp lại cả hai danh sách để thứ tự khớp server ngay.
        if (patch.pinned !== undefined) {
          void reload();
          void loadArchived();
        }
      }
    } catch {
      setStateError(t('conversationStateFailed'));
    }
  }, [loadArchived, reload, t]);

  /** Đánh dấu đã đọc ở server và phản ánh ngay vào state (mốc của mình + unread của conversation). */
  const markRead = useCallback(async (conversationId: string) => {
    try {
      const res = await apiJson<{ marked: number; lastReadSeq: number }>(
        `/api/v1/messages/conversations/${conversationId}/read`,
        { method: 'POST', body: '{}' },
      );
      if (myId) setReadMarkers((prev) => ({ ...prev, [myId]: res.lastReadSeq }));
      setConversations((prev) => {
        const next = prev.map((c) => (c.id === conversationId ? { ...c, unread: 0, lastReadSeq: res.lastReadSeq } : c));
        recountUnread(next);
        return next;
      });
    } catch {
      // Đánh dấu đã đọc lỗi thì để lần mở/đọc sau thử lại — không chặn đọc tin.
    }
  }, [myId, recountUnread]);

  /** Chặn một liên hệ; server trả về danh sách đã chặn mới để hiển thị ngay. */
  async function blockContact(userId: string) {
    setBlockMessage(null);
    try {
      const res = await apiJson<{ blocked: string[] }>(`/api/v1/messages/contacts/${userId}/block`, {
        method: 'POST',
        body: '{}',
      });
      setBlocked(res.blocked);
      setBlockMessage(t('contactBlocked'));
    } catch {
      setBlockMessage(t('blockFailed'));
    }
  }

  /** Bỏ chặn một liên hệ; server trả về danh sách đã chặn mới để hiển thị ngay. */
  async function unblockContact(userId: string) {
    setBlockMessage(null);
    try {
      const res = await apiJson<{ blocked: string[] }>(`/api/v1/messages/contacts/${userId}/block`, {
        method: 'DELETE',
      });
      setBlocked(res.blocked);
      setBlockMessage(t('contactUnblocked'));
    } catch {
      setBlockMessage(t('unblockFailed'));
    }
  }

  useEffect(() => {
    void reload().catch(() => setError(t('messagesLoadFailed')));
  }, [reload]);

  // Deep-link từ thông báo (việc nối tiếp của #33): thông báo
  // message_new của #49 trỏ contextUrl = /messages?conversation=<id>.
  // Danh sách nạp xong thì mở đúng conversation đó — có sẵn trong
  // danh sách thì mở như cú bấm của người dùng; chưa có (danh sách
  // nạp thiếu/trễ) thì lấy chi tiết thẳng theo id bằng đúng endpoint
  // trang vẫn dùng để mở, chèn vào danh sách rồi mở. Server là nơi
  // thực thi quyền thành viên: không phải thành viên/không tồn tại
  // thì bỏ qua deep-link, trang giữ nguyên như không có tham số.
  const deepLinkId = searchParams.get('conversation');
  useEffect(() => {
    if (!deepLinkId || !listLoaded || deepLinkHandledRef.current) return;
    deepLinkHandledRef.current = true;
    const found = conversations.find((c) => c.id === deepLinkId);
    if (found) {
      void open(found);
      return;
    }
    void (async () => {
      try {
        const detail = await apiJson<ConversationDetailView>(`/api/v1/messages/conversations/${deepLinkId}`);
        const summary: ConversationView = {
          id: detail.id,
          type: detail.type,
          name: detail.name,
          members: detail.members,
          unread: detail.unread,
          lastReadSeq: detail.lastReadSeq,
          lastMessageSeq: detail.lastMessageSeq,
          lastMessage: detail.lastMessage,
        };
        setConversations((prev) => (prev.some((c) => c.id === summary.id) ? prev : [summary, ...prev]));
        await open(summary);
      } catch {
        // Không phải thành viên hoặc conversation không tồn tại: bỏ qua deep-link.
      }
    })();
    // `open` là hàm của chính trang (định nghĩa dưới đây), không phải
    // dependency cần theo dõi — mốc chạy một lần do deepLinkHandledRef gác.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkId, listLoaded, conversations]);

  // Khôi phục NGỮ CẢNH GẦN NHẤT (lát MSG-T3): không có deep-link
  // thì mở lại hội thoại đã lưu bền khi danh sách nạp xong — đúng
  // một lần cho mỗi lần nạp trang (gác bằng ref như deep-link).
  // Hội thoại không còn mở được (hết tư cách thành viên...) thì bỏ
  // qua êm, trang giữ trạng thái chưa chọn như không có gì đã lưu.
  const contextRestoredRef = useRef(false);
  useEffect(() => {
    if (deepLinkId || !listLoaded || contextRestoredRef.current) return;
    contextRestoredRef.current = true;
    const savedId = readStoredConversationId();
    if (!savedId) return;
    const found = conversations.find((c) => c.id === savedId);
    if (found) {
      void open(found);
      return;
    }
    void (async () => {
      try {
        const detail = await apiJson<ConversationDetailView>(`/api/v1/messages/conversations/${savedId}`);
        const { messages: _detailMessages, hasMoreBefore: _hasMore, memberReadMarkers: _markers, ...summary } = detail;
        setConversations((prev) => (prev.some((c) => c.id === summary.id) ? prev : [summary, ...prev]));
        await open(summary);
      } catch {
        // Không còn mở được hội thoại đã lưu: bỏ qua êm.
      }
    })();
    // Chạy một lần theo mốc listLoaded — `open`/`conversations` không
    // phải dependency cần theo dõi (cùng kỷ luật với deep-link ở trên).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkId, listLoaded]);

  // Kênh realtime: nối một lần khi trang mở; handlers đọc state mới
  // nhất qua ref nên không phải nối lại khi state đổi.
  useEffect(() => {
    if (!myId) return;
    const noteSeq = (conversationId: string, seq: number) => {
      const seen = lastSeqRef.current.get(conversationId) ?? 0;
      if (seq > seen) lastSeqRef.current.set(conversationId, seq);
    };
    const handle = connectMessagingRealtime({
      onNewMessage: ({ conversationId, message }) => {
        noteSeq(conversationId, message.seq);
        if (activeRef.current?.id === conversationId) {
          setMessages((prev) => mergeMessages(prev, [message]));
          // Đang mở cuộc trò chuyện thì tin của người khác được đọc ngay.
          if (message.userIdFrom !== myId) void markRead(conversationId);
        }
      },
      onConversationUpdated: ({ conversationId, message, unreadCount }) => {
        // Sự kiện mang seq CŨ hơn seq đã áp cho conversation này (một
        // sự kiện outbox trước bị consumer phân phối muộn hơn sự kiện
        // sau): bỏ qua để huy hiệu chưa đọc và tin cuối không nhảy lùi
        // theo số của thời điểm cũ — số đúng luôn có qua REST (quan sát
        // nhẹ của review Lớp A). Sự kiện trùng seq là phân phối lại của
        // cùng một sự kiện, vẫn áp như thường và vô hại.
        if (message.seq < (lastSeqRef.current.get(conversationId) ?? 0)) return;
        noteSeq(conversationId, message.seq);
        setConversations((prev) => {
          const target = prev.find((c) => c.id === conversationId);
          if (!target) {
            recountUnread(prev);
            return prev;
          }
          // Danh sách tự sắp xếp lại theo hoạt động mới nhất (lát M1,
          // issue #204): conversation vừa có tin mới được đưa lên đầu
          // — cùng thứ tự server trả khi tải lại (updated_at giảm
          // dần) nên realtime và reload không bao giờ lệch nhau.
          const next = [
            {
              ...target,
              unread: activeRef.current?.id === conversationId ? 0 : unreadCount,
              lastMessage: message,
              lastMessageSeq: message.seq,
            },
            ...prev.filter((c) => c.id !== conversationId),
          ];
          recountUnread(next);
          return next;
        });
        // Cây nhóm cũng nhận số chưa đọc mới của conversation này để
        // huy hiệu trên các nút của tab Nhóm khớp ngay (lát MSG-T3).
        setGroupTree((prev) => withTreeUnread(prev, conversationId, activeRef.current?.id === conversationId ? 0 : unreadCount));
      },
      onMessageDeleted: ({ conversationId, messageId, deletedBy }) => {
        if (activeRef.current?.id !== conversationId) return;
        // Xoá mềm (Lớp B): đánh dấu ngay trong khung — phía học sinh
        // không còn thấy tin (lọc ở bước render), phía có thẩm quyền
        // kiểm duyệt thấy dấu vết ai đã xoá. Payload không kèm nội
        // dung nên không có đường nào nội dung bị lộ lại qua realtime.
        setMessages((prev) => prev.map((m) => (m.id === messageId
          ? { ...m, deletedAt: new Date().toISOString(), deletedBy }
          : m)));
      },
      onConversationInvalidate: ({ conversationId }) => {
        // Vòng đời tin nhắn theo vai (issue #33): thu hồi phát
        // message.deleted trước, invalidate sau — chỉ tải lại cửa sổ
        // tin mới phân biệt được "đã thu hồi" (recalledAt, nội dung
        // rỗng) với "đã xoá", và tin bị xoá cứng mới biến mất khỏi
        // khung. Danh sách luôn tải lại vì tin cuối/số chưa đọc đã đổi.
        if (activeRef.current?.id === conversationId) {
          void (async () => {
            try {
              const detail = await apiJson<ConversationDetailView>(`/api/v1/messages/conversations/${conversationId}`);
              setMessages(detail.messages);
              setHasMoreBefore(detail.hasMoreBefore ?? false);
              const markers: Record<string, number> = {};
              for (const marker of detail.memberReadMarkers ?? []) markers[marker.userId] = marker.lastReadSeq;
              setReadMarkers(markers);
            } catch {
              // Giữ khung cũ; lần tải lại sau sẽ đồng bộ.
            }
          })();
        }
        void reload().catch(() => undefined);
      },
      onReadReceipt: ({ conversationId, userId, lastReadSeq }) => {
        if (activeRef.current?.id === conversationId) {
          setReadMarkers((prev) => ({ ...prev, [userId]: Math.max(prev[userId] ?? 0, lastReadSeq) }));
        }
      },
      onTyping: ({ conversationId, userId }) => {
        if (activeRef.current?.id !== conversationId || userId === myId) return;
        setTypingUsers((prev) => ({ ...prev, [userId]: true }));
        const timeouts = typingTimeoutsRef.current;
        const existing = timeouts.get(userId);
        if (existing) clearTimeout(existing);
        timeouts.set(userId, setTimeout(() => {
          setTypingUsers((prev) => {
            const next = { ...prev };
            delete next[userId];
            return next;
          });
        }, 4500));
      },
      onPresence: ({ userId, online }) => {
        setOnlineUsers((prev) => ({ ...prev, [userId]: online }));
      },
      onReconnect: () => {
        // Nối lại: danh sách lấy tươi bằng REST (truy vấn tổng hợp đã
        // rẻ), conversation đang mở xin đúng phần thiếu theo seq.
        void reload().catch(() => undefined);
        const current = activeRef.current;
        if (current) {
          const lastSeq = lastSeqRef.current.get(current.id) ?? 0;
          void handle.sync({ [current.id]: lastSeq }).then((missing) => {
            const missed = missing[current.id];
            if (missed && missed.length) {
              for (const m of missed) noteSeq(current.id, m.seq);
              setMessages((prev) => mergeMessages(prev, missed));
            }
          });
        }
      },
    });
    realtimeRef.current = handle;
    return () => {
      handle.disconnect();
      realtimeRef.current = null;
      for (const timeout of typingTimeoutsRef.current.values()) clearTimeout(timeout);
      typingTimeoutsRef.current.clear();
    };
  }, [myId, markRead, recountUnread, reload]);

  /** Đóng hội thoại đang mở — nút quay lại ở mobile (issue #256); ở desktop khung phải về trạng thái trống. */
  function closeConversation() {
    setActive(null);
    // Đóng hẳn là rời ngữ cảnh: lần quay lại không mở lại hội thoại này (lát MSG-T3).
    storeConversationId(null);
  }

  async function open(conv: ConversationView) {
    setActive(conv);
    // Lưu bền hội thoại đang mở để quay lại màn Tin nhắn là gặp
    // đúng ngữ cảnh gần nhất (lát MSG-T3); deep-link thắng giá trị này.
    storeConversationId(conv.id);
    setTypingUsers({});
    setReportMessage(null);
    setActionMessage(null);
    setSendError(null);
    // Kết quả tìm là của conversation trước — không mang sang.
    setMessageSearch({ query: '', results: [], loading: false, failed: false, submitted: false });
    const detail = await apiJson<ConversationDetailView>(`/api/v1/messages/conversations/${conv.id}`);
    // Chi tiết mang theo enabled + thẩm quyền của chính user (Lớp B):
    // gộp vào conversation đang mở để header/khung soạn biết đường hiển thị.
    const { messages: _detailMessages, ...detailView } = detail;
    setActive({ ...conv, ...detailView });
    mergePeople(detail.memberProfiles);
    setMessages(detail.messages);
    setHasMoreBefore(detail.hasMoreBefore ?? false);
    const markers: Record<string, number> = {};
    for (const marker of detail.memberReadMarkers ?? []) markers[marker.userId] = marker.lastReadSeq;
    setReadMarkers(markers);
    const newest = detail.messages.length ? detail.messages[detail.messages.length - 1]!.seq : (detail.lastMessageSeq ?? 0);
    if (newest) lastSeqRef.current.set(conv.id, newest);
    realtimeRef.current?.joinConversation(conv.id);
    await markRead(conv.id);
  }

  /** Tải cửa sổ tin cũ hơn (cursor beforeSeq = seq nhỏ nhất đang có). */
  async function loadOlder() {
    if (!active) return;
    const oldest = messages.find((m) => !m.localStatus);
    if (!oldest) return;
    const page = await apiJson<{ messages: MessageView[]; hasMoreBefore: boolean }>(
      `/api/v1/messages/conversations/${active.id}/messages?beforeSeq=${oldest.seq}&limit=50`,
    );
    setMessages((prev) => mergeMessages(page.messages, prev));
    setHasMoreBefore(page.hasMoreBefore);
  }

  /**
   * Đẩy một tin lạc quan lên cuối và gửi thật; xác nhận của server (REST hoặc socket) thay bản tạm theo clientMessageId.
   * Tin TRẢ LỜI (lát M3) mang kèm `replyToMessageId` + khối trích dẫn
   * lạc quan dựng tại client; bản thật của server (đã dựng lại quote
   * theo quyền) thay thế nguyên vẹn khi về.
   */
  async function deliver(conversationId: string, text: string, clientMessageId: string, quote?: { replyToMessageId: string; replyTo: MessageQuoteView } | null) {
    if (!myId) return;
    setMessages((prev) => mergeMessages(prev, [{
      id: `temp-${clientMessageId}`,
      conversationId,
      userIdFrom: myId,
      fullMessage: text,
      createdAt: new Date().toISOString(),
      seq: 0,
      clientMessageId,
      replyToMessageId: quote?.replyToMessageId ?? null,
      replyTo: quote?.replyTo ?? null,
      localStatus: 'sending',
    }]));
    try {
      const saved = await apiJson<MessageView>(`/api/v1/messages/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          text, clientMessageId,
          ...(quote ? { replyToMessageId: quote.replyToMessageId } : {}),
        }),
      });
      const seen = lastSeqRef.current.get(conversationId) ?? 0;
      if (saved.seq > seen) lastSeqRef.current.set(conversationId, saved.seq);
      setMessages((prev) => mergeMessages(prev, [saved]));
      // Tin mình vừa gửi cũng là hoạt động mới nhất (lát M1, issue
      // #204): cập nhật xem trước và đưa conversation lên đầu danh
      // sách ngay tại chỗ, không chờ sự kiện conversation.updated
      // phản hồi về qua socket.
      setConversations((prev) => {
        const target = prev.find((c) => c.id === conversationId);
        if (!target) return prev;
        return [
          { ...target, lastMessage: saved, lastMessageSeq: saved.seq },
          ...prev.filter((c) => c.id !== conversationId),
        ];
      });
    } catch (err) {
      // Hai lỗi có mã riêng của lát M2 phải hiện thành câu chữ rõ
      // ràng cạnh composer (kèm trạng thái failed để thử lại được);
      // lỗi khác giữ hành vi cũ (chỉ đánh dấu failed).
      if (err instanceof ApiError && err.problem.code === 'messaging.message_too_long') {
        setSendError(t('messageTooLong', { max: MESSAGING_MAX_MESSAGE_LENGTH_DEFAULT }));
      } else if (err instanceof ApiError && err.problem.code === 'messaging.rate_limited') {
        setSendError(t('messageRateLimited'));
      }
      setMessages((prev) => prev.map((m) => (m.clientMessageId === clientMessageId && m.localStatus
        ? { ...m, localStatus: 'failed' as const }
        : m)));
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!active) return;
    // Khoá chống gọi trùng (fix nhân đôi tin, issue #33): một lượt
    // send() đang bay cho conversation này thì lượt gọi sau bị bỏ qua
    // ngay tại ref — kể cả hai submit trong cùng một nhịp render, khi
    // draft ở state chưa kịp xoá và cả hai lượt đều đọc được nội dung.
    if (sendInFlightRef.current.has(active.id)) return;
    const text = drafts[active.id] ?? '';
    if (!text.trim()) return;
    // Áp trần ở client theo ĐÚNG cách đếm của server (lát M2): vượt
    // trần thì giữ nguyên nháp + báo rõ, không bắn request chắc chắn
    // bị 400. Trần hiển thị là giá trị mặc định dùng chung ở
    // contracts; server vẫn là nguồn sự thật (quản trị đổi
    // site-config thì lỗi 400 của server cũng được dịch rõ ở deliver).
    if (countMessageCharacters(text) > MESSAGING_MAX_MESSAGE_LENGTH_DEFAULT) {
      setSendError(t('messageTooLong', { max: MESSAGING_MAX_MESSAGE_LENGTH_DEFAULT }));
      return;
    }
    // Khoá idempotency của BẢN NHÁP này (fix nhân đôi tin, issue
    // #33): đã có thì dùng lại, chưa có thì sinh một lần. Mọi lượt
    // submit lặp của cùng bản nháp mang CÙNG khoá → server trả đúng
    // một tin kể cả khi cả hai POST đều tới nơi.
    let clientMessageId = draftClientIdRef.current.get(active.id);
    if (!clientMessageId) {
      clientMessageId = crypto.randomUUID();
      draftClientIdRef.current.set(active.id, clientMessageId);
    }
    sendInFlightRef.current.add(active.id);
    setSendingConversationIds((prev) => new Set(prev).add(active.id));
    try {
      setSendError(null);
      // Chỉ xoá nháp của đúng conversation vừa gửi (lát M1, issue
      // #204) — nháp của các conversation khác giữ nguyên.
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[active.id];
        return next;
      });
      // Đích trích dẫn của conversation này cũng chỉ tiêu thụ một lần
      // (lát M3): gửi xong là ô soạn trở về trạng thái thường; tin đã
      // gửi (kể cả khi lỗi) tự mang trích dẫn của nó để thử lại.
      const target = replyTargets[active.id] ?? null;
      setReplyTargets((prev) => {
        const next = { ...prev };
        delete next[active.id];
        return next;
      });
      await deliver(
        active.id, text, clientMessageId,
        target ? { replyToMessageId: target.id, replyTo: localQuoteOf(target) } : null,
      );
      // Lượt gửi đã có kết quả từ server (tin thật về, hoặc tin lạc
      // quan đã rơi vào failed và giữ khoá của chính nó cho retrySend)
      // — bản nháp hiện tại chấm dứt ở đây: bỏ khoá để bản nháp KẾ
      // TIẾP sinh khoá mới, không bị gộp oan vào tin vừa gửi.
      if (draftClientIdRef.current.get(active.id) === clientMessageId) {
        draftClientIdRef.current.delete(active.id);
      }
    } finally {
      sendInFlightRef.current.delete(active.id);
      setSendingConversationIds((prev) => {
        const next = new Set(prev);
        next.delete(active.id);
        return next;
      });
    }
  }

  /** Thử gửi lại một tin đã lỗi — dùng lại đúng clientMessageId nên server không tạo trùng kể cả khi lần trước đã tới nơi. */
  async function retrySend(message: MessageView) {
    if (!active || !message.clientMessageId) return;
    setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, localStatus: 'sending' as const } : m)));
    await deliver(
      active.id, message.fullMessage, message.clientMessageId,
      message.replyToMessageId && message.replyTo
        ? { replyToMessageId: message.replyToMessageId, replyTo: message.replyTo }
        : null,
    );
  }

  /**
   * Nhảy tới MỘT tin theo (id, seq) — cơ chế chung của lát M3 (khối
   * trích dẫn) và lát M4 (kết quả tìm): tin đang có trong danh sách
   * thì cuộn ngay + tô sáng tạm; chưa tải thì xin cửa sổ quanh vị trí
   * của nó bằng ĐÚNG cơ chế phân trang hiện có (beforeSeq = seq + 1
   * → cửa sổ kết thúc tại tin đích), gộp vào danh sách rồi mới cuộn.
   * Tin đích không còn hiển thị được với mình (đã xoá-phía-mình...)
   * thì cửa sổ tải về không chứa nó — dừng êm, không báo lỗi.
   */
  async function jumpToMessage(messageId: string, seq: number) {
    if (!active) return;
    const scrollAndHighlight = () => {
      setHighlightedMessageId(messageId);
      // Phần tử có thể chưa kịp dựng sau lần gộp cửa sổ mới — thử
      // vài nhịp ngắn trước khi bỏ cuộc.
      let attempts = 0;
      const tryScroll = () => {
        attempts += 1;
        const ok = scrollerRef.current?.scrollToMessage(messageId, { behavior: 'smooth' }) ?? false;
        if (!ok && attempts < 6) setTimeout(tryScroll, 60);
      };
      tryScroll();
      setTimeout(() => {
        setHighlightedMessageId((cur) => (cur === messageId ? null : cur));
      }, 2400);
    };
    if (messages.some((m) => m.id === messageId)) {
      scrollAndHighlight();
      return;
    }
    try {
      const page = await apiJson<{ messages: MessageView[]; hasMoreBefore: boolean }>(
        `/api/v1/messages/conversations/${active.id}/messages?beforeSeq=${seq + 1}&limit=50`,
      );
      setMessages((prev) => mergeMessages(page.messages, prev));
      if (page.hasMoreBefore) setHasMoreBefore(true);
      if (page.messages.some((m) => m.id === messageId)) scrollAndHighlight();
    } catch {
      // Giữ nguyên khung hiện tại; người dùng vẫn đọc tiếp được.
    }
  }

  /** Nhảy tới tin gốc từ một khối trích dẫn (lát M3). */
  async function jumpToQuotedMessage(quote: MessageQuoteView) {
    await jumpToMessage(quote.id, quote.seq);
  }

  /**
   * Chạy một lượt tìm nội dung trong conversation đang mở (lát M4):
   * server là nơi thực thi luật tầm nhìn — client chỉ mang từ khoá
   * và hiển thị kết quả. Từ khoá toàn khoảng trắng thì xoá kết quả
   * êm (không bắn request chắc chắn bị 400).
   */
  async function runMessageSearch(rawQuery: string) {
    if (!active) return;
    const conversationId = active.id;
    const q = rawQuery.trim();
    if (!q) {
      setMessageSearch({ query: '', results: [], loading: false, failed: false, submitted: false });
      return;
    }
    setMessageSearch({ query: q, results: [], loading: true, failed: false, submitted: true });
    try {
      const res = await apiJson<{ results: MessageSearchResultView[] }>(
        `/api/v1/messages/conversations/${conversationId}/search?q=${encodeURIComponent(q)}&limit=50`,
      );
      // Người dùng đã chuyển conversation trong lúc chờ: bỏ kết quả cũ.
      if (activeRef.current?.id !== conversationId) return;
      setMessageSearch({ query: q, results: res.results, loading: false, failed: false, submitted: true });
    } catch {
      if (activeRef.current?.id !== conversationId) return;
      setMessageSearch({ query: q, results: [], loading: false, failed: true, submitted: true });
    }
  }

  /** Xoá lượt tìm hiện tại (lát M4) — khung tin trở về nguyên trạng. */
  function clearMessageSearch() {
    setMessageSearch({ query: '', results: [], loading: false, failed: false, submitted: false });
  }

  /** Phát tín hiệu đang nhập, throttle 3 giây ở client (server còn throttle thêm theo cửa sổ Redis). */
  function noteTyping() {
    if (!active) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current < 3000) return;
    lastTypingSentRef.current = now;
    realtimeRef.current?.typing(active.id);
  }

  /** Cập nhật trạng thái quan hệ của một dòng roster trong bộ chọn người ngay tại chỗ (không chờ tải lại). */
  const patchRosterRelationship = useCallback((userId: string, relationship: ContactRelationship) => {
    setPickerMembers((prev) => prev.map((m) => (m.userId === userId ? { ...m, relationship } : m)));
  }, []);

  /**
   * Gửi yêu cầu kết bạn tới một user (Lớp B: luồng yêu cầu–chấp nhận
   * thay danh bạ một chiều) — điểm vào là dòng ROSTER thành viên khoá
   * và hàng chờ kết bạn, không còn tìm theo tên hay form nhập UUID thô.
   */
  async function sendContactRequestTo(userId: string) {
    setContactMessage(null);
    try {
      const res = await apiJson<{ status: 'pending' | 'accepted' }>(`/api/v1/messages/contacts/${userId}`, {
        method: 'POST',
        body: '{}',
      });
      setContactMessage(res.status === 'accepted' ? t('contactRequestAccepted') : t('contactRequestSent'));
      // Phản ánh ngay lên dòng roster đang hiện, rồi đồng bộ lại toàn bộ.
      patchRosterRelationship(userId, res.status === 'accepted' ? 'contact' : 'pending_outgoing');
      await reload();
    } catch {
      setContactMessage(t('contactRequestFailed'));
    }
  }

  /**
   * Đường roster của một ngữ cảnh bộ chọn người (lát MSG-T3):
   * roster LỚP (MSG-T2) và roster KHOÁ dùng chung một khuôn phân
   * trang con trỏ phía server; ngữ cảnh liên hệ không có roster.
   */
  function pickerRosterUrl(context: PeoplePickerContext, cursor?: string): string | null {
    if (context.kind === 'contacts') return null;
    const base = context.kind === 'class'
      ? `/api/v1/messages/classes/${context.id}/members?limit=50`
      : `/api/v1/messages/courses/${context.id}/members?limit=50`;
    return cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base;
  }

  /** Chọn một ngữ cảnh trong bộ chọn người: liên hệ thì không nạp gì; lớp/khoá thì nạp trang roster đầu. */
  async function openPickerContext(context: PeoplePickerContext) {
    setPickerContext(context);
    setPickerMembers([]);
    setPickerCursor(null);
    setPickerError(null);
    const url = pickerRosterUrl(context);
    if (!url) return;
    try {
      const res = await apiJson<{ members: RosterMember[]; nextCursor: string | null }>(url);
      setPickerMembers(res.members);
      setPickerCursor(res.nextCursor);
      mergePeople(Object.fromEntries(res.members.map((m) => [m.userId, m])));
    } catch {
      setPickerError(t('rosterLoadFailed'));
    }
  }

  /** Tải trang roster tiếp theo của ngữ cảnh đang chọn trong bộ chọn người. */
  async function loadMorePicker() {
    if (!pickerCursor) return;
    const url = pickerRosterUrl(pickerContext, pickerCursor);
    if (!url) return;
    try {
      const res = await apiJson<{ members: RosterMember[]; nextCursor: string | null }>(url);
      setPickerMembers((prev) => [...prev, ...res.members]);
      setPickerCursor(res.nextCursor);
      mergePeople(Object.fromEntries(res.members.map((m) => [m.userId, m])));
    } catch {
      setPickerError(t('rosterLoadFailed'));
    }
  }

  /** Chấp nhận/từ chối một yêu cầu kết bạn đang chờ. */
  async function respondContactRequest(userId: string, action: 'accept' | 'decline') {
    setContactMessage(null);
    try {
      await apiJson(`/api/v1/messages/contacts/requests/${userId}/${action}`, { method: 'POST', body: '{}' });
      patchRosterRelationship(userId, action === 'accept' ? 'contact' : 'none');
      await reload();
    } catch {
      setContactMessage(t('contactRequestFailed'));
    }
  }

  /** Mở cuộc trò chuyện 1-1 với một liên hệ đã duyệt. */
  async function messageContact(userId: string) {
    const conv = await apiJson<ConversationView>('/api/v1/messages/conversations', {
      method: 'POST',
      body: JSON.stringify({ memberIds: [userId] }),
    });
    await reload();
    await open(conv);
  }

  /**
   * Mở một conversation ĐÃ có id (lát MSG-T3 — nút nhóm con/nhóm tự
   * do/chat đã ensure của cây Nhóm): có sẵn trong danh sách (chính
   * hoặc đã lưu) thì mở như cú bấm thường; chưa có thì lấy chi tiết
   * theo id bằng đúng cơ chế deep-link rồi mở — server là nơi thực
   * thi quyền thành viên, không phải thành viên thì bỏ qua êm.
   */
  async function openConversationById(conversationId: string) {
    const found = conversations.find((c) => c.id === conversationId)
      ?? archivedConversations.find((c) => c.id === conversationId);
    if (found) {
      await open(found);
      return;
    }
    try {
      const detail = await apiJson<ConversationDetailView>(`/api/v1/messages/conversations/${conversationId}`);
      const { messages: _detailMessages, hasMoreBefore: _hasMore, memberReadMarkers: _markers, ...summary } = detail;
      setConversations((prev) => (prev.some((c) => c.id === summary.id) ? prev : [summary, ...prev]));
      await open(summary);
    } catch {
      // Không phải thành viên hoặc conversation không tồn tại: giữ nguyên màn hiện tại.
    }
  }

  /**
   * Mở CHAT CẤP LỚP từ nút lớp của cây Nhóm (lát MSG-T3): ensure
   * qua endpoint lớp của MSG-T2 rồi mở ngay ở khung phải — bấm dòng
   * lớp là vào chat lớp, tối đa 2 thao tác tính từ màn Tin nhắn.
   * Người ngoài lớp nhận 404 ở server thì giữ nguyên màn hiện tại.
   */
  async function openClassChat(classId: string) {
    try {
      const conv = await apiJson<ConversationView>(`/api/v1/messages/classes/${classId}/conversation`);
      await reload();
      await open(conv);
    } catch {
      // Không thuộc lớp: giữ nguyên màn hiện tại.
    }
  }

  /**
   * Mở CHAT CẤP KHOÁ từ nút khoá của cây Nhóm (lát MSG-T3): ensure
   * qua endpoint khoá (đường đã có từ chat cấp khoá) rồi mở ngay ở
   * khung phải, cùng kỷ luật 2 thao tác như chat lớp.
   */
  async function openCourseChat(courseId: string) {
    try {
      const conv = await apiJson<ConversationView>(`/api/v1/messages/courses/${courseId}/conversation`);
      await reload();
      await open(conv);
    } catch {
      // Không thuộc khoá: giữ nguyên màn hiện tại.
    }
  }

  /**
   * Mở chat của một NHÓM CON chưa có conversation (lát MSG-T3):
   * tạo/lấy conversation gắn course group qua đường sẵn có rồi mở —
   * cùng đường trang quản trị khoá dùng để mở chat nhóm con.
   */
  async function openGroupConversation(groupId: string) {
    try {
      const conv = await apiJson<ConversationView>('/api/v1/messages/conversations/group', {
        method: 'POST',
        body: JSON.stringify({ groupId }),
      });
      await reload();
      await open(conv);
    } catch {
      // Không thuộc nhóm/khoá chứa nhóm: giữ nguyên màn hiện tại.
    }
  }

  /**
   * Tạo NHÓM TỰ DO từ sheet tạo nhóm (lát MSG-T3): POST type 2 với
   * tên + thành viên đã chọn; cổng chặn học sinh nằm ở server
   * (`messaging.group_creation_forbidden`) — lỗi đó dịch thành câu
   * rõ ràng hiện trong sheet, lỗi khác hiện câu chung. Thành công
   * thì nạp lại (cây có nhóm mới) và mở ngay nhóm vừa tạo.
   *
   * @returns true khi tạo thành công (khung trái đóng sheet và về tab Nhóm).
   */
  async function createFreeGroup(name: string, memberIds: string[]): Promise<boolean> {
    setGroupCreateError(null);
    try {
      const conv = await apiJson<ConversationView>('/api/v1/messages/conversations', {
        method: 'POST',
        body: JSON.stringify({ type: 2, name, memberIds }),
      });
      await reload();
      await open(conv);
      return true;
    } catch (err) {
      setGroupCreateError(
        err instanceof ApiError && err.problem.code === 'messaging.group_creation_forbidden'
          ? t('groupCreateForbidden')
          : t('groupCreateFailed'),
      );
      return false;
    }
  }

  /** Báo cáo cuộc trò chuyện đang mở — về giáo viên phụ trách + quản trị viên (Lớp B). */
  async function reportActiveConversation() {
    if (!active) return;
    setReportMessage(null);
    try {
      await apiJson(`/api/v1/messages/conversations/${active.id}/report`, { method: 'POST', body: '{}' });
      setReportMessage(t('conversationReported'));
    } catch {
      setReportMessage(t('reportFailed'));
    }
  }

  /** Bật/tắt chat của cuộc trò chuyện đang mở (chỉ hiện khi canManage). */
  async function toggleActiveChat() {
    if (!active) return;
    const updated = await apiJson<ConversationView>(`/api/v1/messages/conversations/${active.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !(active.enabled ?? true) }),
    });
    setActive((prev) => (prev ? { ...prev, enabled: updated.enabled } : prev));
    setConversations((prev) => prev.map((c) => (c.id === active.id ? { ...c, enabled: updated.enabled } : c)));
  }

  /**
   * Xoá-phía-mình một tin nhắn (vòng đời tin nhắn theo vai, issue #33):
   * chỉ tác giả, mọi lúc — tin chỉ ẩn khỏi tầm nhìn của chính người
   * xoá, phía kia không đổi. Server trả dòng tin kèm dấu vết — áp ngay
   * vào khung; phía học sinh tin biến mất ở bước render.
   */
  async function deleteMessage(message: MessageView) {
    setActionMessage(null);
    try {
      const deleted = await apiJson<MessageView>(`/api/v1/messages/messages/${message.id}`, { method: 'DELETE' });
      setMessages((prev) => prev.map((m) => (m.id === message.id
        ? { ...m, deletedAt: deleted.deletedAt ?? new Date().toISOString(), deletedBy: deleted.deletedBy ?? myId ?? null }
        : m)));
    } catch {
      setActionMessage(t('deleteMessageFailed'));
    }
  }

  /**
   * Cửa sổ thu hồi mặc định (phút) theo site-config
   * `core/messagingrecallwindowminutes`: server là thẩm quyền cuối
   * (ngoài cửa sổ trả 403) — client chỉ dùng mốc này để ẨN nút thu
   * hồi khi tin đã cũ, không tự quyết cho phép thu hồi.
   */
  const RECALL_WINDOW_MINUTES = 15;
  function canRecall(message: MessageView): boolean {
    if (message.userIdFrom !== myId || message.localStatus || message.recalledAt || message.deletedAt) return false;
    return Date.now() - new Date(message.createdAt).getTime() < RECALL_WINDOW_MINUTES * 60 * 1000;
  }

  /** Thu hồi tin của mình cho mọi người (chỉ trong cửa sổ): nội dung bị vô hiệu, khung hiện dòng đã thu hồi. */
  async function recallMessage(message: MessageView) {
    setActionMessage(null);
    try {
      const recalled = await apiJson<MessageView>(`/api/v1/messages/messages/${message.id}/recall`, { method: 'POST', body: '{}' });
      setMessages((prev) => prev.map((m) => (m.id === message.id
        ? { ...m, fullMessage: '', recalledAt: recalled.recalledAt ?? new Date().toISOString(), recalledBy: recalled.recalledBy ?? myId ?? null }
        : m)));
    } catch {
      setActionMessage(t('recallMessageFailed'));
    }
  }

  /** Xoá cứng một tin (chỉ moderator có moderation:manage): lý do bắt buộc, tin biến mất khỏi khung ngay. */
  async function hardDeleteMessage(message: MessageView) {
    setActionMessage(null);
    if (!window.confirm(t('hardDeleteConfirm'))) return;
    const reason = window.prompt(t('hardDeleteReasonPrompt'));
    if (!reason || !reason.trim()) return;
    try {
      await apiJson(`/api/v1/messages/messages/${message.id}/hard-delete`, {
        method: 'POST', body: JSON.stringify({ reason: reason.trim() }),
      });
      setMessages((prev) => prev.filter((m) => m.id !== message.id));
      setSelectedForBulk((prev) => {
        const next = new Set(prev);
        next.delete(message.id);
        return next;
      });
    } catch {
      setActionMessage(t('hardDeleteMessageFailed'));
    }
  }

  /** Gỡ hàng loạt các tin đã chọn (chỉ moderator): toàn bộ danh sách kiểm tra thẩm quyền trước, một tin ngoài phạm vi là cả lượt bị từ chối. */
  async function bulkRemoveSelected() {
    setActionMessage(null);
    const messageIds = [...selectedForBulk];
    if (messageIds.length === 0) return;
    if (!window.confirm(t('bulkRemoveConfirm', { count: messageIds.length }))) return;
    const reason = window.prompt(t('bulkRemoveReasonPrompt'));
    if (!reason || !reason.trim()) return;
    try {
      await apiJson('/api/v1/messages/messages/bulk-remove', {
        method: 'POST', body: JSON.stringify({ messageIds, reason: reason.trim() }),
      });
      setMessages((prev) => prev.filter((m) => !selectedForBulk.has(m.id)));
      setSelectedForBulk(new Set());
    } catch {
      setActionMessage(t('bulkRemoveMessageFailed'));
    }
  }

  const lastOwnMessage = [...messages].reverse().find((m) => m.userIdFrom === myId && !m.localStatus);
  const seenByAllOthers = Boolean(
    active && lastOwnMessage
      && active.members.filter((memberId) => memberId !== myId)
        .every((memberId) => (readMarkers[memberId] ?? 0) >= lastOwnMessage.seq),
  );
  const typingNames = Object.keys(typingUsers).filter((userId) => typingUsers[userId]);
  // Tầm nhìn xoá mềm ở phía client (server đã chốt theo vai trò):
  // tin đã xoá chỉ còn hiện với người có thẩm quyền kiểm duyệt.
  const visibleMessages = messages.filter((m) => !m.deletedAt || active?.canModerate);
  /** Nháp đang hiện ở composer: nháp của conversation đang mở (lát M1). */
  const draft = active ? (drafts[active.id] ?? '') : '';
  /** Đích trích dẫn đang chờ gửi của conversation đang mở (lát M3). */
  const replyTarget = active ? (replyTargets[active.id] ?? null) : null;
  /** Các lớp của tôi cho ngữ cảnh theo lớp của bộ chọn người — lấy từ chính cây nhóm (lát MSG-T3). */
  const pickerClasses = groupTree?.classes.map((c) => ({ classId: c.classId, name: c.name })) ?? [];
  /**
   * Có hiện nút tạo nhóm tự do hay không (lát MSG-T3): người xem có
   * vai DẠY/STAFF ở bất kỳ nút nào của cây (dạy lớp/khoá, staff lớp,
   * hoặc đang quản trị một nhóm tự do) thì hiện; học sinh thuần
   * (mọi nút đều là vai học) thì ẩn. Đây chỉ là trình bày — cổng
   * thật chặn học sinh tạo nhóm nằm ở server.
   */
  const canCreateFreeGroup = Boolean(groupTree && (
    groupTree.classes.some((c) => c.myRole !== 'learning')
    || groupTree.coursesOutsideClasses.some((c) => c.myRole !== 'learning')
    || groupTree.freeGroups.some((g) => g.myRole === 'staff')
  ));

  return (
    <PageShell fillHeight width="full">
      {/*
        Master–detail nhắn tin (issue #256) nằm TRONG vùng nội dung
        của khung app chung — sidebar + header của app giữ nguyên
        (chốt Lão gia 08:20 ngày 26/10/2026, sổ quyết định mục D).
        Desktop: hai khung cuộn độc lập; mobile: một khung tại một
        thời điểm, khung chat có nút quay lại (CSS thuần, cả hai
        khung luôn mounted).
      */}
      <div className="flex h-[calc(100dvh-5.5rem)] min-h-0 overflow-hidden rounded-xl border bg-background md:h-[calc(100dvh-7rem)]">
        <div
          className={active
            ? 'hidden min-h-0 w-full flex-col md:flex md:w-[340px] md:shrink-0 md:border-r lg:w-[360px]'
            : 'flex min-h-0 w-full flex-col md:w-[340px] md:shrink-0 md:border-r lg:w-[360px]'}
        >
          <ConversationSidebar
            conversations={conversations}
            archivedConversations={archivedConversations}
            onRequestArchived={() => void loadArchived()}
            groupTree={groupTree}
            active={active}
            unread={unread}
            error={error}
            myId={myId}
            onlineUsers={onlineUsers}
            onOpenConversation={open}
            onOpenConversationById={(conversationId) => void openConversationById(conversationId)}
            onOpenClassChat={(classId) => void openClassChat(classId)}
            onOpenCourseChat={(courseId) => void openCourseChat(courseId)}
            onOpenGroupConversation={(groupId) => void openGroupConversation(groupId)}
            canCreateFreeGroup={canCreateFreeGroup}
            onCreateFreeGroup={createFreeGroup}
            groupCreateError={groupCreateError}
            onUpdateConversationState={updateConversationState}
            stateError={stateError}
            nameOf={nameOf}
            tab={sidebarTab}
            onTabChange={setSidebarTab}
            contacts={contacts}
            contactMessage={contactMessage}
            incomingRequests={incomingRequests}
            outgoingRequests={outgoingRequests}
            blocked={blocked}
            blockMessage={blockMessage}
            onMessageContact={messageContact}
            onSendContactRequest={sendContactRequestTo}
            onRespondContactRequest={respondContactRequest}
            onUnblockContact={unblockContact}
            pickerContext={pickerContext}
            onSelectPickerContext={(context) => void openPickerContext(context)}
            pickerClasses={pickerClasses}
            pickerCourses={myCourses}
            pickerMembers={pickerMembers}
            pickerRosterError={pickerError}
            pickerRosterCursor={pickerCursor}
            onLoadMorePicker={() => void loadMorePicker()}
          />
        </div>
        <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden min-h-0 flex-1 flex-col md:flex'}>
          <ChatPanel
            active={active}
            myId={myId}
            onlineUsers={onlineUsers}
            readMarkers={readMarkers}
            onBack={closeConversation}
            blocked={blocked}
        onUnblockContact={unblockContact}
        onBlockContact={blockContact}
        onReportConversation={reportActiveConversation}
        onToggleChat={toggleActiveChat}
        reportMessage={reportMessage}
        actionMessage={actionMessage}
        hasMoreBefore={hasMoreBefore}
        onLoadOlder={loadOlder}
        selectedForBulk={selectedForBulk}
        setSelectedForBulk={setSelectedForBulk}
        onBulkRemove={bulkRemoveSelected}
        visibleMessages={visibleMessages}
        nameOf={nameOf}
        onRetrySend={retrySend}
        onDeleteMessage={deleteMessage}
        canRecall={canRecall}
        onRecallMessage={recallMessage}
        onHardDeleteMessage={hardDeleteMessage}
        seenByAllOthers={seenByAllOthers}
        typingNames={typingNames}
        draft={draft}
        setDrafts={setDrafts}
        onNoteTyping={noteTyping}
        onSend={send}
        sendError={sendError}
        sendInFlight={!!active && sendingConversationIds.has(active.id)}
        replyTarget={replyTarget}
        onStartReply={(m) => setReplyTargets((prev) => ({ ...prev, [m.conversationId]: m }))}
        onCancelReply={() => { if (active) setReplyTargets((prev) => ({ ...prev, [active.id]: null })); }}
        onJumpToQuote={(quote) => void jumpToQuotedMessage(quote)}
        highlightedMessageId={highlightedMessageId}
        scrollerRef={scrollerRef}
        messageSearch={messageSearch}
        onSearchMessages={(q) => void runMessageSearch(q)}
        onClearMessageSearch={clearMessageSearch}
        onJumpToSearchResult={(result) => void jumpToMessage(result.id, result.seq)}
          />
        </div>
      </div>
    </PageShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default MessagesPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('navMessages');
}

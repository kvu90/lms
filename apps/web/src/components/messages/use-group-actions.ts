/**
 * Hook điều phối mở và quản trị nhóm của trang Tin nhắn (đợt C của
 * issue #223, lát 3): sở hữu lỗi tạo nhóm, thông báo báo cáo/hành
 * động và các thao tác mở chat lớp/khoá/nhóm con, tạo nhóm tự do,
 * báo cáo conversation, gỡ thành viên và bật/tắt chat. Di chuyển từ
 * `pages/messages.tsx` (dòng 339–341 và khoảng 1.300–1.380), giữ
 * nguyên kỷ luật: server là nơi thực thi quyền thành viên (không
 * phải thành viên thì bỏ qua êm); cổng chặn học sinh tạo nhóm nằm ở
 * server, client chỉ trình bày nút theo vai.
 *
 * @param params - `active` là conversation đang mở cùng các setter
 * của nó và của danh sách; `conversations`/`archivedConversations`
 * để mở conversation đã có; `groupTree` để suy quyền hiển thị nút
 * tạo nhóm; `nameOf` cho câu xác nhận gỡ thành viên; `reload` nạp
 * lại sau khi tạo/mở; `open` mở conversation (trang nối qua
 * callback dùng-chung); `setPanelRefreshTick` để làm mới panel sau
 * khi gỡ thành viên.
 * @returns Trạng thái nhóm và handler cho trang lắp ghép.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '#lib/api';
import {
  classConversationQueryOptions,
  conversationDetailQueryOptions,
  courseConversationQueryOptions,
  useCreateFreeGroup,
  useCreateGroupConversation,
  useRemoveConversationMember,
  useReportConversation,
  useSetConversationEnabled,
} from '#lib/messaging-data';
import type { ConversationGroupTreeView, ConversationView } from './types';

export interface UseGroupActionsParams {
  /** Conversation đang mở (null khi chưa chọn). */
  active: ConversationView | null;
  /** Ghi conversation đang mở (gỡ thành viên/tắt chat áp ngay). */
  setActive: (active: ConversationView | null | ((prev: ConversationView | null) => ConversationView | null)) => void;
  /** Ghi danh sách conversation. */
  setConversations: (conversations: ConversationView[] | ((prev: ConversationView[]) => ConversationView[])) => void;
  /** Danh sách conversation chính — nguồn tìm conversation đã có. */
  conversations: ConversationView[];
  /** Mục đã lưu — nguồn tìm conversation đã có. */
  archivedConversations: ConversationView[];
  /** Cây nhóm của tôi — nguồn suy quyền hiển thị nút tạo nhóm. */
  groupTree: ConversationGroupTreeView | null;
  /** Tên hiển thị của một user (câu xác nhận gỡ thành viên). */
  nameOf: (userId: string) => string;
  /** Nạp lại danh sách sau khi tạo/mở nhóm. */
  reload: () => Promise<void>;
  /** Mở conversation (trang nối qua callback dùng-chung). */
  open: (conv: ConversationView) => Promise<void> | void;
  /** Tăng mốc làm mới panel thành viên sau khi gỡ thành viên. */
  setPanelRefreshTick: (tick: number | ((prev: number) => number)) => void;
}

export function useGroupActions({
  active,
  setActive,
  setConversations,
  conversations,
  archivedConversations,
  groupTree,
  nameOf,
  reload,
  open,
  setPanelRefreshTick,
}: UseGroupActionsParams) {
  const { t } = useTranslation('app');
  const queryClient = useQueryClient();
  /** Lỗi tạo nhóm tự do gần nhất (đã dịch từ mã lỗi server); null khi không có. */
  const [groupCreateError, setGroupCreateError] = useState<string | null>(null);
  const [reportMessage, setReportMessage] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const groupConversationMutation = useCreateGroupConversation();
  const freeGroupMutation = useCreateFreeGroup();
  const reportConversationMutation = useReportConversation();
  const removeMemberMutation = useRemoveConversationMember();
  const conversationEnabledMutation = useSetConversationEnabled();

  /**
   * Mở một conversation ĐÃ có id (lát MSG-T3 — nút nhóm con/nhóm tự
   * do/chat đã ensure của cây Nhóm): có sẵn trong danh sách (chính
   * hoặc đã lưu) thì mở như cú bấm thường; chưa có thì lấy chi tiết
   * theo id bằng đúng cơ chế deep-link rồi mở — server là nơi thực
   * thi quyền thành viên, không phải thành viên thì bỏ qua êm.
   */
  async function openConversationById(conversationId: string) {
    const found =
      conversations.find((c) => c.id === conversationId) ?? archivedConversations.find((c) => c.id === conversationId);
    if (found) {
      await open(found);
      return;
    }
    try {
      const detail = await queryClient.fetchQuery(conversationDetailQueryOptions(conversationId));
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
      const conv = await queryClient.fetchQuery(classConversationQueryOptions(classId));
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
      const conv = await queryClient.fetchQuery(courseConversationQueryOptions(courseId));
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
      const conv = await groupConversationMutation.mutateAsync(groupId);
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
      const conv = await freeGroupMutation.mutateAsync({ name, memberIds });
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
      await reportConversationMutation.mutateAsync(active.id);
      setReportMessage(t('conversationReported'));
    } catch {
      setReportMessage(t('reportFailed'));
    }
  }

  /**
   * Gỡ một thành viên khỏi NHÓM TỰ DO đang mở (lát MSG-T4): xác
   * nhận trước khi gọi DELETE — server là cổng cuối (chỉ nhóm tự
   * do, chỉ người có thẩm quyền quản lý, không gỡ người tạo). Thành
   * công thì áp danh sách thành viên mới ngay + làm mới panel; lỗi
   * hiện ở dải thông báo hành động của khung chat.
   */
  async function removeGroupMember(userId: string) {
    if (!active) return;
    if (!window.confirm(t('memberRemoveConfirm', { name: nameOf(userId) }))) return;
    setActionMessage(null);
    try {
      const updated = await removeMemberMutation.mutateAsync({ conversationId: active.id, userId });
      setActive((prev) => (prev ? { ...prev, members: updated.members } : prev));
      setConversations((prev) => prev.map((c) => (c.id === active.id ? { ...c, members: updated.members } : c)));
      setPanelRefreshTick((n) => n + 1);
      setActionMessage(t('memberRemoved'));
    } catch {
      setActionMessage(t('memberRemoveFailed'));
    }
  }

  /** Bật/tắt chat của cuộc trò chuyện đang mở (chỉ hiện khi canManage). */
  async function toggleActiveChat() {
    if (!active) return;
    const updated = await conversationEnabledMutation.mutateAsync({
      conversationId: active.id,
      enabled: !(active.enabled ?? true),
    });
    setActive((prev) => (prev ? { ...prev, enabled: updated.enabled } : prev));
    setConversations((prev) => prev.map((c) => (c.id === active.id ? { ...c, enabled: updated.enabled } : c)));
  }

  /** Xoá thông báo báo cáo/hành động khi mở conversation mới — phần đặt lại phía nhóm của trình bao `open` ở trang. */
  function clearActionMessages() {
    setReportMessage(null);
    setActionMessage(null);
  }

  /**
   * Có hiện nút tạo nhóm tự do hay không (lát MSG-T3): người xem có
   * vai DẠY/STAFF ở bất kỳ nút nào của cây (dạy lớp/khoá, staff lớp,
   * hoặc đang quản trị một nhóm tự do) thì hiện; học sinh thuần
   * (mọi nút đều là vai học) thì ẩn. Đây chỉ là trình bày — cổng
   * thật chặn học sinh tạo nhóm nằm ở server.
   */
  const canCreateFreeGroup = Boolean(
    groupTree &&
    (groupTree.classes.some((c) => c.myRole !== 'learning') ||
      groupTree.coursesOutsideClasses.some((c) => c.myRole !== 'learning') ||
      groupTree.freeGroups.some((g) => g.myRole === 'staff')),
  );

  return {
    groupCreateError,
    reportMessage,
    setReportMessage,
    actionMessage,
    setActionMessage,
    openConversationById,
    openClassChat,
    openCourseChat,
    openGroupConversation,
    createFreeGroup,
    reportActiveConversation,
    removeGroupMember,
    toggleActiveChat,
    clearActionMessages,
    canCreateFreeGroup,
  };
}

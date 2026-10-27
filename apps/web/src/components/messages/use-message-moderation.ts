/**
 * Hook điều phối kiểm duyệt tin của trang Tin nhắn (đợt C của issue
 * #223, lát 3): sở hữu tập tin đã chọn để gỡ hàng loạt và các thao
 * tác xoá-phía-mình, thu hồi, xoá cứng, gỡ hàng loạt. Di chuyển từ
 * `pages/messages.tsx` (dòng 343–351 và khoảng 1.380–1.458), giữ
 * nguyên luật: chỉ tác giả mới xoá-phía-mình mọi lúc; thu hồi chỉ
 * trong cửa sổ (client chỉ ẩn nút khi tin đã cũ, server là thẩm
 * quyền cuối); xoá cứng và gỡ hàng loạt hỏi lý do bắt buộc qua
 * `window.prompt`; toàn bộ danh sách gỡ hàng loạt được kiểm tra
 * thẩm quyền trước, một tin ngoài phạm vi là cả lượt bị từ chối.
 *
 * @param params - `active` là conversation đang mở; `myId` để xét
 * quyền thu hồi; `setMessages` để áp kết quả lên khung tin;
 * `setActionMessage` để báo kết quả ở dải thông báo của khung chat.
 * @returns Trạng thái kiểm duyệt và handler cho trang lắp ghép.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useBulkRemoveMessages,
  useDeleteMessageForMe,
  useHardDeleteMessage,
  useRecallMessage,
} from '#lib/messaging-data';
import type { ConversationView, MessageView } from './types';

export interface UseMessageModerationParams {
  /** Conversation đang mở (null khi chưa chọn). */
  active: ConversationView | null;
  /** Id người xem hiện tại (chỉ tác giả mới thu hồi/xoá-phía-mình). */
  myId: string | undefined;
  /** Ghi cửa sổ tin của conversation đang mở. */
  setMessages: (messages: MessageView[] | ((prev: MessageView[]) => MessageView[])) => void;
  /** Ghi thông báo hành động của khung chat. */
  setActionMessage: (message: string | null) => void;
}

/**
 * Cửa sổ thu hồi mặc định (phút) theo site-config
 * `core/messagingrecallwindowminutes`: server là thẩm quyền cuối
 * (ngoài cửa sổ trả 403) — client chỉ dùng mốc này để ẨN nút thu
 * hồi khi tin đã cũ, không tự quyết cho phép thu hồi.
 */
const RECALL_WINDOW_MINUTES = 15;

export function useMessageModeration({ active, myId, setMessages, setActionMessage }: UseMessageModerationParams) {
  const { t } = useTranslation('app');
  /** Tin đã chọn để gỡ hàng loạt (chỉ moderator) — chọn bằng checkbox ở từng dòng tin. */
  const [selectedForBulk, setSelectedForBulk] = useState<Set<string>>(new Set());

  const deleteMessageMutation = useDeleteMessageForMe();
  const recallMessageMutation = useRecallMessage();
  const hardDeleteMutation = useHardDeleteMessage();
  const bulkRemoveMutation = useBulkRemoveMessages();

  /**
   * Xoá-phía-mình một tin nhắn (vòng đời tin nhắn theo vai, issue #33):
   * chỉ tác giả, mọi lúc — tin chỉ ẩn khỏi tầm nhìn của chính người
   * xoá, phía kia không đổi. Server trả dòng tin kèm dấu vết — áp ngay
   * vào khung; phía học sinh tin biến mất ở bước render.
   */
  async function deleteMessage(message: MessageView) {
    setActionMessage(null);
    try {
      const deleted = await deleteMessageMutation.mutateAsync(message.id);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === message.id
            ? {
                ...m,
                deletedAt: deleted.deletedAt ?? new Date().toISOString(),
                deletedBy: deleted.deletedBy ?? myId ?? null,
              }
            : m,
        ),
      );
    } catch {
      setActionMessage(t('deleteMessageFailed'));
    }
  }

  function canRecall(message: MessageView): boolean {
    if (message.userIdFrom !== myId || message.localStatus || message.recalledAt || message.deletedAt) return false;
    return Date.now() - new Date(message.createdAt).getTime() < RECALL_WINDOW_MINUTES * 60 * 1000;
  }

  /** Thu hồi tin của mình cho mọi người (chỉ trong cửa sổ): nội dung bị vô hiệu, khung hiện dòng đã thu hồi. */
  async function recallMessage(message: MessageView) {
    setActionMessage(null);
    try {
      const recalled = await recallMessageMutation.mutateAsync(message.id);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === message.id
            ? {
                ...m,
                fullMessage: '',
                recalledAt: recalled.recalledAt ?? new Date().toISOString(),
                recalledBy: recalled.recalledBy ?? myId ?? null,
              }
            : m,
        ),
      );
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
      await hardDeleteMutation.mutateAsync({ messageId: message.id, reason: reason.trim() });
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
      await bulkRemoveMutation.mutateAsync({ messageIds, reason: reason.trim() });
      setMessages((prev) => prev.filter((m) => !selectedForBulk.has(m.id)));
      setSelectedForBulk(new Set());
    } catch {
      setActionMessage(t('bulkRemoveMessageFailed'));
    }
  }

  return {
    selectedForBulk,
    setSelectedForBulk,
    deleteMessage,
    canRecall,
    recallMessage,
    hardDeleteMessage,
    bulkRemoveSelected,
  };
}

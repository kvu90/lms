/**
 * Hook điều phối hội thoại đang mở của trang Tin nhắn (đợt C của
 * issue #223, lát 2): sở hữu hội thoại đang mở, cửa sổ tin, mốc
 * đọc, trạng thái đang gõ/hiện diện, cùng các thao tác mở/đóng và
 * tải tin cũ hơn. Di chuyển từ `pages/messages.tsx` (dòng 258–263,
 * khoảng 874–1.000 và các giá trị suy ra ở khoảng 1.459–1.517), giữ
 * nguyên hành vi: chi tiết mang theo enabled + thẩm quyền của chính
 * user được gộp vào conversation đang mở để header/khung soạn biết
 * đường hiển thị; tin mới nhất đặt mốc seq cho lần đồng bộ nối lại.
 *
 * @param params - `mergePeople` gom tên hiển thị từ chi tiết;
 * `markRead` đánh dấu đã đọc sau khi mở; `myId` phục vụ giá trị
 * suy ra "đã xem"; `lastSeqRef` là mốc seq dùng chung do trang sở
 * hữu; `realtimeRef` để báo socket tham gia conversation vừa mở.
 * @returns Trạng thái hội thoại đang mở và handler cho trang lắp ghép.
 */
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { conversationDetailQueryOptions, conversationMessagesPageQueryOptions } from '#lib/messaging-data';
import type { MessagingRealtimeHandle } from '#lib/messaging-socket';
import { storeConversationId } from './page-helpers';
import { mergeMessages } from './utils';
import type { ConversationView, MessageView, PersonSummary } from './types';

export interface UseActiveConversationParams {
  /** Gom tên hiển thị từ chi tiết conversation vào bản đồ tên chung. */
  mergePeople: (profiles: Record<string, PersonSummary> | undefined) => void;
  /** Đánh dấu đã đọc ở server sau khi mở conversation. */
  markRead: (conversationId: string) => Promise<void>;
  /** Id người xem hiện tại (phục vụ giá trị suy ra "đã xem"). */
  myId: string | undefined;
  /** Mốc seq cao nhất đã thấy của từng conversation — trang sở hữu chung. */
  lastSeqRef: { current: Map<string, number> };
  /** Handle socket realtime — trang sở hữu chung, hook realtime gán vào. */
  realtimeRef: { current: MessagingRealtimeHandle | null };
}

export function useActiveConversation({
  mergePeople,
  markRead,
  myId,
  lastSeqRef,
  realtimeRef,
}: UseActiveConversationParams) {
  const queryClient = useQueryClient();
  const [active, setActive] = useState<ConversationView | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [readMarkers, setReadMarkers] = useState<Record<string, number>>({});
  const [typingUsers, setTypingUsers] = useState<Record<string, boolean>>({});
  const [onlineUsers, setOnlineUsers] = useState<Record<string, boolean>>({});
  const activeRef = useRef<ConversationView | null>(null);
  activeRef.current = active;

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
    const detail = await queryClient.fetchQuery(conversationDetailQueryOptions(conv.id));
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
    const newest = detail.messages.length
      ? detail.messages[detail.messages.length - 1]!.seq
      : (detail.lastMessageSeq ?? 0);
    if (newest) lastSeqRef.current.set(conv.id, newest);
    realtimeRef.current?.joinConversation(conv.id);
    await markRead(conv.id);
  }

  /** Tải cửa sổ tin cũ hơn (cursor beforeSeq = seq nhỏ nhất đang có). */
  async function loadOlder() {
    if (!active) return;
    const oldest = messages.find((m) => !m.localStatus);
    if (!oldest) return;
    const page = await queryClient.fetchQuery(conversationMessagesPageQueryOptions(active.id, oldest.seq));
    setMessages((prev) => mergeMessages(page.messages, prev));
    setHasMoreBefore(page.hasMoreBefore);
  }

  const lastOwnMessage = [...messages].reverse().find((m) => m.userIdFrom === myId && !m.localStatus);
  const seenByAllOthers = Boolean(
    active &&
    lastOwnMessage &&
    active.members
      .filter((memberId) => memberId !== myId)
      .every((memberId) => (readMarkers[memberId] ?? 0) >= lastOwnMessage.seq),
  );
  const typingNames = Object.keys(typingUsers).filter((userId) => typingUsers[userId]);
  // Tầm nhìn xoá mềm ở phía client (server đã chốt theo vai trò):
  // tin đã xoá chỉ còn hiện với người có thẩm quyền kiểm duyệt.
  const visibleMessages = messages.filter((m) => !m.deletedAt || active?.canModerate);

  return {
    active,
    setActive,
    messages,
    setMessages,
    hasMoreBefore,
    setHasMoreBefore,
    readMarkers,
    setReadMarkers,
    typingUsers,
    setTypingUsers,
    onlineUsers,
    setOnlineUsers,
    activeRef,
    closeConversation,
    open,
    loadOlder,
    lastOwnMessage,
    seenByAllOthers,
    typingNames,
    visibleMessages,
  };
}

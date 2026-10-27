/**
 * Hook điều phối khôi phục ngữ cảnh của trang Tin nhắn (đợt C của
 * issue #223, lát 1): hai hiệu ứng chạy đúng một lần khi danh sách
 * nạp xong — deep-link từ thông báo (`?conversation=<id>`) thắng
 * ngữ cảnh đã lưu, nếu không có deep-link thì mở lại hội thoại đã
 * lưu bền. Di chuyển từ `pages/messages.tsx` (hiệu ứng dòng
 * 678–742), giữ nguyên kỷ luật: deep-link có sẵn trong danh sách
 * thì mở như cú bấm; chưa có thì lấy chi tiết rồi chèn vào danh
 * sách rồi mở; server là nơi thực thi quyền thành viên nên không
 * phải thành viên/không tồn tại thì bỏ qua êm.
 *
 * @param params - `deepLinkId` từ tham số truy vấn; `listLoaded` là
 * mốc danh sách đã nạp xong; `conversations` để tìm hội thoại đã
 * có; `setConversations` để chèn hội thoại lấy theo id; `open` mở
 * conversation (trang nối qua callback dùng-chung).
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { conversationDetailQueryOptions } from '#lib/messaging-data';
import { readStoredConversationId } from './page-helpers';
import type { ConversationView } from './types';

export interface UseConversationRestoreParams {
  /** Id conversation từ deep-link `?conversation=` (null khi không có). */
  deepLinkId: string | null;
  /** Danh sách đã nạp xong ít nhất một lần. */
  listLoaded: boolean;
  /** Danh sách conversation chính — nguồn tìm hội thoại đã có. */
  conversations: ConversationView[];
  /** Ghi danh sách conversation (chèn hội thoại lấy theo id). */
  setConversations: (conversations: ConversationView[] | ((prev: ConversationView[]) => ConversationView[])) => void;
  /** Mở conversation (trang nối qua callback dùng-chung). */
  open: (conv: ConversationView) => Promise<void> | void;
}

export function useConversationRestore({
  deepLinkId,
  listLoaded,
  conversations,
  setConversations,
  open,
}: UseConversationRestoreParams) {
  const queryClient = useQueryClient();
  /** Deep-link ?conversation= chỉ xử lý một lần khi trang vừa nạp (không giành cuộc trò chuyện đang mở ở các lần nạp lại sau). */
  const deepLinkHandledRef = useRef(false);
  /** Ngữ cảnh gần nhất chỉ khôi phục một lần cho mỗi lần nạp trang (gác bằng ref như deep-link). */
  const contextRestoredRef = useRef(false);

  // Deep-link từ thông báo (việc nối tiếp của #33): thông báo
  // message_new của #49 trỏ contextUrl = /messages?conversation=<id>.
  // Danh sách nạp xong thì mở đúng conversation đó — có sẵn trong
  // danh sách thì mở như cú bấm của người dùng; chưa có (danh sách
  // nạp thiếu/trễ) thì lấy chi tiết thẳng theo id bằng đúng endpoint
  // trang vẫn dùng để mở, chèn vào danh sách rồi mở. Server là nơi
  // thực thi quyền thành viên: không phải thành viên/không tồn tại
  // thì bỏ qua deep-link, trang giữ nguyên như không có tham số.
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
        const detail = await queryClient.fetchQuery(conversationDetailQueryOptions(deepLinkId));
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
        const detail = await queryClient.fetchQuery(conversationDetailQueryOptions(savedId));
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
}

/**
 * Hook điều phối tìm trong hội thoại của trang Tin nhắn (đợt C của
 * issue #223, lát 2): sở hữu trạng thái một lượt tìm, tin đang tô
 * sáng và handle cuộn, cùng các thao tác nhảy tới tin và chạy/xoá
 * lượt tìm. Di chuyển từ `pages/messages.tsx` (dòng 279–293 và
 * khoảng 1.100–1.142), giữ nguyên cơ chế: tin đích đang có thì cuộn
 * ngay + tô sáng tạm; chưa tải thì xin cửa sổ quanh vị trí của nó
 * bằng đúng cơ chế phân trang hiện có rồi mới cuộn; tin đích không
 * còn hiển thị được thì dừng êm.
 *
 * @param params - `active` là conversation đang mở; `messages` là
 * cửa sổ tin hiện tại; `setMessages`/`setHasMoreBefore` để gộp cửa
 * sổ tải thêm; `activeRef` để bỏ kết quả cũ khi đã chuyển
 * conversation trong lúc chờ.
 * @returns Trạng thái tìm kiếm và handler cho trang lắp ghép.
 */
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { conversationMessagesPageQueryOptions, messageSearchQueryOptions } from '#lib/messaging-data';
import { mergeMessages } from './utils';
import type { ConversationView, MessageQuoteView, MessageSearchResultView, MessageView, ScrollerHandle } from './types';

export interface UseMessageSearchParams {
  /** Conversation đang mở (null khi chưa chọn). */
  active: ConversationView | null;
  /** Cửa sổ tin hiện tại của conversation đang mở. */
  messages: MessageView[];
  /** Ghi cửa sổ tin (gộp cửa sổ tải thêm khi nhảy tới tin chưa có). */
  setMessages: (messages: MessageView[] | ((prev: MessageView[]) => MessageView[])) => void;
  /** Ghi cờ còn tin cũ hơn phía trước. */
  setHasMoreBefore: (value: boolean) => void;
  /** Ref conversation đang mở — đọc mới nhất để bỏ kết quả tìm đã cũ. */
  activeRef: { current: ConversationView | null };
}

export function useMessageSearch({
  active,
  messages,
  setMessages,
  setHasMoreBefore,
  activeRef,
}: UseMessageSearchParams) {
  const queryClient = useQueryClient();
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
  /** Tin gốc vừa được nhảy tới từ một khối trích dẫn — tô sáng tạm để mắt bắt được vị trí. */
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  /** Handle cuộn của MessageScroller (component con trong ChatPanel giữ vào đây). */
  const scrollerRef = useRef<ScrollerHandle | null>(null);

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
      const page = await queryClient.fetchQuery(conversationMessagesPageQueryOptions(active.id, seq + 1));
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
      const res = await queryClient.fetchQuery(messageSearchQueryOptions(conversationId, q));
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

  return {
    messageSearch,
    highlightedMessageId,
    scrollerRef,
    jumpToMessage,
    jumpToQuotedMessage,
    runMessageSearch,
    clearMessageSearch,
  };
}

/**
 * Hook điều phối tìm trong hội thoại của trang Tin nhắn (đợt C của
 * issue #223, lát 2; chuyển sang cache TanStack ở CN-13, issue
 * #493): một lượt tìm là một ĐĂNG KÝ trên cache — state cục bộ chỉ
 * giữ (conversation, từ khoá) đã gửi, kết quả/trạng thái tải/lỗi
 * đều đọc từ query tương ứng trong cache; nhảy tới tin dùng đường
 * nạp trang của hook hội thoại đang mở (trang về cache rồi cửa sổ
 * hiển thị tự suy ra). Giữ nguyên cơ chế: tin đích đang có thì
 * cuộn ngay + tô sáng tạm; chưa tải thì xin cửa sổ quanh vị trí
 * của nó bằng đúng cơ chế phân trang hiện có rồi mới cuộn; tin
 * đích không còn hiển thị được thì dừng êm.
 *
 * @param params - `active` là conversation đang mở; `messages` là
 * cửa sổ tin hiện tại; `ensurePageLoaded` nạp một cửa sổ theo mốc
 * seq vào cache khi nhảy tới tin chưa có.
 * @returns Trạng thái tìm kiếm và handler cho trang lắp ghép.
 */
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { messageSearchQueryOptions } from '#lib/messaging-data';
import { queryKeys } from '#lib/query-keys';
import type { ConversationView, MessageQuoteView, MessageSearchResultView, MessageView, ScrollerHandle } from './types';

export interface UseMessageSearchParams {
  /** Conversation đang mở (null khi chưa chọn). */
  active: ConversationView | null;
  /** Cửa sổ tin hiện tại của conversation đang mở. */
  messages: MessageView[];
  /** Nạp một cửa sổ tin theo mốc beforeSeq vào cache (của hook hội thoại đang mở). */
  ensurePageLoaded: (beforeSeq: number) => Promise<{ messages: MessageView[]; hasMoreBefore: boolean } | null>;
}

/** Trạng thái trống của một lượt tìm (chưa gửi hoặc đã xoá). */
const EMPTY_SEARCH: {
  query: string;
  results: MessageSearchResultView[];
  loading: boolean;
  failed: boolean;
  submitted: boolean;
} = { query: '', results: [], loading: false, failed: false, submitted: false };

export function useMessageSearch({ active, messages, ensurePageLoaded }: UseMessageSearchParams) {
  const queryClient = useQueryClient();
  /**
   * Tìm nội dung tin trong conversation đang mở (lát M4, issue
   * #237): state chỉ giữ (conversation, từ khoá) của lượt tìm đã
   * gửi — kết quả server trả (chỉ tin còn hiển thị được với mình),
   * cờ đang tải và cờ lỗi đọc từ query trong cache. Đổi
   * conversation là xoá trắng (xử lý ở `open`); kết quả của
   * conversation khác với conversation đang mở không bao giờ hiện
   * (điều kiện suy ra ở dưới).
   */
  const [submitted, setSubmitted] = useState<{ conversationId: string; q: string } | null>(null);
  const searchQuery = useQuery({
    ...messageSearchQueryOptions(submitted?.conversationId ?? '', submitted?.q ?? ''),
    enabled: !!submitted,
  });
  const messageSearch =
    submitted && active && submitted.conversationId === active.id
      ? {
          query: submitted.q,
          results: searchQuery.data?.results ?? [],
          loading: searchQuery.isFetching,
          failed: searchQuery.isError,
          submitted: true,
        }
      : EMPTY_SEARCH;
  /** Tin gốc vừa được nhảy tới từ một khối trích dẫn — tô sáng tạm để mắt bắt được vị trí. */
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  /** Handle cuộn của MessageScroller (component con trong ChatPanel giữ vào đây). */
  const scrollerRef = useRef<ScrollerHandle | null>(null);

  /**
   * Nhảy tới MỘT tin theo (id, seq) — cơ chế chung của lát M3 (khối
   * trích dẫn) và lát M4 (kết quả tìm): tin đang có trong danh sách
   * thì cuộn ngay + tô sáng tạm; chưa tải thì xin cửa sổ quanh vị trí
   * của nó bằng ĐÚNG cơ chế phân trang hiện có (beforeSeq = seq + 1
   * → cửa sổ kết thúc tại tin đích), nạp vào cache rồi mới cuộn.
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
      const page = await ensurePageLoaded(seq + 1);
      if (page && page.messages.some((m) => m.id === messageId)) scrollAndHighlight();
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
   * êm (không bắn request chắc chắn bị 400). Gửi lại đúng từ khoá
   * đang có thì nạp lại query trong cache để kết quả luôn tươi.
   */
  async function runMessageSearch(rawQuery: string) {
    if (!active) return;
    const q = rawQuery.trim();
    if (!q) {
      setSubmitted(null);
      return;
    }
    if (submitted && submitted.conversationId === active.id && submitted.q === q) {
      await queryClient.refetchQueries({ queryKey: queryKeys.messagingSearch(active.id, q) });
      return;
    }
    setSubmitted({ conversationId: active.id, q });
  }

  /** Xoá lượt tìm hiện tại (lát M4) — khung tin trở về nguyên trạng. */
  function clearMessageSearch() {
    setSubmitted(null);
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

/**
 * Hook điều phối soạn và gửi tin của trang Tin nhắn (đợt C của
 * issue #223, lát 2): sở hữu nháp theo từng conversation, đích trả
 * lời trích dẫn, lỗi gửi và tập conversation đang gửi, cùng các
 * thao tác đẩy tin lạc quan, gửi, gửi lại và phát tín hiệu đang
 * nhập. Di chuyển từ `pages/messages.tsx` (dòng 270–293, 387–397 và
 * khoảng 1.000–1.142), giữ nguyên kỷ luật: gửi LẠC QUAN với
 * clientMessageId (server chống trùng — thử lại không nhân đôi);
 * khoá idempotency sinh một lần cho một bản nháp và chỉ bỏ khi lượt
 * gửi đã có kết quả; lượt gửi trùng cho cùng conversation bị bỏ qua
 * ngay tại ref.
 *
 * @param params - `active` là conversation đang mở; `myId` là người
 * gửi; `addLocalMessage`/`setLocalMessageStatus` để đẩy và đổi
 * trạng thái tin lạc quan (state chỉ-client của hook hội thoại
 * đang mở); `mergeServerMessages` để gộp tin thật vào cache chi
 * tiết; `lastSeqRef` là mốc seq dùng chung do trang sở hữu;
 * `realtimeRef` để phát tín hiệu đang nhập qua socket.
 * @returns Trạng thái soạn tin và handler cho trang lắp ghép.
 */
import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { MESSAGING_MAX_MESSAGE_LENGTH_DEFAULT } from '@lms/contracts';
import { ApiError } from '#lib/api';
import { useSendMessage } from '#lib/messaging-data';
import type { MessagingRealtimeHandle } from '#lib/messaging-socket';
import { countMessageCharacters, localQuoteOf } from './utils';
import type { ConversationView, MessageQuoteView, MessageView } from './types';

export interface UseMessageComposerParams {
  /** Conversation đang mở (null khi chưa chọn). */
  active: ConversationView | null;
  /** Id người xem hiện tại (người gửi). */
  myId: string | undefined;
  /** Đẩy/cập nhật một tin lạc quan (state chỉ-client của hook hội thoại đang mở). */
  addLocalMessage: (message: MessageView) => void;
  /** Đổi trạng thái tin lạc quan theo clientMessageId (đang gửi/đã lỗi). */
  setLocalMessageStatus: (conversationId: string, clientMessageId: string, status: 'sending' | 'failed') => void;
  /** Gộp tin thật vào cache chi tiết của đúng conversation. */
  mergeServerMessages: (conversationId: string, messages: MessageView[]) => void;
  /** Mốc seq cao nhất đã thấy của từng conversation — trang sở hữu chung. */
  lastSeqRef: { current: Map<string, number> };
  /** Handle socket realtime — trang sở hữu chung, hook realtime gán vào. */
  realtimeRef: { current: MessagingRealtimeHandle | null };
}

export function useMessageComposer({
  active,
  myId,
  addLocalMessage,
  setLocalMessageStatus,
  mergeServerMessages,
  lastSeqRef,
  realtimeRef,
}: UseMessageComposerParams) {
  const { t } = useTranslation('app');
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
  /**
   * Lỗi gửi phải nói rõ lý do (lát M2, issue #212): vượt trần ký tự
   * (400) hay gửi quá nhanh (429) hiện thành thông báo cạnh composer
   * thay vì chỉ để tin rơi vào trạng thái failed câm như trước.
   */
  const [sendError, setSendError] = useState<string | null>(null);
  const sendMessageMutation = useSendMessage();
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
   * Đẩy một tin lạc quan lên cuối và gửi thật; xác nhận của server (REST hoặc socket) thay bản tạm theo clientMessageId.
   * Tin TRẢ LỜI (lát M3) mang kèm `replyToMessageId` + khối trích dẫn
   * lạc quan dựng tại client; bản thật của server (đã dựng lại quote
   * theo quyền) thay thế nguyên vẹn khi về.
   */
  async function deliver(
    conversationId: string,
    text: string,
    clientMessageId: string,
    quote?: { replyToMessageId: string; replyTo: MessageQuoteView } | null,
  ) {
    if (!myId) return;
    addLocalMessage({
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
    });
    try {
      const saved = await sendMessageMutation.mutateAsync({
        conversationId,
        body: {
          text,
          clientMessageId,
          ...(quote ? { replyToMessageId: quote.replyToMessageId } : {}),
        },
      });
      const seen = lastSeqRef.current.get(conversationId) ?? 0;
      if (saved.seq > seen) lastSeqRef.current.set(conversationId, saved.seq);
      // Tin thật gộp vào cache chi tiết qua mergeServerMessages —
      // cùng lượt đó bản tạm được dọn khỏi state lạc quan theo
      // clientMessageId (vòng đời bản tạm kết thúc tại xác nhận).
      // Xem trước danh sách
      // (tin cuối + đưa conversation lên đầu — lát M1, issue #204)
      // do chính đột biến gửi tin vá vào cache danh sách ở tầng dữ
      // kiện, không chờ sự kiện conversation.updated qua socket.
      mergeServerMessages(conversationId, [saved]);
    } catch (err) {
      // Hai lỗi có mã riêng của lát M2 phải hiện thành câu chữ rõ
      // ràng cạnh composer (kèm trạng thái failed để thử lại được);
      // lỗi khác giữ hành vi cũ (chỉ đánh dấu failed).
      if (err instanceof ApiError && err.problem.code === 'messaging.message_too_long') {
        setSendError(t('messageTooLong', { max: MESSAGING_MAX_MESSAGE_LENGTH_DEFAULT }));
      } else if (err instanceof ApiError && err.problem.code === 'messaging.rate_limited') {
        setSendError(t('messageRateLimited'));
      }
      setLocalMessageStatus(conversationId, clientMessageId, 'failed');
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
        active.id,
        text,
        clientMessageId,
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
    setLocalMessageStatus(active.id, message.clientMessageId, 'sending');
    await deliver(
      active.id,
      message.fullMessage,
      message.clientMessageId,
      message.replyToMessageId && message.replyTo
        ? { replyToMessageId: message.replyToMessageId, replyTo: message.replyTo }
        : null,
    );
  }

  /** Phát tín hiệu đang nhập, throttle 3 giây ở client (server còn throttle thêm theo cửa sổ Redis). */
  function noteTyping() {
    if (!active) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current < 3000) return;
    lastTypingSentRef.current = now;
    realtimeRef.current?.typing(active.id);
  }

  /** Xoá lỗi gửi khi mở conversation mới — phần đặt lại phía composer của trình bao `open` ở trang. */
  function resetComposerForOpen() {
    setSendError(null);
  }

  /** Nháp đang hiện ở composer: nháp của conversation đang mở (lát M1). */
  const draft = active ? (drafts[active.id] ?? '') : '';
  /** Đích trích dẫn đang chờ gửi của conversation đang mở (lát M3). */
  const replyTarget = active ? (replyTargets[active.id] ?? null) : null;

  return {
    drafts,
    setDrafts,
    replyTargets,
    setReplyTargets,
    sendError,
    sendingConversationIds,
    send,
    retrySend,
    noteTyping,
    resetComposerForOpen,
    draft,
    replyTarget,
  };
}

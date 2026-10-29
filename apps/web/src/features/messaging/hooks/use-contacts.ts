/**
 * Hook điều phối danh bạ, kết bạn và bộ chọn người của trang Tin
 * nhắn (đợt C của issue #223, lát 3; chuyển sang cache TanStack ở
 * CN-13, issue #493): danh bạ đã duyệt, hàng chờ kết bạn và danh
 * sách đã chặn là dữ kiện máy chủ — đọc trực tiếp từ cache qua
 * useQuery; các trang roster của bộ chọn người cũng là các query
 * trong cache theo khoá URL, state cục bộ chỉ còn ngữ cảnh đang
 * chọn + danh sách URL các trang đã xin (tiến độ nạp). Đột biến
 * quan hệ tự invalidate/vá cache ở tầng dữ kiện; vá quan hệ tại
 * chỗ trên roster dùng `setQueriesData` theo tiền tố khoá roster.
 * Giữ nguyên luồng Lớp B: danh bạ ĐÃ DUYỆT + hàng chờ kết bạn
 * (đến/đi) thay danh bạ một chiều cũ; điểm vào kết bạn là dòng
 * roster và hàng chờ, không còn tìm theo tên hay form nhập UUID
 * thô.
 *
 * @param params - `reload` nạp lại danh sách sau khi quan hệ đổi;
 * `open` mở conversation (trang nối qua callback dùng-chung);
 * `patchPanelRelationship` phản ánh quan hệ lên panel thành viên
 * (trang nối qua callback dùng-chung); `groupTree` để suy các lớp
 * cho bộ chọn người; `mergePeople` gom tên hiển thị từ roster.
 * @returns Trạng thái danh bạ và handler cho trang lắp ghép.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { messagingBlockedContactsQueryOptions, messagingContactRequestsQueryOptions, messagingContactsQueryOptions, rosterPageQueryOptions, useCreateDirectConversation, useRespondContactRequest, useSendContactRequest, useSetContactBlocked } from '../queries/messaging';
import { queryKeys } from '../queries/keys';
import type {
  ContactRelationship,
  ConversationGroupTreeView,
  ConversationView,
  PeoplePickerContext,
  PersonSummary,
  RosterMember,
} from '../types/types';

export interface UseContactsParams {
  /** Nạp lại danh sách sau khi quan hệ kết bạn đổi (từ hook danh sách). */
  reload: () => Promise<void>;
  /** Mở conversation (trang nối qua callback dùng-chung). */
  open: (conv: ConversationView) => Promise<void> | void;
  /** Phản ánh quan hệ lên panel thành viên (trang nối qua callback dùng-chung). */
  patchPanelRelationship: (userId: string, relationship: ContactRelationship) => void;
  /** Cây nhóm của tôi — nguồn các lớp cho bộ chọn người. */
  groupTree: ConversationGroupTreeView | null;
  /** Gom tên hiển thị từ roster vào bản đồ tên chung. */
  mergePeople: (profiles: Record<string, PersonSummary> | undefined) => void;
}

export function useContacts({ reload, open, patchPanelRelationship, groupTree, mergePeople }: UseContactsParams) {
  const { t } = useTranslation('app');
  const queryClient = useQueryClient();
  // Lớp B (issue #33): danh bạ ĐÃ DUYỆT + hàng chờ kết bạn (đến/đi),
  // thay danh bạ một chiều cũ — cả ba đều đọc từ cache.
  const contactsQuery = useQuery(messagingContactsQueryOptions());
  const requestsQuery = useQuery(messagingContactRequestsQueryOptions());
  const blockedQuery = useQuery(messagingBlockedContactsQueryOptions());
  const contacts = contactsQuery.data?.contacts ?? [];
  const incomingRequests = requestsQuery.data?.incoming ?? [];
  const outgoingRequests = requestsQuery.data?.outgoing ?? [];
  const blocked = blockedQuery.data?.blocked ?? [];
  const [contactMessage, setContactMessage] = useState<string | null>(null);
  const [blockMessage, setBlockMessage] = useState<string | null>(null);

  // Hồ sơ kèm các đáp ứng danh bạ/đã chặn chảy vào bản đồ tên chung.
  useEffect(() => {
    mergePeople(contactsQuery.data?.profiles);
  }, [contactsQuery.data, mergePeople]);
  useEffect(() => {
    mergePeople(blockedQuery.data?.profiles);
  }, [blockedQuery.data, mergePeople]);

  /**
   * Bộ CHỌN NGƯỜI dùng chung của hai sheet Tin nhắn mới / Tạo nhóm
   * (lát MSG-T3): ngữ cảnh đang chọn + các URL trang roster đã xin
   * của ngữ cảnh đó. Roster lớp và roster khoá dùng chung một hình
   * dạng dòng nên một bộ trạng thái phục vụ cả hai sheet (chỉ một
   * sheet mở tại một thời điểm); dữ kiện từng trang nằm trong
   * cache theo khoá URL của trang.
   */
  const [pickerContext, setPickerContext] = useState<PeoplePickerContext>({ kind: 'contacts' });
  const [pickerUrls, setPickerUrls] = useState<string[]>([]);
  const pickerQueries = useQueries({ queries: pickerUrls.map((url) => rosterPageQueryOptions(url)) });
  const pickerMembers: RosterMember[] = pickerQueries.flatMap((q) => q.data?.members ?? []);
  /** Con trỏ trang kế: con trỏ của trang gần nhất đã có dữ kiện (trang lỗi chưa tính là đã qua). */
  let pickerCursor: string | null = null;
  for (const q of pickerQueries) {
    if (q.data) pickerCursor = q.data.nextCursor;
  }
  const pickerError = pickerQueries.some((q) => q.isError) ? t('rosterLoadFailed') : null;

  // Hồ sơ các dòng roster đã nạp chảy vào bản đồ tên chung — gác
  // bằng chữ ký tập userId để hiệu ứng không lặp vô hạn khi mảng
  // suy ra đổi danh tính mỗi lần render mà nội dung không đổi.
  const mergedPickerSigRef = useRef('');
  useEffect(() => {
    if (!pickerMembers.length) return;
    const sig = pickerMembers.map((m) => m.userId).join(',');
    if (sig === mergedPickerSigRef.current) return;
    mergedPickerSigRef.current = sig;
    mergePeople(Object.fromEntries(pickerMembers.map((m) => [m.userId, m])));
  }, [pickerMembers, mergePeople]);

  const contactBlockedMutation = useSetContactBlocked();
  const contactRequestMutation = useSendContactRequest();
  const respondRequestMutation = useRespondContactRequest();
  const directConversationMutation = useCreateDirectConversation();

  /** Chặn một liên hệ; danh sách đã chặn mới do đột biến vá thẳng vào cache từ đáp ứng. */
  async function blockContact(userId: string) {
    setBlockMessage(null);
    try {
      await contactBlockedMutation.mutateAsync({ userId, block: true });
      setBlockMessage(t('contactBlocked'));
    } catch {
      setBlockMessage(t('blockFailed'));
    }
  }

  /** Bỏ chặn một liên hệ; danh sách đã chặn mới do đột biến vá thẳng vào cache từ đáp ứng. */
  async function unblockContact(userId: string) {
    setBlockMessage(null);
    try {
      await contactBlockedMutation.mutateAsync({ userId, block: false });
      setBlockMessage(t('contactUnblocked'));
    } catch {
      setBlockMessage(t('unblockFailed'));
    }
  }

  /** Cập nhật trạng thái quan hệ của một dòng roster trong MỌI trang roster đang có ở cache ngay tại chỗ (không chờ tải lại). */
  const patchRosterRelationship = useCallback(
    (userId: string, relationship: ContactRelationship) => {
      queryClient.setQueriesData<{ members: RosterMember[]; nextCursor: string | null }>(
        { queryKey: ['messages', 'roster'] },
        (old) =>
          old ? { ...old, members: old.members.map((m) => (m.userId === userId ? { ...m, relationship } : m)) } : old,
      );
    },
    [queryClient],
  );

  /**
   * Gửi yêu cầu kết bạn tới một user (Lớp B: luồng yêu cầu–chấp nhận
   * thay danh bạ một chiều) — điểm vào là dòng ROSTER thành viên khoá
   * và hàng chờ kết bạn, không còn tìm theo tên hay form nhập UUID thô.
   */
  async function sendContactRequestTo(userId: string) {
    setContactMessage(null);
    try {
      const res = await contactRequestMutation.mutateAsync(userId);
      setContactMessage(res.status === 'accepted' ? t('contactRequestAccepted') : t('contactRequestSent'));
      // Phản ánh ngay lên dòng roster đang hiện, rồi đồng bộ lại toàn bộ.
      patchRosterRelationship(userId, res.status === 'accepted' ? 'contact' : 'pending_outgoing');
      patchPanelRelationship(userId, res.status === 'accepted' ? 'contact' : 'pending_outgoing');
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
    const base =
      context.kind === 'class'
        ? `/api/v1/messages/classes/${context.id}/members?limit=50`
        : `/api/v1/messages/courses/${context.id}/members?limit=50`;
    return cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base;
  }

  /** Chọn một ngữ cảnh trong bộ chọn người: liên hệ thì không nạp gì; lớp/khoá thì xin trang roster đầu (query trong cache tự nạp). */
  function openPickerContext(context: PeoplePickerContext) {
    setPickerContext(context);
    mergedPickerSigRef.current = '';
    const url = pickerRosterUrl(context);
    setPickerUrls(url ? [url] : []);
  }

  /** Tải trang roster tiếp theo của ngữ cảnh đang chọn; trang đã xin mà lỗi thì nạp lại đúng khoá của nó. */
  async function loadMorePicker() {
    if (!pickerCursor) return;
    const url = pickerRosterUrl(pickerContext, pickerCursor);
    if (!url) return;
    if (pickerUrls.includes(url)) {
      await queryClient.refetchQueries({ queryKey: queryKeys.messagingRosterPage(url) });
      return;
    }
    setPickerUrls((prev) => [...prev, url]);
  }

  /** Chấp nhận/từ chối một yêu cầu kết bạn đang chờ. */
  async function respondContactRequest(userId: string, action: 'accept' | 'decline') {
    setContactMessage(null);
    try {
      await respondRequestMutation.mutateAsync({ userId, action });
      patchRosterRelationship(userId, action === 'accept' ? 'contact' : 'none');
      patchPanelRelationship(userId, action === 'accept' ? 'contact' : 'none');
      await reload();
    } catch {
      setContactMessage(t('contactRequestFailed'));
    }
  }

  /** Mở cuộc trò chuyện 1-1 với một liên hệ đã duyệt. */
  async function messageContact(userId: string) {
    const conv = await directConversationMutation.mutateAsync(userId);
    await reload();
    await open(conv);
  }

  /** Các lớp của tôi cho ngữ cảnh theo lớp của bộ chọn người — lấy từ chính cây nhóm (lát MSG-T3). */
  const pickerClasses = groupTree?.classes.map((c) => ({ classId: c.classId, name: c.name })) ?? [];

  return {
    contacts,
    incomingRequests,
    outgoingRequests,
    contactMessage,
    blocked,
    blockMessage,
    pickerContext,
    pickerMembers,
    pickerCursor,
    pickerError,
    blockContact,
    unblockContact,
    patchRosterRelationship,
    sendContactRequestTo,
    pickerRosterUrl,
    openPickerContext,
    loadMorePicker,
    respondContactRequest,
    messageContact,
    pickerClasses,
  };
}

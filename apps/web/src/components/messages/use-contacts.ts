/**
 * Hook điều phối danh bạ, kết bạn và bộ chọn người của trang Tin
 * nhắn (đợt C của issue #223, lát 3): sở hữu danh bạ đã duyệt, hàng
 * chờ kết bạn, danh sách đã chặn và trạng thái bộ chọn người dùng
 * chung của hai sheet Tin nhắn mới / Tạo nhóm. Di chuyển từ
 * `pages/messages.tsx` (dòng 296–341, 552–574 và khoảng
 * 1.143–1.300), giữ nguyên luồng Lớp B: danh bạ ĐÃ DUYỆT + hàng chờ
 * kết bạn (đến/đi) thay danh bạ một chiều cũ; điểm vào kết bạn là
 * dòng roster và hàng chờ, không còn tìm theo tên hay form nhập
 * UUID thô.
 *
 * @param params - `reload` nạp lại danh sách sau khi quan hệ đổi;
 * `open` mở conversation (trang nối qua callback dùng-chung);
 * `patchPanelRelationship` phản ánh quan hệ lên panel thành viên
 * (trang nối qua callback dùng-chung); `groupTree` để suy các lớp
 * cho bộ chọn người; `mergePeople` gom tên hiển thị từ roster.
 * @returns Trạng thái danh bạ và handler cho trang lắp ghép.
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  rosterPageQueryOptions,
  useCreateDirectConversation,
  useRespondContactRequest,
  useSendContactRequest,
  useSetContactBlocked,
} from '#lib/messaging-data';
import type {
  ContactRelationship,
  ContactRequestView,
  ConversationGroupTreeView,
  ConversationView,
  PeoplePickerContext,
  PersonSummary,
  RosterMember,
} from './types';

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
  // thay danh bạ một chiều cũ.
  const [contacts, setContacts] = useState<string[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<ContactRequestView[]>([]);
  const [outgoingRequests, setOutgoingRequests] = useState<ContactRequestView[]>([]);
  const [contactMessage, setContactMessage] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [blockMessage, setBlockMessage] = useState<string | null>(null);
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

  const contactBlockedMutation = useSetContactBlocked();
  const contactRequestMutation = useSendContactRequest();
  const respondRequestMutation = useRespondContactRequest();
  const directConversationMutation = useCreateDirectConversation();

  /** Chặn một liên hệ; server trả về danh sách đã chặn mới để hiển thị ngay. */
  async function blockContact(userId: string) {
    setBlockMessage(null);
    try {
      const res = await contactBlockedMutation.mutateAsync({ userId, block: true });
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
      const res = await contactBlockedMutation.mutateAsync({ userId, block: false });
      setBlocked(res.blocked);
      setBlockMessage(t('contactUnblocked'));
    } catch {
      setBlockMessage(t('unblockFailed'));
    }
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

  /** Chọn một ngữ cảnh trong bộ chọn người: liên hệ thì không nạp gì; lớp/khoá thì nạp trang roster đầu. */
  async function openPickerContext(context: PeoplePickerContext) {
    setPickerContext(context);
    setPickerMembers([]);
    setPickerCursor(null);
    setPickerError(null);
    const url = pickerRosterUrl(context);
    if (!url) return;
    try {
      const res = await queryClient.fetchQuery(rosterPageQueryOptions(url));
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
      const res = await queryClient.fetchQuery(rosterPageQueryOptions(url));
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
    setContacts,
    incomingRequests,
    setIncomingRequests,
    outgoingRequests,
    setOutgoingRequests,
    contactMessage,
    blocked,
    setBlocked,
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

/**
 * Hook điều phối dữ liệu panel thành viên của trang Tin nhắn (đợt
 * C của issue #223, lát 3): sở hữu dòng thành viên của panel cho
 * conversation nhóm đang mở, hiệu ứng nạp roster theo ngữ cảnh và
 * việc lắp gói panel đưa xuống khung chat. Di chuyển từ
 * `pages/messages.tsx` (dòng 352–358, 580–666, 1.143–1.148 và khoảng
 * 1.506–1.517), giữ nguyên luật: roster lớp/khoá đọc HẾT các trang
 * con trỏ (trần 25 trang × 100 dòng); nhóm con lọc roster khoá theo
 * thành viên conversation; nhóm tự do dựng từ danh sách thành viên;
 * người đã chặn bị ẩn khỏi panel; entries chỉ lấy từ `panelData`
 * khi đúng conversation đang mở, đang nạp lại thì null để panel hiện
 * trạng thái đang tải thay vì dữ liệu của conversation trước.
 *
 * @param params - `active` là conversation đang mở; `groupTree` và
 * `myCourses` để suy ngữ cảnh roster; `conversations` để suy tập
 * đối tác 1–1; `contacts`/`incomingRequests`/`outgoingRequests`/
 * `blocked` để suy quan hệ và ẩn người đã chặn ở nhóm tự do;
 * `contactMessage` làm thông báo của panel; `nameOf`/`mergePeople`
 * từ hook danh sách; các handler mở/nhắn/kết bạn từ hook danh bạ;
 * `removeGroupMember` từ hook nhóm (trang nối qua callback
 * dùng-chung).
 * @returns Dữ liệu panel thành viên và handler cho trang lắp ghép.
 */
import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { rosterPageQueryOptions } from '#lib/messaging-data';
import { memberPanelContextOf } from './page-helpers';
import type { MemberPanelBundle } from './member-panel';
import type {
  ContactRelationship,
  ContactRequestView,
  ConversationGroupTreeView,
  ConversationView,
  MemberPanelEntry,
  MessagingCourse,
  PersonSummary,
  RosterMember,
} from './types';

export interface UseMemberPanelDataParams {
  /** Conversation đang mở (null khi chưa chọn). */
  active: ConversationView | null;
  /** Cây nhóm của tôi — nguồn tra khoá chứa nhóm con + tên lớp/khoá. */
  groupTree: ConversationGroupTreeView | null;
  /** Các khoá của tôi — nguồn tên khoá dự phòng. */
  myCourses: MessagingCourse[];
  /** Danh sách conversation — nguồn suy tập đối tác 1–1. */
  conversations: ConversationView[];
  /** Id người xem hiện tại. */
  myId: string | undefined;
  /** Danh bạ đã duyệt — nguồn suy quan hệ ở nhóm tự do. */
  contacts: string[];
  /** Hàng chờ kết bạn đến — nguồn suy quan hệ ở nhóm tự do. */
  incomingRequests: ContactRequestView[];
  /** Hàng chờ kết bạn đi — nguồn suy quan hệ ở nhóm tự do. */
  outgoingRequests: ContactRequestView[];
  /** Danh sách đã chặn — người đã chặn bị ẩn khỏi panel. */
  blocked: string[];
  /** Thông báo kết bạn gần nhất — panel hiển thị cùng. */
  contactMessage: string | null;
  /** Tên hiển thị của một user. */
  nameOf: (userId: string) => string;
  /** Gom tên hiển thị từ roster vào bản đồ tên chung. */
  mergePeople: (profiles: Record<string, PersonSummary> | undefined) => void;
  /** Mở cuộc trò chuyện 1–1 với một thành viên. */
  messageContact: (userId: string) => Promise<void>;
  /** Gửi yêu cầu kết bạn tới một thành viên. */
  sendContactRequestTo: (userId: string) => Promise<void>;
  /** Chấp nhận/từ chối một yêu cầu kết bạn. */
  respondContactRequest: (userId: string, action: 'accept' | 'decline') => Promise<void>;
  /** Gỡ một thành viên khỏi nhóm tự do (trang nối qua callback dùng-chung). */
  removeGroupMember: (userId: string) => Promise<void> | void;
}

export function useMemberPanelData({
  active,
  groupTree,
  myCourses,
  conversations,
  myId,
  contacts,
  incomingRequests,
  outgoingRequests,
  blocked,
  contactMessage,
  nameOf,
  mergePeople,
  messageContact,
  sendContactRequestTo,
  respondContactRequest,
  removeGroupMember,
}: UseMemberPanelDataParams) {
  const queryClient = useQueryClient();
  /**
   * Dòng thành viên của PANEL THÀNH VIÊN (lát MSG-T4) cho
   * conversation nhóm đang mở: nạp theo ngữ cảnh roster của
   * conversation (toàn bộ các trang roster lớp/khoá, lọc cho nhóm
   * con; dựng tại client cho nhóm tự do) và mang theo id của
   * conversation mà chúng thuộc về để không hiện nhầm dữ liệu của
   * conversation trước trong lúc nạp lại.
   */
  const [panelData, setPanelData] = useState<{
    conversationId: string;
    entries: MemberPanelEntry[] | null;
    failed: boolean;
  }>({ conversationId: '', entries: null, failed: false });
  /** Mốc làm mới panel — gỡ thành viên xong thì tăng để hiệu ứng nạp chạy lại. */
  const [panelRefreshTick, setPanelRefreshTick] = useState(0);

  /** Ngữ cảnh roster của panel thành viên cho conversation nhóm đang mở (lát MSG-T4). */
  const panelContext = active ? memberPanelContextOf(active, groupTree, myCourses) : null;
  const panelContextKey = !panelContext
    ? ''
    : panelContext.kind === 'free'
      ? 'free'
      : `${panelContext.kind}:${panelContext.id}:${panelContext.kind === 'course' && panelContext.subgroup ? 'sub' : 'whole'}`;

  // Nạp dòng thành viên cho panel thành viên (lát MSG-T4) mỗi khi
  // đổi conversation nhóm / đổi ngữ cảnh / có mốc làm mới: roster
  // lớp/khoá đọc HẾT các trang con trỏ (panel cần đủ hai nhóm
  // GV/HS cùng lúc, khác bộ chọn người chỉ nạp từng trang theo
  // thao tác); nhóm con lọc roster khoá theo thành viên của
  // conversation; nhóm tự do dựng từ danh sách thành viên + hồ sơ
  // kèm chi tiết conversation, quan hệ suy từ danh bạ/hàng chờ của
  // chính người xem, và người tôi đã chặn bị ẩn khỏi panel như mọi
  // bề mặt nhắn tin khác (luật chặn đã chốt).
  useEffect(() => {
    if (!active || active.type !== 2 || !panelContext) {
      setPanelData({ conversationId: '', entries: null, failed: false });
      return;
    }
    const conversationId = active.id;
    const context = panelContext;
    let cancelled = false;
    setPanelData({ conversationId, entries: null, failed: false });
    void (async () => {
      try {
        if (context.kind === 'free') {
          const relationshipOf = (id: string): ContactRelationship => {
            if (contacts.includes(id)) return 'contact';
            if (incomingRequests.some((r) => r.userId === id)) return 'pending_incoming';
            if (outgoingRequests.some((r) => r.userId === id)) return 'pending_outgoing';
            return 'none';
          };
          const entries: MemberPanelEntry[] = active.members
            .filter((id) => !blocked.includes(id))
            .map((id) => {
              const profile = active.memberProfiles?.[id];
              return {
                userId: id,
                displayName: profile?.displayName ?? nameOf(id),
                username: profile?.username ?? '',
                role: active.createdBy === id ? ('admin' as const) : ('member' as const),
                relationship: relationshipOf(id),
                canDirectMessage: false,
                isCreator: active.createdBy === id,
              };
            });
          if (!cancelled) setPanelData({ conversationId, entries, failed: false });
          return;
        }
        const base =
          context.kind === 'class'
            ? `/api/v1/messages/classes/${context.id}/members`
            : `/api/v1/messages/courses/${context.id}/members`;
        const all: RosterMember[] = [];
        let cursor: string | null = null;
        // Trần 25 trang × 100 dòng: đủ cho lớp/khoá thực tế; vượt
        // trần thì panel hiện phần đã nạp thay vì vòng lặp vô hạn.
        for (let page = 0; page < 25; page += 1) {
          const url: string = cursor ? `${base}?limit=100&cursor=${encodeURIComponent(cursor)}` : `${base}?limit=100`;
          const res = await queryClient.fetchQuery(rosterPageQueryOptions(url));
          all.push(...res.members);
          cursor = res.nextCursor;
          if (!cursor) break;
        }
        mergePeople(Object.fromEntries(all.map((m) => [m.userId, m])));
        const memberSet = new Set(active.members);
        const rows = context.kind === 'course' && context.subgroup ? all.filter((m) => memberSet.has(m.userId)) : all;
        const entries: MemberPanelEntry[] = rows.map((m) => ({
          userId: m.userId,
          displayName: m.displayName,
          username: m.username,
          role: m.role,
          relationship: m.relationship,
          canDirectMessage: m.canDirectMessage ?? false,
        }));
        if (!cancelled) setPanelData({ conversationId, entries, failed: false });
      } catch {
        if (!cancelled) setPanelData({ conversationId, entries: [], failed: true });
      }
    })();
    return () => {
      cancelled = true;
    };
    // Chạy theo id conversation + khoá ngữ cảnh + mốc làm mới; các
    // trạng thái quan hệ của nhóm tự do được đọc tại thời điểm chạy
    // và đồng bộ lại qua patch tại chỗ khi có hành động kết bạn —
    // cùng kỷ luật gác ref/deps chọn lọc như các hiệu ứng khác của trang.
    // Giữ disable CÓ CHỦ ĐÍCH cho react-hooks/exhaustive-deps:
    // hiệu ứng nạp roster khoá theo (id conversation, khoá ngữ
    // cảnh, mốc làm mới); các giá trị còn lại mà thân hiệu ứng đọc
    // (active, panelContext, danh bạ/hàng chờ/người đã chặn,
    // nameOf, mergePeople, queryClient) là ảnh chụp tại thời điểm
    // chạy. Đưa chúng vào mảng phụ thuộc sẽ nạp lại toàn bộ
    // roster (tới 25 trang) và đặt panel về trạng thái đang tải
    // mỗi khi đối tượng conversation đổi — ví dụ mỗi tin nhắn mới
    // trong nhóm — tức đổi hành vi người dùng thấy được, nên
    // không sửa mảng phụ thuộc tại điểm này.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, panelContextKey, panelRefreshTick]);

  /** Cập nhật trạng thái quan hệ của một dòng trong panel thành viên ngay tại chỗ (lát MSG-T4) — cùng kỷ luật với bộ chọn người. */
  const patchPanelRelationship = useCallback((userId: string, relationship: ContactRelationship) => {
    setPanelData((prev) =>
      prev.entries
        ? { ...prev, entries: prev.entries.map((e) => (e.userId === userId ? { ...e, relationship } : e)) }
        : prev,
    );
  }, []);

  /**
   * Tập người đã có hội thoại 1–1 với tôi (lát MSG-T4): căn cứ
   * nhánh "đã có hội thoại mở trước" của menu thành viên — phía
   * server vẫn tự kiểm lại `assertCanContact` khi mở/gửi.
   */
  const directPartnerIds = new Set<string>();
  for (const c of conversations) {
    if (c.type !== 1) continue;
    for (const memberId of c.members) {
      if (memberId !== myId) directPartnerIds.add(memberId);
    }
  }
  /**
   * Gói panel thành viên đưa xuống khung chat (lát MSG-T4): chỉ có
   * khi conversation đang mở là hội thoại nhóm và xác định được
   * ngữ cảnh roster; entries chỉ lấy từ `panelData` khi nó thuộc
   * đúng conversation này (đang nạp lại thì null → panel hiện trạng
   * thái đang tải thay vì dữ liệu của conversation trước).
   */
  const memberPanel: MemberPanelBundle | null =
    active && panelContext
      ? {
          context: panelContext,
          entries: panelData.conversationId === active.id ? panelData.entries : null,
          failed: panelData.conversationId === active.id && panelData.failed,
          notice: contactMessage,
          directPartnerIds,
          onMessageMember: (userId) => {
            void messageContact(userId);
          },
          onSendContactRequest: (userId) => {
            void sendContactRequestTo(userId);
          },
          onRespondContactRequest: (userId, action) => {
            void respondContactRequest(userId, action);
          },
          onRemoveMember: (userId) => {
            void removeGroupMember(userId);
          },
        }
      : null;

  return {
    panelData,
    panelRefreshTick,
    setPanelRefreshTick,
    panelContext,
    patchPanelRelationship,
    memberPanel,
  };
}

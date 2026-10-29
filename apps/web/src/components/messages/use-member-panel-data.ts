/**
 * Hook điều phối dữ liệu panel thành viên của trang Tin nhắn (đợt
 * C của issue #223, lát 3; chuyển sang cache TanStack ở CN-13,
 * issue #493): dòng thành viên của panel SUY RA từ cache — roster
 * lớp/khoá nằm trong cache theo khoá trang (hiệu ứng mồi nạp HẾT
 * các trang con trỏ vào cache, trần 25 trang × 100 dòng, luôn đọc
 * tươi từ server như trước), nhóm con lọc roster khoá theo thành
 * viên conversation, nhóm tự do dựng từ danh sách thành viên +
 * quan hệ đọc từ các query danh bạ trong cache; state cục bộ chỉ
 * còn TIẾN ĐỘ mồi (conversation + ngữ cảnh + các URL đã nạp + cờ
 * lỗi). Giữ nguyên luật: người đã chặn bị ẩn khỏi panel; entries
 * chỉ hiện khi tiến độ mồi thuộc đúng conversation đang mở, đang
 * mồi lại thì null để panel hiện trạng thái đang tải thay vì dữ
 * liệu của conversation trước.
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
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
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
   * TIẾN ĐỘ MỒI của PANEL THÀNH VIÊN (lát MSG-T4) cho conversation
   * nhóm đang mở: những URL trang roster đã nạp vào cache cho đúng
   * (conversation, ngữ cảnh) này + cờ lỗi + cờ đang mồi. Dữ kiện
   * dòng thành viên tự suy ra từ cache theo tiến độ này nên không
   * hiện nhầm dữ liệu của conversation trước trong lúc mồi lại.
   */
  const [panelPrime, setPanelPrime] = useState<{
    conversationId: string;
    contextKey: string;
    urls: string[];
    failed: boolean;
    priming: boolean;
  } | null>(null);
  /** Mốc làm mới panel — gỡ thành viên xong thì tăng để hiệu ứng mồi chạy lại. */
  const [panelRefreshTick, setPanelRefreshTick] = useState(0);

  /** Ngữ cảnh roster của panel thành viên cho conversation nhóm đang mở (lát MSG-T4). */
  const panelContext = active ? memberPanelContextOf(active, groupTree, myCourses) : null;
  const panelContextKey = !panelContext
    ? ''
    : panelContext.kind === 'free'
      ? 'free'
      : `${panelContext.kind}:${panelContext.id}:${panelContext.kind === 'course' && panelContext.subgroup ? 'sub' : 'whole'}`;

  // Mồi roster cho panel thành viên (lát MSG-T4) mỗi khi đổi
  // conversation nhóm / đổi ngữ cảnh / có mốc làm mới: roster
  // lớp/khoá đọc HẾT các trang con trỏ THẲNG từ server vào cache
  // (panel cần đủ hai nhóm GV/HS cùng lúc, khác bộ chọn người chỉ
  // nạp từng trang theo thao tác; `staleTime: 0` ở lời mồi giữ
  // đúng kỷ luật luôn-đọc-tươi của panel như trước khi chuyển
  // cache); nhóm tự do không có roster — tiến độ mồi xong ngay,
  // entries dựng tại bước suy ra từ danh bạ/hàng chờ trong cache.
  useEffect(() => {
    if (!active || active.type !== 2 || !panelContext) {
      setPanelPrime(null);
      return;
    }
    const conversationId = active.id;
    const context = panelContext;
    const contextKey = panelContextKey;
    let cancelled = false;
    if (context.kind === 'free') {
      setPanelPrime({ conversationId, contextKey, urls: [], failed: false, priming: false });
      return;
    }
    setPanelPrime({ conversationId, contextKey, urls: [], failed: false, priming: true });
    void (async () => {
      const base =
        context.kind === 'class'
          ? `/api/v1/messages/classes/${context.id}/members`
          : `/api/v1/messages/courses/${context.id}/members`;
      const urls: string[] = [];
      let cursor: string | null = null;
      try {
        // Trần 25 trang × 100 dòng: đủ cho lớp/khoá thực tế; vượt
        // trần thì panel hiện phần đã nạp thay vì vòng lặp vô hạn.
        for (let page = 0; page < 25; page += 1) {
          const url: string = cursor ? `${base}?limit=100&cursor=${encodeURIComponent(cursor)}` : `${base}?limit=100`;
          const res = await queryClient.fetchQuery({ ...rosterPageQueryOptions(url), staleTime: 0 });
          urls.push(url);
          cursor = res.nextCursor;
          if (!cursor) break;
        }
        if (!cancelled) setPanelPrime({ conversationId, contextKey, urls, failed: false, priming: false });
      } catch {
        if (!cancelled) setPanelPrime({ conversationId, contextKey, urls, failed: true, priming: false });
      }
    })();
    return () => {
      cancelled = true;
    };
    // Chạy theo id conversation + khoá ngữ cảnh + mốc làm mới; các
    // giá trị còn lại mà thân hiệu ứng đọc (active, panelContext,
    // queryClient) là ảnh chụp tại thời điểm chạy, chỉ dùng để xác
    // định (conversation, ngữ cảnh) và đường roster của lần mồi đó.
    // Giữ disable CÓ CHỦ ĐÍCH cho react-hooks/exhaustive-deps:
    // hiệu ứng mồi roster chạy theo (id conversation, khoá ngữ
    // cảnh, mốc làm mới). Đưa các giá trị ảnh chụp vào mảng phụ
    // thuộc sẽ mồi lại toàn bộ roster (tới 25 trang) và đặt panel
    // về trạng thái đang tải mỗi khi đối tượng conversation đổi —
    // ví dụ mỗi tin nhắn mới trong nhóm — tức đổi hành vi người
    // dùng thấy được, nên không sửa mảng phụ thuộc tại điểm này.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, panelContextKey, panelRefreshTick]);

  /** Tiến độ mồi thuộc đúng (conversation, ngữ cảnh) đang mở — không thuộc thì panel đang tải (null). */
  const prime =
    active && panelContext && panelPrime && panelPrime.conversationId === active.id && panelPrime.contextKey === panelContextKey
      ? panelPrime
      : null;
  const panelQueries = useQueries({
    queries: (prime && !prime.priming ? prime.urls : []).map((url) => rosterPageQueryOptions(url)),
  });

  // Hồ sơ các dòng roster đã nạp chảy vào bản đồ tên chung — gác
  // bằng chữ ký tập userId để hiệu ứng không lặp khi mảng kết quả
  // đổi danh tính mỗi lần render mà nội dung không đổi.
  const mergedPanelSigRef = useRef('');
  useEffect(() => {
    const members = panelQueries.flatMap((q) => q.data?.members ?? []);
    if (!members.length) return;
    const sig = members.map((m) => m.userId).join(',');
    if (sig === mergedPanelSigRef.current) return;
    mergedPanelSigRef.current = sig;
    mergePeople(Object.fromEntries(members.map((m) => [m.userId, m])));
  }, [panelQueries, mergePeople]);

  /**
   * Dòng thành viên của panel — SUY RA từ cache + quan hệ hiện
   * hành: chưa mồi xong (hoặc mồi của conversation/ngữ cảnh khác)
   * thì null (đang tải); mồi lỗi thì rỗng + cờ failed ở gói panel;
   * nhóm tự do dựng từ thành viên của conversation (người đã chặn
   * bị ẩn như mọi bề mặt nhắn tin khác — luật chặn đã chốt), quan
   * hệ suy từ danh bạ/hàng chờ của chính người xem; roster lớp/khoá
   * lấy từ các trang trong cache, nhóm con lọc theo thành viên
   * conversation.
   */
  let panelEntries: MemberPanelEntry[] | null = null;
  if (active && panelContext && prime && !prime.priming) {
    if (prime.failed) {
      panelEntries = [];
    } else if (panelContext.kind === 'free') {
      const relationshipOf = (id: string): ContactRelationship => {
        if (contacts.includes(id)) return 'contact';
        if (incomingRequests.some((r) => r.userId === id)) return 'pending_incoming';
        if (outgoingRequests.some((r) => r.userId === id)) return 'pending_outgoing';
        return 'none';
      };
      panelEntries = active.members
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
    } else if (panelQueries.every((q) => q.data)) {
      const all: RosterMember[] = panelQueries.flatMap((q) => q.data!.members);
      const memberSet = new Set(active.members);
      const rows =
        panelContext.kind === 'course' && panelContext.subgroup ? all.filter((m) => memberSet.has(m.userId)) : all;
      panelEntries = rows.map((m) => ({
        userId: m.userId,
        displayName: m.displayName,
        username: m.username,
        role: m.role,
        relationship: m.relationship,
        canDirectMessage: m.canDirectMessage ?? false,
      }));
    }
  }

  /** Cập nhật trạng thái quan hệ của một dòng trong MỌI trang roster đang có ở cache ngay tại chỗ (lát MSG-T4) — cùng kỷ luật với bộ chọn người; dòng của nhóm tự do tự suy lại từ danh bạ/hàng chờ trong cache. */
  const patchPanelRelationship = useCallback(
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
   * ngữ cảnh roster; entries chỉ lấy khi tiến độ mồi thuộc đúng
   * conversation này (đang mồi lại thì null → panel hiện trạng
   * thái đang tải thay vì dữ liệu của conversation trước).
   */
  const memberPanel: MemberPanelBundle | null =
    active && panelContext
      ? {
          context: panelContext,
          entries: panelEntries,
          failed: !!prime && prime.failed,
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
    panelRefreshTick,
    setPanelRefreshTick,
    panelContext,
    patchPanelRelationship,
    memberPanel,
  };
}

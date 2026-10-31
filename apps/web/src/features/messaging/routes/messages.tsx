import { useCallback, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import '#config/i18n';
import { useAuth } from '#lib/auth';
import type { MessagingRealtimeHandle } from '../api/messaging-socket';
import { PageShell } from '#components/page-shell';
import { ChatPanel } from '../components/chat-panel';
import { ConversationSidebar } from '../components/conversation-sidebar';
import type { SelfPresenceChoice } from '../components/own-profile-sheet';
import { useConversationList } from '../hooks/use-conversation-list';
import { useConversationRestore } from '../hooks/use-conversation-restore';
import { useActiveConversation } from '../hooks/use-active-conversation';
import { useMessageComposer } from '../hooks/use-message-composer';
import { useMessageSearch } from '../hooks/use-message-search';
import { useMessagesRealtime } from '../hooks/use-messages-realtime';
import { useContacts } from '../hooks/use-contacts';
import { useGroupActions } from '../hooks/use-group-actions';
import { useMessageModeration } from '../hooks/use-message-moderation';
import { useMemberPanelData } from '../hooks/use-member-panel-data';
import type { ContactRelationship, ConversationView } from '../types/types';

/**
 * Tin nhắn: danh sách cuộc trò chuyện với số chưa đọc, luồng tin nhắn và
 * việc gửi. Tin nhắn hiển thị/gửi theo mô hình mới (issue #33): seq
 * đơn điệu theo conversation là mốc phân trang/đồng bộ; gửi LẠC QUAN
 * với clientMessageId (server chống trùng — thử lại không nhân đôi);
 * tin mới/đã đọc đến qua WebSocket (sự kiện được server phân phối từ
 * outbox), huy hiệu chưa đọc cập nhật theo sự kiện thay vì tải lại
 * toàn bộ; mất nối thì khi nối lại trang xin phần thiếu theo seq.
 * Trang còn quản lý chặn liên lạc: chặn/bỏ chặn người đối thoại trong
 * cuộc trò chuyện đang mở và xem danh sách đã chặn
 * (GET/POST/DELETE /messages/contacts...). Deep-link
 * ?conversation=<id> (contextUrl của thông báo message_new, #49) mở
 * đúng cuộc trò chuyện khi trang nạp — việc nối tiếp của #33.
 *
 * Cấu trúc khung trái: thanh tab bốn tab lọc ngang hàng như
 * bản demo (Tất cả / Chưa đọc / Nhóm / Yêu thích, issue #606) —
 * tab Tất cả gồm MỌI hội thoại chưa lưu trữ (1–1 lẫn nhóm) và
 * tab Chưa đọc gồm mọi hội thoại còn tin chưa đọc ở cả hai
 * loại; tab Nhóm là danh sách phẳng các mục nhóm dựng từ API
 * cây của MSG-T1, Danh bạ hạ thành sheet "Tin nhắn mới". Tab
 * đang chọn + hội thoại đang mở được LƯU BỀN ở localStorage
 * (hai khoá trong `page-helpers.ts`) để quay lại màn Tin nhắn
 * là gặp đúng ngữ cảnh gần nhất; deep-link có mặt thì thắng
 * ngữ cảnh đã lưu.
 *
 * Cấu trúc sau đợt C (issue #363): file này chỉ còn lắp ghép — mọi
 * trạng thái, hiệu ứng và handler điều phối nằm trong các hook ở
 * `components/messages/` (danh sách, khôi phục ngữ cảnh, hội thoại
 * đang mở, soạn/gửi, tìm kiếm, realtime, danh bạ, panel thành viên,
 * nhóm, kiểm duyệt) và các hàm thuần ở `page-helpers.ts`.
 */

/**
 * Callback dùng-chung "gán muộn" cho vòng phụ thuộc chéo giữa các
 * hook điều phối: hook sở hữu một hàm (ví dụ `open`,
 * `applyReadMarker`) có thể được tạo SAU hook cần dùng hàm đó, nên
 * trang tạo trước một hàm ổn định ủy quyền qua ref, rồi gán triển
 * khai thật ngay sau khi hook sở hữu được tạo — vẫn trong cùng lượt
 * render, trước mọi hiệu ứng và xử lý sự kiện, nên mọi lời gọi đều
 * thấy triển khai mới nhất.
 * Chỉ dùng cho đúng các điểm chéo đã liệt kê ở thân component; các
 * hook khác nhận trực tiếp giá trị trả về của hook đã tạo trước.
 *
 * @returns Cặp [hàm ổn định để truyền xuống, hàm gán triển khai thật].
 */
function useLateCallback<Fn extends (...args: any[]) => any>() {
  const ref = useRef<Fn | null>(null);
  const call = useCallback((...args: Parameters<Fn>): ReturnType<Fn> | undefined => {
    return ref.current?.(...args) as ReturnType<Fn> | undefined;
  }, []);
  const assign = useCallback((fn: Fn) => {
    ref.current = fn;
  }, []);
  return [call, assign] as const;
}

export function MessagesPage() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const myId = user?.id;
  /**
   * Mức hiện diện người xem tự chọn cho chính mình (giai đoạn 2
   * của vòng sửa PR #610): mặc định online. Chọn offline thì
   * trang KHÔNG nối socket realtime — server gỡ presence nên
   * trạng thái ngoại tuyến là THẬT ở mọi bề mặt; chọn lại online
   * thì nối lại và nạp lại danh sách để lấp phần đã lỡ trong lúc
   * ngoại tuyến. Lựa chọn chỉ sống trong phiên trang (chưa có dữ
   * kiện backend cho tuỳ chọn này).
   */
  const [selfPresence, setSelfPresence] = useState<SelfPresenceChoice>('online');
  /** Handle socket realtime — hook realtime gán vào, hook soạn tin đọc ra. */
  const realtimeRef = useRef<MessagingRealtimeHandle | null>(null);
  /** Seq cao nhất đã thấy của từng conversation — mốc xin đồng bộ khi nối lại, bốn hook cùng dùng. */
  const lastSeqRef = useRef<Map<string, number>>(new Map());

  // Các callback dùng-chung (xem `useLateCallback` ở trên): hàm ổn
  // định truyền xuống hook cần dùng, triển khai thật gán ngay sau khi
  // hook sở hữu được tạo trong thân component này.
  const [openCall, assignOpen] = useLateCallback<(conv: ConversationView) => Promise<void>>();
  const [applyReadMarkerCall, assignApplyReadMarker] =
    useLateCallback<(conversationId: string, userId: string, lastReadSeq: number) => void>();
  const [patchPanelCall, assignPatchPanel] =
    useLateCallback<(userId: string, relationship: ContactRelationship) => void>();
  const [removeMemberCall, assignRemoveMember] = useLateCallback<(userId: string) => Promise<void>>();

  // Lát 1: danh sách + khôi phục ngữ cảnh (khôi phục cần `open` nên
  // gọi sau khi trình bao `open` đã gán ở cuối thân component).
  const list = useConversationList({
    myId,
    applyReadMarker: applyReadMarkerCall,
    lastSeqRef,
  });

  // Lát 2: hội thoại đang mở, soạn/gửi, tìm kiếm, realtime.
  const activeHook = useActiveConversation({
    mergePeople: list.mergePeople,
    markRead: list.markRead,
    myId,
    lastSeqRef,
    realtimeRef,
  });
  assignApplyReadMarker(activeHook.applyReadMarker);

  const composer = useMessageComposer({
    active: activeHook.active,
    myId,
    addLocalMessage: activeHook.addLocalMessage,
    setLocalMessageStatus: activeHook.setLocalMessageStatus,
    mergeServerMessages: activeHook.mergeServerMessages,
    lastSeqRef,
    realtimeRef,
  });

  const search = useMessageSearch({
    active: activeHook.active,
    messages: activeHook.messages,
    ensurePageLoaded: activeHook.ensurePageLoaded,
  });

  useMessagesRealtime({
    myId,
    markRead: list.markRead,
    recountUnread: list.recountUnread,
    reload: list.reload,
    activeRef: activeHook.activeRef,
    lastSeqRef,
    mergeServerMessages: activeHook.mergeServerMessages,
    patchMessages: activeHook.patchMessages,
    applyReadMarker: activeHook.applyReadMarker,
    invalidateConversationWindow: activeHook.invalidateConversationWindow,
    setConversations: list.setConversations,
    setGroupTree: list.setGroupTree,
    setTypingUsers: activeHook.setTypingUsers,
    setOnlineUsers: activeHook.setOnlineUsers,
    realtimeRef,
    suspendRealtime: selfPresence === 'offline',
  });

  // Lát 3: danh bạ, panel thành viên, nhóm, kiểm duyệt.
  const contacts = useContacts({
    reload: list.reload,
    open: openCall,
    patchPanelRelationship: patchPanelCall,
    groupTree: list.groupTree,
    mergePeople: list.mergePeople,
  });

  const memberPanel = useMemberPanelData({
    active: activeHook.active,
    groupTree: list.groupTree,
    myCourses: list.myCourses,
    conversations: list.conversations,
    myId,
    contacts: contacts.contacts,
    incomingRequests: contacts.incomingRequests,
    outgoingRequests: contacts.outgoingRequests,
    blocked: contacts.blocked,
    contactMessage: contacts.contactMessage,
    nameOf: list.nameOf,
    mergePeople: list.mergePeople,
    messageContact: contacts.messageContact,
    sendContactRequestTo: contacts.sendContactRequestTo,
    respondContactRequest: contacts.respondContactRequest,
    removeGroupMember: removeMemberCall,
  });
  assignPatchPanel(memberPanel.patchPanelRelationship);

  const groupActions = useGroupActions({
    active: activeHook.active,
    setConversations: list.setConversations,
    conversations: list.conversations,
    archivedConversations: list.archivedConversations,
    groupTree: list.groupTree,
    nameOf: list.nameOf,
    reload: list.reload,
    open: openCall,
    setPanelRefreshTick: memberPanel.setPanelRefreshTick,
  });
  assignRemoveMember(groupActions.removeGroupMember);

  const moderation = useMessageModeration({
    active: activeHook.active,
    myId,
    patchMessages: activeHook.patchMessages,
    setActionMessage: groupActions.setActionMessage,
  });

  // Trình bao `open` dùng chung: trước khi mở conversation mới thì
  // đặt lại các trạng thái theo-conversation của các hook khác
  // (lỗi gửi, lượt tìm, thông báo báo cáo/hành động) đúng như `open`
  // cũ trong file trang từng làm, rồi mới mở qua hook hội thoại.
  assignOpen(async (conv: ConversationView) => {
    composer.resetComposerForOpen();
    search.clearMessageSearch();
    groupActions.clearActionMessages();
    await activeHook.open(conv);
  });

  useConversationRestore({
    deepLinkId: searchParams.get('conversation'),
    listLoaded: list.listLoaded,
    conversations: list.conversations,
    setConversations: list.setConversations,
    open: openCall,
    sidebarTab: list.sidebarTab,
  });

  /**
   * Đổi tab khung trái (issue #608, điểm A-BS5): vào tab Nhóm
   * thì khung phải về trạng thái CHƯA CHỌN nếu hội thoại đang
   * mở không phải hội thoại nhóm — đúng hành vi của bản demo
   * (mở tab Nhóm lần đầu là thấy trạng thái rỗng, hội thoại chỉ
   * mở khi người dùng chọn trong cây). Đóng hội thoại ở đây
   * cũng xoá ngữ cảnh đã lưu bền như nút quay lại, nên quay lại
   * tab Trò chuyện không tự mở lại hội thoại cũ.
   */
  const handleSidebarTabChange = (tab: string) => {
    list.setSidebarTab(tab);
    if (tab === 'groups' && activeHook.active && activeHook.active.type !== 2) {
      activeHook.closeConversation();
    }
  };

  /**
   * Đổi mức hiện diện của chính người xem: về online thì nạp lại
   * danh sách hội thoại ngay (phần thay đổi trong lúc ngoại tuyến
   * không có kênh realtime nào mang tới); về offline chỉ cần đổi
   * trạng thái — hook realtime tự ngắt socket ở lượt hiệu ứng kế.
   */
  const handleSelfPresenceChange = (presence: SelfPresenceChoice) => {
    setSelfPresence(presence);
    if (presence === 'online') void list.reload().catch(() => undefined);
  };

  return (
    <PageShell fillHeight width="full" className="py-6 sm:px-6" contentClassName="mx-auto max-w-[1440px]">
      {/*
        Master–detail nhắn tin (issue #256) nằm TRONG vùng nội dung
        của khung app chung — sidebar + header của app giữ nguyên
        (quyết định 08:20 ngày 26/10/2026, sổ quyết định mục D).
        Desktop: hai khung cuộn độc lập; mobile: một khung tại một
        thời điểm, khung chat có nút quay lại (CSS thuần, cả hai
        khung luôn mounted).
      */}
      {/*
        Vùng chứa trang (issue #608): trần bề ngang 1440px và
        đệm của bản demo đạt ở chính tầng route này qua props
        của PageShell (đệm dọc 24px, đệm ngang 16px → 24px từ
        màn sm) và trần bề ngang của khối nội dung — PageShell
        dùng chung cho các trang khác không đổi. Thẻ khung chat
        bo góc 10px và có chiều cao tối thiểu 520px ở màn lg
        như demo; công thức chiều cao giữ theo vỏ app của hệ
        (đầu trang của vỏ khác demo nên số trừ khác).
      */}
      <div className="flex h-[calc(100dvh-5.5rem)] min-h-0 overflow-hidden rounded-lg border bg-background md:h-[calc(100dvh-7rem)] lg:min-h-[520px]">
        <div
          className={
            activeHook.active
              ? 'hidden min-h-0 w-full min-w-0 flex-col md:flex md:w-[304px] md:shrink-0 md:border-r lg:w-[360px]'
              : 'flex min-h-0 w-full min-w-0 flex-col md:w-[304px] md:shrink-0 md:border-r lg:w-[360px]'
          }
        >
          <ConversationSidebar
            conversations={list.conversations}
            archivedConversations={list.archivedConversations}
            onRequestArchived={() => void list.loadArchived()}
            groupTree={list.groupTree}
            active={activeHook.active}
            error={list.error}
            myId={myId}
            myEmail={user?.email ?? null}
            myUsername={user?.username ?? null}
            selfPresence={selfPresence}
            onSelfPresenceChange={handleSelfPresenceChange}
            onlineUsers={activeHook.onlineUsers}
            onOpenConversation={openCall}
            onOpenConversationById={(conversationId) => void groupActions.openConversationById(conversationId)}
            onOpenClassChat={(classId) => void groupActions.openClassChat(classId)}
            onOpenCourseChat={(courseId) => void groupActions.openCourseChat(courseId)}
            onOpenGroupConversation={(groupId) => void groupActions.openGroupConversation(groupId)}
            canCreateFreeGroup={groupActions.canCreateFreeGroup}
            onCreateFreeGroup={groupActions.createFreeGroup}
            groupCreateError={groupActions.groupCreateError}
            onUpdateConversationState={list.updateConversationState}
            stateError={list.stateError}
            nameOf={list.nameOf}
            tab={list.sidebarTab}
            onTabChange={handleSidebarTabChange}
            contacts={contacts.contacts}
            contactMessage={contacts.contactMessage}
            incomingRequests={contacts.incomingRequests}
            outgoingRequests={contacts.outgoingRequests}
            blocked={contacts.blocked}
            blockMessage={contacts.blockMessage}
            onMessageContact={contacts.messageContact}
            onSendContactRequest={contacts.sendContactRequestTo}
            onRespondContactRequest={contacts.respondContactRequest}
            onUnblockContact={contacts.unblockContact}
            pickerContext={contacts.pickerContext}
            onSelectPickerContext={(context) => void contacts.openPickerContext(context)}
            pickerClasses={contacts.pickerClasses}
            pickerCourses={list.myCourses}
            pickerMembers={contacts.pickerMembers}
            pickerRosterError={contacts.pickerError}
            pickerRosterCursor={contacts.pickerCursor}
            onLoadMorePicker={() => void contacts.loadMorePicker()}
            loading={!list.listLoaded && !list.error}
            groupTreeLoading={list.groupTreeLoading}
            groupTreeError={list.groupTreeError}
          />
        </div>
        <div className={activeHook.active ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden min-h-0 min-w-0 flex-1 flex-col md:flex'}>
          <ChatPanel
            active={activeHook.active}
            myId={myId}
            onlineUsers={activeHook.onlineUsers}
            readMarkers={activeHook.readMarkers}
            onBack={activeHook.closeConversation}
            blocked={contacts.blocked}
            onUnblockContact={contacts.unblockContact}
            onBlockContact={contacts.blockContact}
            onReportConversation={groupActions.reportActiveConversation}
            onToggleChat={groupActions.toggleActiveChat}
            reportMessage={groupActions.reportMessage}
            actionMessage={groupActions.actionMessage}
            hasMoreBefore={activeHook.hasMoreBefore}
            onLoadOlder={activeHook.loadOlder}
            selectedForBulk={moderation.selectedForBulk}
            setSelectedForBulk={moderation.setSelectedForBulk}
            onBulkRemove={moderation.bulkRemoveSelected}
            visibleMessages={activeHook.visibleMessages}
            nameOf={list.nameOf}
            onRetrySend={composer.retrySend}
            onDeleteMessage={moderation.deleteMessage}
            canRecall={moderation.canRecall}
            onRecallMessage={moderation.recallMessage}
            onHardDeleteMessage={moderation.hardDeleteMessage}
            onUpdateConversationState={list.updateConversationState}
            people={list.people}
            loading={!list.listLoaded && !list.error}
            typingNames={activeHook.typingNames}
            draft={composer.draft}
            setDrafts={composer.setDrafts}
            onNoteTyping={composer.noteTyping}
            onSend={composer.send}
            sendError={composer.sendError}
            sendInFlight={!!activeHook.active && composer.sendingConversationIds.has(activeHook.active.id)}
            replyTarget={composer.replyTarget}
            onStartReply={(m) => composer.setReplyTargets((prev) => ({ ...prev, [m.conversationId]: m }))}
            onCancelReply={() => {
              if (activeHook.active) composer.setReplyTargets((prev) => ({ ...prev, [activeHook.active!.id]: null }));
            }}
            onJumpToQuote={(quote) => void search.jumpToQuotedMessage(quote)}
            highlightedMessageId={search.highlightedMessageId}
            scrollerRef={search.scrollerRef}
            messageSearch={search.messageSearch}
            onSearchMessages={(q) => void search.runMessageSearch(q)}
            onClearMessageSearch={search.clearMessageSearch}
            onJumpToSearchResult={(result) => void search.jumpToMessage(result.id, result.seq)}
            memberPanel={memberPanel.memberPanel}
          />
        </div>
      </div>
    </PageShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default MessagesPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';
import { appKeyMeta } from '#lib/route-meta';
export function meta() {
  return appKeyMeta('navMessages');
}

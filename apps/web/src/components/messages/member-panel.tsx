import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Check, Info, MessageCircle, Trash, UserPlus, X } from 'lucide-react';
import { Avatar, AvatarFallback } from '@lms/ui/components/avatar';
import { Badge } from '@lms/ui/components/badge';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@lms/ui/components/dropdown-menu';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@lms/ui/components/sheet';
import { useTranslation } from 'react-i18next';
import type { ConversationView, MemberPanelContext, MemberPanelEntry } from './types';
import { initialsOf } from './utils';

/**
 * Panel THÀNH VIÊN + menu trên avatar/tên của khung chat nhóm (lát
 * MSG-T4, issue #33 — mục 4.3 của hồ sơ cấu trúc nhắn tin).
 *
 * Flow tổng thể:
 * 1. Trang Tin nhắn xác định NGỮ CẢNH ROSTER của conversation đang
 *    mở (lớp / khoá / nhóm con lọc theo roster khoá / nhóm tự do) và
 *    nạp sẵn các dòng thành viên ({@link MemberPanelEntry}) — server
 *    đã tính `relationship` + `canDirectMessage` cho roster lớp/khoá;
 *    nhóm tự do suy quan hệ từ danh bạ của chính người xem. File này
 *    CHỈ trình bày và phát sự kiện lên trang, không tự gọi API và
 *    không tự suy luật quan hệ nào khác.
 * 2. Panel (mở bằng nút Info ở header khung chat) gồm: thông tin
 *    nhóm (tên, loại, thuộc lớp/khoá nào, số thành viên) + công tắc
 *    Bật/Tắt chat khi người xem có thẩm quyền quản lý; rồi danh
 *    sách thành viên phân hai nhóm theo loại (Giáo viên/Học sinh
 *    cho nhóm cấu trúc, Quản trị viên/Thành viên cho nhóm tự do),
 *    mỗi dòng giữ chấm online và mốc đã xem như panel cũ.
 * 3. Bấm avatar/tên một thành viên — trong panel hoặc trên dòng
 *    tin — mở {@link MemberActionMenu}: các mục hiện theo ĐÚNG luật
 *    quan hệ đã chốt (nhắn riêng khi đã là liên hệ / có cờ nhắn
 *    thẳng GV→HS / đã có hội thoại 1–1 mở trước; chưa quan hệ thì
 *    Kết bạn; chặn thì không hiện nhắn riêng), cộng Xem thông tin
 *    (hồ sơ rút gọn trong phạm vi ngữ cảnh chung) và hành động quản
 *    trị theo loại nhóm (nhóm cấu trúc dẫn về màn roster, nhóm tự
 *    do gỡ thành viên tại chỗ qua API).
 *
 * Bất biến: thành viên nhóm CẤU TRÚC không bao giờ bị gỡ/sửa ngay
 * trong chat — nguồn sự thật là roster lớp/khoá; menu của nhóm cấu
 * trúc chỉ chứa đường dẫn về màn roster tương ứng.
 */

/** Dữ kiện + sự kiện của panel thành viên do trang Tin nhắn đưa xuống khung chat. */
export interface MemberPanelBundle {
  /** Ngữ cảnh roster của conversation đang mở. */
  context: MemberPanelContext;
  /** Các dòng thành viên đã nạp; null = đang nạp. */
  entries: MemberPanelEntry[] | null;
  /** Lần nạp roster gần nhất lỗi (panel hiện câu lỗi, giữ khung). */
  failed: boolean;
  /** Thông báo kết quả hành động danh bạ gần nhất (kết bạn/chấp nhận…) để hiện trong panel. */
  notice: string | null;
  /** Tập user đã có hội thoại 1–1 với tôi — căn cứ nhánh "GV đã mở trước" của luật nhắn riêng. */
  directPartnerIds: ReadonlySet<string>;
  /** Mở hội thoại 1–1 với một thành viên (trang gọi API tạo/lấy conversation). */
  onMessageMember: (userId: string) => void;
  /** Gửi yêu cầu kết bạn tới một thành viên. */
  onSendContactRequest: (userId: string) => void;
  /** Chấp nhận/từ chối một yêu cầu kết bạn đang chờ. */
  onRespondContactRequest: (userId: string, action: 'accept' | 'decline') => void;
  /** Gỡ một thành viên khỏi nhóm tự do (chỉ trang/API mới thực thi cổng canManage). */
  onRemoveMember: (userId: string) => void;
}

/**
 * Nhãn vai trò của một dòng thành viên trong panel: nhóm cấu trúc
 * dùng cặp Giáo viên/Học sinh, nhóm tự do dùng Quản trị viên/Thành
 * viên — cùng các khoá i18n với tiêu đề hai nhóm của danh sách.
 *
 * @param role - Vai trò của dòng thành viên.
 * @param t - Hàm dịch của i18next.
 * @returns Nhãn vai trò đã dịch.
 */
function roleLabel(role: MemberPanelEntry['role'], t: (key: string) => string): string {
  switch (role) {
    case 'teacher': return t('memberGroupTeachers');
    case 'student': return t('memberGroupStudents');
    case 'admin': return t('memberGroupAdmins');
    default: return t('memberGroupMembers');
  }
}

/**
 * Nhãn trạng thái quan hệ trong hồ sơ rút gọn của một thành viên.
 *
 * @param entry - Dòng thành viên cần nhãn quan hệ.
 * @param t - Hàm dịch của i18next.
 * @returns Nhãn quan hệ đã dịch.
 */
function relationshipLabel(entry: MemberPanelEntry, t: (key: string) => string): string {
  if (entry.canDirectMessage && entry.relationship !== 'contact') return t('memberRelDirect');
  switch (entry.relationship) {
    case 'contact': return t('relationshipContact');
    case 'pending_incoming': return t('memberRelPendingIncoming');
    case 'pending_outgoing': return t('memberRelPendingOutgoing');
    case 'blocked': return t('memberRelBlocked');
    default: return t('memberRelNone');
  }
}

interface MemberActionMenuProps {
  /** Thành viên mà menu thao tác trên. */
  entry: MemberPanelEntry;
  /** Id của chính người xem (menu trên chính mình chỉ còn Xem thông tin). */
  myId: string | undefined;
  /** Loại ngữ cảnh của conversation (quyết định mục quản trị trong menu). */
  context: MemberPanelContext;
  /** Người xem có thẩm quyền quản lý conversation hay không (server tính, client chỉ trình bày). */
  canManage: boolean;
  /** Đã có hội thoại 1–1 với thành viên này hay chưa. */
  hasDirectConversation: boolean;
  /** Phần tử kích mở menu (avatar + tên) — do nơi gọi dựng theo bố cục của nó. */
  children: ReactNode;
  /** Class cho nút kích mở menu (bố cục dòng của nơi gọi). */
  triggerClassName?: string;
  /** Nhãn truy cập của nút kích mở menu. */
  triggerLabel: string;
  onMessageMember: (userId: string) => void;
  onSendContactRequest: (userId: string) => void;
  onRespondContactRequest: (userId: string, action: 'accept' | 'decline') => void;
  onRemoveMember: (userId: string) => void;
  /** Mở hồ sơ rút gọn của thành viên (sheet ở khung chat). */
  onViewProfile: (entry: MemberPanelEntry) => void;
}

/**
 * Menu thao tác trên MỘT thành viên, mở khi bấm avatar/tên của họ.
 *
 * Các mục được dựng theo đúng luật quan hệ đã chốt (sổ quyết định
 * mục D + mục 4.3 của hồ sơ cấu trúc nhắn tin):
 * - "Nhắn riêng" chỉ hiện khi luật cho phép NGAY LÚC NÀY: đã là
 *   liên hệ, hoặc có cờ `canDirectMessage` (GV nhắn thẳng HS thuộc
 *   lớp/khoá của mình), hoặc đã có hội thoại 1–1 tồn tại (nhánh GV
 *   đã mở trước ở chiều HS→GV — cổng cuối vẫn là `assertCanContact`
 *   phía server khi mở/gửi). Quan hệ chặn thì mục này KHÔNG hiện —
 *   chặn thắng mọi bề mặt.
 * - Chưa quan hệ, không có cờ nhắn thẳng và cũng chưa có hội
 *   thoại 1–1 nào tồn tại: hiện "Kết bạn" thay cho Nhắn riêng
 *   (HS↔HS vẫn phải kết bạn trước). Đang chờ đến thì Chấp
 *   nhận/Từ chối; đang chờ đi thì một mục mờ ghi trạng thái.
 * - "Xem thông tin" luôn có (trừ khi bị chặn hai chiều — dòng đó
 *   vốn đã bị ẩn khỏi roster/panel ở tầng dữ liệu).
 * - Mục quản trị chỉ khi `canManage`: nhóm cấu trúc dẫn về màn
 *   roster (không gỡ tay trong chat); nhóm tự do gỡ thành viên tại
 *   chỗ, trừ người tạo nhóm và trừ chính mình.
 *
 * @param props - Thành viên đích, ngữ cảnh và các sự kiện lên trang/khung chat.
 * @returns Menu thả xuống bọc phần tử kích hoạt được truyền vào.
 */
export function MemberActionMenu({
  entry, myId, context, canManage, hasDirectConversation, children, triggerClassName,
  triggerLabel, onMessageMember, onSendContactRequest, onRespondContactRequest,
  onRemoveMember, onViewProfile,
}: MemberActionMenuProps) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const isSelf = entry.userId === myId;
  const blocked = entry.relationship === 'blocked';
  /** Nhánh cho phép nhắn riêng ngay — xem TSDoc của component; chặn thắng tất cả. */
  const canMessageNow = !blocked && !isSelf
    && (entry.relationship === 'contact' || entry.canDirectMessage || hasDirectConversation);
  /** Đường về màn roster của ngữ cảnh — chỉ nhóm cấu trúc mới có. */
  const rosterHref = context.kind === 'class'
    ? `/classes/${context.id}`
    : context.kind === 'course'
      ? `/courses/${context.id}`
      : null;

  // Bị chặn hai chiều: dòng thành viên không mang menu nào cả —
  // giữ đúng luật "liên hệ đã chặn ẩn khỏi mọi bề mặt nhắn tin".
  if (blocked) return <>{children}</>;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<button type="button" aria-label={triggerLabel} className={triggerClassName} />}
      >
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4}>
        {canMessageNow ? (
          <DropdownMenuItem onClick={() => onMessageMember(entry.userId)}>
            <MessageCircle aria-hidden />
            {t('directMessageAction')}
          </DropdownMenuItem>
        ) : null}
        {!isSelf && entry.relationship === 'none' && !entry.canDirectMessage && !hasDirectConversation ? (
          <DropdownMenuItem onClick={() => onSendContactRequest(entry.userId)}>
            <UserPlus aria-hidden />
            {t('addContact')}
          </DropdownMenuItem>
        ) : null}
        {!isSelf && entry.relationship === 'pending_incoming' ? (
          <>
            <DropdownMenuItem onClick={() => onRespondContactRequest(entry.userId, 'accept')}>
              <Check aria-hidden />
              {t('acceptContactRequest')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onRespondContactRequest(entry.userId, 'decline')}>
              <X aria-hidden />
              {t('declineContactRequest')}
            </DropdownMenuItem>
          </>
        ) : null}
        {!isSelf && entry.relationship === 'pending_outgoing' ? (
          <DropdownMenuItem disabled>
            {t('memberRequestPending')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onClick={() => onViewProfile(entry)}>
          <Info aria-hidden />
          {t('memberViewProfile')}
        </DropdownMenuItem>
        {canManage && rosterHref ? (
          <DropdownMenuItem onClick={() => navigate(rosterHref)}>
            {context.kind === 'class' ? t('memberManageClassRoster') : t('memberManageCourseRoster')}
          </DropdownMenuItem>
        ) : null}
        {canManage && context.kind === 'free' && !isSelf && !entry.isCreator ? (
          <DropdownMenuItem variant="destructive" onClick={() => onRemoveMember(entry.userId)}>
            <Trash aria-hidden />
            {t('memberRemoveFromGroup')}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface MemberProfileSheetProps {
  /** Thành viên đang xem hồ sơ rút gọn; null = sheet đóng. */
  entry: MemberPanelEntry | null;
  /** Tên ngữ cảnh chung (lớp/khoá của conversation) để ghi phạm vi hồ sơ. */
  contextName: string;
  /** Thành viên đang trực tuyến hay không (bản đồ presence của trang). */
  online: boolean;
  /** Đóng sheet. */
  onClose: () => void;
}

/**
 * Hồ sơ RÚT GỌN của một thành viên trong phạm vi ngữ cảnh chung
 * (mục 4.3 của hồ sơ cấu trúc nhắn tin): tên, định danh, vai trò
 * trong ngữ cảnh của conversation đang mở, trạng thái quan hệ với
 * người xem và trạng thái trực tuyến. Không hiển thị bất kỳ dữ kiện
 * nào ngoài phạm vi lớp/khoá/nhóm chung này.
 *
 * @param props - Thành viên + ngữ cảnh chung + sự kiện đóng.
 * @returns Sheet hồ sơ trượt từ phải.
 */
export function MemberProfileSheet({ entry, contextName, online, onClose }: MemberProfileSheetProps) {
  const { t } = useTranslation('app');
  return (
    <Sheet open={entry !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>{t('memberProfileTitle')}</SheetTitle>
        </SheetHeader>
        {entry ? (
          <div className="space-y-4 px-4 pb-4">
            <div className="flex items-center gap-3">
              <span className="relative shrink-0">
                <Avatar>
                  <AvatarFallback>{initialsOf(entry.displayName)}</AvatarFallback>
                </Avatar>
                {online ? (
                  <span className="absolute right-0 bottom-0 size-2.5 rounded-full bg-emerald-500 ring-2 ring-background" />
                ) : null}
              </span>
              <div className="min-w-0">
                <p className="truncate font-medium">{entry.displayName}</p>
                <p className="truncate text-sm text-muted-foreground">@{entry.username}</p>
              </div>
            </div>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t('memberProfileRole')}</dt>
                <dd className="font-medium">{roleLabel(entry.role, t)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t('memberProfileContext')}</dt>
                <dd className="truncate font-medium">{contextName}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t('memberProfileRelationship')}</dt>
                <dd className="font-medium">{relationshipLabel(entry, t)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t('memberProfilePresence')}</dt>
                <dd className="font-medium">{online ? t('onlineNow') : t('memberOffline')}</dd>
              </div>
              {entry.isCreator ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t('memberProfileGroupRole')}</dt>
                  <dd className="font-medium">{t('memberCreatorBadge')}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

interface MemberPanelProps {
  /** Conversation nhóm đang mở (tên/loại/số thành viên/cờ bật tắt + thẩm quyền của người xem). */
  conversation: ConversationView;
  /** Gói dữ kiện + sự kiện panel do trang đưa xuống. */
  bundle: MemberPanelBundle;
  /** Id của chính người xem. */
  myId: string | undefined;
  /** Bản đồ trực tuyến theo user (presence của trang). */
  onlineUsers: Record<string, boolean>;
  /** Mốc đã đọc theo từng thành viên của conversation (cho huy hiệu Đã xem). */
  readMarkers: Record<string, number>;
  /** Seq tin mới nhất đang có — mốc so "đã xem" của từng thành viên. */
  newestSeq: number;
  /** Mở hồ sơ rút gọn của một thành viên. */
  onViewProfile: (entry: MemberPanelEntry) => void;
}

/**
 * Thân PANEL THÔNG TIN của một hội thoại nhóm: thông tin nhóm
 * (kèm trạng thái bật/tắt chat — công tắc nằm ở thanh hành động
 * của khung chat, chỉ người có thẩm quyền quản lý mới thấy) +
 * danh sách thành viên phân nhóm, thay cho danh sách id thô của
 * panel cũ.
 *
 * Luồng hiển thị: trang nạp roster theo ngữ cảnh và đưa các dòng
 * xuống qua `bundle.entries`; panel phân hai nhóm theo `role`
 * (Giáo viên/Học sinh cho nhóm cấu trúc; Quản trị viên/Thành viên
 * cho nhóm tự do — người tạo nhóm tự do là dòng quản trị viên duy
 * nhất vì thẩm quyền của nhóm neo vào người tạo), giữ chấm online
 * và huy hiệu đã xem/chưa xem theo mốc đọc như panel cũ. Mỗi dòng
 * bấm được vào avatar/tên để mở {@link MemberActionMenu}.
 *
 * @param props - Conversation đang mở + gói panel + các bản đồ trạng thái của khung chat.
 * @returns Khối panel hiển thị dưới header khung chat khi nút Info đang bật.
 */
export function MemberPanel({
  conversation, bundle, myId, onlineUsers, readMarkers, newestSeq, onViewProfile,
}: MemberPanelProps) {
  const { t } = useTranslation('app');
  const { context, entries, failed, notice } = bundle;
  const typeLabel = context.kind === 'class'
    ? t('memberTypeClass')
    : context.kind === 'course'
      ? (context.subgroup ? t('memberTypeGroup') : t('memberTypeCourse'))
      : t('memberTypeFree');
  /** Hai nhóm trình bày theo loại conversation (xem TSDoc của component). */
  const primaryRoles: MemberPanelEntry['role'][] = context.kind === 'free' ? ['admin'] : ['teacher'];
  const secondaryRoles: MemberPanelEntry['role'][] = context.kind === 'free' ? ['member'] : ['student'];
  const primary = entries?.filter((e) => primaryRoles.includes(e.role)) ?? [];
  const secondary = entries?.filter((e) => secondaryRoles.includes(e.role)) ?? [];

  /** Một dòng thành viên: nút avatar + tên mở menu thao tác; huy hiệu vai và mốc đã xem nằm ngoài nút. */
  const memberRow = (entry: MemberPanelEntry) => {
    const seen = newestSeq > 0 && (readMarkers[entry.userId] ?? 0) >= newestSeq;
    const online = Boolean(onlineUsers[entry.userId]);
    return (
      <li key={entry.userId} data-testid={`member-panel-row-${entry.userId}`} className="flex items-center gap-2">
        <MemberActionMenu
          entry={entry}
          myId={myId}
          context={context}
          canManage={Boolean(conversation.canManage)}
          hasDirectConversation={bundle.directPartnerIds.has(entry.userId)}
          triggerLabel={t('memberMenuLabel', { name: entry.displayName })}
          triggerClassName="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-left hover:bg-muted"
          onMessageMember={bundle.onMessageMember}
          onSendContactRequest={bundle.onSendContactRequest}
          onRespondContactRequest={bundle.onRespondContactRequest}
          onRemoveMember={bundle.onRemoveMember}
          onViewProfile={onViewProfile}
        >
          <span className="relative shrink-0">
            <Avatar>
              <AvatarFallback>{initialsOf(entry.displayName)}</AvatarFallback>
            </Avatar>
            {online ? (
              <span className="absolute right-0 bottom-0 size-2.5 rounded-full bg-emerald-500 ring-2 ring-background" />
            ) : null}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm">
            {entry.displayName} <span className="text-muted-foreground">@{entry.username}</span>
          </span>
        </MemberActionMenu>
        {entry.isCreator ? <Badge variant="outline">{t('memberCreatorBadge')}</Badge> : null}
        <Badge variant="secondary">{roleLabel(entry.role, t)}</Badge>
        <Badge variant={seen ? 'secondary' : 'outline'}>
          {seen ? t('memberSeenState') : t('memberNotSeenState')}
        </Badge>
      </li>
    );
  };

  return (
    <div className="space-y-3 border-b px-3 py-2" data-testid="member-panel">
      <h3 className="text-sm font-medium">{t('conversationInfoTitle')}</h3>
      <dl className="space-y-1 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{t('memberInfoName')}</dt>
          <dd className="truncate font-medium">{conversation.name ?? context.name}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{t('memberInfoType')}</dt>
          <dd className="font-medium">{typeLabel}</dd>
        </div>
        {context.kind !== 'free' && context.parentName ? (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{t('memberInfoBelongsTo')}</dt>
            <dd className="truncate font-medium">{context.parentName}</dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{t('conversationMembersTitle')}</dt>
          <dd className="font-medium">{t('conversationMembersCount', { count: conversation.members.length })}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">{t('memberInfoChatState')}</dt>
          <dd className="font-medium">
            {(conversation.enabled ?? true) ? t('memberChatOn') : t('memberChatOff')}
          </dd>
        </div>
      </dl>
      {notice ? <p role="status" className="text-sm">{notice}</p> : null}
      <h4 className="text-sm font-medium">{t('conversationMembersTitle')}</h4>
      {entries === null && !failed ? (
        <p className="text-sm text-muted-foreground">{t('memberPanelLoading')}</p>
      ) : null}
      {failed ? <p role="alert" className="text-sm">{t('rosterLoadFailed')}</p> : null}
      {entries !== null && entries.length === 0 && !failed ? (
        <p className="text-sm text-muted-foreground">{t('memberPanelEmpty')}</p>
      ) : null}
      {primary.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">
            {context.kind === 'free' ? t('memberGroupAdmins') : t('memberGroupTeachers')}
          </p>
          <ul className="space-y-1">{primary.map(memberRow)}</ul>
        </div>
      ) : null}
      {secondary.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">
            {context.kind === 'free' ? t('memberGroupMembers') : t('memberGroupStudents')}
          </p>
          <ul className="space-y-1">{secondary.map(memberRow)}</ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Gói trạng thái hồ sơ rút gọn dùng chung cho khung chat: giữ
 * thành viên đang xem + thao tác mở/đóng, để cả menu trong panel
 * lẫn menu trên avatar dòng tin cùng mở một sheet.
 *
 * @returns Entry đang xem (null = đóng) và hai thao tác mở/đóng.
 */
export function useMemberProfile() {
  const [entry, setEntry] = useState<MemberPanelEntry | null>(null);
  return {
    entry,
    open: (next: MemberPanelEntry) => setEntry(next),
    close: () => setEntry(null),
  };
}

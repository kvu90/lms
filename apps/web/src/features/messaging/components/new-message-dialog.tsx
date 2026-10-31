import { Avatar, AvatarFallback } from '@lms/ui/components/avatar';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@lms/ui/components/dialog';
import { Input } from '@lms/ui/components/input';
import { useTranslation } from 'react-i18next';
import { PeoplePicker } from './people-picker';
import type {
  ContactRequestView,
  MessagingCourse,
  PeoplePickerContext,
  RosterMember,
} from '../types/types';
import { initialsOf } from '../utils/utils';

/**
 * Hộp thoại "TIN NHẮN MỚI" của màn Tin nhắn (lát MSG-T3, issue
 * #33; đổi từ ngăn kéo trượt bên phải sang hộp thoại nằm giữa
 * màn hình như bản demo ở issue #591) — nơi tab Danh bạ cũ được
 * HẠ xuống theo quyết cấu trúc 11:36 ngày 26/10/2026: bắt đầu
 * một hội thoại riêng không còn là một tab chính, mà là một
 * hộp thoại mở từ nút "Tin nhắn mới". Nội dung và đường dữ
 * kiện liên hệ bên trong giữ nguyên như bề mặt cũ.
 *
 * Flow tổng thể:
 *
 * 1. Hộp thoại mở → mục trên cùng là LỜI MỜI KẾT BẠN đang chờ
 *    (nếu có): người gửi hiện bằng tên hiển thị, chấp nhận/từ
 *    chối đi qua đúng endpoint yêu cầu kết bạn; số lời mời chờ
 *    cũng là badge trên nút mở hộp thoại ở khung trái.
 * 2. Phần chọn người do {@link PeoplePicker} trình bày: liên hệ đã
 *    kết bạn (danh sách phẳng, mỗi dòng một nút Nhắn tin), hoặc
 *    roster của một lớp/khoá của tôi. Hành động trên dòng roster
 *    tuân đúng luật quan hệ đã chốt: được nhắn thẳng khi API gắn cờ
 *    `canDirectMessage` (GV ↔ HS thuộc lớp/khoá của mình, không cần
 *    kết bạn) hoặc khi đã là liên hệ; chưa có quan hệ thì chỉ có
 *    Kết bạn; đang chờ thì hiện trạng thái/hành động trả lời tương
 *    ứng. Người đã bị chặn không xuất hiện ở bất kỳ mục nào (server
 *    đã ẩn ở mọi đường đọc).
 * 3. Cuối hộp thoại là mục LIÊN HỆ ĐÃ CHẶN với nút Bỏ chặn — giữ
 *    bề mặt quản lý chặn duy nhất còn lại sau khi tab Danh bạ bị
 *    hạ — và khối LIÊN KẾT MỜI chỉ ở dạng hình dạng vô hiệu
 *    (điểm chưa có phán quyết về chức năng, issue #591).
 * 4. Bấm Nhắn tin ở bất kỳ dòng nào: sự kiện đi lên trang chứa —
 *    trang tạo/lấy hội thoại 1–1, đóng hộp thoại, chuyển khung
 *    trái về tab Tất cả và mở hội thoại ở khung phải.
 *
 * Bất biến: hộp thoại chỉ trình bày + phát sự kiện; luật được
 * phép nhắn ai là của server (cổng `assertCanContact` khi tạo
 * hội thoại) — client không tự nới cũng không tự cấm thêm.
 */
interface NewMessageDialogProps {
  /** Hộp thoại đang mở hay không (trang/sidebar chứa giữ trạng thái). */
  open: boolean;
  /** Đổi trạng thái mở của hộp thoại. */
  onOpenChange: (open: boolean) => void;
  /** Lời mời kết bạn ĐẾN đang chờ trả lời. */
  incomingRequests: ContactRequestView[];
  /** Lời mời kết bạn ĐI đang chờ phía kia trả lời. */
  outgoingRequests: ContactRequestView[];
  /** Id các liên hệ đã kết bạn của tôi. */
  contacts: string[];
  /** Thông báo gần nhất của các thao tác kết bạn; null khi không có. */
  contactMessage: string | null;
  /** Id các liên hệ tôi đã chặn. */
  blocked: string[];
  /** Thông báo gần nhất của thao tác chặn/bỏ chặn; null khi không có. */
  blockMessage: string | null;
  /** Tên hiển thị của một user (trang chứa tra từ bản đồ tên dùng chung). */
  nameOf: (userId: string) => string;
  /** Mở hội thoại 1–1 với một người (trang chứa tạo/lấy rồi mở ở khung phải). */
  onMessageContact: (userId: string) => void;
  /** Gửi yêu cầu kết bạn tới một người trong roster. */
  onSendContactRequest: (userId: string) => void;
  /** Trả lời một lời mời kết bạn (chấp nhận hoặc từ chối). */
  onRespondContactRequest: (userId: string, action: 'accept' | 'decline') => void;
  /** Bỏ chặn một liên hệ. */
  onUnblockContact: (userId: string) => void;
  /** Ngữ cảnh chọn người đang chọn trong bộ chọn. */
  pickerContext: PeoplePickerContext;
  /** Đổi ngữ cảnh chọn người (trang chứa nạp roster tương ứng). */
  onSelectPickerContext: (context: PeoplePickerContext) => void;
  /** Các lớp của tôi cho ngữ cảnh theo lớp. */
  pickerClasses: { classId: string; name: string }[];
  /** Các khoá của tôi cho ngữ cảnh theo khoá. */
  pickerCourses: MessagingCourse[];
  /** Một trang roster của ngữ cảnh lớp/khoá đang chọn. */
  pickerMembers: RosterMember[];
  /** Lỗi nạp roster gần nhất; null khi không có. */
  pickerRosterError: string | null;
  /** Con trỏ trang roster kế; null là đã hết trang. */
  pickerRosterCursor: string | null;
  /** Tải trang roster tiếp theo. */
  onLoadMorePicker: () => void;
}

/**
 * Trình bày hộp thoại "Tin nhắn mới" với đủ ba mục: lời mời kết bạn,
 * chọn người theo ngữ cảnh, liên hệ đã chặn.
 *
 * @param props - Dữ kiện và sự kiện do khung trái Tin nhắn đưa xuống.
 * @returns Hộp thoại điều khiển bằng `open`/`onOpenChange`.
 */
export function NewMessageDialog({
  open, onOpenChange, incomingRequests, outgoingRequests, contacts, contactMessage,
  blocked, blockMessage, nameOf, onMessageContact, onSendContactRequest,
  onRespondContactRequest, onUnblockContact, pickerContext, onSelectPickerContext,
  pickerClasses, pickerCourses, pickerMembers, pickerRosterError, pickerRosterCursor,
  onLoadMorePicker,
}: NewMessageDialogProps) {
  const { t } = useTranslation('app');

  /**
   * Hành động cuối dòng roster theo ĐÚNG luật quan hệ đã chốt —
   * giữ nguyên bộ nút của tab Danh bạ cũ, chỉ đổi nơi trình bày:
   * nhắn thẳng khi có cờ `canDirectMessage` (không ép qua kết bạn),
   * đã là liên hệ thì nhắn được; chưa quan hệ thì chỉ Kết bạn; đang
   * chờ đến thì Chấp nhận/Từ chối ngay tại dòng.
   */
  const renderMemberAction = (m: RosterMember) => (
    <>
      {m.canDirectMessage && m.relationship !== 'contact' ? (
        <Button type="button" variant="outline" onClick={() => void onMessageContact(m.userId)}>
          {t('messageWithContact')}
        </Button>
      ) : null}
      {m.relationship === 'none' ? (
        <Button type="button" variant="outline" onClick={() => void onSendContactRequest(m.userId)}>
          {t('addContact')}
        </Button>
      ) : null}
      {m.relationship === 'pending_outgoing' ? (
        <span className="text-sm text-muted-foreground">{t('contactRequestPendingSuffix')}</span>
      ) : null}
      {m.relationship === 'pending_incoming' ? (
        <>
          <Button type="button" variant="outline" onClick={() => void onRespondContactRequest(m.userId, 'accept')}>
            {t('acceptContactRequest')}
          </Button>
          <Button type="button" variant="outline" onClick={() => void onRespondContactRequest(m.userId, 'decline')}>
            {t('declineContactRequest')}
          </Button>
        </>
      ) : null}
      {m.relationship === 'contact' ? (
        <Button type="button" variant="outline" onClick={() => void onMessageContact(m.userId)}>
          {t('messageWithContact')}
        </Button>
      ) : null}
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('newMessage')}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">
          {/* Thông báo kết quả hành động danh bạ (kết bạn/chấp nhận…)
              hiện bất kể ngữ cảnh đang chọn — người dùng vừa thao tác
              ở ngữ cảnh khoá/lớp vẫn phải thấy kết quả ngay. */}
          {contactMessage ? <p role="status" className="text-sm">{contactMessage}</p> : null}
          {incomingRequests.length > 0 ? (
            <div className="space-y-2">
              <h3 className="flex items-center gap-2 font-medium">
                {t('incomingRequestsTitle')}
                <Badge>{incomingRequests.length}</Badge>
              </h3>
              <ul className="space-y-1">
                {incomingRequests.map((r) => (
                  <li key={r.userId} data-testid={`incoming-request-${r.userId}`} className="flex items-center gap-2">
                    <Avatar>
                      <AvatarFallback>{initialsOf(r.displayName ?? nameOf(r.userId))}</AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1 truncate text-sm">{r.displayName ?? nameOf(r.userId)}</span>
                    <Button type="button" variant="outline" onClick={() => void onRespondContactRequest(r.userId, 'accept')}>
                      {t('acceptContactRequest')}
                    </Button>
                    <Button type="button" variant="outline" onClick={() => void onRespondContactRequest(r.userId, 'decline')}>
                      {t('declineContactRequest')}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {outgoingRequests.length > 0 ? (
            <div className="space-y-2">
              <h3 className="font-medium">{t('outgoingRequestsTitle')}</h3>
              <ul className="space-y-1">
                {outgoingRequests.map((r) => (
                  <li key={r.userId} className="text-sm">
                    {r.displayName ?? nameOf(r.userId)} {t('contactRequestPendingSuffix')}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="space-y-2">
            <PeoplePicker
              context={pickerContext}
              onSelectContext={onSelectPickerContext}
              classes={pickerClasses}
              courses={pickerCourses}
              members={pickerMembers}
              rosterError={pickerRosterError}
              rosterCursor={pickerRosterCursor}
              onLoadMore={onLoadMorePicker}
              renderMemberAction={renderMemberAction}
            />
            {pickerContext.kind === 'contacts' ? (
              <>
                <ul className="space-y-1">
                  {contacts.map((userId) => (
                    <li key={userId} data-testid={`contact-${userId}`} className="flex items-center gap-2">
                      <Avatar>
                        <AvatarFallback>{initialsOf(nameOf(userId))}</AvatarFallback>
                      </Avatar>
                      <span className="min-w-0 flex-1 truncate text-sm">{nameOf(userId)}</span>
                      <Button type="button" variant="outline" onClick={() => void onMessageContact(userId)}>
                        {t('messageWithContact')}
                      </Button>
                    </li>
                  ))}
                </ul>
                {contacts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('noContacts')}</p>
                ) : null}
              </>
            ) : null}
          </div>
          <div className="space-y-2">
            <h3 className="font-medium">{t('blockedContactsTitle')}</h3>
            {blockMessage ? <p role="status" className="text-sm">{blockMessage}</p> : null}
            <ul className="space-y-1">
              {blocked.map((userId) => (
                <li key={userId} data-testid={`blocked-${userId}`} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm">{nameOf(userId)}</span>
                  <Button type="button" variant="outline" onClick={() => void onUnblockContact(userId)}>
                    {t('unblockContact')}
                  </Button>
                </li>
              ))}
            </ul>
            {blocked.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noBlockedContacts')}</p>
            ) : null}
          </div>
          {/*
            Liên kết mời (issue #591): phần tử thuộc bản demo
            nhưng là điểm CHƯA có phán quyết về chức năng và hệ
            không có cơ chế liên kết mời nào — ở đợt này chỉ
            dựng đúng HÌNH DẠNG (nhãn + ô liên kết + nút sao
            chép) ở trạng thái vô hiệu: không sinh liên kết,
            không sao chép gì. Chức năng chỉ được nối ở đợt
            backend sau khi điểm này có phán quyết.
          */}
          <div className="space-y-2">
            <h3 className="font-medium">{t('inviteLinkLabel')}</h3>
            <div className="flex gap-2">
              <Input
                aria-label={t('inviteLinkLabel')}
                placeholder={t('inviteLinkPlaceholder')}
                disabled
                value=""
                readOnly
              />
              <Button type="button" variant="outline" disabled>
                {t('copyInviteLink')}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

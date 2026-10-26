import { useEffect, useState } from 'react';
import { Button } from '@lms/ui/components/button';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@lms/ui/components/sheet';
import { useTranslation } from 'react-i18next';
import { PeoplePicker } from './people-picker';
import type {
  MessagingCourse,
  PeoplePickerContext,
  RosterMember,
} from './types';

/**
 * Sheet "TẠO NHÓM" (nhóm tự do) của màn Tin nhắn (lát MSG-T3, issue
 * #33) — bề mặt tạo nhóm tự do đầu tiên ngay trong màn Tin nhắn,
 * mở từ nút "+ Tạo nhóm" ở mục Nhóm tự do của tab Nhóm. Nút đó chỉ
 * hiện với người có vai dạy/staff (trang chứa suy từ cây nhóm);
 * cổng thật nằm ở server: học sinh bị chặn ở tầng service bằng mã
 * `messaging.group_creation_forbidden`, client chỉ trình bày.
 *
 * Flow tổng thể:
 *
 * 1. Người tạo nhập TÊN nhóm và chọn THÀNH VIÊN qua cùng bộ chọn
 *    người theo ngữ cảnh của sheet Tin nhắn mới ({@link
 *    PeoplePicker} ở chế độ chọn nhiều): liên hệ đã kết bạn, hoặc
 *    roster của một lớp/khoá của mình — không có nguồn người nào
 *    khác (giữ quyết bỏ tìm người theo tên).
 * 2. Bấm Tạo nhóm → sự kiện đi lên trang chứa: trang gọi
 *    `POST /messages/conversations` với `type: 2` + tên + danh sách
 *    thành viên đã chọn; thành công thì trang đóng sheet, nạp lại
 *    cây nhóm, chuyển về tab Nhóm và mở ngay nhóm vừa tạo ở khung
 *    phải; lỗi (điển hình 403 khi người tạo không có vai staff) thì
 *    trang đặt `createError` để hiện trong sheet, sheet giữ nguyên
 *    dữ liệu đã nhập/chọn để sửa tiếp.
 * 3. Mỗi lần sheet mở lại là một lượt tạo mới: tên và lựa chọn được
 *    xoá trắng (giữ trong state cục bộ của sheet, reset theo
 *    `open`).
 *
 * Bất biến: nhóm tự do luôn có tên (server nhận `name` cho type 2)
 * và ít nhất một thành viên được chọn ngoài người tạo — nút tạo bị
 * khoá và có dòng nhắc cho tới khi đủ hai điều kiện đó.
 */
interface CreateGroupSheetProps {
  /** Sheet đang mở hay không (khung trái giữ trạng thái). */
  open: boolean;
  /** Đổi trạng thái mở của sheet. */
  onOpenChange: (open: boolean) => void;
  /** Tạo nhóm với tên + id thành viên đã chọn (trang chứa gọi API). */
  onCreateGroup: (name: string, memberIds: string[]) => void;
  /** Lỗi tạo nhóm gần nhất do trang chứa đặt; null khi không có. */
  createError: string | null;
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
  /** Danh sách liên hệ của tôi (id + tên hiển thị) làm nguồn chọn ở ngữ cảnh liên hệ. */
  contactEntries: { userId: string; displayName: string }[];
}

/**
 * Trình bày sheet tạo nhóm tự do: ô tên nhóm + bộ chọn thành viên
 * theo ngữ cảnh + nút tạo.
 *
 * @param props - Dữ kiện và sự kiện do khung trái Tin nhắn đưa xuống.
 * @returns Sheet điều khiển bằng `open`/`onOpenChange`.
 */
export function CreateGroupSheet({
  open, onOpenChange, onCreateGroup, createError, pickerContext, onSelectPickerContext,
  pickerClasses, pickerCourses, pickerMembers, pickerRosterError, pickerRosterCursor,
  onLoadMorePicker, contactEntries,
}: CreateGroupSheetProps) {
  const { t } = useTranslation('app');
  const [name, setName] = useState('');
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());

  // Mỗi lượt mở là một lượt tạo mới: xoá tên + lựa chọn của lượt
  // trước để không tạo nhầm nhóm bằng dữ liệu cũ.
  useEffect(() => {
    if (open) {
      setName('');
      setSelectedIds(new Set());
    }
  }, [open ]);

  /** Đảo trạng thái chọn của một người (từ roster hoặc từ danh sách liên hệ). */
  const toggle = (userId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const canSubmit = name.trim().length > 0 && selectedIds.size > 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t('createGroupTitle')}</SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-4">
          <div className="space-y-2">
            <Label htmlFor="msg-t3-group-name">{t('groupNameLabel')}</Label>
            <Input
              id="msg-t3-group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('groupNamePlaceholder')}
            />
          </div>
          <div className="space-y-2">
            <h3 className="font-medium">{t('groupPickMembers')}</h3>
            <PeoplePicker
              context={pickerContext}
              onSelectContext={onSelectPickerContext}
              classes={pickerClasses}
              courses={pickerCourses}
              members={pickerMembers}
              rosterError={pickerRosterError}
              rosterCursor={pickerRosterCursor}
              onLoadMore={onLoadMorePicker}
              selectedIds={selectedIds}
              onToggleMember={(m) => toggle(m.userId)}
              contactEntries={contactEntries}
              onToggleContactEntry={toggle}
            />
          </div>
          {selectedIds.size === 0 ? (
            <p className="text-sm text-muted-foreground">{t('groupNeedMember')}</p>
          ) : null}
          {createError ? <p role="alert" className="text-sm">{createError}</p> : null}
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={() => onCreateGroup(name.trim(), [...selectedIds])}
          >
            {t('createGroupTitle')}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

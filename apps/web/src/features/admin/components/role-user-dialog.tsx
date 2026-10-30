import { useState } from 'react';
import type { UserWithAssignmentsListItem } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@lms/ui/components/dialog';
import { useTranslation } from 'react-i18next';
import '#config/i18n';
import { contextLevelLabelKey } from '../utils/context-level-label';
import { RoleUnassignDialog, type UnassignTarget } from './role-unassign-dialog';

/**
 * Hộp thoại quản lý vai trò của đúng một người dùng trên trang vai trò
 * (issue #569), mở từ nút "Quản lý vai trò" của dòng người đó trong
 * bảng người dùng kèm vai trò.
 *
 * Luồng nghiệp vụ: hộp thoại liệt kê mọi gán vai của người dùng — mỗi
 * gán bày tên vai kèm nhãn cấp ngữ cảnh dạng chữ, không bày mã định
 * danh hay đường dẫn ngữ cảnh. Gán tay có nút gỡ mở hộp thoại xác
 * nhận gỡ hiện hành; gán do ghi danh cấp (`component = 'enrol'`)
 * không có thao tác gỡ và hiện thẳng lý do không gỡ trực tiếp được.
 * Nút gán thêm mở hộp thoại gán hiện hành với người dùng này chọn
 * sẵn (qua hàm gọi lại của trang, hộp thoại quản lý đóng trước để
 * không chồng hai hộp thoại). Sau gán/gỡ thành công, bảng tải lại qua
 * việc làm mới gốc khoá truy vấn nên lần mở lại hộp thoại thấy gán
 * mới nhất; trong một lần mở, danh sách lấy từ dữ kiện bảng hiện tại
 * do trang truyền vào nên cũng tự cập nhật khi bảng tải lại.
 *
 * Về lồng hộp thoại: hộp thoại xác nhận gỡ được render BÊN TRONG nội
 * dung của hộp thoại quản lý (không phải hộp thoại anh em bên ngoài)
 * để thao tác bên ngoài hộp thoại xác nhận không bị hộp thoại quản lý
 * hiểu là bấm ra ngoài mà tự đóng; yêu cầu đóng từ hộp thoại quản lý
 * cũng bị giữ lại trong lúc hộp thoại xác nhận đang mở.
 *
 * @param props - Trạng thái mở, dòng người dùng kèm gán vai, hàm đóng
 * và hàm mở hộp thoại gán cho chính người này.
 */
export interface RoleUserDialogProps {
  /** Hộp thoại đang mở hay không. */
  open: boolean;
  /** Dòng người dùng kèm toàn bộ gán vai của người đó. */
  user: UserWithAssignmentsListItem;
  /** Đóng hộp thoại. */
  onClose: () => void;
  /** Mở hộp thoại gán vai cho chính người dùng này (người dùng chọn sẵn). */
  onAssignForUser: (user: UserWithAssignmentsListItem) => void;
}

/**
 * Tên hiển thị của người dùng: họ tên đầy đủ khi có, lùi về tên đăng
 * nhập khi hồ sơ trống cả họ lẫn tên.
 */
function displayNameOf(user: UserWithAssignmentsListItem): string {
  const fullName = `${user.firstName} ${user.lastName}`.trim();
  return fullName === '' ? user.username : fullName;
}

export function RoleUserDialog({ open, user, onClose, onAssignForUser }: RoleUserDialogProps) {
  const { t } = useTranslation('app');
  /** Dòng gán đang chờ xác nhận gỡ; null khi hộp thoại xác nhận đóng. */
  const [unassignTarget, setUnassignTarget] = useState<UnassignTarget | null>(null);

  if (!open) return null;

  const displayName = displayNameOf(user);

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        // Giữ hộp thoại quản lý mở trong lúc hộp thoại xác nhận gỡ đang mở.
        if (!nextOpen && unassignTarget === null) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('userRolesManageTitle', { name: displayName })}</DialogTitle>
          <DialogDescription>{t('userRolesManageDescription')}</DialogDescription>
        </DialogHeader>
        {user.assignments.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('userRolesManageEmpty')}</p>
        ) : (
          <ul className="space-y-2">
            {user.assignments.map((assignment) => {
              const contextLabel = t(contextLevelLabelKey(assignment.contextLevel), {
                level: assignment.contextLevel,
              });
              return (
                <li key={assignment.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
                  <span>
                    <span className="block font-medium">{assignment.roleName}</span>
                    <span className="block text-sm text-muted-foreground">{contextLabel}</span>
                  </span>
                  {assignment.component === 'enrol' ? (
                    <span className="text-sm text-muted-foreground">{t('assignmentEnrolManaged')}</span>
                  ) : (
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() =>
                        setUnassignTarget({
                          assignment: { id: assignment.id },
                          userLabel: displayName,
                          roleLabel: assignment.roleName,
                          contextLabel,
                        })
                      }
                    >
                      {t('unassignRole')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="button" onClick={() => onAssignForUser(user)}>
            {t('userRolesAssignMore')}
          </Button>
        </DialogFooter>
        {/* Hộp thoại xác nhận gỡ nằm trong nội dung hộp thoại quản lý để không bị hiểu là bấm ra ngoài. */}
        {unassignTarget !== null ? (
          <RoleUnassignDialog open target={unassignTarget} onClose={() => setUnassignTarget(null)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

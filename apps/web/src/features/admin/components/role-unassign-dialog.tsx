import { useState } from 'react';
import type { AssignmentListItem } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@lms/ui/components/dialog';
import { ErrorAlert } from '#components/error-alert';
import { useTranslation } from 'react-i18next';
import '#config/i18n';
import { ApiError } from '#lib/api';
import { useDeleteRoleAssignment } from '../queries/admin-roles';

/**
 * Dòng gán sắp gỡ kèm nhãn hiển thị đã phân giải ở bảng (tên người
 * dùng, tên vai trò, nhãn ngữ cảnh) — hộp thoại chỉ xác nhận và gọi
 * API, không tự phân giải định danh.
 */
export interface UnassignTarget {
  /** Dòng gán cần gỡ (chỉ cần định danh để gọi API gỡ). */
  assignment: Pick<AssignmentListItem, 'id'>;
  /** Tên người dùng hiển thị của dòng gán. */
  userLabel: string;
  /** Tên vai trò hiển thị của dòng gán. */
  roleLabel: string;
  /** Nhãn ngữ cảnh hiển thị của dòng gán. */
  contextLabel: string;
}

/**
 * Hộp thoại xác nhận gỡ dòng gán vai, dựng trên component Dialog
 * thật của `@lms/ui`.
 *
 * Luồng nghiệp vụ: hộp thoại nêu rõ bộ ba sắp gỡ (người dùng × vai trò
 * × ngữ cảnh) và yêu cầu xác nhận. Khi backend từ chối, hộp thoại GIỮ
 * NGUYÊN kèm đúng lý do — trường hợp đua dữ kiện khiến dòng thường bị
 * chuyển thành dòng do ghi danh quản lý giữa lúc liệt kê và lúc bấm gỡ
 * thì mã `access.assignment_enrol_managed` được dịch thành lý do rút
 * ghi danh; mã lạ thì dùng thông báo chung, không hiện mã kỹ thuật.
 * Gỡ thành công thì hộp thoại đóng và bảng tải lại đúng trang hiện hành
 * qua việc làm mới truy vấn danh sách.
 *
 * Dòng do ghi danh quản lý không tới được hộp thoại này: bảng hiển thị
 * thẳng trạng thái không gỡ trực tiếp được thay cho nút gỡ.
 *
 * @param props - Trạng thái mở, dòng gán sắp gỡ và hàm đóng hộp thoại.
 */
export interface RoleUnassignDialogProps {
  /** Hộp thoại đang mở hay không. */
  open: boolean;
  /** Dòng gán sắp gỡ; null khi hộp thoại đóng. */
  target: UnassignTarget | null;
  /** Đóng hộp thoại (sau khi gỡ thành công hoặc khi người dùng huỷ). */
  onClose: () => void;
}

/**
 * Dịch mã lỗi gỡ gán của backend thành thông báo cho người dùng; mã lạ
 * thì dùng thông báo chung, không hiện mã kỹ thuật ra giao diện.
 */
function unassignErrorMessage(error: unknown, t: (key: string) => string): string {
  if (error instanceof ApiError && error.problem.code === 'access.assignment_enrol_managed') {
    return t('assignmentEnrolManaged');
  }
  return t('unassignRoleFailed');
}

export function RoleUnassignDialog({ open, target, onClose }: RoleUnassignDialogProps) {
  const { t } = useTranslation('app');
  const [error, setError] = useState<string | null>(null);
  const deleteMutation = useDeleteRoleAssignment();

  if (!open || !target) return null;

  /** Gỡ gán: lỗi thì giữ hộp thoại mở kèm lý do; thành công thì đóng. */
  async function confirmUnassign() {
    if (!target) return;
    setError(null);
    try {
      await deleteMutation.mutateAsync(target.assignment.id);
      onClose();
    } catch (caught) {
      setError(unassignErrorMessage(caught, (key) => t(key)));
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !deleteMutation.isPending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-semibold">{t('unassignRoleTitle')}</DialogTitle>
          <DialogDescription>
            {t('unassignRoleConfirm', {
              role: target.roleLabel,
              user: target.userLabel,
              context: target.contextLabel,
            })}
          </DialogDescription>
        </DialogHeader>
        {error ? <ErrorAlert variant="destructive">{error}</ErrorAlert> : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={deleteMutation.isPending} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={deleteMutation.isPending}
            onClick={() => void confirmUnassign()}
          >
            {deleteMutation.isPending ? t('unassigningRole') : t('unassignRole')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

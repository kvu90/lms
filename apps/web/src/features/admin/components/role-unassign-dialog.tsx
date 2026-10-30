import { useEffect, useState } from 'react';
import type { AssignmentListItem } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
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
  /** Dòng gán cần gỡ. */
  assignment: AssignmentListItem;
  /** Tên người dùng hiển thị của dòng gán. */
  userLabel: string;
  /** Tên vai trò hiển thị của dòng gán. */
  roleLabel: string;
  /** Nhãn ngữ cảnh hiển thị của dòng gán. */
  contextLabel: string;
}

/**
 * Hộp thoại xác nhận gỡ dòng gán vai (đợt 3, issue #547).
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

  /** Phím Escape đóng hộp thoại khi không trong lúc gỡ. */
  useEffect(() => {
    if (!open || deleteMutation.isPending) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, deleteMutation.isPending, onClose]);

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
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[20vh]"
      onClick={() => {
        if (!deleteMutation.isPending) onClose();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('unassignRoleTitle')}
        className="w-full max-w-md rounded-xl border bg-background p-6 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="mb-2 text-lg font-semibold">{t('unassignRoleTitle')}</h2>
        <p className="mb-4 text-sm">
          {t('unassignRoleConfirm', {
            role: target.roleLabel,
            user: target.userLabel,
            context: target.contextLabel,
          })}
        </p>
        {error ? (
          <ErrorAlert variant="destructive" className="mb-4">
            {error}
          </ErrorAlert>
        ) : null}
        <div className="flex justify-end gap-2">
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
        </div>
      </div>
    </div>
  );
}

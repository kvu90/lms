import { useEffect, useState } from 'react';
import type { RoleListItem } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { ErrorAlert } from '#components/error-alert';
import { ApiError } from '#lib/api';
import { useTranslation } from 'react-i18next';
import '#config/i18n';
import { useDeleteRole } from '../queries/admin-roles';

/**
 * Hộp thoại xác nhận xoá vai trò của feature admin.
 *
 * Luồng nghiệp vụ: hộp thoại nêu rõ tên vai trò sắp xoá và yêu cầu xác
 * nhận. Khi backend từ chối xoá, hộp thoại GIỮ NGUYÊN kèm đúng lý do
 * backend trả về — vai dựng sẵn (có `archetype`) và vai còn người giữ
 * là hai trường hợp phân biệt bằng mã lỗi riêng; vai thường không còn
 * người giữ thì xoá thành công, hộp thoại đóng và lưới thẻ cập nhật
 * ngay qua việc làm mới truy vấn danh sách vai.
 *
 * @param props - Trạng thái mở, vai trò sắp xoá và hàm đóng hộp thoại.
 */
export interface RoleDeleteDialogProps {
  /** Hộp thoại đang mở hay không. */
  open: boolean;
  /** Vai trò sắp xoá; null khi hộp thoại đóng. */
  role: RoleListItem | null;
  /** Đóng hộp thoại (sau khi xoá thành công hoặc khi người dùng huỷ). */
  onClose: () => void;
}

/**
 * Dịch mã lỗi xoá vai trò của backend thành thông báo cho người dùng;
 * mã lạ thì dùng thông báo chung, không hiện mã kỹ thuật ra giao diện.
 */
function deleteErrorMessage(error: unknown, t: (key: string) => string): string {
  if (error instanceof ApiError) {
    if (error.problem.code === 'access.role_archetype_delete_forbidden') {
      return t('deleteRoleArchetypeForbidden');
    }
    if (error.problem.code === 'access.role_has_assignments') {
      return t('deleteRoleHasAssignments');
    }
  }
  return t('deleteRoleFailed');
}

export function RoleDeleteDialog({ open, role, onClose }: RoleDeleteDialogProps) {
  const { t } = useTranslation('app');
  const [error, setError] = useState<string | null>(null);
  const deleteMutation = useDeleteRole();

  /** Mỗi lần mở là một lượt xác nhận mới: xoá lỗi của lượt trước. */
  useEffect(() => {
    if (open) setError(null);
  }, [open ]);

  /** Phím Escape đóng hộp thoại khi không trong lúc xoá. */
  useEffect(() => {
    if (!open || deleteMutation.isPending) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, deleteMutation.isPending, onClose]);

  if (!open || !role) return null;

  /** Xoá vai trò: lỗi thì giữ hộp thoại mở kèm lý do; thành công thì đóng. */
  async function confirmDelete() {
    setError(null);
    try {
      await deleteMutation.mutateAsync(role.id);
      onClose();
    } catch (caught) {
      setError(deleteErrorMessage(caught, (key) => t(key)));
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
        aria-label={t('deleteRole')}
        className="w-full max-w-md rounded-xl border bg-background p-6 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="mb-2 text-lg font-semibold">{t('deleteRole')}</h2>
        <p className="mb-4 text-sm">{t('deleteRoleConfirm', { name: role.name })}</p>
        {error ? (
          <ErrorAlert variant="destructive" className="mb-4">
            {error}
          </ErrorAlert>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={deleteMutation.isPending}
            onClick={onClose}
          >
            {t('cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={deleteMutation.isPending}
            onClick={() => void confirmDelete()}
          >
            {deleteMutation.isPending ? t('deletingRole') : t('deleteRole')}
          </Button>
        </div>
      </div>
    </div>
  );
}

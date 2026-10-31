import { useState } from 'react';
import type { RoleListItem } from '@lms/contracts';
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
import { ApiError } from '#lib/api';
import { useTranslation } from 'react-i18next';
import '#config/i18n';
import { useDeleteRole } from '../queries/admin-roles';

/**
 * Hộp thoại xác nhận xoá vai trò của feature admin, dựng trên
 * component Dialog thật của `@lms/ui` theo hình hộp thoại xác nhận
 * xoá của mẫu (tiêu đề "Delete Role", câu xác nhận nêu tên vai trò,
 * nút huỷ phụ và nút xoá destructive).
 *
 * Luồng nghiệp vụ: hộp thoại nêu rõ tên vai trò sắp xoá và yêu cầu
 * xác nhận. Khi backend từ chối xoá, hộp thoại GIỮ NGUYÊN kèm đúng lý
 * do backend trả về — vai dựng sẵn (có `archetype`) và vai còn người
 * giữ là hai trường hợp phân biệt bằng mã lỗi riêng; vai thường không
 * còn người giữ thì xoá thành công, hộp thoại đóng và lưới thẻ cập
 * nhật ngay qua việc làm mới truy vấn danh sách vai.
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

  if (!open || !role) return null;

  /** Xoá vai trò: lỗi thì giữ hộp thoại mở kèm lý do; thành công thì đóng. */
  async function confirmDelete() {
    if (!role) return;
    setError(null);
    try {
      await deleteMutation.mutateAsync(role.id);
      onClose();
    } catch (caught) {
      setError(deleteErrorMessage(caught, (key) => t(key)));
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
          <DialogTitle className="font-semibold">{t('deleteRole')}</DialogTitle>
          <DialogDescription>{t('deleteRoleConfirm', { name: role.name })}</DialogDescription>
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
            onClick={() => void confirmDelete()}
          >
            {deleteMutation.isPending ? t('deletingRole') : t('deleteRole')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

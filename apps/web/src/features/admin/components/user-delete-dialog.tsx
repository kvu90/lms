import { useState } from 'react';
import type { UserProfile } from '@lms/contracts';
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
import { useDeleteAdminUser } from '../queries/admin-users';

/**
 * Hộp thoại xác nhận xoá người dùng của feature admin, dựng trên
 * component Dialog chuẩn của `@lms/ui` (thay cho `window.confirm` của
 * trình duyệt mà trang danh sách dùng trước đây).
 *
 * Luồng nghiệp vụ: hộp thoại nêu rõ tên người dùng sắp xoá và yêu cầu
 * xác nhận tường minh. Xác nhận gọi đột biến xoá mềm
 * (DELETE /users/:id): thành công thì hộp thoại đóng và trang nhận
 * thông báo đã xoá qua `onDeleted` — danh sách và thẻ thống kê tự làm
 * mới vì đột biến vô hiệu hoá gốc khoá người dùng; thất bại thì hộp
 * thoại GIỮ NGUYÊN kèm thông báo lỗi để người dùng thử lại, không
 * đóng giả vờ thành công. Trong lúc đang xoá, cả hai nút đều khoá và
 * yêu cầu đóng từ primitive (phím Escape, bấm ra ngoài, nút ×) bị bỏ
 * qua cho tới khi đột biến kết thúc.
 *
 * @param props - Người dùng sắp xoá, hàm đóng và hàm báo đã xoá xong.
 */
export interface UserDeleteDialogProps {
  /** Người dùng sắp xoá; hộp thoại chỉ render khi có người dùng đích. */
  user: UserProfile;
  /** Đóng hộp thoại khi người dùng huỷ hoặc sau khi xoá thành công. */
  onClose: () => void;
  /** Báo cho trang biết việc xoá đã thành công để hiện thông báo. */
  onDeleted: () => void;
}

/**
 * Tên hiển thị của người dùng trong câu xác nhận: họ tên đầy đủ khi
 * có, lùi về tên đăng nhập khi hồ sơ trống cả họ lẫn tên — luôn nêu
 * đúng một định danh người dùng đọc được, không hiện id kỹ thuật.
 */
function displayNameOf(user: UserProfile): string {
  const fullName = `${user.firstName} ${user.lastName}`.trim();
  return fullName === '' ? user.username : fullName;
}

export function UserDeleteDialog({ user, onClose, onDeleted }: UserDeleteDialogProps) {
  const { t } = useTranslation('app');
  const [error, setError] = useState<string | null>(null);
  const deleteMutation = useDeleteAdminUser();

  /** Xoá người dùng: lỗi thì giữ hộp thoại mở kèm lý do; thành công thì đóng và báo trang. */
  async function confirmDelete() {
    setError(null);
    try {
      await deleteMutation.mutateAsync(user.id);
      onDeleted();
      onClose();
    } catch {
      setError(t('userDeleteFailed'));
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !deleteMutation.isPending) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('deleteUserTitle')}</DialogTitle>
          <DialogDescription>
            {t('confirmDeleteUser', { username: displayNameOf(user) })}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <ErrorAlert variant="destructive">
            {error}
          </ErrorAlert>
        ) : null}
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
            {deleteMutation.isPending ? t('deletingUser') : t('deleteAction')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

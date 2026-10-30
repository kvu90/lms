import { CAP } from '@lms/contracts';
import { useTranslation } from 'react-i18next';
import '#config/i18n';

/**
 * Ô chọn bốn trạng thái quyền dùng chung cho mọi bề mặt ma trận của
 * feature admin (hộp thoại ma trận vai trò và trang Quyền độc lập):
 * Cho phép (1) / Kế thừa (0) / Ngăn chặn (−1) / Cấm hẳn (−1000) —
 * đúng mô hình bốn trạng thái của hệ theo (năng lực × ngữ cảnh).
 * Tuyệt đối không thay bằng công tắc hai trạng thái: hai trạng thái
 * không có chỗ cho Ngăn chặn/Cấm hẳn nên sẽ hiển thị sai và làm mất
 * chốt chặn khi lưu.
 *
 * Dùng `<select>` native (bọc bởi cùng chuỗi class với các ô chọn
 * khác của feature) thay cho Select của Base UI vì select native mới
 * điều khiển được bằng `selectOptions` trong test component, và vì
 * ô ma trận cần đổi giá trị ngay bằng một lần chọn không qua lớp
 * popup. Kiểu dáng lấy theo SelectTrigger của hệ: cao h-9, bo
 * rounded-md, cỡ chữ text-sm.
 */

/** Chuỗi class của ô chọn native trong các bề mặt vai trò — dùng chung để mọi ô chọn nhìn nhất quán. */
export const NATIVE_SELECT_CLASS =
  'h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** Bốn giá trị quyền theo thứ tự hiển thị trong ô chọn. */
const PERMISSION_VALUES = [CAP.ALLOW, CAP.INHERIT, CAP.PREVENT, CAP.PROHIBIT] as const;

/**
 * Ô chọn giá trị quyền bốn trạng thái của một ô ma trận.
 *
 * @param props - Giá trị hiện tại của ô, hàm báo đổi giá trị, cờ khoá
 * ô (đang lưu hoặc ma trận chưa sẵn sàng) và nhãn truy cập của ô.
 */
export interface PermissionSelectProps {
  /** Giá trị bốn trạng thái đang hiển thị của ô. */
  value: number;
  /** Báo lên bề mặt chứa khi người dùng chọn giá trị mới. */
  onChange: (permission: number) => void;
  /** Khoá ô: không cho đổi trong lúc ô đang lưu hoặc dữ kiện chưa sẵn sàng. */
  disabled?: boolean;
  /** Nhãn truy cập mô tả ô (năng lực × vai trò) cho trình đọc màn hình. */
  ariaLabel: string;
}

export function PermissionSelect({ value, onChange, disabled, ariaLabel }: PermissionSelectProps) {
  const { t } = useTranslation('app');
  const PERMISSION_LABEL: Record<number, string> = {
    [CAP.ALLOW]: t('permAllow'),
    [CAP.INHERIT]: t('permInherit'),
    [CAP.PREVENT]: t('permPrevent'),
    [CAP.PROHIBIT]: t('permProhibit'),
  };
  return (
    <select
      aria-label={ariaLabel}
      className={NATIVE_SELECT_CLASS}
      value={String(value)}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.target.value))}
    >
      {PERMISSION_VALUES.map((permission) => (
        <option key={permission} value={String(permission)}>
          {PERMISSION_LABEL[permission]}
        </option>
      ))}
    </select>
  );
}

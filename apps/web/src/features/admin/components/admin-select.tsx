import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@lms/ui/components/select';

/**
 * Ô chọn dùng chung của các bề mặt vai trò & quyền trong feature
 * admin, dựng trên component Select thật của `@lms/ui` (Base UI) —
 * thay toàn bộ `<select>` native trước đây: nút mở mang viền,
 * `shadow-xs`, chevron và danh sách xổ dạng popover có style đúng
 * khuôn Select của bản demo mẫu, thay vì mũi tên và danh sách xổ
 * native của hệ điều hành.
 *
 * Hai thích ứng với API của Base UI, gói gọn trong component này để
 * mọi bề mặt gọi không phải tự xử lý:
 *
 * - Giá trị rỗng `''` (lựa chọn "Tất cả" của các bộ lọc, lựa chọn
 *   giữ chỗ "Chọn…" của các hộp thoại) không phải giá trị hợp lệ
 *   của Select nên được ánh xạ qua một giá trị đại diện nội bộ khi
 *   ra vào component; bề mặt gọi chỉ thấy `''` như trước.
 * - Nhãn của lựa chọn đang chọn lấy từ bảng `items` (giá trị →
 *   nhãn) để nút mở hiện nhãn dạng chữ thay vì giá trị kỹ thuật.
 */

/** Giá trị đại diện nội bộ cho lựa chọn mang giá trị `''` ở bề mặt gọi. */
const EMPTY_VALUE = '__empty__';

/** Một lựa chọn của ô chọn: giá trị nghiệp vụ và nhãn hiển thị. */
export interface AdminSelectOption {
  /** Giá trị nghiệp vụ (`''` cho lựa chọn "Tất cả"/giữ chỗ). */
  value: string;
  /** Nhãn hiển thị đã dịch. */
  label: string;
}

/** Thuộc tính của ô chọn dùng chung feature admin. */
export interface AdminSelectProps {
  /** Id của nút mở — nhãn FieldLabel của bề mặt gọi trỏ vào id này. */
  id?: string;
  /** Nhãn truy cập khi ô chọn không có nhãn nhìn thấy đi kèm (ô cỡ trang). */
  ariaLabel?: string;
  /** Giá trị đang chọn (`''` khi đang ở lựa chọn rỗng). */
  value: string;
  /** Báo bề mặt chứa khi người dùng chọn giá trị mới (`''` khi chọn lựa chọn rỗng). */
  onValueChange: (value: string) => void;
  /** Danh sách lựa chọn theo thứ tự hiển thị. */
  options: AdminSelectOption[];
  /** Khoá ô chọn (đang lưu, hoặc không có dữ kiện để chọn). */
  disabled?: boolean;
  /** Class bổ sung cho nút mở (mặc định `w-full` như các ô trong Field; ô cỡ trang truyền `w-fit`). */
  className?: string;
}

export function AdminSelect({
  id,
  ariaLabel,
  value,
  onValueChange,
  options,
  disabled,
  className,
}: AdminSelectProps) {
  const items = Object.fromEntries(
    options.map((option) => [option.value === '' ? EMPTY_VALUE : option.value, option.label]),
  );
  return (
    <Select
      items={items}
      value={value === '' ? EMPTY_VALUE : value}
      onValueChange={(next) => {
        if (typeof next === 'string') onValueChange(next === EMPTY_VALUE ? '' : next);
      }}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label={ariaLabel} className={className ?? 'w-full'}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem
            key={option.value === '' ? EMPTY_VALUE : option.value}
            value={option.value === '' ? EMPTY_VALUE : option.value}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

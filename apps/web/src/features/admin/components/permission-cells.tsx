import { CAP } from '@lms/contracts';
import { Badge } from '@lms/ui/components/badge';
import { Checkbox } from '@lms/ui/components/checkbox';
import { Toggle } from '@lms/ui/components/toggle';
import { Eye, Lock, PencilLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '#config/i18n';

/**
 * Ô điều khiển quyền của hai bề mặt ma trận (hộp thoại ma trận vai
 * trò và trang Quyền độc lập) sau phán quyết vòng sửa 3 của PR #601
 * ("hình dạng demo, dữ kiện thật", comment phán quyết 6539398880):
 *
 * - Hình dạng theo ngôn ngữ demo nhưng mỗi ô là MỘT năng lực thật:
 *   hộp thoại dùng Checkbox của `@lms/ui`, trang Quyền dùng Toggle
 *   của `@lms/ui` dạng nút icon size-8 (bật = `bg-primary/10
 *   text-primary`, tắt = ghost xám; icon theo loại năng lực — read
 *   là Eye, write là PencilLine, đúng cặp icon demo dùng cho
 *   Read/Write). Không có cột/nút Create/Delete vì dữ kiện của hệ
 *   không có hai trục đó.
 * - Vòng sửa bố cục của PR #601: cả hai bề mặt gom mỗi resource
 *   thành đúng MỘT hàng — hộp thoại bày các checkbox của một
 *   resource trên cùng hàng theo cụm Đọc/Ghi kèm nhãn hành động
 *   của năng lực; trang Quyền bày các nút toggle của một resource
 *   cạnh nhau trong cùng ô của hàng resource, tên năng lực truy
 *   được qua aria-label và `title` của nút.
 * - Ánh xạ hai trạng thái của vòng này: bật ⇔ Cho phép (1), tắt ⇔
 *   Kế thừa (0); thao tác bật/tắt chỉ ghi hai giá trị đó qua cơ chế
 *   lưu hiện hữu của từng bề mặt.
 * - Ô đang mang Ngăn chặn (−1) hoặc Cấm hẳn (−1000) đã lưu: bày huy
 *   hiệu mang tên trạng thái ngay cạnh ô (phân biệt rõ với ô Kế
 *   thừa đang tắt) và KHOÁ thao tác boolean trên ô đó — không thao
 *   tác nào ở hai bề mặt đổi được giá trị này trong vòng này. Biên
 *   tập đầy đủ bốn trạng thái thuộc đợt nối backend (issue #598).
 */

/**
 * Ô bị khoá thao tác boolean ở vòng này hay không: giá trị đang hiển
 * thị là Ngăn chặn hoặc Cấm hẳn đã lưu.
 *
 * @param value - Giá trị quyền bốn trạng thái đang hiển thị của ô.
 */
export function isLockedPermission(value: number): boolean {
  return value === CAP.PREVENT || value === CAP.PROHIBIT;
}

/**
 * Huy hiệu trạng thái khoá đặt cạnh ô mang Ngăn chặn/Cấm hẳn: Cấm
 * hẳn dùng biến thể destructive, Ngăn chặn dùng dải amber như huy
 * hiệu trạng thái chờ của hệ — cả hai đều khác hẳn ô Kế thừa (không
 * có huy hiệu).
 *
 * @param props - Giá trị khoá (Ngăn chặn hoặc Cấm hẳn) cần bày tên.
 */
function LockedPermissionMark({ value }: { value: number }) {
  const { t } = useTranslation('app');
  const prohibit = value === CAP.PROHIBIT;
  return (
    <Badge
      variant={prohibit ? 'destructive' : 'outline'}
      className={prohibit ? undefined : 'border-amber-600/30 bg-amber-600/10 text-amber-600'}
    >
      <Lock aria-hidden />
      {prohibit ? t('permProhibit') : t('permPrevent')}
    </Badge>
  );
}

/** Thuộc tính của ô checkbox quyền trong hộp thoại ma trận vai trò. */
export interface PermissionCheckboxCellProps {
  /** Giá trị bốn trạng thái đang hiển thị của ô. */
  value: number;
  /** Khoá ô vì lý do ngoài trạng thái khoá (đang lưu ở bề mặt chứa). */
  disabled?: boolean;
  /** Nhãn truy cập mô tả ô cho trình đọc màn hình. */
  ariaLabel: string;
  /** Báo bề mặt chứa khi người dùng bật (true = Cho phép) hoặc tắt (false = Kế thừa) ô. */
  onToggle: (allowed: boolean) => void;
}

/**
 * Ô checkbox của một năng lực trong hộp thoại ma trận vai trò: tích
 * khi ô đang Cho phép, trống khi Kế thừa; ô Ngăn chặn/Cấm hẳn hiện
 * trống kèm huy hiệu trạng thái và bị khoá.
 *
 * @param props - Xem {@link PermissionCheckboxCellProps}.
 */
export function PermissionCheckboxCell({ value, disabled, ariaLabel, onToggle }: PermissionCheckboxCellProps) {
  const locked = isLockedPermission(value);
  return (
    <span className="inline-flex items-center justify-center gap-2">
      <Checkbox
        aria-label={ariaLabel}
        checked={value === CAP.ALLOW}
        disabled={disabled || locked}
        onCheckedChange={(checked) => onToggle(checked)}
      />
      {locked ? <LockedPermissionMark value={value} /> : null}
    </span>
  );
}

/** Thuộc tính của ô toggle quyền trong trang Quyền độc lập. */
export interface PermissionToggleCellProps {
  /** Giá trị bốn trạng thái đang hiển thị của ô. */
  value: number;
  /** Loại năng lực (`read` | `write`) — quyết định icon của nút toggle. */
  capType: string;
  /** Khoá ô vì lý do ngoài trạng thái khoá (ô đang lưu ở bề mặt chứa). */
  disabled?: boolean;
  /** Nhãn truy cập mô tả ô (năng lực × vai trò) cho trình đọc màn hình. */
  ariaLabel: string;
  /**
   * Tên năng lực đầy đủ đặt ở thuộc tính `title` của nút: từ vòng
   * sửa bố cục của PR #601, một ô của bảng chứa nhiều nút icon cạnh
   * nhau nên tên năng lực phải truy được khi di chuột (tooltip gốc
   * của trình duyệt) bên cạnh aria-label.
   */
  title?: string;
  /** Báo bề mặt chứa khi người dùng bật (true = Cho phép) hoặc tắt (false = Kế thừa) ô. */
  onToggle: (allowed: boolean) => void;
}

/**
 * Ô toggle của một cặp (vai trò × năng lực) trong trang Quyền độc
 * lập: nút icon size-8 như demo — nhấn khi ô đang Cho phép, ghost
 * xám khi Kế thừa; ô Ngăn chặn/Cấm hẳn bị khoá và mang huy hiệu
 * trạng thái ngay dưới nút.
 *
 * @param props - Xem {@link PermissionToggleCellProps}.
 */
export function PermissionToggleCell({ value, capType, disabled, ariaLabel, title, onToggle }: PermissionToggleCellProps) {
  const locked = isLockedPermission(value);
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Toggle
        aria-label={ariaLabel}
        title={title}
        size="sm"
        pressed={value === CAP.ALLOW}
        disabled={disabled || locked}
        className="size-8 min-w-8 px-0 text-muted-foreground hover:text-foreground aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:bg-primary/20"
        onPressedChange={(pressed) => onToggle(pressed)}
      >
        {capType === 'read' ? <Eye /> : <PencilLine />}
      </Toggle>
      {locked ? <LockedPermissionMark value={value} /> : null}
    </span>
  );
}

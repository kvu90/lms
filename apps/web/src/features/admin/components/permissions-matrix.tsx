import { CAP, type CapabilityMatrixResponse } from '@lms/contracts';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@lms/ui/components/table';
import { useTranslation } from 'react-i18next';
import '#config/i18n';
import { type CapabilityGroup } from '../types/admin-roles';
import { PermissionToggleCell } from './permission-cells';

/**
 * Bảng ma trận quyền toàn trang của trang Quyền độc lập.
 *
 * Hình dáng theo bảng mẫu (ô tiêu đề đệm 16px, tên resource đệm 16px
 * đậm vừa, tiêu đề cột vai là tên đậm kèm dòng số người giữ 12px ở
 * dưới) nhưng giữ mô hình thật của hệ: MỖI RESOURCE MỘT HÀNG như
 * bảng mẫu (vòng sửa bố cục của PR #601), cột = vai trò. Ô của một
 * (resource × vai trò) chứa các nút toggle icon của TỪNG năng lực
 * thuộc resource đó đặt cạnh nhau — mỗi nút là một năng lực thật
 * theo phán quyết vòng sửa 3 của PR #601 ("hình dạng demo, dữ kiện
 * thật"): bật ⇔ Cho phép, tắt ⇔ Kế thừa — dùng chung component ô
 * với hộp thoại ma trận vai trò (xem `permission-cells.tsx`). Thứ
 * tự nút trong ô: năng lực loại read trước, loại write sau, trong
 * cùng loại xếp theo tên; tên đầy đủ của năng lực nằm ở aria-label
 * và title của nút để phân biệt các nút icon trong cùng ô. Không
 * chế trục Create/Delete: hệ chỉ có năng lực loại đọc và ghi. Ô
 * đang mang Ngăn chặn/Cấm hẳn đã lưu thì toggle bị khoá kèm huy
 * hiệu trạng thái, không thao tác nào ở trang đổi được giá trị đó
 * ở vòng này.
 *
 * Bảng chỉ trình bày ghi đè ĐÃ LƯU tại ngữ cảnh đang chọn, không
 * trình bày quyền hiệu lực sau kế thừa: năng lực vắng mặt trong đáp
 * ứng nghĩa là đang ở trạng thái kế thừa (INHERIT = 0) tại ngữ cảnh
 * đó. Trang chứa chỉ render bảng khi cả ba truy vấn (danh mục, cây
 * context, ma trận) đều thành công — ma trận chưa tải xong thì không
 * có ô nào hiển thị để sửa, nên không thể ghi từ ma trận chưa thấy.
 *
 * @param props - Các nhóm năng lực, đáp ứng ma trận, hàm đọc giá trị
 *   hiển thị của một ô (ghi đè lạc quan ưu tiên trước giá trị đã lưu),
 *   tập ô đang lưu (mỗi ô đang lưu khoá riêng, các ô khác vẫn sửa
 *   được) và hàm báo đổi giá trị một ô.
 */
export interface PermissionsMatrixProps {
  /** Các nhóm năng lực xếp theo tên resource, mỗi nhóm xếp theo tên. */
  groups: CapabilityGroup[];
  /** Đáp ứng ma trận toàn trang tại ngữ cảnh đang chọn. */
  matrix: CapabilityMatrixResponse;
  /**
   * Giá trị hiển thị của một ô: sửa đổi lạc quan của người dùng (nếu
   * có) rồi tới ghi đè đã lưu, vắng mặt thì kế thừa.
   */
  valueOf: (roleId: string, capability: string) => number;
  /** Ngữ cảnh đang hiển thị của ma trận — cùng vai trò và năng lực tạo thành khoá ô đang lưu. */
  contextId: string;
  /** Khoá `ngữ cảnh:vai trò:năng lực` của các ô đang chờ ghi xong. */
  savingCells: ReadonlySet<string>;
  /** Báo trang chứa khi người dùng đổi giá trị một ô. */
  onCellChange: (roleId: string, capability: string, permission: number) => void;
}

export function PermissionsMatrix({
  groups,
  matrix,
  contextId,
  valueOf,
  savingCells,
  onCellChange,
}: PermissionsMatrixProps) {
  const { t } = useTranslation('app');

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-10 p-4 font-semibold text-foreground">{t('capability')}</TableHead>
          {matrix.roles.map((role) => (
            <TableHead key={role.id} className="h-10 p-4 text-foreground">
              <span className="block font-semibold">{role.name}</span>
              <span className="block text-xs font-normal text-muted-foreground">
                {t('roleUsersCount', { count: role.userCount })}
              </span>
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group) => {
          // Thứ tự nút trong ô: loại read trước, loại write sau,
          // trong cùng loại xếp theo tên năng lực.
          const orderedCapabilities = [...group.capabilities].sort((left, right) =>
            left.capType === right.capType
              ? left.name.localeCompare(right.name)
              : left.capType === 'read'
                ? -1
                : 1,
          );
          return (
            <TableRow key={group.resource}>
              <TableCell className="p-4 font-medium whitespace-nowrap">{group.resource}</TableCell>
              {matrix.roles.map((role) => (
                <TableCell key={role.id} className="px-4 py-2">
                  <span className="inline-flex flex-wrap items-start gap-1">
                    {orderedCapabilities.map((capability) => {
                      const key = `${contextId}:${role.id}:${capability.name}`;
                      return (
                        <PermissionToggleCell
                          key={capability.name}
                          ariaLabel={t('permissionsCellLabel', {
                            capability: capability.name,
                            role: role.name,
                          })}
                          title={capability.name}
                          capType={capability.capType}
                          value={valueOf(role.id, capability.name)}
                          disabled={savingCells.has(key)}
                          onToggle={(allowed) =>
                            onCellChange(role.id, capability.name, allowed ? CAP.ALLOW : CAP.INHERIT)
                          }
                        />
                      );
                    })}
                  </span>
                </TableCell>
              ))}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

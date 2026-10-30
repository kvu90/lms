import { Fragment } from 'react';
import type { CapabilityMatrixResponse } from '@lms/contracts';
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
import { verbOfCapability, type CapabilityGroup } from '../types/admin-roles';
import { PermissionSelect } from './permission-select';

/**
 * Bảng ma trận quyền toàn trang của trang Quyền độc lập.
 *
 * Hình dáng theo bảng mẫu (ô tiêu đề đệm 16px, tên resource đệm 16px
 * đậm vừa, tiêu đề cột vai là tên đậm kèm dòng số người giữ 12px ở
 * dưới) nhưng giữ mô hình thật của hệ: hàng = năng lực thật gom theo
 * resource kèm hàng tiêu đề nhóm, cột = vai trò. Mỗi ô là MỘT điều
 * khiển bốn trạng thái dùng chung component với hộp thoại ma trận
 * vai trò (Cho phép / Kế thừa / Ngăn chặn / Cấm hẳn) — tuyệt đối
 * không dùng công tắc hai trạng thái và không dựng cột
 * Read/Write/Create/Delete tách riêng: hệ chỉ có năng lực loại đọc
 * và ghi, không có trục Create/Delete trong dữ kiện.
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
        {groups.map((group) => (
          <Fragment key={group.resource}>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableCell colSpan={matrix.roles.length + 1} className="p-4 font-medium">
                {group.resource}
              </TableCell>
            </TableRow>
            {group.capabilities.map((capability) => (
              <TableRow key={capability.name}>
                <TableCell className="p-4 whitespace-nowrap">
                  <strong>{verbOfCapability(capability.name)}</strong>{' '}
                  <code className="text-xs text-muted-foreground">{capability.name}</code>
                </TableCell>
                {matrix.roles.map((role) => {
                  const key = `${contextId}:${role.id}:${capability.name}`;
                  return (
                    <TableCell key={role.id} className="px-4 py-2">
                      <PermissionSelect
                        ariaLabel={t('permissionsCellLabel', {
                          capability: capability.name,
                          role: role.name,
                        })}
                        value={valueOf(role.id, capability.name)}
                        disabled={savingCells.has(key)}
                        onChange={(permission) => onCellChange(role.id, capability.name, permission)}
                      />
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}

import { Fragment } from 'react';
import { CAP, type CapabilityMatrixResponse } from '@lms/contracts';
import { NativeSelect, NativeSelectOption } from '@lms/ui/components/native-select';
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

/**
 * Bảng ma trận quyền toàn trang của trang Permissions độc lập.
 *
 * Hình dáng theo demo /apps/permissions nhưng giữ mô hình thật của
 * hệ: hàng = năng lực (124) gom theo resource (38) kèm hàng tiêu đề
 * nhóm, cột = vai trò (tiêu đề cột: tên vai + số người giữ phân biệt
 * từ đáp ứng ma trận, không gọi thêm). Mỗi ô là một điều khiển bốn
 * trạng thái (ALLOW / INHERIT / PREVENT / PROHIBIT) theo đúng ngôn
 * ngữ của hộp thoại ma trận vai trò — tuyệt đối không dùng công tắc
 * hai trạng thái: trạng thái hai giá trị không có ô cho PREVENT /
 * PROHIBIT nên sẽ hiển thị sai và làm mất chốt chặn khi lưu.
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

const PERMISSION_VALUES = [CAP.ALLOW, CAP.INHERIT, CAP.PREVENT, CAP.PROHIBIT] as const;

export function PermissionsMatrix({
  groups,
  matrix,
  contextId,
  valueOf,
  savingCells,
  onCellChange,
}: PermissionsMatrixProps) {
  const { t } = useTranslation('app');
  const PERMISSION_LABEL: Record<number, string> = {
    [CAP.ALLOW]: t('permAllow'),
    [CAP.INHERIT]: t('permInherit'),
    [CAP.PREVENT]: t('permPrevent'),
    [CAP.PROHIBIT]: t('permProhibit'),
  };

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('capability')}</TableHead>
          {matrix.roles.map((role) => (
            <TableHead key={role.id}>
              <span className="block font-medium">{role.name}</span>
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
            <TableRow className="bg-muted/50">
              <TableCell colSpan={matrix.roles.length + 1} className="text-sm font-medium">
                {group.resource}
              </TableCell>
            </TableRow>
            {group.capabilities.map((capability) => (
              <TableRow key={capability.name}>
                <TableCell>
                  <strong>{verbOfCapability(capability.name)}</strong>{' '}
                  <code className="text-xs text-muted-foreground">{capability.name}</code>
                </TableCell>
                {matrix.roles.map((role) => {
                  const key = `${contextId}:${role.id}:${capability.name}`;
                  return (
                    <TableCell key={role.id}>
                      <NativeSelect
                        aria-label={t('permissionsCellLabel', {
                          capability: capability.name,
                          role: role.name,
                        })}
                        value={String(valueOf(role.id, capability.name))}
                        onChange={(event) => {
                          onCellChange(role.id, capability.name, Number(event.target.value));
                        }}
                        disabled={savingCells.has(key)}
                      >
                        {PERMISSION_VALUES.map((value) => (
                          <NativeSelectOption key={value} value={String(value)}>
                            {PERMISSION_LABEL[value]}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
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

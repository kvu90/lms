import { useMemo, useState } from 'react';
import { CAP, type Capability, type RoleListItem } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Checkbox } from '@lms/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@lms/ui/components/dialog';
import { Field, FieldError, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@lms/ui/components/table';
import { ErrorAlert } from '#components/error-alert';
import type { ContextRow, RoleCapabilityRow } from '#lib/access';
import { useTranslation } from 'react-i18next';
import '#config/i18n';
import { contextOptionLabel } from '../api/context-labels';
import { useCreateRole, useReplaceRoleCapabilities, useUpdateRole } from '../queries/admin-roles';
import { groupCapabilitiesByResource, verbOfCapability, type RoleMatrixDraft } from '../types/admin-roles';
import { AdminSelect } from './admin-select';
import { isLockedPermission, PermissionCheckboxCell } from './permission-cells';

/**
 * Hộp thoại thêm/sửa vai trò kèm ma trận quyền của feature admin,
 * dựng trên component Dialog thật của `@lms/ui` theo số đo của hộp
 * thoại vai trò mẫu: khung rộng tối đa 768px (sm:max-w-3xl), cao tối
 * đa 90vh cuộn dọc, tiêu đề 16px semibold, form xếp dọc cách nhau
 * gap-6, ma trận nằm trong khung viền bo rounded-lg.
 *
 * Luồng nghiệp vụ:
 *
 * 1. Mở hộp thoại: trường tên/mô tả nạp từ vai đang sửa (hoặc trống khi
 *    tạo); `shortName` chỉ hiện khi tạo, bắt buộc và duy nhất, khi sửa
 *    thì khoá không cho đổi; ngữ cảnh mặc định là ngữ cảnh hệ thống
 *    (cấp 10). Trang chứa render hộp thoại có điều kiện nên mỗi lần mở
 *    là một lượt làm việc mới với state khởi tạo sạch. Hành động huỷ
 *    chỉ có đúng một nút ở chân hộp thoại — đóng bằng nút × của
 *    Dialog, bằng Huỷ hay bằng Escape đều bị chặn trong lúc đang lưu.
 *    Nhãn của ô chọn ngữ cảnh lấy qua adapter nhãn ngữ cảnh (tên cấp
 *    dạng chữ), không bày chuỗi kỹ thuật của dòng ngữ cảnh. Tên vai
 *    được kiểm ngay tại trường như form mẫu: ô nhập có placeholder,
 *    tên đã nhập mà ngắn hơn 2 ký tự thì hiện lỗi ngay dưới ô nhập
 *    và nút Lưu chỉ mở khi tên đạt tối thiểu đó — không còn trạng
 *    thái nút Lưu bị khoá lặng mà người dùng không biết lý do.
 * 2. Ma trận trình bày các ghi đè ĐÃ LƯU tại ngữ cảnh đang chọn, gom
 *    theo resource, dưới dạng bảng checkbox theo ngôn ngữ demo (vòng
 *    sửa 3 của PR #601 theo phán quyết "hình dạng demo, dữ kiện
 *    thật"): mỗi ô là một checkbox trên MỘT năng lực thật — tích là
 *    Cho phép, trống là Kế thừa — không dựng bốn cột
 *    Read/Write/Create/Delete. Vòng sửa bố cục của PR #601 gom mỗi
 *    resource thành đúng MỘT hàng như bảng mẫu: ô đầu là tên
 *    resource, kế là checkbox chọn cả nhóm, rồi cụm Đọc chứa các
 *    checkbox của năng lực loại read và cụm Ghi chứa các checkbox
 *    của năng lực loại write — mỗi checkbox kèm nhãn hành động của
 *    năng lực đó, mọi năng lực thật vẫn hiện và sửa được từng cái
 *    ngay trên hàng. Giá trị mỗi ô suy ra từ hai nguồn:
 *    sửa đổi của người dùng trong lượt này (ưu tiên) rồi tới dòng đã
 *    lưu của ngữ cảnh đang chọn, vắng mặt thì là kế thừa. Đổi ngữ cảnh
 *    xoá sạch sửa đổi của ngữ cảnh trước nên ma trận không bao giờ lẫn
 *    ghi đè giữa hai ngữ cảnh; ma trận tải về muộn cũng tự đúng vì giá
 *    trị suy ra trực tiếp từ props, không qua state đồng bộ bằng effect.
 *    Ô đang mang Ngăn chặn/Cấm hẳn đã lưu thì bị KHOÁ thao tác
 *    boolean và mang huy hiệu trạng thái: không thao tác nào trong
 *    hộp thoại đổi được giá trị đó, và khi lưu, giá trị đã lưu đi qua
 *    `valueOf` vào tập thay toàn bộ nên được giữ nguyên phía server.
 *    Biên tập đầy đủ bốn trạng thái thuộc đợt nối backend (#598).
 *    Cổng an toàn ở chế độ sửa: nút Lưu bị chặn cho tới khi ma trận tải
 *    thành công — lưu khi ma trận chưa về hoặc tải lỗi sẽ gửi PUT thay
 *    toàn bộ mang tập gần rỗng và xoá lặng ghi đè đã lưu; khi tải lỗi,
 *    hộp thoại hiện thông báo lỗi kèm nút thử lại thay vì hiện ma trận
 *    trống.
 * 3. Chọn theo cấp của bảng checkbox (thay cơ chế chọn nhanh bốn
 *    trạng thái trước đây): checkbox ở hàng tiêu đề đặt Cho phép/Kế
 *    thừa cho MỌI ô sửa được của ma trận, checkbox trên hàng của
 *    resource đặt cho các ô sửa được của resource đó; ô khoá (Ngăn
 *    chặn/Cấm hẳn) không thuộc phạm vi của cả hai cấp và không được
 *    tính vào trạng thái tích/mixed của checkbox cấp.
 * 4. Lưu: khi tạo — tạo vai trò trước, rồi lưu ma trận bằng endpoint
 *    thay toàn bộ tại ngữ cảnh đang chọn nếu ma trận có ghi đè khác kế
 *    thừa; khi sửa — cập nhật tên/mô tả rồi lưu ma trận bằng đúng một
 *    lần gọi thay toàn bộ cho ngữ cảnh đang chọn. Tạo xong nhưng lưu
 *    ma trận lỗi thì hộp thoại GIỮ NGUYÊN kèm thông báo riêng (không
 *    hiển thị như đã thành công); bấm Lưu lại chỉ cập nhật + lưu ma
 *    trận, không tạo vai trò trùng.
 *
 * @param props - Trạng thái mở, chế độ tạo/sửa, vai đang sửa, danh mục
 *   năng lực, các dòng ma trận đã lưu (mọi ngữ cảnh), trạng thái tải
 *   và tải lỗi của ma trận, hàm tải lại ma trận, cây context và hàm
 *   đóng hộp thoại.
 */
export interface RoleMatrixDialogProps {
  /** Hộp thoại đang mở hay không. */
  open: boolean;
  /** Chế độ tạo mới hay sửa vai trò có sẵn. */
  mode: 'create' | 'edit';
  /** Vai trò đang sửa; null ở chế độ tạo. */
  role: RoleListItem | null;
  /** Danh mục năng lực phẳng từ `GET /access/capabilities`. */
  capabilities: Capability[];
  /** Các dòng ma trận đã lưu của vai (mọi ngữ cảnh). */
  matrixRows: RoleCapabilityRow[];
  /** Ma trận đã lưu đang tải hay không. */
  matrixPending: boolean;
  /** Ma trận đã lưu tải lỗi hay không — chỉ bật ở chế độ sửa. */
  matrixError: boolean;
  /** Tải lại ma trận đã lưu (nút thử lại khi tải lỗi). */
  onMatrixRetry: () => void;
  /** Cây context phân quyền từ `GET /access/contexts`. */
  contexts: ContextRow[];
  /** Đóng hộp thoại (sau khi lưu thành công hoặc khi người dùng huỷ). */
  onClose: () => void;
}

export function RoleMatrixDialog({
  open,
  mode,
  role,
  capabilities,
  matrixRows,
  matrixPending,
  matrixError,
  onMatrixRetry,
  contexts,
  onClose,
}: RoleMatrixDialogProps) {
  const { t } = useTranslation('app');

  const [name, setName] = useState(role?.name ?? '');
  const [shortName, setShortName] = useState(role?.shortName ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  /** Ngữ cảnh người dùng đã chọn trong hộp thoại; trống nghĩa là dùng ngữ cảnh hệ thống mặc định. */
  const [contextOverride, setContextOverride] = useState('');
  /** Sửa đổi ma trận của người dùng trong lượt này, ghi đè lên dòng đã lưu khi hiển thị và khi lưu. */
  const [edits, setEdits] = useState<RoleMatrixDraft>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Id vai trò vừa tạo trong lượt này khi lưu ma trận lỗi — lần Lưu lại dùng id này thay vì tạo mới. */
  const [createdRoleId, setCreatedRoleId] = useState<string | null>(null);

  const createMutation = useCreateRole();
  const updateMutation = useUpdateRole();
  const replaceMutation = useReplaceRoleCapabilities();
  const saving = createMutation.isPending || updateMutation.isPending || replaceMutation.isPending;

  /** Ngữ cảnh hệ thống (cấp 10) — ngữ cảnh mặc định của hộp thoại. */
  const systemContextId = contexts.find((ctx) => ctx.contextLevel === 10)?.id ?? '';
  /** Ngữ cảnh đang sửa: lựa chọn tường minh, nếu chưa chọn thì ngữ cảnh hệ thống. */
  const contextId = contextOverride !== '' ? contextOverride : systemContextId;

  /** Các ghi đè đã lưu tại ngữ cảnh đang chọn, suy ra trực tiếp từ props. */
  const savedByCapability = useMemo(() => {
    const saved: RoleMatrixDraft = {};
    for (const row of matrixRows) {
      if (row.contextId === contextId) saved[row.capability] = row.permission;
    }
    return saved;
  }, [matrixRows, contextId]);

  /** Giá trị hiển thị của một ô: sửa đổi trong lượt này, rồi dòng đã lưu, rồi kế thừa. */
  function valueOf(capabilityName: string): number {
    return edits[capabilityName] ?? savedByCapability[capabilityName] ?? CAP.INHERIT;
  }

  /**
   * Một cụm checkbox cùng loại (Đọc hoặc Ghi) trên hàng của một
   * resource: mỗi năng lực là một checkbox kèm nhãn hành động của
   * nó; cụm rỗng (resource không có năng lực thuộc loại đó) hiện
   * dấu gạch ngang mờ thay vì để ô trống khó hiểu.
   */
  function renderCluster(cluster: Capability[]) {
    if (cluster.length === 0) return <span className="text-muted-foreground">—</span>;
    return (
      <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {cluster.map((capability) => (
          <span key={capability.name} className="inline-flex items-center gap-1.5">
            <PermissionCheckboxCell
              ariaLabel={capability.name}
              value={valueOf(capability.name)}
              disabled={saving}
              onToggle={(allowed) =>
                setEdits((prev) => ({
                  ...prev,
                  [capability.name]: allowed ? CAP.ALLOW : CAP.INHERIT,
                }))
              }
            />
            <span className="text-sm">{verbOfCapability(capability.name)}</span>
          </span>
        ))}
      </span>
    );
  }

  if (!open) return null;

  const groups = groupCapabilitiesByResource(capabilities);

  /**
   * Trạng thái của checkbox chọn theo cấp (toàn cục hoặc một nhóm
   * resource): chỉ tính các ô SỬA ĐƯỢC — ô khoá Ngăn chặn/Cấm hẳn
   * không thuộc phạm vi chọn và không làm checkbox cấp thành mixed.
   */
  function scopeState(scope: Capability[]): { checked: boolean; indeterminate: boolean } {
    const editable = scope.filter((capability) => !isLockedPermission(valueOf(capability.name)));
    const allowed = editable.filter((capability) => valueOf(capability.name) === CAP.ALLOW).length;
    return {
      checked: editable.length > 0 && allowed === editable.length,
      indeterminate: allowed > 0 && allowed < editable.length,
    };
  }

  /**
   * Đặt Cho phép (allowed = true) hoặc Kế thừa (false) cho mọi ô
   * sửa được trong một phạm vi; ô khoá giữ nguyên giá trị đã lưu
   * trong bản nháp — chọn theo cấp không bao giờ ghi đè Ngăn
   * chặn/Cấm hẳn.
   */
  function applyScope(scope: Capability[], allowed: boolean) {
    setEdits((prev) => {
      const next = { ...prev };
      for (const capability of scope) {
        const current = next[capability.name] ?? savedByCapability[capability.name] ?? CAP.INHERIT;
        if (isLockedPermission(current)) continue;
        next[capability.name] = allowed ? CAP.ALLOW : CAP.INHERIT;
      }
      return next;
    });
  }

  /**
   * Lưu hộp thoại: tạo/cập nhật vai trò rồi lưu ma trận thay toàn bộ
   * đúng một lần cho ngữ cảnh đang chọn. Lỗi ở bước nào thì dừng ở
   * bước đó, giữ hộp thoại mở kèm thông báo — không đóng như đã xong.
   */
  async function save() {
    setSaveError(null);
    const targetId = createdRoleId ?? role?.id ?? null;
    let step: 'role' | 'matrix' = 'role';
    try {
      let id = targetId;
      if (mode === 'create' && !id) {
        const created = await createMutation.mutateAsync({
          name: name.trim(),
          shortName: shortName.trim().toLowerCase(),
          description: description.trim() === '' ? undefined : description.trim(),
        });
        id = created.id;
        setCreatedRoleId(id);
      } else if (id) {
        await updateMutation.mutateAsync({
          roleId: id,
          draft: { name: name.trim(), description: description.trim() },
        });
      }
      if (!id || !contextId) return;
      step = 'matrix';
      const overrides = capabilities
        .map((capability) => ({ capability: capability.name, permission: valueOf(capability.name) }))
        .filter((entry) => entry.permission !== CAP.INHERIT);
      // Chế độ tạo mà ma trận toàn kế thừa thì vai mới vốn đã có 0 ghi
      // đè nên bỏ qua lần gọi thay toàn bộ; chế độ sửa luôn gọi một lần
      // để việc xoá hết ghi đè tại ngữ cảnh cũng được lưu.
      if (mode === 'edit' || overrides.length > 0) {
        await replaceMutation.mutateAsync({ roleId: id, payload: { contextId, overrides } });
      }
      onClose();
    } catch {
      // Vai đã tạo nhưng ma trận chưa lưu: thông báo riêng để người dùng
      // bấm Lưu lại thay vì tưởng đã xong hoặc tạo trùng vai trò.
      setSaveError(
        step === 'matrix' && (mode === 'create' || createdRoleId) ? t('roleCreatedMatrixFailed') : t('roleSaveFailed'),
      );
    }
  }

  const title = mode === 'create' ? t('roleDialogCreateTitle') : t('roleDialogEditTitle');
  /** Dòng mô tả phụ dưới tiêu đề, đổi theo chế độ tạo/sửa như mẫu hộp thoại quản trị chuẩn. */
  const subtitle = mode === 'create' ? t('roleDialogCreateDescription') : t('roleDialogEditDescription');
  /**
   * Chế độ sửa chỉ lưu được khi ma trận đã tải thành công: đang tải
   * hoặc tải lỗi mà vẫn cho lưu thì PUT thay toàn bộ mang tập gần
   * rỗng (mọi ô tính là kế thừa) và xoá lặng ghi đè đã lưu tại ngữ
   * cảnh đó. Chế độ tạo không có ma trận đã lưu nên không cần cổng.
   */
  const matrixReady = mode === 'create' || (!matrixPending && !matrixError);
  /**
   * Lỗi tên tại trường: tên đã nhập (khác rỗng) mà ngắn hơn 2 ký tự
   * thì báo ngay dưới ô nhập như form mẫu; tên còn trống thì chưa
   * báo lỗi nhưng nút Lưu vẫn khoá theo điều kiện `canSave`.
   */
  const nameError = name.trim() !== '' && name.trim().length < 2;
  const canSave =
    name.trim().length >= 2 && (mode === 'edit' || shortName.trim() !== '') && contextId !== '' && !saving && matrixReady;
  /** Trạng thái checkbox chọn toàn cục ở hàng tiêu đề bảng ma trận. */
  const allScopeState = scopeState(capabilities);

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        // Đang lưu thì giữ hộp thoại mở: đóng giữa chừng sẽ mất dấu
        // lần ghi đang chạy và trạng thái lỗi của nó.
        if (!nextOpen && !saving) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-semibold">{title}</DialogTitle>
          <DialogDescription>{subtitle}</DialogDescription>
        </DialogHeader>

        {saveError ? <ErrorAlert variant="destructive">{saveError}</ErrorAlert> : null}

        <div className="flex flex-col gap-6">
          <FieldGroup>
            <Field data-invalid={nameError || undefined}>
              <FieldLabel htmlFor="role-dialog-name">{t('roleName')}</FieldLabel>
              <Input
                id="role-dialog-name"
                placeholder={t('roleNamePlaceholder')}
                aria-invalid={nameError || undefined}
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={saving}
              />
              {nameError ? <FieldError>{t('roleNameTooShort')}</FieldError> : null}
            </Field>
            <Field>
              <FieldLabel htmlFor="role-dialog-shortname">{t('roleShortName')}</FieldLabel>
              <Input
                id="role-dialog-shortname"
                value={shortName}
                onChange={(e) => setShortName(e.target.value)}
                disabled={saving || mode === 'edit' || createdRoleId !== null}
              />
              <p className="text-xs text-muted-foreground">{t('roleShortNameHint')}</p>
            </Field>
            <Field>
              <FieldLabel htmlFor="role-dialog-description">{t('roleDescription')}</FieldLabel>
              <Input
                id="role-dialog-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={saving}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="role-dialog-context">{t('roleContext')}</FieldLabel>
              <AdminSelect
                id="role-dialog-context"
                value={contextId}
                onValueChange={(next) => {
                  // Đổi ngữ cảnh là đổi tập ghi đè đang sửa: xoá sạch sửa
                  // đổi của ngữ cảnh trước để không lẫn sang ngữ cảnh mới.
                  setContextOverride(next);
                  setEdits({});
                }}
                disabled={saving || contexts.length === 0}
                options={[
                  { value: '', label: t('selectContext') },
                  ...contexts.map((ctx) => ({
                    value: ctx.id,
                    label: contextOptionLabel(contexts, ctx, (key, options) => t(key, options)),
                  })),
                ]}
              />
            </Field>
          </FieldGroup>

          <div>
            <h3 className="mb-3 text-sm font-medium">{t('roleMatrix')}</h3>
            {matrixError ? (
              <>
                <ErrorAlert variant="destructive" className="mb-3">
                  {t('roleMatrixLoadFailed')}
                </ErrorAlert>
                <Button type="button" variant="outline" size="sm" onClick={onMatrixRetry}>
                  {t('retry')}
                </Button>
              </>
            ) : matrixPending ? (
              <p className="text-sm text-muted-foreground">{t('loading')}</p>
            ) : (
              <div className="overflow-hidden rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-48 p-3">{t('resource')}</TableHead>
                      <TableHead className="w-16 p-3 text-center">
                        <Checkbox
                          aria-label={t('roleSelectAllPermissions')}
                          checked={allScopeState.checked}
                          indeterminate={allScopeState.indeterminate}
                          disabled={saving}
                          onCheckedChange={(checked) => applyScope(capabilities, checked)}
                        />
                      </TableHead>
                      <TableHead className="p-3">{t('roleReadLabel')}</TableHead>
                      <TableHead className="p-3">{t('roleWriteLabel')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {groups.map((group) => (
                      <TableRow key={group.resource}>
                        <TableCell className="p-3 font-medium whitespace-nowrap">{group.resource}</TableCell>
                        <TableCell className="p-3 text-center">
                          <Checkbox
                            aria-label={t('roleSelectAllForResource', { resource: group.resource })}
                            checked={scopeState(group.capabilities).checked}
                            indeterminate={scopeState(group.capabilities).indeterminate}
                            disabled={saving}
                            onCheckedChange={(checked) => applyScope(group.capabilities, checked)}
                          />
                        </TableCell>
                        <TableCell className="p-3">
                          {renderCluster(group.capabilities.filter((capability) => capability.capType === 'read'))}
                        </TableCell>
                        <TableCell className="p-3">
                          {renderCluster(group.capabilities.filter((capability) => capability.capType === 'write'))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="button" disabled={!canSave} onClick={() => void save()}>
            {saving ? t('savingRole') : t('saveRole')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

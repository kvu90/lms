import { useEffect, useMemo, useState } from 'react';
import { CAP, type Capability, type RoleListItem } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { X } from 'lucide-react';
import { ErrorAlert } from '#components/error-alert';
import type { ContextRow, RoleCapabilityRow } from '#lib/access';
import { useTranslation } from 'react-i18next';
import '#config/i18n';
import { useCreateRole, useReplaceRoleCapabilities, useUpdateRole } from '../queries/admin-roles';
import { groupCapabilitiesByResource, verbOfCapability, type RoleMatrixDraft } from '../types/admin-roles';

/**
 * Hộp thoại thêm/sửa vai trò kèm ma trận quyền của feature admin.
 *
 * Luồng nghiệp vụ (theo đặc tả đợt 2):
 *
 * 1. Mở hộp thoại: trường tên/mô tả nạp từ vai đang sửa (hoặc trống khi
 *    tạo); `shortName` chỉ hiện khi tạo, bắt buộc và duy nhất, khi sửa
 *    thì khoá không cho đổi; ngữ cảnh mặc định là ngữ cảnh hệ thống
 *    (cấp 10). Trang chứa render hộp thoại có điều kiện nên mỗi lần mở
 *    là một lượt làm việc mới với state khởi tạo sạch. Đầu hộp thoại
 *    gồm tiêu đề, một dòng mô tả phụ theo chế độ (tạo/sửa) và nút đóng
 *    × ở góc trên; hành động huỷ chỉ có đúng một nút ở hàng nút dưới
 *    cùng — đóng bằng ×, bằng Huỷ hay bằng Escape đều đi qua cùng một
 *    hàm đóng và cùng bị chặn trong lúc đang lưu.
 * 2. Ma trận trình bày các ghi đè ĐÃ LƯU tại ngữ cảnh đang chọn, gom
 *    theo resource, mỗi ô là một điều khiển bốn trạng thái (ALLOW /
 *    INHERIT / PREVENT / PROHIBIT) trên năng lực thật — không dựng bốn
 *    cột Read/Write/Create/Delete. Giá trị mỗi ô suy ra từ hai nguồn:
 *    sửa đổi của người dùng trong lượt này (ưu tiên) rồi tới dòng đã
 *    lưu của ngữ cảnh đang chọn, vắng mặt thì là kế thừa. Đổi ngữ cảnh
 *    xoá sạch sửa đổi của ngữ cảnh trước nên ma trận không bao giờ lẫn
 *    ghi đè giữa hai ngữ cảnh; ma trận tải về muộn cũng tự đúng vì giá
 *    trị suy ra trực tiếp từ props, không qua state đồng bộ bằng effect.
 *    Cổng an toàn ở chế độ sửa: nút Lưu bị chặn cho tới khi ma trận tải
 *    thành công — lưu khi ma trận chưa về hoặc tải lỗi sẽ gửi PUT thay
 *    toàn bộ mang tập gần rỗng và xoá lặng ghi đè đã lưu; khi tải lỗi,
 *    hộp thoại hiện thông báo lỗi kèm nút thử lại thay vì hiện ma trận
 *    trống.
 * 3. Chọn nhanh: chọn một trạng thái rồi bấm áp — theo hàng (mọi ô
 *    trong nhóm resource đó) hoặc toàn cục (mọi ô trong ma trận).
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

const PERMISSION_VALUES = [CAP.ALLOW, CAP.INHERIT, CAP.PREVENT, CAP.PROHIBIT] as const;

/** Lớp Tailwind dùng chung cho các ô select thuần trong hộp thoại. */
const SELECT_CLASS =
  'h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

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
  const PERMISSION_LABEL: Record<number, string> = {
    [CAP.ALLOW]: t('permAllow'),
    [CAP.INHERIT]: t('permInherit'),
    [CAP.PREVENT]: t('permPrevent'),
    [CAP.PROHIBIT]: t('permProhibit'),
  };

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
  const [quickGlobal, setQuickGlobal] = useState('');
  const [quickByResource, setQuickByResource] = useState<Record<string, string>>({});

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

  /** Phím Escape đóng hộp thoại khi không trong lúc lưu. */
  useEffect(() => {
    if (!open || saving) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, saving, onClose]);

  if (!open) return null;

  const groups = groupCapabilitiesByResource(capabilities);

  /** Đặt một trạng thái cho mọi năng lực trong một nhóm resource. */
  function applyToResource(resource: string, permission: number) {
    const group = groups.find((item) => item.resource === resource);
    if (!group) return;
    setEdits((prev) => {
      const next = { ...prev };
      for (const capability of group.capabilities) next[capability.name] = permission;
      return next;
    });
  }

  /** Đặt một trạng thái cho mọi năng lực trong toàn bộ ma trận. */
  function applyToAll(permission: number) {
    setEdits((prev) => {
      const next = { ...prev };
      for (const capability of capabilities) next[capability.name] = permission;
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
  const canSave =
    name.trim() !== '' && (mode === 'edit' || shortName.trim() !== '') && contextId !== '' && !saving && matrixReady;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[5vh]"
      onClick={() => {
        if (!saving) onClose();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-4xl rounded-xl border bg-background p-6 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">{title}</h2>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('closeDialog')}
            disabled={saving}
            onClick={onClose}
          >
            <X aria-hidden />
          </Button>
        </div>

        {saveError ? (
          <ErrorAlert variant="destructive" className="mb-4">
            {saveError}
          </ErrorAlert>
        ) : null}

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="role-dialog-name">{t('roleName')}</FieldLabel>
            <Input id="role-dialog-name" value={name} onChange={(e) => setName(e.target.value)} disabled={saving} />
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
            <select
              id="role-dialog-context"
              className={SELECT_CLASS}
              value={contextId}
              onChange={(e) => {
                // Đổi ngữ cảnh là đổi tập ghi đè đang sửa: xoá sạch sửa
                // đổi của ngữ cảnh trước để không lẫn sang ngữ cảnh mới.
                setContextOverride(e.target.value);
                setEdits({});
              }}
              disabled={saving || contexts.length === 0}
            >
              <option value="">{t('selectContext')}</option>
              {contexts.map((ctx) => (
                <option key={ctx.id} value={ctx.id}>
                  {t('contextOption', { level: ctx.contextLevel, instance: ctx.instanceId, path: ctx.path })}
                </option>
              ))}
            </select>
          </Field>
        </FieldGroup>

        <div className="mt-6">
          <h3 className="text-sm font-semibold">{t('roleMatrix')}</h3>
          <p className="mb-3 text-xs text-muted-foreground">{t('roleMatrixHint')}</p>
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
            <>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <label htmlFor="role-dialog-quick-all" className="text-sm font-medium">
                  {t('roleQuickApply')}
                </label>
                <select
                  id="role-dialog-quick-all"
                  className={SELECT_CLASS}
                  value={quickGlobal}
                  onChange={(e) => setQuickGlobal(e.target.value)}
                  disabled={saving}
                >
                  <option value="">—</option>
                  {PERMISSION_VALUES.map((value) => (
                    <option key={value} value={String(value)}>
                      {PERMISSION_LABEL[value]}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={saving || quickGlobal === ''}
                  onClick={() => applyToAll(Number(quickGlobal))}
                >
                  {t('applyToAll')}
                </Button>
              </div>

              <div className="space-y-6">
                {groups.map((group) => (
                  <section key={group.resource} aria-label={group.resource}>
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <h4 className="text-sm font-semibold">{group.resource}</h4>
                      <select
                        aria-label={t('roleQuickApplyRow', { resource: group.resource })}
                        className={SELECT_CLASS}
                        value={quickByResource[group.resource] ?? ''}
                        onChange={(e) => setQuickByResource((prev) => ({ ...prev, [group.resource]: e.target.value }))}
                        disabled={saving}
                      >
                        <option value="">—</option>
                        {PERMISSION_VALUES.map((value) => (
                          <option key={value} value={String(value)}>
                            {PERMISSION_LABEL[value]}
                          </option>
                        ))}
                      </select>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={saving || (quickByResource[group.resource] ?? '') === ''}
                        onClick={() => applyToResource(group.resource, Number(quickByResource[group.resource]))}
                      >
                        {t('applyToRow')}
                      </Button>
                    </div>
                    <ul className="divide-y rounded-md border">
                      {group.capabilities.map((capability) => (
                        <li key={capability.name} className="flex items-center justify-between gap-4 px-3 py-2">
                          <span className="min-w-0">
                            <strong>{verbOfCapability(capability.name)}</strong>{' '}
                            <code className="text-xs text-muted-foreground">{capability.name}</code>
                          </span>
                          <select
                            aria-label={capability.name}
                            className={`${SELECT_CLASS} shrink-0`}
                            value={String(valueOf(capability.name))}
                            onChange={(e) => {
                              const permission = Number(e.target.value);
                              setEdits((prev) => ({ ...prev, [capability.name]: permission }));
                            }}
                            disabled={saving}
                          >
                            {PERMISSION_VALUES.map((value) => (
                              <option key={value} value={String(value)}>
                                {PERMISSION_LABEL[value]}
                              </option>
                            ))}
                          </select>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="button" disabled={!canSave} onClick={() => void save()}>
            {saving ? t('savingRole') : t('saveRole')}
          </Button>
        </div>
      </div>
    </div>
  );
}

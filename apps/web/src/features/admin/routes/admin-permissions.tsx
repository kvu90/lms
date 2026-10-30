import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CAP } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent } from '@lms/ui/components/card';
import { Field, FieldLabel } from '@lms/ui/components/field';
import {
  NativeSelect,
  NativeSelectOption,
} from '@lms/ui/components/native-select';
import { PageSkeleton } from '#components/page-skeleton';
import { ErrorAlert } from '#components/error-alert';
import { useTranslation } from 'react-i18next';
import { PageHeader, PageShell } from '#components/page-shell';
import '#config/i18n';
import { useAccessCapabilities, useAccessContexts } from '#lib/access';
import { PermissionsMatrix } from '../components/permissions-matrix';
import {
  useCapabilityMatrix,
  useSetCapabilityOverride,
} from '../queries/admin-roles';
import { groupCapabilitiesByResource } from '../types/admin-roles';

/**
 * Trang Permissions độc lập: ma trận quyền toàn trang của mọi vai trò
 * tại một ngữ cảnh, theo hình dáng demo /apps/permissions nhưng giữ
 * mô hình thật của hệ (quyết định của issue #570).
 *
 * Luồng hiển thị:
 *
 * 1. Ba query TanStack: danh mục capability, cây context (dùng chung
 *    ở `src/lib/access.ts`) và ma trận toàn trang theo ngữ cảnh
 *    (feature query, `GET /access/capability-matrix`). Ngữ cảnh mặc
 *    định là ngữ cảnh hệ thống (cấp 10); đổi ngữ cảnh là đổi tập ghi
 *    đè đang xem — sửa đổi lạc quan của ngữ cảnh trước bị xoá sạch
 *    như hộp thoại ma trận, không lẫn sang ngữ cảnh mới.
 * 2. Ba thẻ tổng quan trên bảng: số vai trò trong đáp ứng ma trận, số
 *    resource phân biệt trong danh mục, và số ô đang ở trạng thái Cho
 *    phép (ALLOW) tại ngữ cảnh đang chọn — con số thứ ba đếm TRỰC
 *    TIẾP từ các ô đang hiển thị (ghi đè đã lưu + sửa đổi lạc quan)
 *    nên đổi một ô sang Cho phép tăng ngay 1, đổi khỏi Cho phép giảm
 *    ngay 1, không cần tải lại.
 * 3. Sửa từng ô áp dụng ngay qua `POST /access/overrides` (đúng một
 *    lần gọi cho một lần đổi, thân gồm vai trò + năng lực + ngữ cảnh
 *    + giá trị): trong lúc chờ, chỉ ô đó bị khoá (khoá mang cả
 *    ngữ cảnh nên đổi ngữ cảnh không khoá nhầm ô cùng vị trí ở
 *    ngữ cảnh mới); ghi lỗi thì ô hoàn
 *    lại giá trị trước đó kèm thông báo lỗi cho người dùng. Không có
 *    nút Lưu toàn trang, không tìm kiếm/lọc/phân trang cho bảng (demo
 *    cũng không có), không cột Read/Write/Create/Delete tách riêng —
 *    hệ chỉ có 124 năng lực với hai loại read/write, không có trục
 *    Create/Delete trong dữ liệu.
 * 4. Cổng an toàn như hộp thoại ma trận: khi ma trận chưa tải xong
 *    hoặc tải lỗi, trang hiện khung chờ hoặc thông báo lỗi kèm nút
 *    thử lại thay vì hiện bảng trống để sửa — ghi từ ma trận chưa
 *    thấy có thể ghi đè sai trạng thái đã lưu.
 */
export function AdminPermissionsPage() {
  const { t } = useTranslation('app');
  /** Ngữ cảnh người dùng đã chọn; trống nghĩa là dùng ngữ cảnh hệ thống mặc định. */
  const [contextOverride, setContextOverride] = useState('');
  /**
   * Sửa đổi lạc quan theo từng ô: vai trò → năng lực → giá trị bốn
   * trạng thái. Giá trị này ưu tiên trước ghi đè đã lưu khi hiển thị;
   * ghi lỗi thì mục tương ứng bị xoá để ô hoàn lại giá trị đã lưu.
   */
  const [edits, setEdits] = useState<Record<string, Record<string, number>>>({});
  /** Khoá `ngữ cảnh:vai trò:năng lực` của các ô đang chờ ghi xong. */
  const [savingCells, setSavingCells] = useState<ReadonlySet<string>>(new Set());
  /** Thông báo lỗi ghi của lần đổi ô gần nhất; null khi không có lỗi. */
  const [saveError, setSaveError] = useState<string | null>(null);

  const capabilitiesQuery = useAccessCapabilities();
  const contextsQuery = useAccessContexts();
  const contexts = contextsQuery.data ?? [];
  const systemContextId =
    contexts.find((ctx) => ctx.contextLevel === 10)?.id ?? contexts[0]?.id ?? '';
  const contextId = contextOverride || systemContextId;
  /**
   * Gương ngữ cảnh mới nhất để đối chiếu khi lỗi muộn về: callback
   * lỗi của lần ghi chụp ngữ cảnh lúc gọi, còn ngữ cảnh hiển thị
   * có thể đã đổi trong lúc chờ — chỉ hiện lỗi khi hai bên vẫn
   * trùng nhau (xem `handleCellChange`).
   */
  const contextIdRef = useRef(contextId);
  useEffect(() => {
    contextIdRef.current = contextId;
  }, [contextId]);
  const matrixQuery = useCapabilityMatrix(contextId);
  const setOverrideMutation = useSetCapabilityOverride();

  const matrix = matrixQuery.data;
  const groups = useMemo(
    () => groupCapabilitiesByResource(capabilitiesQuery.data ?? []),
    [capabilitiesQuery.data],
  );
  /** Bảng tra ghi đè đã lưu: `vai trò:năng lực` → giá trị. */
  const savedValues = useMemo(() => {
    const map = new Map<string, number>();
    for (const role of matrix?.roles ?? []) {
      for (const override of role.overrides) {
        map.set(`${role.id}:${override.capability}`, override.permission);
      }
    }
    return map;
  }, [matrix]);
  /** Giá trị hiển thị của một ô: sửa đổi lạc quan, rồi ghi đè đã lưu, rồi kế thừa. */
  const valueOf = useCallback(
    (roleId: string, capability: string) =>
      edits[roleId]?.[capability] ?? savedValues.get(`${roleId}:${capability}`) ?? CAP.INHERIT,
    [edits, savedValues],
  );
  /** Số ô Cho phép tại ngữ cảnh đang chọn, đếm từ các ô đang hiển thị. */
  const allowCount = useMemo(() => {
    if (!matrix) return 0;
    let count = 0;
    for (const role of matrix.roles) {
      for (const group of groups) {
        for (const capability of group.capabilities) {
          if (valueOf(role.id, capability.name) === CAP.ALLOW) count += 1;
        }
      }
    }
    return count;
  }, [matrix, groups, valueOf]);

  const contextsEmpty = contextsQuery.isSuccess && contexts.length === 0;
  const loadFailed =
    capabilitiesQuery.isError || contextsQuery.isError || matrixQuery.isError || contextsEmpty;
  const loading =
    !loadFailed &&
    (capabilitiesQuery.isPending || contextsQuery.isPending || matrixQuery.isPending);
  const matrixReady = !loadFailed && !loading && matrix !== undefined;

  /** Đổi một ô: ghi lạc quan ngay, khoá riêng ô đó, lỗi thì hoàn lại. */
  const handleCellChange = (roleId: string, capability: string, permission: number) => {
    const key = `${contextId}:${roleId}:${capability}`;
    setEdits((prev) => ({ ...prev, [roleId]: { ...prev[roleId], [capability]: permission } }));
    setSavingCells((prev) => new Set(prev).add(key));
    setSaveError(null);
    setOverrideMutation.mutate(
      { roleId, capability, contextId, permission },
      {
        onSuccess: () => {
          setSavingCells((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
        },
        onError: () => {
          setSavingCells((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
          // Chỉ hoàn lại khi ô vẫn đang giữ đúng giá trị ghi lỗi (người
          // dùng đổi tiếp ô đó trong lúc chờ thì giữ giá trị mới nhất).
          setEdits((prev) => {
            const roleEdits = prev[roleId];
            if (!roleEdits || roleEdits[capability] !== permission) return prev;
            const next = { ...prev };
            const nextRole = { ...roleEdits };
            delete nextRole[capability];
            if (Object.keys(nextRole).length === 0) delete next[roleId];
            else next[roleId] = nextRole;
            return next;
          });
          // Lỗi muộn về sau khi đã đổi ngữ cảnh thì không hiện sai
          // chỗ: chỉ hiện lỗi khi vẫn đang xem đúng ngữ cảnh của
          // lần ghi đó (gương ngữ cảnh mới nhất ở trên).
          if (contextIdRef.current === contextId) {
            setSaveError(t('permissionsSaveFailed'));
          }
        },
      },
    );
  };

  return (
    <PageShell width="full">
      <PageHeader title={t('navPermissions')} description={t('permissionsDescription')} />
      {loadFailed ? (
        <>
          <ErrorAlert variant="destructive">{t('permissionsLoadFailed')}</ErrorAlert>
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void capabilitiesQuery.refetch();
                void contextsQuery.refetch();
                void matrixQuery.refetch();
              }}
            >
              {t('retry')}
            </Button>
          </div>
        </>
      ) : null}
      {loading ? (
        <PageSkeleton label={t('loading')} rows={['h-9 w-full', 'h-9 w-full', 'h-9 w-full']} />
      ) : null}
      {matrixReady && matrix ? (
        <>
          <div className="max-w-xs">
            <Field>
              <FieldLabel htmlFor="permissions-context">{t('roleContext')}</FieldLabel>
              <NativeSelect
                id="permissions-context"
                value={contextId}
                onChange={(event) => {
                  // Đổi ngữ cảnh là đổi tập ghi đè đang xem: xoá sạch
                  // sửa đổi lạc quan của ngữ cảnh trước. Tập ô đang
                  // lưu KHÔNG xoá theo — khoá mang ngữ cảnh nên
                  // không khoá nhầm ô ở ngữ cảnh mới, và quay lại
                  // ngữ cảnh cũ khi yêu cầu còn chờ thì ô vẫn khoá.
                  setContextOverride(event.target.value);
                  setEdits({});
                  setSaveError(null);
                }}
                disabled={contexts.length === 0}
              >
                {contexts.map((ctx) => (
                  <NativeSelectOption key={ctx.id} value={ctx.id}>
                    {t('contextOption', {
                      level: ctx.contextLevel,
                      instance: ctx.instanceId,
                      path: ctx.path,
                    })}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardContent className="space-y-1">
                <div className="text-2xl font-bold">{matrix.roles.length}</div>
                <div className="text-sm text-muted-foreground">{t('permissionsRoleCount')}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="space-y-1">
                <div className="text-2xl font-bold">{groups.length}</div>
                <div className="text-sm text-muted-foreground">{t('permissionsResourceCount')}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="space-y-1">
                <div className="text-2xl font-bold">{allowCount}</div>
                <div className="text-sm text-muted-foreground">{t('permissionsAllowCount')}</div>
              </CardContent>
            </Card>
          </div>
          {saveError ? <ErrorAlert variant="destructive">{saveError}</ErrorAlert> : null}
          <Card>
            <CardContent>
              <div className="overflow-x-auto">
                <PermissionsMatrix
                  contextId={contextId}
                  groups={groups}
                  matrix={matrix}
                  valueOf={valueOf}
                  savingCells={savingCells}
                  onCellChange={handleCellChange}
                />
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}
    </PageShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default AdminPermissionsPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';
import { appKeyMeta } from '#lib/route-meta';
export function meta() {
  return appKeyMeta('navPermissions');
}

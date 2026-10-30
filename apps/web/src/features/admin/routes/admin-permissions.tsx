import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CAP } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent } from '@lms/ui/components/card';
import { Field, FieldLabel } from '@lms/ui/components/field';
import { PageSkeleton } from '#components/page-skeleton';
import { ErrorAlert } from '#components/error-alert';
import { useTranslation } from 'react-i18next';
import { PageShell } from '#components/page-shell';
import '#config/i18n';
import { useAccessCapabilities, useAccessContexts } from '#lib/access';
import { contextOptionLabel } from '../api/context-labels';
import { PermissionsMatrix } from '../components/permissions-matrix';
import { NATIVE_SELECT_CLASS } from '../components/permission-select';
import { useCapabilityMatrix, useSetCapabilityOverride } from '../queries/admin-roles';
import { groupCapabilitiesByResource } from '../types/admin-roles';

/**
 * Trang Quyền độc lập: ma trận quyền toàn trang của mọi vai trò tại
 * một ngữ cảnh, theo hình dáng trang Permissions mẫu (tiêu đề 20px
 * semibold kèm mô tả, ba thẻ tổng trên bảng, bảng phẳng trong thẻ
 * không bóng) nhưng giữ mô hình thật của hệ.
 *
 * Luồng hiển thị:
 *
 * 1. Ba query TanStack: danh mục capability, cây context (dùng chung
 *    ở `src/lib/access.ts`) và ma trận toàn trang theo ngữ cảnh
 *    (feature query, `GET /access/capability-matrix`). Bộ chọn ngữ
 *    cảnh là bắt buộc — ghi đè sống theo (năng lực × ngữ cảnh) nên
 *    trang không có trạng thái "mọi ngữ cảnh"; ngữ cảnh mặc định là
 *    ngữ cảnh hệ thống (cấp 10), nhãn ngữ cảnh lấy qua adapter nhãn
 *    (tên cấp dạng chữ). Đổi ngữ cảnh là đổi tập ghi đè đang xem —
 *    sửa đổi lạc quan của ngữ cảnh trước bị xoá sạch như hộp thoại
 *    ma trận, không lẫn sang ngữ cảnh mới.
 * 2. Ba thẻ tổng quan trên bảng: số vai trò trong đáp ứng ma trận, số
 *    resource phân biệt trong danh mục, và số ô đang ở trạng thái Cho
 *    phép (ALLOW) tại ngữ cảnh đang chọn — con số thứ ba đếm TRỰC
 *    TIẾP từ các ô đang hiển thị (ghi đè đã lưu + sửa đổi lạc quan)
 *    nên đổi một ô sang Cho phép tăng ngay 1, đổi khỏi Cho phép giảm
 *    ngay 1, không cần tải lại.
 * 3. Sửa từng ô áp dụng ngay qua `POST /access/overrides` (đúng một
 *    lần gọi cho một lần đổi, thân gồm vai trò + năng lực + ngữ cảnh
 *    + giá trị): trong lúc chờ, chỉ ô đó bị khoá (khoá mang cả ngữ
 *    cảnh nên đổi ngữ cảnh không khoá nhầm ô cùng vị trí ở ngữ cảnh
 *    mới); ghi lỗi thì ô hoàn lại giá trị trước đó kèm thông báo lỗi
 *    cho người dùng. Không có nút Lưu toàn trang, không tìm kiếm/lọc/
 *    phân trang cho bảng (bảng mẫu cũng không có), không cột
 *    Read/Write/Create/Delete tách riêng — hệ chỉ có năng lực loại
 *    đọc và ghi, không có trục Create/Delete trong dữ kiện.
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
      <div>
        <h1 className="font-heading text-xl font-semibold">{t('navPermissions')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('permissionsDescription')}</p>
      </div>
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
              <select
                id="permissions-context"
                className={`${NATIVE_SELECT_CLASS} w-full`}
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
                  <option key={ctx.id} value={ctx.id}>
                    {contextOptionLabel(contexts, ctx, (key, options) => t(key, options))}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 md:gap-6">
            <Card>
              <CardContent className="flex flex-col gap-1">
                <span className="text-2xl font-semibold">{matrix.roles.length}</span>
                <span className="text-sm text-muted-foreground">{t('permissionsRoleCount')}</span>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex flex-col gap-1">
                <span className="text-2xl font-semibold">{groups.length}</span>
                <span className="text-sm text-muted-foreground">{t('permissionsResourceCount')}</span>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex flex-col gap-1">
                <span className="text-2xl font-semibold">{allowCount}</span>
                <span className="text-sm text-muted-foreground">{t('permissionsAllowCount')}</span>
              </CardContent>
            </Card>
          </div>
          {saveError ? <ErrorAlert variant="destructive">{saveError}</ErrorAlert> : null}
          <Card className="gap-0 p-0 shadow-none">
            <CardContent className="p-0">
              <PermissionsMatrix
                contextId={contextId}
                groups={groups}
                matrix={matrix}
                valueOf={valueOf}
                savingCells={savingCells}
                onCellChange={handleCellChange}
              />
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

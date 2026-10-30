import { useState } from 'react';
import type { RoleListItem } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent } from '@lms/ui/components/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@lms/ui/components/dropdown-menu';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Ellipsis } from 'lucide-react';
import { PageSkeleton } from '#components/page-skeleton';
import { ErrorAlert } from '#components/error-alert';
import { useTranslation } from 'react-i18next';
import { PageShell } from '#components/page-shell';
import '#config/i18n';
import { useAccessCapabilities, useAccessContexts, useAccessRoles, useRoleCapabilities } from '#lib/access';
import { RoleAssignmentsSection } from '../components/role-assignments';
import { RoleDeleteDialog } from '../components/role-delete-dialog';
import { RoleMatrixDialog } from '../components/role-matrix-dialog';

/**
 * Trang quản trị vai trò: lưới thẻ vai trò + hộp thoại ma trận (đợt 2)
 * và khu vực bảng người dùng theo vai trò (đợt 3) thay thế form gán vai
 * rời rạc cũ — bảng này là lối gán/gỡ vai duy nhất của trang, form cũ
 * đã bị thay thế hoàn toàn vì hộp thoại gán từ bảng bao phủ đủ các
 * trường của nó (người dùng, vai trò, ngữ cảnh mặc định hệ thống) kèm
 * hiển thị đúng lý do của các chốt chặn gán mà form cũ không có.
 *
 * Luồng hiển thị:
 *
 * 1. Ba query TanStack dùng chung (lib/access.ts): danh sách vai kèm
 *    tổng hợp đợt 1, danh mục capability, cây context. Trang vào thẳng
 *    lưới thẻ, không có khối tiêu đề riêng phía trên lưới. Lưới thẻ
 *    dựng từ ĐÚNG MỘT lần gọi danh sách — mỗi thẻ hiện tên vai, số
 *    người giữ phân biệt và một dải số nền xám gồm đúng ba con số thật
 *    (Đọc / Ghi / Tổng số resource vai chạm tới, số lớn với nhãn nằm
 *    dưới số); thẻ cuối của lưới là một thẻ đầy đủ cùng kích thước
 *    gồm tiêu đề, mô tả ngắn và nút mở hộp thoại tạo vai trò — lối
 *    vào tạo vai trò duy nhất của trang.
 * 2. Menu ba chấm trên mỗi thẻ chỉ có hai mục: Sửa vai trò (mở hộp
 *    thoại ma trận ở chế độ sửa) và Xoá vai trò (mở hộp thoại xác nhận
 *    xoá). Hộp thoại thêm/sửa dùng chung cho tạo và sửa, lưu qua
 *    endpoint thay toàn bộ của đợt 1.
 * 3. Ma trận của vai đang sửa là query theo vai được chọn, lọc theo
 *    ngữ cảnh trong hộp thoại — đổi ngữ cảnh không gọi lại API, chỉ
 *    đổi tập ghi đè đang sửa.
 * 4. Khu vực bảng gán vai (component riêng) nhận danh sách vai và cây
 *    context đã tải ở đây để phân giải tên vai trò, nhãn ngữ cảnh và
 *    làm lựa chọn cho bộ lọc — bảng tự giữ trạng thái lọc/tìm/trang
 *    và gọi API đợt 1 theo đúng tham số đó.
 */
export function AdminRolesPage() {
  const { t } = useTranslation('app');
  /** Hộp thoại ma trận đang mở: chế độ tạo (role null) hoặc sửa một vai. */
  const [matrixDialog, setMatrixDialog] = useState<{
    mode: 'create' | 'edit';
    role: RoleListItem | null;
  } | null>(null);
  /** Vai trò đang chờ xác nhận xoá; null khi hộp thoại đóng. */
  const [deleteTarget, setDeleteTarget] = useState<RoleListItem | null>(null);

  const rolesQuery = useAccessRoles();
  const capabilitiesQuery = useAccessCapabilities();
  const contextsQuery = useAccessContexts();
  const matrixRole = matrixDialog?.mode === 'edit' ? matrixDialog.role : null;
  const matrixQuery = useRoleCapabilities(matrixRole?.id ?? null);

  const roles = rolesQuery.data ?? [];
  const capabilities = capabilitiesQuery.data ?? [];
  const contexts = contextsQuery.data ?? [];
  const matrix = matrixQuery.data ?? [];
  const loading = rolesQuery.isPending || capabilitiesQuery.isPending || contextsQuery.isPending;
  const loadFailed = rolesQuery.isError || capabilitiesQuery.isError || contextsQuery.isError;

  return (
    <PageShell width="full">
      {loadFailed ? (
        <>
          <ErrorAlert variant="destructive">{t('rolesLoadFailed')}</ErrorAlert>
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void rolesQuery.refetch();
                void capabilitiesQuery.refetch();
                void contextsQuery.refetch();
              }}
            >
              {t('retry')}
            </Button>
          </div>
        </>
      ) : null}
      <Card>
        <CardContent>
          {loading ? (
            <PageSkeleton label={t('loading')} rows={['h-9 w-full', 'h-9 w-full', 'h-9 w-full']} />
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {roles.map((r) => (
                  <Card key={r.id}>
                    <CardContent className="space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <strong>{r.name}</strong>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button type="button" variant="ghost" size="icon-sm" aria-label={t('roleActions')} />
                            }
                          >
                            <Ellipsis aria-hidden />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setMatrixDialog({ mode: 'edit', role: r })}>
                              {t('editRole')}
                            </DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget(r)}>
                              {t('deleteRole')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {t('roleUsersCount', { count: r.userCount ?? 0 })}
                      </p>
                      {/* Dải số của thẻ: đúng ba con số thật của hệ (ghi
                          đè Đọc, ghi đè Ghi, tổng resource) — hệ không có
                          khái niệm quyền Create/Delete tách riêng nên
                          không bày thêm con số như các mẫu quản trị
                          chung. */}
                      <div className="flex divide-x rounded-lg bg-muted text-center">
                        <div className="flex-1 px-2 py-3">
                          <div className="text-xl font-semibold">{r.readOverrideCount ?? 0}</div>
                          <div className="text-xs text-muted-foreground">{t('roleReadLabel')}</div>
                        </div>
                        <div className="flex-1 px-2 py-3">
                          <div className="text-xl font-semibold">{r.writeOverrideCount ?? 0}</div>
                          <div className="text-xs text-muted-foreground">{t('roleWriteLabel')}</div>
                        </div>
                        <div className="flex-1 px-2 py-3">
                          <div className="text-xl font-semibold">{r.resourceCount ?? 0}</div>
                          <div className="text-xs text-muted-foreground">{t('roleTotalLabel')}</div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
                {/* Thẻ thêm vai trò: một thẻ đầy đủ trong lưới (tiêu đề,
                    mô tả ngắn, nút nằm trong thẻ) thay cho dải nét đứt
                    trước đây, để lối vào tạo vai trò ngang hàng thị giác
                    với các thẻ vai trò. */}
                <Card>
                  <CardContent className="flex h-full flex-col items-start gap-2">
                    <strong>{t('addRoleCard')}</strong>
                    <p className="text-sm text-muted-foreground">{t('addRoleCardDescription')}</p>
                    <Button
                      type="button"
                      className="mt-auto"
                      onClick={() => setMatrixDialog({ mode: 'create', role: null })}
                    >
                      {t('addRoleCard')}
                    </Button>
                  </CardContent>
                </Card>
              </div>
              {roles.length === 0 ? (
                <Empty className="p-6">
                  <EmptyHeader>
                    <EmptyTitle>{t('noRolesYet')}</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <RoleAssignmentsSection roles={roles} contexts={contexts} />

      {/* Render có điều kiện: mỗi lần mở hộp thoại là một lượt làm việc mới với state khởi tạo sạch. */}
      {matrixDialog !== null ? (
        <RoleMatrixDialog
          open
          mode={matrixDialog.mode}
          role={matrixDialog.role}
          capabilities={capabilities}
          matrixRows={matrix}
          // Query ma trận chỉ bật khi sửa một vai; ở chế độ tạo, query bị
          // tắt vẫn mang trạng thái pending nên không được truyền thẳng.
          matrixPending={matrixRole !== null && matrixQuery.isPending}
          // Lỗi tải ma trận cũng phải vào hộp thoại: ma trận trống do lỗi
          // mà vẫn cho lưu thì PUT thay toàn bộ sẽ xoá lặng ghi đè đã lưu.
          matrixError={matrixRole !== null && matrixQuery.isError}
          onMatrixRetry={() => void matrixQuery.refetch()}
          contexts={contexts}
          onClose={() => setMatrixDialog(null)}
        />
      ) : null}
      {deleteTarget !== null ? (
        <RoleDeleteDialog open role={deleteTarget} onClose={() => setDeleteTarget(null)} />
      ) : null}
    </PageShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default AdminRolesPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';
import { appKeyMeta } from '#lib/route-meta';
export function meta() {
  return appKeyMeta('navRoles');
}

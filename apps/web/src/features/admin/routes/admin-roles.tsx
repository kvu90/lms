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
import { EllipsisVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { PageSkeleton } from '#components/page-skeleton';
import { ErrorAlert } from '#components/error-alert';
import { useTranslation } from 'react-i18next';
import { PageShell } from '#components/page-shell';
import '#config/i18n';
import { useAccessCapabilities, useAccessContexts, useAccessRoles, useRoleCapabilities } from '#lib/access';
import { RoleAssignmentsSection } from '../components/role-assignments';
import { RoleDeleteDialog } from '../components/role-delete-dialog';
import { RoleMatrixDialog } from '../components/role-matrix-dialog';
import { UsersWithRolesSection } from '../components/users-with-roles';

/**
 * Trang quản trị vai trò: lưới thẻ vai trò + hộp thoại ma trận, bảng
 * gán vai và bảng người dùng kèm vai trò — các hộp thoại gán từ hai
 * bảng bao phủ đủ các trường của form gán rời rạc cũ (người dùng, vai
 * trò, ngữ cảnh mặc định hệ thống) kèm hiển thị đúng lý do của các
 * chốt chặn gán mà form cũ không có, nên form cũ đã bị thay thế hoàn
 * toàn.
 *
 * Luồng hiển thị:
 *
 * 1. Ba query TanStack dùng chung (lib/access.ts): danh sách vai kèm
 *    tổng hợp, danh mục capability, cây context. Trang vào thẳng lưới
 *    thẻ, không có khối tiêu đề riêng phía trên lưới. Lưới thẻ dựng từ
 *    ĐÚNG MỘT lần gọi danh sách theo số đo của lưới thẻ mẫu: khe 20px,
 *    1/2/3 cột theo bề rộng; mỗi thẻ hiện tên vai 16px medium, dòng số
 *    người giữ 12px màu phụ ngay dưới tên, và một dải số nền xám nhạt
 *    (bo 8px, đệm 12×8) gồm đúng ba con số thật của hệ (ghi đè Đọc /
 *    ghi đè Ghi / Tổng số resource vai chạm tới — số 14px semibold,
 *    nhãn 10px màu phụ, vạch ngăn đứng trước con số Tổng; hệ không có
 *    khái niệm quyền Create/Delete tách riêng nên không bày thêm con
 *    số như các mẫu quản trị chung). Thẻ cuối của lưới là thẻ thêm vai
 *    cùng kích thước với nội dung căn giữa: tiêu đề 18px medium, dòng
 *    phụ 14px và nút outline kèm dấu cộng mở hộp thoại tạo vai trò —
 *    lối vào tạo vai trò duy nhất của trang.
 * 2. Menu ba chấm trên mỗi thẻ chỉ có hai mục: Sửa vai trò (mở hộp
 *    thoại ma trận ở chế độ sửa) và Xoá vai trò (mở hộp thoại xác nhận
 *    xoá, mục destructive). Hộp thoại thêm/sửa dùng chung cho tạo và
 *    sửa, lưu qua endpoint thay toàn bộ.
 * 3. Ma trận của vai đang sửa là query theo vai được chọn, lọc theo
 *    ngữ cảnh trong hộp thoại — đổi ngữ cảnh không gọi lại API, chỉ
 *    đổi tập ghi đè đang sửa.
 * 4. Hai khu vực bảng dưới lưới (component riêng) nhận danh sách vai
 *    và cây context đã tải ở đây: bảng gán vai (lọc theo vai trò/ngữ
 *    cảnh, tìm kiếm, phân trang phía server, hộp thoại gán/gỡ) và
 *    bảng người dùng kèm vai trò (một người một dòng kèm mọi gán của
 *    họ, đọc từ endpoint gộp) — mỗi bảng tự giữ trạng thái lọc/tìm/
 *    trang và gọi API theo đúng tham số đó.
 * 5. Trang đứng trong khung `app` của PageShell (trần 1440px, đệm
 *    trong trần, khoảng cách khối 24px) như trang quản trị của bản
 *    demo mẫu. Báo lỗi tải dữ kiện đi theo độ hạt của từng query:
 *    danh sách vai là dữ kiện chính — chỉ khi query này lỗi VÀ chưa
 *    có dữ kiện nào thì trang mới hiện banner lỗi toàn trang kèm nút
 *    thử lại; hai query phụ (danh mục capability, cây context) lỗi
 *    khi chưa có dữ kiện thì báo tại chỗ ở đầu trang, giữ nguyên dữ
 *    kiện đang hiển thị; đã có dữ kiện mà một lần làm mới nền lỗi
 *    thì không dựng banner phủ lên dữ kiện còn tốt. Trước đây cả ba
 *    query gộp thành một cờ lỗi duy nhất nên một lỗi tạm thời của
 *    endpoint phụ cũng bật banner "Không tải được vai trò" chập
 *    chờn theo nhịp làm mới nền.
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
  /**
   * Lỗi tải theo độ hạt của từng query (điểm 5 ở comment đầu file):
   * banner toàn trang chỉ khi danh sách vai lỗi và chưa có dữ kiện;
   * hai query phụ lỗi khi chưa có dữ kiện thì báo tại chỗ; lỗi làm
   * mới nền khi đã có dữ kiện không sinh thông báo nào.
   */
  const rolesLoadFailed = rolesQuery.isError && rolesQuery.data === undefined;
  const supportLoadFailed =
    !rolesLoadFailed &&
    ((capabilitiesQuery.isError && capabilitiesQuery.data === undefined) ||
      (contextsQuery.isError && contextsQuery.data === undefined));

  return (
    <PageShell width="app" contentClassName="gap-6">
      {rolesLoadFailed ? (
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
      {supportLoadFailed ? (
        <ErrorAlert
          variant="destructive"
          descriptionClassName="flex items-center justify-between gap-2"
        >
          <span>{t('rolesSupportLoadFailed')}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void capabilitiesQuery.refetch();
              void contextsQuery.refetch();
            }}
          >
            {t('retry')}
          </Button>
        </ErrorAlert>
      ) : null}
      {loading ? (
        <PageSkeleton label={t('loading')} rows={['h-9 w-full', 'h-9 w-full', 'h-9 w-full']} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {roles.map((r) => (
              <Card key={r.id}>
                <CardContent className="flex flex-col gap-3">
                  <div className="flex justify-between gap-2">
                    <div>
                      <h4 className="text-base leading-tight font-medium">{r.name}</h4>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t('roleUsersCount', { count: r.userCount ?? 0 })}
                      </p>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button type="button" variant="ghost" size="icon-sm" aria-label={t('roleActions')} />
                        }
                      >
                        <EllipsisVertical aria-hidden className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setMatrixDialog({ mode: 'edit', role: r })}>
                          <Pencil aria-hidden className="size-4" />
                          {t('editRole')}
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget(r)}>
                          <Trash2 aria-hidden className="size-4" />
                          {t('deleteRole')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  {/* Dải số của thẻ: đúng ba con số thật của hệ (ghi đè
                      Đọc, ghi đè Ghi, tổng resource) trên nền xám nhạt,
                      vạch ngăn đứng chỉ đặt trước con số Tổng. */}
                  <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
                    <div className="flex flex-1 flex-col items-center gap-0.5">
                      <span className="text-sm font-semibold">{r.readOverrideCount ?? 0}</span>
                      <span className="text-[10px] text-muted-foreground">{t('roleReadLabel')}</span>
                    </div>
                    <div className="flex flex-1 flex-col items-center gap-0.5">
                      <span className="text-sm font-semibold">{r.writeOverrideCount ?? 0}</span>
                      <span className="text-[10px] text-muted-foreground">{t('roleWriteLabel')}</span>
                    </div>
                    <div className="h-6 w-px bg-border" aria-hidden />
                    <div className="flex flex-1 flex-col items-center gap-0.5">
                      <span className="text-sm font-semibold">{r.resourceCount ?? 0}</span>
                      <span className="text-[10px] text-muted-foreground">{t('roleTotalLabel')}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
            {/* Thẻ thêm vai trò ở cuối lưới: nội dung căn giữa (tiêu
                đề, dòng phụ, nút outline kèm dấu cộng) — lối vào tạo
                vai trò ngang hàng thị giác với các thẻ vai trò. */}
            <Card className="items-center justify-center">
              <CardContent className="flex flex-col items-center justify-center gap-4">
                <div className="text-center">
                  <p className="text-lg font-medium">{t('addRoleCard')}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{t('addRoleCardDescription')}</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => setMatrixDialog({ mode: 'create', role: null })}
                >
                  <Plus aria-hidden className="size-4" />
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

      <RoleAssignmentsSection roles={roles} contexts={contexts} />

      <UsersWithRolesSection roles={roles} contexts={contexts} />

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

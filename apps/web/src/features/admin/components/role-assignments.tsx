import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { PaginationState } from '@tanstack/react-table';
import type { AssignmentListItem, RoleListItem } from '@lms/contracts';
import { Avatar, AvatarFallback } from '@lms/ui/components/avatar';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Field, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { PageSkeleton } from '#components/page-skeleton';
import { ErrorAlert } from '#components/error-alert';
import { DataTable, type DataColumn } from '#components/data-table';
import { useTranslation } from 'react-i18next';
import '#config/i18n';
import type { ContextRow } from '#lib/access';
import { formatDate } from '#utils/date-format';
import { roleAssignmentsQueryOptions } from '../queries/admin-roles';
import { RoleAssignmentDialog } from './role-assignment-dialog';
import { RoleUnassignDialog, type UnassignTarget } from './role-unassign-dialog';

/**
 * Khu vực bảng người dùng và vai trò của họ trên trang quản trị vai trò
 * (đợt 3, issue #547), đặt dưới lưới thẻ vai trò của đợt 2 và thay thế
 * form gán vai rời rạc cũ: bảng + bộ lọc + tìm kiếm + phân trang đều
 * chạy phía server trên hợp đồng đợt 1, thao tác gán/gỡ ngay tại bảng.
 *
 * Luồng hiển thị:
 *
 * 1. Trạng thái lọc/tìm/trang sống ở đây: đổi vai trò, ngữ cảnh, từ
 *    khoá hay trang đều đổi khoá truy vấn nên gọi lại
 *    GET /access/assignments với tham số tương ứng; tổng số dòng khớp
 *    do server trả về quyết định số trang. Bảng giữ keepPreviousData
 *    nên đổi lọc/trang không nháy rỗng mà chỉ hiện dòng "đang tải".
 *    Trang hiện tại được kẹp theo tổng mới nhất ngay trong lúc render
 *    (không dùng effect để tránh lỗi lint set-state-in-effect): sau
 *    khi gỡ — hay bất kỳ thay đổi nào làm tổng giảm — trang cũ có thể
 *    vượt quá trang cuối (ví dụ 21 dòng, cỡ trang 20, đang ở trang 2
 *    thì gỡ dòng duy nhất còn 20 dòng, tức 1 trang); lần render sau
 *    điều kiện đã sai nên dừng, và truy vấn tự tải lại trang hợp lệ
 *    cuối cùng thay vì kẹt ở trang rỗng không có nút quay lại.
 *    API chưa có hợp đồng sắp xếp nên bảng không bật sắp xếp cột —
 *    sắp xếp một trang đơn lẻ sẽ gây hiểu nhầm là sắp xếp toàn cục.
 * 2. Mỗi dòng gán là một bộ ba người dùng × vai trò × ngữ cảnh: cùng
 *    vai trò ở nhiều ngữ cảnh thành nhiều dòng. Tên vai trò và nhãn
 *    ngữ cảnh phân giải từ danh sách vai/cây context trang đã tải;
 *    định danh không phân giải được thì hiện đúng định danh đó thay vì
 *    bịa nhãn. Tên/email người dùng lấy từ phản hồi đã ghép sẵn của
 *    đợt 1; dòng trỏ tới người dùng không còn tồn tại (cả hai đều null)
 *    thì hiện trạng thái đó thay cho tên.
 * 3. Dòng do ghi danh quản lý (`component = 'enrol'`) không có nút gỡ:
 *    ô thao tác hiện thẳng trạng thái không gỡ trực tiếp được kèm lý
 *    do (phải rút ghi danh). Dòng thường có nút gỡ mở hộp thoại xác
 *    nhận; hộp thoại đó vẫn dịch mã `access.assignment_enrol_managed`
 *    cho trường hợp đua dữ kiện giữa lúc liệt kê và lúc bấm gỡ.
 * 4. Gán vai mở hộp thoại riêng từ bảng (chọn người dùng có tìm kiếm,
 *    chọn vai trò, chọn ngữ cảnh). Sau gán/gỡ thành công, đột biến làm
 *    mới gốc khoá bảng nên bảng tải lại đúng trang và bộ lọc hiện hành,
 *    đồng thời lưới thẻ cập nhật số người giữ qua tiền tố `access`.
 *
 * @param props - Danh sách vai trò và cây context trang đã tải, dùng để
 * phân giải tên vai trò, nhãn ngữ cảnh và làm lựa chọn cho bộ lọc.
 */
export interface RoleAssignmentsSectionProps {
  /** Danh sách vai trò (lưới thẻ của trang đã tải). */
  roles: RoleListItem[];
  /** Cây context (trang đã tải). */
  contexts: ContextRow[];
}

/** Các lựa chọn số dòng mỗi trang của bảng (API đợt 1 chặn tối đa 100). */
const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

/**
 * Kiểu ô chọn native của trang — cùng chuỗi class với hộp thoại ma trận
 * trên cùng trang để các ô chọn nhìn nhất quán; dùng select native
 * thay cho Select của Base UI vì select native mới điều khiển được
 * bằng selectOptions trong test component như hộp thoại ma trận.
 */
const SELECT_CLASS =
  'h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function RoleAssignmentsSection({ roles, contexts }: RoleAssignmentsSectionProps) {
  const { t } = useTranslation('app');
  /** '' nghĩa là không lọc theo tiêu chí đó — Select hiện mục "Tất cả". */
  const [roleFilter, setRoleFilter] = useState('');
  const [contextFilter, setContextFilter] = useState('');
  const [search, setSearch] = useState('');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 20 });
  const [assignOpen, setAssignOpen] = useState(false);
  /** Dòng đang chờ xác nhận gỡ; null khi hộp thoại đóng. */
  const [unassignTarget, setUnassignTarget] = useState<UnassignTarget | null>(null);

  const assignmentsQuery = useQuery({
    ...roleAssignmentsQueryOptions({
      roleId: roleFilter === '' ? undefined : roleFilter,
      contextId: contextFilter === '' ? undefined : contextFilter,
      search: search === '' ? undefined : search,
      page: pagination.pageIndex + 1,
      pageSize: pagination.pageSize,
    }),
    placeholderData: keepPreviousData,
  });
  const data = assignmentsQuery.data;
  const pageCount = Math.ceil((data?.total ?? 0) / pagination.pageSize);

  /**
   * Kẹp trang hiện tại theo tổng mới nhất, thực hiện ngay trong lúc
   * render theo mẫu "điều chỉnh state khi dữ liệu đổi" của React (không
   * dùng effect): khi tổng giảm mà trang hiện tại vượt quá trang cuối
   * thì đưa trang về trang cuối; lần render sau điều kiện đã sai nên
   * dừng, và truy vấn với trang mới tự tải lại dữ liệu đúng trang. Đổi
   * lọc/tìm/cỡ trang đã tự reset về trang 0 ở onChange nên đường kẹp
   * này chủ yếu bao phủ đường gỡ và mọi thay đổi tổng từ bên ngoài.
   */
  if (data && pagination.pageIndex > Math.max(0, pageCount - 1)) {
    setPagination((p) => ({ ...p, pageIndex: Math.max(0, pageCount - 1) }));
  }

  /** Tên vai trò của dòng gán, phân giải từ danh sách vai của trang. */
  function roleNameOf(row: AssignmentListItem): string {
    return roles.find((r) => r.id === row.roleId)?.name ?? row.roleId;
  }

  /** Nhãn ngữ cảnh của dòng gán kèm cấp ngữ cảnh, phân giải từ cây context của trang. */
  function contextLabelOf(row: AssignmentListItem): string {
    const ctx = contexts.find((c) => c.id === row.contextId);
    if (!ctx) return row.contextId;
    return t('contextOption', { level: ctx.contextLevel, instance: ctx.instanceId, path: ctx.path });
  }

  /** Tên người dùng hiển thị của dòng gán; null khi người dùng không còn tồn tại. */
  function userLabelOf(row: AssignmentListItem): string {
    return row.userName ?? t('assignmentMissingUser');
  }

  const columns: DataColumn<AssignmentListItem>[] = [
    {
      id: 'user',
      header: t('assignmentUserColumn'),
      cell: (row) => (
        <span className="flex items-center gap-2">
          <Avatar>
            <AvatarFallback>{row.userName ? row.userName.charAt(0) : '?'}</AvatarFallback>
          </Avatar>
          <span>
            <strong className="block">{userLabelOf(row)}</strong>
            <span className="block text-sm text-muted-foreground">{row.userEmail ?? '—'}</span>
          </span>
        </span>
      ),
    },
    {
      id: 'role',
      header: t('assignmentRoleColumn'),
      cell: (row) => roleNameOf(row),
    },
    {
      id: 'context',
      header: t('assignmentContextColumn'),
      cell: (row) => contextLabelOf(row),
    },
    {
      id: 'assignedAt',
      header: t('assignmentAssignedAtColumn'),
      cell: (row) => formatDate(row.updatedAt),
    },
    {
      id: 'actions',
      header: t('assignmentActionsColumn'),
      cell: (row) =>
        row.component === 'enrol' ? (
          <span className="text-sm text-muted-foreground">{t('assignmentEnrolManaged')}</span>
        ) : (
          <Button
            type="button"
            variant="destructive"
            onClick={() =>
              setUnassignTarget({
                assignment: row,
                userLabel: userLabelOf(row),
                roleLabel: roleNameOf(row),
                contextLabel: contextLabelOf(row),
              })
            }
          >
            {t('unassignRole')}
          </Button>
        ),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('assignmentTableTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <Field>
            <FieldLabel htmlFor="assignment-search">{t('assignmentSearch')}</FieldLabel>
            <Input
              id="assignment-search"
              placeholder={t('assignmentSearchPlaceholder')}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPagination((p) => ({ ...p, pageIndex: 0 }));
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="assignment-role-filter">{t('assignmentFilterRole')}</FieldLabel>
            <select
              id="assignment-role-filter"
              className={SELECT_CLASS}
              value={roleFilter}
              onChange={(e) => {
                setRoleFilter(e.target.value);
                setPagination((p) => ({ ...p, pageIndex: 0 }));
              }}
            >
              <option value="">{t('assignmentFilterRoleAll')}</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="assignment-context-filter">{t('assignmentFilterContext')}</FieldLabel>
            <select
              id="assignment-context-filter"
              className={SELECT_CLASS}
              value={contextFilter}
              onChange={(e) => {
                setContextFilter(e.target.value);
                setPagination((p) => ({ ...p, pageIndex: 0 }));
              }}
            >
              <option value="">{t('assignmentFilterContextAll')}</option>
              {contexts.map((c) => (
                <option key={c.id} value={c.id}>
                  {t('contextOption', { level: c.contextLevel, instance: c.instanceId, path: c.path })}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="assignment-pagesize">{t('assignmentPageSize')}</FieldLabel>
            <select
              id="assignment-pagesize"
              className={SELECT_CLASS}
              value={String(pagination.pageSize)}
              onChange={(e) => {
                const next = Number(e.target.value);
                setPagination({
                  pageIndex: 0,
                  pageSize: PAGE_SIZE_OPTIONS.includes(next as 10 | 20 | 50) ? next : 20,
                });
              }}
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={String(n)}>
                  {String(n)}
                </option>
              ))}
            </select>
          </Field>
          <Button type="button" onClick={() => setAssignOpen(true)}>
            {t('assignRole')}
          </Button>
        </div>
        {assignmentsQuery.isError ? (
          <ErrorAlert variant="destructive" descriptionClassName="flex items-center justify-between gap-2">
            <span>{t('assignmentLoadFailed')}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void assignmentsQuery.refetch()}>
              {t('retry')}
            </Button>
          </ErrorAlert>
        ) : null}
        {assignmentsQuery.isFetching && !assignmentsQuery.isPending ? (
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        ) : null}
        <p className="text-sm text-muted-foreground">{t('assignmentTotal', { total: data?.total ?? 0 })}</p>
        {assignmentsQuery.isPending ? (
          <PageSkeleton label={t('loading')} rows={['h-9 w-full', 'h-9 w-full', 'h-9 w-full']} />
        ) : (
          <DataTable
            data={data?.assignments ?? []}
            columns={columns}
            labels={{
              columns: t('dashboard:tableColumns'),
              previous: t('dashboard:tablePrevious'),
              next: t('dashboard:tableNext'),
              empty: t('assignmentEmpty'),
              pageInfo: (page, pages) => t('dashboard:tablePageInfo', { page, pages }),
            }}
            getRowId={(row) => row.id}
            manualPagination
            pageCount={pageCount}
            pagination={pagination}
            onPaginationChange={setPagination}
          />
        )}
      </CardContent>
      {/* Render có điều kiện: mỗi lần mở hộp thoại là một lượt làm việc mới với state khởi tạo sạch. */}
      {assignOpen ? (
        <RoleAssignmentDialog
          open
          roles={roles}
          contexts={contexts}
          onClose={() => setAssignOpen(false)}
        />
      ) : null}
      {unassignTarget !== null ? (
        <RoleUnassignDialog open target={unassignTarget} onClose={() => setUnassignTarget(null)} />
      ) : null}
    </Card>
  );
}

import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { RoleListItem, UserListStatus, UserWithAssignmentsListItem } from '@lms/contracts';
import { Avatar, AvatarFallback } from '@lms/ui/components/avatar';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Field, FieldLabel } from '@lms/ui/components/field';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@lms/ui/components/input-group';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@lms/ui/components/table';
import { EllipsisVertical, Plus, Search } from 'lucide-react';
import { PageSkeleton } from '#components/page-skeleton';
import { ErrorAlert } from '#components/error-alert';
import { useTranslation } from 'react-i18next';
import '#config/i18n';
import type { ContextRow } from '#lib/access';
import { formatWithOptions } from '#utils/date-format';
import { assignmentContextLabel } from '../api/context-labels';
import { usersWithAssignmentsQueryOptions } from '../queries/admin-roles';
import { AdminSelect } from './admin-select';
import { RoleAssignmentDialog } from './role-assignment-dialog';
import { RoleUserDialog, userDisplayName } from './role-user-dialog';
import { TablePagination } from './table-pagination';

/**
 * Bảng người dùng kèm vai trò của họ trên trang vai trò — một dòng là
 * một người dùng kèm toàn bộ gán vai của người đó, đọc từ endpoint
 * gộp `GET /access/users-with-assignments`, không gọi danh sách
 * người dùng và danh sách gán riêng lẻ rồi tự ghép ở client.
 *
 * Hình dáng theo thẻ bảng "Total users with their roles" của mẫu:
 * thẻ phẳng, đầu thẻ có viền dưới (tiêu đề 18px medium + mô tả),
 * vùng lọc gồm hai khối riêng ngăn nhau bằng viền dưới, mỗi khối đệm
 * 24px — khối lọc là hai ô chọn có nhãn đặt phía trên (vai trò,
 * trạng thái; KHÔNG có ô chọn gói dịch vụ vì gói thuộc về trung tâm,
 * không thuộc về người dùng), khối công cụ là ô tìm kiếm bên trái và
 * cụm cỡ trang + nút Gán vai trò bên phải (KHÔNG có Export/Import vì
 * hệ không có endpoint đó). Mọi ô chọn là Select của `@lms/ui` qua
 * component dùng chung của feature. Hàng bảng cao 56px:
 * người dùng là avatar 36px kèm tên đậm và email xám dưới tên; cột
 * vai trò bày MỌI gán của người đó kèm nhãn cấp ngữ cảnh dạng chữ
 * qua adapter — không bày định danh hay đường dẫn kỹ thuật; trạng
 * thái là pill màu theo trạng thái tài khoản; ngày tham gia bày dạng
 * chữ; cột thao tác mở hộp thoại quản lý gán của đúng người đó.
 * Không có cột chọn hàng (không có thao tác hàng loạt nào đứng sau)
 * và không có cột Plan/Billing. Chân bảng là dòng "Hiển thị X đến Y
 * trong Z mục" kèm cụm nút chuyển trang 36px.
 *
 * Luồng hiển thị:
 *
 * 1. Trạng thái lọc/tìm/trang sống ở đây: đổi vai trò, trạng thái, từ
 *    khoá hay trang đều đổi khoá truy vấn nên gọi lại endpoint gộp
 *    với tham số tương ứng; tổng số NGƯỜI DÙNG khớp do server trả về
 *    quyết định số trang (tổng đếm người dùng, không đếm dòng gán).
 *    Bảng giữ keepPreviousData nên đổi lọc/trang không nháy rỗng.
 *    Trang hiện tại được kẹp theo tổng mới nhất ngay trong lúc render
 *    như bảng gán vai (không dùng effect). API không có hợp đồng sắp
 *    xếp nên bảng không bật sắp xếp cột.
 * 2. Quản lý gán vai không yếu đi: nút thao tác của dòng mở hộp thoại
 *    liệt kê mọi gán của người đó — gán tay gỡ qua hộp thoại xác nhận
 *    hiện hành, gán do ghi danh cấp (`component = 'enrol'`) không có
 *    thao tác gỡ và hiện thẳng lý do; trong hộp thoại có lối vào gán
 *    thêm cho chính người đó (người dùng chọn sẵn). Sau gán/gỡ thành
 *    công, đột biến làm mới gốc khoá bảng nên bảng tải lại đúng trang
 *    và bộ lọc hiện hành, đồng thời lưới thẻ cập nhật số người giữ
 *    qua tiền tố `access`.
 *
 * @param props - Danh sách vai trò (dùng cho bộ lọc vai trò và hộp
 * thoại gán) và cây context (dùng cho hộp thoại gán, hộp thoại quản
 * lý gán và cột vai trò) do trang đã tải.
 */
export interface UsersWithRolesSectionProps {
  /** Danh sách vai trò (lưới thẻ của trang đã tải). */
  roles: RoleListItem[];
  /** Cây context (trang đã tải, dùng cho hộp thoại gán, hộp thoại quản lý và cột vai trò). */
  contexts: ContextRow[];
}

/** Các lựa chọn cỡ trang của bảng theo mẫu (mặc định 10). */
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

/** Chữ viết tắt cho avatar: chữ đầu của họ và tên, lùi về chữ đầu của tên đăng nhập. */
function initialsOf(user: UserWithAssignmentsListItem): string {
  const initials = `${user.firstName.charAt(0)}${user.lastName.charAt(0)}`.trim().toUpperCase();
  return initials === '' ? user.username.charAt(0).toUpperCase() : initials;
}

export function UsersWithRolesSection({ roles, contexts }: UsersWithRolesSectionProps) {
  const { t } = useTranslation('app');
  /** '' nghĩa là không lọc theo tiêu chí đó. */
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | UserListStatus>('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [assignOpen, setAssignOpen] = useState(false);
  /** Người đang mở hộp thoại quản lý gán; bám theo dòng mới nhất của bảng khi bảng tải lại. */
  const [manageUserId, setManageUserId] = useState<string | null>(null);
  /** Người đang mở hộp thoại gán ở chế độ chọn sẵn (từ hộp thoại quản lý). */
  const [presetUser, setPresetUser] = useState<UserWithAssignmentsListItem | null>(null);

  const usersQuery = useQuery({
    ...usersWithAssignmentsQueryOptions({
      search: search === '' ? undefined : search,
      roleId: roleFilter === '' ? undefined : roleFilter,
      status: statusFilter === '' ? undefined : statusFilter,
      page,
      pageSize,
    }),
    placeholderData: keepPreviousData,
  });
  const data = usersQuery.data;
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  /** Kẹp trang theo tổng mới nhất ngay trong lúc render như bảng gán vai. */
  if (data && page > pageCount) {
    setPage(pageCount);
  }
  const rows = data?.users ?? [];
  const rangeFrom = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeTo = (page - 1) * pageSize + rows.length;
  const manageUser = rows.find((user) => user.id === manageUserId) ?? null;

  /** Pill trạng thái tài khoản: đã xoá > đã khoá > đang hoạt động. */
  function statusBadge(user: UserWithAssignmentsListItem) {
    if (user.deleted)
      return (
        <Badge className="rounded-sm bg-red-600/10 px-2 py-0.5 font-medium text-red-600 capitalize dark:text-red-400">
          {t('userRolesStatusDeleted')}
        </Badge>
      );
    if (user.suspended)
      return (
        <Badge className="rounded-sm bg-amber-600/10 px-2 py-0.5 font-medium text-amber-600 capitalize dark:text-amber-400">
          {t('userRolesStatusSuspended')}
        </Badge>
      );
    return (
      <Badge className="rounded-sm bg-green-600/10 px-2 py-0.5 font-medium text-green-600 capitalize dark:text-green-400">
        {t('userRolesStatusActive')}
      </Badge>
    );
  }

  return (
    <Card className="gap-0 py-0 shadow-none">
      <CardHeader className="border-b px-6 py-5">
        <CardTitle className="text-lg">{t('userRolesTitle')}</CardTitle>
        <CardDescription>{t('userRolesDescription')}</CardDescription>
      </CardHeader>
      {/* Vùng lọc hai khối ngăn nhau bằng viền dưới như thẻ bảng mẫu:
          khối lọc là hai ô chọn có nhãn phía trên (vai trò, trạng
          thái); khối công cụ là tìm kiếm trái, cỡ trang + nút gán phải. */}
      <div className="border-b">
        <div className="flex flex-col gap-4 border-b p-6">
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="user-roles-role-filter">{t('assignmentFilterRole')}</FieldLabel>
              <AdminSelect
                id="user-roles-role-filter"
                value={roleFilter}
                onValueChange={(next) => {
                  setRoleFilter(next);
                  setPage(1);
                }}
                options={[
                  { value: '', label: t('assignmentFilterRoleAll') },
                  ...roles.map((r) => ({ value: r.id, label: r.name })),
                ]}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="user-roles-status-filter">{t('userRolesStatusColumn')}</FieldLabel>
              <AdminSelect
                id="user-roles-status-filter"
                value={statusFilter}
                onValueChange={(next) => {
                  setStatusFilter(next as '' | UserListStatus);
                  setPage(1);
                }}
                options={[
                  { value: '', label: t('userRolesStatusAll') },
                  { value: 'active', label: t('userRolesStatusActive') },
                  { value: 'suspended', label: t('userRolesStatusSuspended') },
                  { value: 'deleted', label: t('userRolesStatusDeleted') },
                ]}
              />
            </Field>
          </div>
        </div>
        <div className="flex gap-4 p-6 max-sm:flex-col sm:items-center sm:justify-between">
          <Field className="w-full max-w-2xs">
            <InputGroup>
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                id="user-roles-search"
                aria-label={t('assignmentSearch')}
                placeholder={t('assignmentSearchPlaceholder')}
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </InputGroup>
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <AdminSelect
              id="user-roles-pagesize"
              ariaLabel={t('userRolesPageSize')}
              className="w-fit"
              value={String(pageSize)}
              onValueChange={(next) => {
                const size = Number(next);
                setPageSize(PAGE_SIZE_OPTIONS.includes(size as 10 | 25 | 50 | 100) ? size : 10);
                setPage(1);
              }}
              options={PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
            />
            <Button type="button" className="h-9 gap-1.5 px-2.5" onClick={() => setAssignOpen(true)}>
              <Plus aria-hidden className="size-4" />
              {t('assignRole')}
            </Button>
          </div>
        </div>
      </div>
      {usersQuery.isError ? (
        <div className="px-6 pt-4">
          <ErrorAlert variant="destructive" descriptionClassName="flex items-center justify-between gap-2">
            <span>{t('assignmentLoadFailed')}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void usersQuery.refetch()}>
              {t('retry')}
            </Button>
          </ErrorAlert>
        </div>
      ) : null}
      {usersQuery.isFetching && !usersQuery.isPending ? (
        <p className="px-6 pt-4 text-sm text-muted-foreground">{t('loading')}</p>
      ) : null}
      {usersQuery.isPending ? (
        <div className="p-6">
          <PageSkeleton label={t('loading')} rows={['h-9 w-full', 'h-9 w-full', 'h-9 w-full']} />
        </div>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow className="h-14 border-t hover:bg-transparent">
                <TableHead className="pl-4 text-muted-foreground">{t('assignmentUserColumn')}</TableHead>
                <TableHead className="text-muted-foreground">{t('assignmentRoleColumn')}</TableHead>
                <TableHead className="text-muted-foreground">{t('userRolesStatusColumn')}</TableHead>
                <TableHead className="text-muted-foreground">{t('userRolesJoinedColumn')}</TableHead>
                <TableHead className="pr-4 text-center text-muted-foreground">
                  {t('assignmentActionsColumn')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center">
                    {t('userRolesEmpty')}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((user) => (
                  <TableRow key={user.id} className="h-14">
                    <TableCell className="pl-4">
                      <span className="flex items-center gap-2">
                        <Avatar className="size-9">
                          <AvatarFallback className="text-xs">{initialsOf(user)}</AvatarFallback>
                        </Avatar>
                        <span>
                          <span className="block text-sm font-medium">{userDisplayName(user)}</span>
                          <span className="block text-sm text-muted-foreground">{user.email}</span>
                        </span>
                      </span>
                    </TableCell>
                    <TableCell>
                      {user.assignments.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        user.assignments.map((assignment) => (
                          <span key={assignment.id} className="block text-sm">
                            {assignment.roleName}{' '}
                            <span className="text-muted-foreground">
                              · {assignmentContextLabel(contexts, assignment, (key, options) => t(key, options))}
                            </span>
                          </span>
                        ))
                      )}
                    </TableCell>
                    <TableCell>{statusBadge(user)}</TableCell>
                    <TableCell>
                      {formatWithOptions(user.createdAt, undefined, {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </TableCell>
                    <TableCell className="pr-4 text-center">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-9"
                        aria-label={t('userRolesManage')}
                        onClick={() => setManageUserId(user.id)}
                      >
                        <EllipsisVertical aria-hidden className="size-4.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <TablePagination
            page={page}
            pageCount={pageCount}
            summary={t('userRolesShowing', { from: rangeFrom, to: rangeTo, total })}
            previousLabel={t('dashboard:tablePrevious')}
            nextLabel={t('dashboard:tableNext')}
            onPageChange={setPage}
          />
        </>
      )}
      {assignOpen ? (
        <RoleAssignmentDialog open roles={roles} contexts={contexts} onClose={() => setAssignOpen(false)} />
      ) : null}
      {manageUser !== null ? (
        <RoleUserDialog
          open
          user={manageUser}
          contexts={contexts}
          onClose={() => setManageUserId(null)}
          onAssignForUser={(user) => {
            setManageUserId(null);
            setPresetUser(user);
          }}
        />
      ) : null}
      {presetUser !== null ? (
        <RoleAssignmentDialog
          open
          roles={roles}
          contexts={contexts}
          presetUser={{ id: presetUser.id, username: presetUser.username, email: presetUser.email }}
          onClose={() => setPresetUser(null)}
        />
      ) : null}
    </Card>
  );
}

import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query';
import type { PaginationState, SortingState } from '@tanstack/react-table';
import type { UserListSortBy, UserListStatus, UserProfile } from '@lms/contracts';
import { Avatar, AvatarFallback } from '@lms/ui/components/avatar';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent } from '@lms/ui/components/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@lms/ui/components/dropdown-menu';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@lms/ui/components/native-select';
import { Ellipsis, Plus } from 'lucide-react';
import { PageSkeleton } from '#components/page-skeleton';
import { ErrorAlert } from '#components/error-alert';
import { useTranslation } from 'react-i18next';
import { PageHeader, PageShell } from '#components/page-shell';
import { SectionCards } from '#components/section-cards';
import { useAccessContexts, useAccessRoles } from '#lib/access';
import { formatDate } from '#utils/date-format';
import '#config/i18n';
import {
  adminUserStatQueryOptions,
  adminUsersAllQueryOptions,
  adminUsersListQueryOptions,
  useAdminUserDetail,
  useCreateAdminUser,
  useToggleUserSuspended,
  useUpdateAdminUser,
} from '../queries/admin-users';
import { roleHoldersQueryOptions, userAssignmentsQueryOptions } from '../queries/admin-roles';
import { UserDeleteDialog } from './user-delete-dialog';
import { DataTable, type DataColumn } from '#components/data-table';

/** Khung một màn form riêng (tạo/sửa) theo chuẩn §9: tiêu đề + quay lại danh sách. */
function UserFormScreen({
  title, children,
}: {
  title: string;
  children: ReactNode;
}) {
  const { t } = useTranslation('app');
  return (
    <PageShell width="narrow">
      <PageHeader title={title} />
      <Card>
        <CardContent>{children}</CardContent>
      </Card>
      <p>
        <Link to="/admin/users" className="text-sm underline">
          {t('backToUsersList')}
        </Link>
      </p>
    </PageShell>
  );
}

/** Các lựa chọn cỡ trang của bảng người dùng (hợp đồng đợt 1 chặn trần 100 phía server). */
const USER_PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

/** Giá trị bộ lọc trạng thái: chuỗi rỗng nghĩa là giữ mặc định của API (chỉ tài khoản chưa xoá). */
type StatusFilterValue = '' | UserListStatus;

/** Các trường sắp xếp được phía server theo hợp đồng đợt 1 — id cột của bảng khớp đúng tên trường của hợp đồng. */
const SORTABLE_FIELD_IDS: readonly string[] = ['name', 'createdAt', 'lastLogin'];

/**
 * Trang quản trị người dùng: danh sách tài khoản toàn hệ dựng lại
 * trình bày theo issue #561 trên hợp đồng của đợt 1 (issue #560) —
 * bốn thẻ thống kê bằng số đếm thật, thanh công cụ một thẻ hai hàng,
 * bảng với cột vai trò theo ngữ cảnh, sắp xếp phía server, chân bảng
 * kiểu khoảng dòng và hộp thoại xác nhận xoá dựng bằng component.
 *
 * Luồng hiển thị:
 *
 * 1. Bốn thẻ thống kê là số đếm TOÀN HỆ, không phản ứng theo bộ lọc
 *    của bảng: ba truy vấn trạng thái (đang hoạt động / bị khoá / đã
 *    xoá) đọc đúng một dòng và lấy tổng server công bố qua lọc trạng
 *    thái của đợt 1; ba nhóm này rời nhau và phủ kín mọi tài khoản
 *    nên thẻ tổng là tổng của ba số đó. Sau mỗi thao tác ghi, đột
 *    biến vô hiệu hoá gốc khoá người dùng nên cả danh sách lẫn thẻ
 *    đều nạp lại số mới.
 * 2. Thanh công cụ nằm trong cùng thẻ với bảng, gồm hai hàng: hàng
 *    một là ô tìm kiếm, lọc trạng thái và lọc vai trò ở ngữ cảnh hệ
 *    thống; hàng hai là bộ chọn cỡ trang và nút thêm người dùng (đi
 *    tới màn tạo riêng hiện có). Đổi tìm kiếm/lọc/cỡ trang/sắp xếp
 *    đều đưa bảng về trang 1. Trang không còn khối tiêu đề riêng
 *    phía trên — thẻ thống kê là phần tử đầu tiên, như bản mẫu.
 * 3. Hai đường dữ liệu của bảng: mặc định bảng đọc đúng một trang
 *    phía server (GET /users với tìm kiếm, trạng thái, sắp xếp, cỡ
 *    trang). Khi có lọc vai trò ở ngữ cảnh hệ thống, hợp đồng danh
 *    sách không có tham số vai trò nên trang hợp hai tập đều do
 *    server lọc: tập người giữ vai tại ngữ cảnh hệ thống (endpoint
 *    gán vai lọc theo vai trò + ngữ cảnh) và toàn bộ tập người dùng
 *    khớp tìm kiếm/trạng thái đã sắp xếp phía server; phần giao nhau
 *    được cắt trang ngay tại trang để hiển thị, tổng và thứ tự vì
 *    thế vẫn đúng theo server.
 * 4. Cột Vai trò đọc các dòng gán của từng người dùng đang hiển thị
 *    qua lọc `userId` của đợt 1: bày các vai tại ngữ cảnh hệ thống
 *    (phân giải tên từ danh sách vai của trang), số dòng gán ở các
 *    ngữ cảnh khác (tổng server trừ số dòng tại hệ thống) và liên
 *    kết sang trang vai trò mang theo bộ lọc đúng người dùng đó.
 *    Vai trò không gộp thành một nhãn đơn vì mô hình gán theo ngữ
 *    cảnh không có khái niệm vai trò chính.
 * 5. Sắp xếp chạy phía server qua DataTable ở chế độ manualSorting:
 *    id cột khớp tên trường hợp đồng (`name`, `createdAt`,
 *    `lastLogin`) nên trạng thái sắp xếp của bảng ánh xạ thẳng sang
 *    tham số `sortBy`/`sortDirection`; giá trị sortValue của cột chỉ
 *    còn vai trò bật/tắt khả năng sắp xếp ở tiêu đề cột. Trang hiện
 *    tại được kẹp theo tổng mới nhất ngay trong lúc render (mẫu của
 *    bảng gán vai) để sau xoá/khoá làm tổng giảm, trang không kẹt ở
 *    trang rỗng.
 * 6. Thao tác tại dòng: sửa đi tới màn sửa riêng hiện có; khoá/mở
 *    khoá giữ đúng hành vi API hiện có; xoá mở hộp thoại xác nhận
 *    dựng bằng component Dialog (không còn `window.confirm`) — sau
 *    xoá, tài khoản biến khỏi danh sách mặc định và thẻ thống kê
 *    cập nhật qua cơ chế làm mới ở điểm 1. Menu thao tác mở rộng
 *    (⋮) chứa cùng ba thao tác. Theo chuẩn §9: tạo mới là màn riêng
 *    (/admin/users/new), sửa là màn riêng (/admin/users/:id/edit).
 */
export function AdminUsersPage() {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>('');
  const [roleFilter, setRoleFilter] = useState('');
  const [sorting, setSorting] = useState<SortingState>([]);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 });
  const [message, setMessage] = useState<string | null>(null);
  /** Người dùng đang chờ xác nhận xoá; null khi hộp thoại đóng. */
  const [deleteTarget, setDeleteTarget] = useState<UserProfile | null>(null);

  const suspendMutation = useToggleUserSuspended();

  // Danh sách vai và cây context là hai query dùng chung của tầng
  // access: vai trò làm lựa chọn cho bộ lọc và để phân giải tên vai
  // ở cột Vai trò; ngữ cảnh hệ thống là dòng có cấp 10 trong cây.
  const rolesQuery = useAccessRoles();
  const contextsQuery = useAccessContexts();
  const roles = rolesQuery.data ?? [];
  const systemContextId = contextsQuery.data?.find((c) => c.contextLevel === 10)?.id;

  // Ba truy vấn đếm theo trạng thái cho thẻ thống kê (điểm 1 của
  // luồng): mỗi truy vấn đọc một dòng và lấy tổng server công bố.
  const activeStatQuery = useQuery(adminUserStatQueryOptions('active'));
  const suspendedStatQuery = useQuery(adminUserStatQueryOptions('suspended'));
  const deletedStatQuery = useQuery(adminUserStatQueryOptions('deleted'));
  const statsPending = activeStatQuery.isPending || suspendedStatQuery.isPending || deletedStatQuery.isPending;
  const totalUsersCount =
    (activeStatQuery.data?.total ?? 0) + (suspendedStatQuery.data?.total ?? 0) + (deletedStatQuery.data?.total ?? 0);

  // Tham số hợp đồng dùng chung cho cả hai đường dữ liệu: trạng
  // thái sắp xếp của bảng ánh xạ thẳng sang sortBy/sortDirection
  // vì id cột khớp tên trường hợp đồng (điểm 5 của luồng).
  const sortEntry = sorting[0];
  const sortBy: UserListSortBy | undefined =
    sortEntry && SORTABLE_FIELD_IDS.includes(sortEntry.id) ? (sortEntry.id as UserListSortBy) : undefined;
  const listParams = {
    search: search === '' ? undefined : search,
    status: statusFilter === '' ? undefined : statusFilter,
    sortBy,
    sortDirection: sortEntry ? (sortEntry.desc ? ('desc' as const) : ('asc' as const)) : undefined,
  };

  const roleFilterActive = roleFilter !== '';
  // Đường mặc định: đúng một trang phía server.
  const pageQuery = useQuery({
    ...adminUsersListQueryOptions({ ...listParams, page: pagination.pageIndex + 1, pageSize: pagination.pageSize }),
    placeholderData: keepPreviousData,
    enabled: !roleFilterActive,
  });
  // Đường lọc vai trò (điểm 3 của luồng): tập người giữ vai tại ngữ
  // cảnh hệ thống và toàn bộ tập người dùng khớp bộ lọc còn lại.
  const holdersQuery = useQuery({
    ...roleHoldersQueryOptions(roleFilter, systemContextId ?? ''),
    enabled: roleFilterActive && systemContextId !== undefined,
  });
  const allUsersQuery = useQuery({
    ...adminUsersAllQueryOptions(listParams),
    placeholderData: keepPreviousData,
    enabled: roleFilterActive,
  });

  const holders = holdersQuery.data;
  const roleFilteredUsers =
    roleFilterActive && holders
      ? (allUsersQuery.data?.users ?? []).filter((u) => holders.has(u.id))
      : [];
  const total = roleFilterActive ? roleFilteredUsers.length : (pageQuery.data?.total ?? 0);
  const rows: UserProfile[] = roleFilterActive
    ? roleFilteredUsers.slice(
        pagination.pageIndex * pagination.pageSize,
        pagination.pageIndex * pagination.pageSize + pagination.pageSize,
      )
    : (pageQuery.data?.users ?? []);
  const pageCount = Math.ceil(total / pagination.pageSize);
  const listPending = roleFilterActive
    ? allUsersQuery.isPending || holdersQuery.isPending || (roleFilterActive && systemContextId === undefined && !contextsQuery.isError)
    : pageQuery.isPending;
  const listFetching = roleFilterActive
    ? allUsersQuery.isFetching || holdersQuery.isFetching
    : pageQuery.isFetching;
  const listError = roleFilterActive
    ? allUsersQuery.isError || holdersQuery.isError || contextsQuery.isError
    : pageQuery.isError;

  /**
   * Kẹp trang hiện tại theo tổng mới nhất ngay trong lúc render
   * (mẫu của bảng gán vai, không dùng effect): khi tổng giảm mà
   * trang hiện tại vượt quá trang cuối thì đưa về trang cuối; lần
   * render sau điều kiện đã sai nên dừng, truy vấn tự tải lại trang
   * hợp lệ thay vì kẹt ở trang rỗng.
   */
  if (!listPending && pagination.pageIndex > Math.max(0, pageCount - 1)) {
    setPagination((p) => ({ ...p, pageIndex: Math.max(0, pageCount - 1) }));
  }

  // Dòng gán vai của từng người dùng đang hiển thị (điểm 4 của
  // luồng): một truy vấn theo userId cho mỗi dòng của trang, ghép
  // kết quả theo định danh người dùng để ô Vai trò đọc đúng dòng.
  const assignmentQueries = useQueries({
    queries: rows.map((u) => userAssignmentsQueryOptions(u.id)),
  });
  const assignmentsByUserId = new Map(rows.map((u, i) => [u.id, assignmentQueries[i]] as const));

  /** Đổi trạng thái sắp xếp của bảng và đưa về trang 1 (điểm 5 của luồng). */
  function handleSortingChange(updater: SortingState | ((old: SortingState) => SortingState)) {
    const next = typeof updater === 'function' ? updater(sorting) : updater;
    setSorting(next);
    setPagination((p) => ({ ...p, pageIndex: 0 }));
  }

  /** Nạp lại các truy vấn đang quyết định nội dung bảng khi người dùng bấm thử lại. */
  function refetchList() {
    if (roleFilterActive) {
      void allUsersQuery.refetch();
      void holdersQuery.refetch();
      void contextsQuery.refetch();
    } else {
      void pageQuery.refetch();
    }
  }

  async function suspend(id: string, suspended: boolean) {
    await suspendMutation.mutateAsync({ id, suspended });
  }

  /** Chữ cái đầu cho ảnh đại diện chữ viết tắt: chữ đầu của họ và tên, lùi về tên đăng nhập khi hồ sơ trống. */
  function initialsOf(user: UserProfile): string {
    const parts = [user.firstName, user.lastName].map((s) => s.trim()).filter((s) => s !== '');
    if (parts.length === 0) return user.username.charAt(0).toUpperCase();
    return parts.map((s) => s.charAt(0).toUpperCase()).join('');
  }

  /** Họ tên đầy đủ của người dùng; lùi về tên đăng nhập khi hồ sơ trống cả họ lẫn tên. */
  function fullNameOf(user: UserProfile): string {
    const fullName = `${user.firstName} ${user.lastName}`.trim();
    return fullName === '' ? user.username : fullName;
  }

  /** Nhãn trạng thái dạng viên màu (Badge): đã xoá là destructive, bị khoá là secondary, còn lại là mặc định. */
  function statusBadgeOf(user: UserProfile) {
    if (user.deleted) return <Badge variant="destructive">{t('userStatusDeleted')}</Badge>;
    if (user.suspended) return <Badge variant="secondary">{t('userStatusSuspended')}</Badge>;
    return <Badge>{t('statusActive')}</Badge>;
  }

  /**
   * Ô Vai trò của một dòng (điểm 4 của luồng): vai tại ngữ cảnh hệ
   * thống theo tên đã phân giải, số gán ở ngữ cảnh khác và liên kết
   * sang trang vai trò mang bộ lọc đúng người dùng đó.
   */
  function roleCellOf(user: UserProfile) {
    const result = assignmentsByUserId.get(user.id);
    if (!result || result.isPending) {
      return <span className="text-sm text-muted-foreground">{t('loading')}</span>;
    }
    if (result.isError || !result.data) {
      return <span className="text-sm text-muted-foreground">—</span>;
    }
    const items = result.data.assignments;
    const systemItems = systemContextId ? items.filter((a) => a.contextId === systemContextId) : [];
    const systemRoleIds = [...new Set(systemItems.map((a) => a.roleId))];
    const otherCount = Math.max(0, result.data.total - systemItems.length);
    return (
      <span className="block space-y-0.5">
        {systemRoleIds.length > 0 ? (
          systemRoleIds.map((roleId) => (
            <span key={roleId} className="block">
              {roles.find((r) => r.id === roleId)?.name ?? roleId}
            </span>
          ))
        ) : (
          <span className="block text-muted-foreground">{t('userNoSystemRoles')}</span>
        )}
        {otherCount > 0 ? (
          <span className="block text-sm text-muted-foreground">
            {t('userOtherContextRoles', { count: otherCount })}
          </span>
        ) : null}
        <Link to={`/admin/roles?userId=${user.id}`} className="block text-sm underline">
          {t('userViewRoles')}
        </Link>
      </span>
    );
  }

  const columns: DataColumn<UserProfile>[] = [
    {
      id: 'name',
      header: t('userColumnUser'),
      sortValue: (u) => fullNameOf(u),
      cell: (u) => (
        <span className="flex items-center gap-2">
          <Avatar>
            <AvatarFallback>{initialsOf(u)}</AvatarFallback>
          </Avatar>
          <span>
            <strong className="block">{fullNameOf(u)}</strong>
            {u.email ? <span className="block text-sm text-muted-foreground">{u.email}</span> : null}
          </span>
        </span>
      ),
    },
    {
      id: 'role',
      header: t('userColumnRole'),
      cell: (u) => roleCellOf(u),
    },
    {
      id: 'status',
      header: t('status'),
      cell: (u) => statusBadgeOf(u),
    },
    {
      id: 'createdAt',
      header: t('userColumnJoined'),
      sortValue: (u) => u.createdAt,
      cell: (u) => formatDate(u.createdAt),
    },
    {
      id: 'lastLogin',
      header: t('userColumnLastLogin'),
      sortValue: (u) => u.lastLogin ?? '',
      cell: (u) =>
        u.lastLogin ? (
          formatDate(u.lastLogin)
        ) : (
          <span className="text-muted-foreground">{t('userNeverLoggedIn')}</span>
        ),
    },
    {
      id: 'actions',
      header: t('actions'),
      cell: (u) => (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" render={<Link to={`/admin/users/${u.id}/edit`} />}>
            {t('editAction')}
          </Button>
          <Button type="button" variant="outline" onClick={() => void suspend(u.id, !u.suspended)}>
            {u.suspended ? t('unsuspend') : t('suspend')}
          </Button>
          {!u.deleted ? (
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setMessage(null);
                setDeleteTarget(u);
              }}
            >
              {t('deleteAction')}
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button type="button" variant="ghost" size="icon" aria-label={t('userMoreActions')} />}
            >
              <Ellipsis aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => navigate(`/admin/users/${u.id}/edit`)}>
                {t('editAction')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void suspend(u.id, !u.suspended)}>
                {u.suspended ? t('unsuspend') : t('suspend')}
              </DropdownMenuItem>
              {!u.deleted ? (
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => {
                    setMessage(null);
                    setDeleteTarget(u);
                  }}
                >
                  {t('deleteAction')}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ];

  return (
    <PageShell width="full">
      <SectionCards
        cards={[
          {
            id: 'total',
            label: t('usersStatTotal'),
            value: String(totalUsersCount),
            loading: statsPending,
          },
          {
            id: 'active',
            label: t('statusActive'),
            value: String(activeStatQuery.data?.total ?? 0),
            loading: activeStatQuery.isPending,
          },
          {
            id: 'suspended',
            label: t('userStatusSuspended'),
            value: String(suspendedStatQuery.data?.total ?? 0),
            loading: suspendedStatQuery.isPending,
          },
          {
            id: 'deleted',
            label: t('userStatusDeleted'),
            value: String(deletedStatQuery.data?.total ?? 0),
            loading: deletedStatQuery.isPending,
          },
        ]}
      />
      {message ? <ErrorAlert>{message}</ErrorAlert> : null}
      <Card>
        <CardContent className="space-y-4">
          {/* Thanh công cụ một thẻ hai hàng (điểm 2 của luồng): hàng
              một là tìm kiếm + hai bộ lọc, hàng hai là cỡ trang và
              nút thêm người dùng; mỗi điều khiển co theo nội dung
              như thanh lọc của bảng gán vai. Ba ô chọn dùng component
              NativeSelect của `@lms/ui` (bọc đúng thẻ select gốc nên
              test component vẫn điều khiển bằng selectOptions, khác
              với Select của Base UI). */}
          <div className="flex flex-wrap items-end gap-2">
            <Field className="w-72 max-w-full">
              <FieldLabel htmlFor="users-search">{t('searchUsers')}</FieldLabel>
              <Input
                id="users-search"
                placeholder={t('searchUsersPlaceholder')}
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPagination((p) => ({ ...p, pageIndex: 0 }));
                }}
              />
            </Field>
            <Field className="w-auto">
              <FieldLabel htmlFor="users-status-filter">{t('userFilterStatus')}</FieldLabel>
              <NativeSelect
                id="users-status-filter"
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value as StatusFilterValue);
                  setPagination((p) => ({ ...p, pageIndex: 0 }));
                }}
              >
                <NativeSelectOption value="">{t('userFilterStatusDefault')}</NativeSelectOption>
                <NativeSelectOption value="active">{t('statusActive')}</NativeSelectOption>
                <NativeSelectOption value="suspended">{t('userStatusSuspended')}</NativeSelectOption>
                <NativeSelectOption value="deleted">{t('userStatusDeleted')}</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field className="w-auto">
              <FieldLabel htmlFor="users-role-filter">{t('userFilterRole')}</FieldLabel>
              <NativeSelect
                id="users-role-filter"
                value={roleFilter}
                onChange={(e) => {
                  setRoleFilter(e.target.value);
                  setPagination((p) => ({ ...p, pageIndex: 0 }));
                }}
              >
                <NativeSelectOption value="">{t('userFilterRoleAll')}</NativeSelectOption>
                {roles.map((r) => (
                  <NativeSelectOption key={r.id} value={r.id}>
                    {r.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <div className="flex flex-wrap items-end justify-between gap-2">
            <Field className="w-auto">
              <FieldLabel htmlFor="users-pagesize">{t('userPageSize')}</FieldLabel>
              <NativeSelect
                id="users-pagesize"
                value={String(pagination.pageSize)}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setPagination({
                    pageIndex: 0,
                    pageSize: USER_PAGE_SIZE_OPTIONS.includes(next as 10 | 25 | 50 | 100) ? next : 10,
                  });
                }}
              >
                {USER_PAGE_SIZE_OPTIONS.map((n) => (
                  <NativeSelectOption key={n} value={String(n)}>
                    {String(n)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Button type="button" render={<Link to="/admin/users/new" />}>
              <Plus aria-hidden />
              {t('createUser')}
            </Button>
          </div>
          {listError ? (
            <ErrorAlert variant="destructive" descriptionClassName="flex items-center justify-between gap-2">
              <span>{t('usersLoadFailed')}</span>
              <Button type="button" variant="outline" size="sm" onClick={refetchList}>
                {t('retry')}
              </Button>
            </ErrorAlert>
          ) : null}
          {listFetching && !listPending ? (
            <p className="text-sm text-muted-foreground">{t('loading')}</p>
          ) : null}
          {listPending ? (
            <PageSkeleton label={t('loading')} rows={['h-9 w-full', 'h-9 w-full', 'h-9 w-full']} />
          ) : null}
        </CardContent>
        {listPending ? null : (
          <DataTable
            data={rows}
            columns={columns}
            labels={{
              columns: t('dashboard:tableColumns'),
              previous: t('dashboard:tablePrevious'),
              next: t('dashboard:tableNext'),
              empty: t('usersEmpty'),
              pageInfo: (page, pages) => t('dashboard:tablePageInfo', { page, pages }),
              rangeInfo: (from, to, rangeTotal) => t('usersShowing', { from, to, total: rangeTotal }),
            }}
            totalRows={total}
            getRowId={(u) => u.id}
            manualPagination
            manualSorting
            sorting={sorting}
            onSortingChange={handleSortingChange}
            pageCount={pageCount}
            pagination={pagination}
            onPaginationChange={setPagination}
          />
        )}
      </Card>
      {/* Render có điều kiện: mỗi lần mở hộp thoại là một lượt xác nhận mới với state khởi tạo sạch. */}
      {deleteTarget !== null ? (
        <UserDeleteDialog
          user={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => setMessage(t('userDeleted'))}
        />
      ) : null}
    </PageShell>
  );
}


/** Màn tạo người dùng riêng (§9): POST /users qua đột biến rồi quay về danh sách. */
export function AdminUserNewPage() {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const createMutation = useCreateAdminUser();
  const [draft, setDraft] = useState({ username: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);

  async function createUser(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await createMutation.mutateAsync(draft);
      navigate('/admin/users');
    } catch {
      setError(t('userCreateFailed'));
    }
  }

  return (
    <UserFormScreen title={t('createUser')}>
      <form onSubmit={(e) => void createUser(e)}>
        <FieldGroup>
          {error ? (
            <ErrorAlert variant="destructive">
              {error}
            </ErrorAlert>
          ) : null}
          <Field>
            <FieldLabel htmlFor="new-username">{t('username')}</FieldLabel>
            <Input
              id="new-username"
              value={draft.username}
              onChange={(e) => setDraft({ ...draft, username: e.target.value })}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="new-email">{t('email')}</FieldLabel>
            <Input
              id="new-email"
              type="email"
              value={draft.email}
              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="new-password">{t('password')}</FieldLabel>
            <Input
              id="new-password"
              type="password"
              value={draft.password}
              onChange={(e) => setDraft({ ...draft, password: e.target.value })}
              required
            />
          </Field>
          <div className="flex justify-end">
            <Button type="submit">{t('create')}</Button>
          </div>
        </FieldGroup>
      </form>
    </UserFormScreen>
  );
}

/**
 * Màn sửa người dùng riêng (§9): nạp hồ sơ qua GET /users/:id, lưu qua
 * PATCH /users/:id (đúng `updateUserSchema`: email/firstName/lastName/
 * password tuỳ chọn — mật khẩu để trống nghĩa là không đổi).
 */
export function AdminUserEditPage() {
  const { t } = useTranslation('app');
  const { userId } = useParams();
  const navigate = useNavigate();
  const userQuery = useAdminUserDetail(userId);
  const updateMutation = useUpdateAdminUser();
  const [draft, setDraft] = useState<{ email: string; firstName: string; lastName: string; password: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const form = draft ?? {
    email: userQuery.data?.email ?? '',
    firstName: userQuery.data?.firstName ?? '',
    lastName: userQuery.data?.lastName ?? '',
    password: '',
  };

  async function saveUser(event: FormEvent) {
    event.preventDefault();
    if (!userId) return;
    setError(null);
    try {
      await updateMutation.mutateAsync({
        userId,
        draft: {
          email: form.email,
          firstName: form.firstName,
          lastName: form.lastName,
          ...(form.password ? { password: form.password } : {}),
        },
      });
      navigate('/admin/users');
    } catch {
      setError(t('userUpdateFailed'));
    }
  }

  if (userQuery.isPending) {
    return (
      <PageShell width="narrow">
        <PageHeader title={t('editUserTitle', { username: '' })} />
        <PageSkeleton label={t('loading')} rows={['h-9 w-full', 'h-9 w-full', 'h-9 w-full']} />
      </PageShell>
    );
  }
  if (userQuery.isError || !userQuery.data) {
    return (
      <PageShell width="narrow">
        <PageHeader title={t('editUserTitle', { username: '' })} />
        <ErrorAlert variant="destructive" descriptionClassName="flex items-center justify-between gap-2">
          <span>{t('userLoadFailed')}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void userQuery.refetch()}>
            {t('retry')}
          </Button>
        </ErrorAlert>
        <p>
          <Link to="/admin/users" className="text-sm underline">
            {t('backToUsersList')}
          </Link>
        </p>
      </PageShell>
    );
  }

  return (
    <UserFormScreen title={t('editUserTitle', { username: userQuery.data.username })}>
      <form onSubmit={(e) => void saveUser(e)}>
        <FieldGroup>
          {error ? (
            <ErrorAlert variant="destructive">
              {error}
            </ErrorAlert>
          ) : null}
          <Field>
            <FieldLabel htmlFor="edit-email">{t('email')}</FieldLabel>
            <Input
              id="edit-email"
              type="email"
              value={form.email}
              onChange={(e) => setDraft({ ...form, email: e.target.value })}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="edit-firstname">{t('firstName')}</FieldLabel>
            <Input
              id="edit-firstname"
              value={form.firstName}
              onChange={(e) => setDraft({ ...form, firstName: e.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="edit-lastname">{t('lastName')}</FieldLabel>
            <Input
              id="edit-lastname"
              value={form.lastName}
              onChange={(e) => setDraft({ ...form, lastName: e.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="edit-password">{t('newPasswordOptional')}</FieldLabel>
            <Input
              id="edit-password"
              type="password"
              value={form.password}
              onChange={(e) => setDraft({ ...form, password: e.target.value })}
            />
          </Field>
          <div className="flex justify-end">
            <Button type="submit">{t('curriculumSave')}</Button>
          </div>
        </FieldGroup>
      </form>
    </UserFormScreen>
  );
}

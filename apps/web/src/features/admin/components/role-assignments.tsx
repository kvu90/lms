import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { PaginationState } from '@tanstack/react-table';
import type { RoleListItem, UserListStatus, UserWithAssignmentsListItem } from '@lms/contracts';
import { Avatar, AvatarFallback } from '@lms/ui/components/avatar';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Field, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@lms/ui/components/native-select';
import { PageSkeleton } from '#components/page-skeleton';
import { ErrorAlert } from '#components/error-alert';
import { DataTable, type DataColumn } from '#components/data-table';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import '#config/i18n';
import type { ContextRow } from '#lib/access';
import { formatWithOptions } from '#utils/date-format';
import {
  userWithAssignmentsByIdQueryOptions,
  usersWithAssignmentsQueryOptions,
} from '../queries/admin-roles';
import { contextLevelLabelKey } from '../utils/context-level-label';
import { RoleAssignmentDialog } from './role-assignment-dialog';
import { RoleUserDialog } from './role-user-dialog';

/**
 * Khu vực bảng người dùng và vai trò của họ trên trang quản trị vai trò
 * (issue #569, dựng lại từ bảng gán vai của đợt 3): một dòng là một
 * người dùng kèm toàn bộ gán vai của người đó, đọc từ endpoint gộp
 * của issue con C-backend — không gọi danh sách người dùng và danh
 * sách gán riêng lẻ rồi tự ghép ở client.
 *
 * Luồng hiển thị:
 *
 * 1. Trạng thái lọc/tìm/trang sống ở đây: đổi vai trò, trạng thái,
 *    từ khoá hay trang đều đổi khoá truy vấn nên gọi lại
 *    GET /access/users-with-assignments với tham số tương ứng; tổng
 *    số người dùng khớp do server trả về quyết định số trang. Bảng
 *    giữ keepPreviousData nên đổi lọc/trang không nháy rỗng mà chỉ
 *    hiện dòng "đang tải". Trang hiện tại được kẹp theo tổng mới nhất
 *    ngay trong lúc render (không dùng effect để tránh lỗi lint
 *    set-state-in-effect). API không có hợp đồng sắp xếp nên bảng
 *    không bật sắp xếp cột — sắp xếp một trang đơn lẻ sẽ gây hiểu
 *    nhầm là sắp xếp toàn cục.
 * 2. Thanh công cụ đúng hai hàng ở bề rộng desktop (hạng mục sửa điểm
 *    rớt nghiệm thu của issue #555): hàng 1 là toàn bộ bộ lọc có nhãn
 *    đặt phía trên (vai trò, trạng thái); hàng 2 là ô tìm kiếm bên
 *    trái và bộ chọn cỡ trang + nút Gán vai trò bên phải. Ở bề rộng
 *    hẹp các hàng được phép gói dòng nhưng không tràn ngang.
 * 3. Cột Vai trò bày mọi gán của người dùng: tên vai kèm nhãn cấp
 *    ngữ cảnh dạng chữ suy từ cấp số của gán — tuyệt đối không hiện
 *    mã định danh hay đường dẫn ngữ cảnh trong danh sách, kể cả khi
 *    dữ kiện thiếu (cấp lạ lùi về nhãn "Cấp <số>"). Cột Trạng thái
 *    là pill suy từ hai cờ suspended/deleted; cột Ngày tham gia là
 *    thời điểm tạo tài khoản định dạng ngày tiếng Việt dễ đọc.
 * 4. Chế độ lọc theo người dùng (liên kết từ cột Vai trò của trang
 *    danh sách người dùng, tham số `userId` trên URL): endpoint gộp
 *    không có tham số lọc theo định danh nên bảng tra đúng người đó
 *    bằng lượt quét các trang của endpoint gộp ở tầng `api/` rồi chỉ
 *    bày một dòng đó, kèm dải lọc đang áp dụng và nút xoá lọc; xoá
 *    lọc bỏ tham số khỏi URL và bảng trở lại đầy đủ. Trong chế độ
 *    này các bộ lọc khác không áp lên dòng đơn đó cho tới khi xoá
 *    lọc theo người dùng — vì lượt tra đơn là tra cứu đích danh, còn
 *    các bộ lọc kia chạy trên danh sách đầy đủ.
 * 5. Quản lý gán vai không yếu đi: nút "Quản lý vai trò" của dòng mở
 *    hộp thoại liệt kê mọi gán của người đó — gán tay gỡ qua hộp thoại
 *    xác nhận hiện hành, gán do ghi danh cấp (`component = 'enrol'`)
 *    không có thao tác gỡ và hiện thẳng lý do; trong hộp thoại có lối
 *    vào gán thêm cho chính người đó (người dùng chọn sẵn). Sau
 *    gán/gỡ thành công, đột biến làm mới gốc khoá bảng nên bảng tải
 *    lại đúng trang và bộ lọc hiện hành, đồng thời lưới thẻ cập nhật
 *    số người giữ qua tiền tố `access`.
 *
 * @param props - Danh sách vai trò (lưới thẻ của trang đã tải, dùng
 * làm lựa chọn cho bộ lọc vai trò và hộp thoại gán) và cây context
 * (trang đã tải, dùng cho hộp thoại gán).
 */
export interface RoleAssignmentsSectionProps {
  /** Danh sách vai trò (lưới thẻ của trang đã tải). */
  roles: RoleListItem[];
  /** Cây context (trang đã tải). */
  contexts: ContextRow[];
}

/** Các lựa chọn số người dùng mỗi trang của bảng (mặc định 10 như mẫu; trần phía server là 100). */
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

/** Kiểu giá trị của bộ lọc trạng thái: '' nghĩa là không lọc theo trạng thái (mặc định phía server: chỉ tài khoản chưa xoá). */
type StatusFilterValue = '' | UserListStatus;

/**
 * Tên hiển thị của người dùng: họ tên đầy đủ khi có, lùi về tên đăng
 * nhập khi hồ sơ trống cả họ lẫn tên — luôn nêu đúng một định danh
 * đọc được, không hiện id kỹ thuật.
 */
function displayNameOf(user: UserWithAssignmentsListItem): string {
  const fullName = `${user.firstName} ${user.lastName}`.trim();
  return fullName === '' ? user.username : fullName;
}

/** Chữ cái đầu cho ảnh đại diện: ký tự đầu của họ, lùi về tên đăng nhập. */
function initialsOf(user: UserWithAssignmentsListItem): string {
  const name = displayNameOf(user);
  return name.charAt(0);
}

export function RoleAssignmentsSection({ roles, contexts }: RoleAssignmentsSectionProps) {
  const { t } = useTranslation('app');
  const [searchParams, setSearchParams] = useSearchParams();
  /** Tham số lọc theo người dùng từ URL (liên kết từ trang danh sách người dùng); null khi không lọc. */
  const userIdParam = searchParams.get('userId');
  /** '' nghĩa là không lọc theo tiêu chí đó — ô chọn hiện mục mặc định. */
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>('');
  const [search, setSearch] = useState('');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 });
  const [assignOpen, setAssignOpen] = useState(false);
  /** Người dùng chọn sẵn cho hộp thoại gán khi mở từ hộp thoại quản lý theo dòng; null khi mở từ nút chung. */
  const [assignPresetUser, setAssignPresetUser] = useState<Pick<
    UserWithAssignmentsListItem,
    'id' | 'username' | 'email'
  > | null>(null);
  /** Định danh người dùng đang mở hộp thoại quản lý vai trò; null khi hộp thoại đóng. */
  const [manageUserId, setManageUserId] = useState<string | null>(null);

  const usersQuery = useQuery({
    ...usersWithAssignmentsQueryOptions({
      roleId: roleFilter === '' ? undefined : roleFilter,
      status: statusFilter === '' ? undefined : statusFilter,
      search: search === '' ? undefined : search,
      page: pagination.pageIndex + 1,
      pageSize: pagination.pageSize,
    }),
    placeholderData: keepPreviousData,
    enabled: userIdParam === null,
  });
  const singleUserQuery = useQuery({
    ...userWithAssignmentsByIdQueryOptions(userIdParam ?? ''),
    enabled: userIdParam !== null,
  });

  /** Dữ kiện hiển thị: chế độ lọc theo người dùng chỉ bày đúng một dòng đó; ngược lại bày trang danh sách đầy đủ. */
  const isSingleUserMode = userIdParam !== null;
  const data = isSingleUserMode
    ? singleUserQuery.data
      ? { users: [singleUserQuery.data], total: 1 }
      : { users: [], total: 0 }
    : usersQuery.data;
  const isPending = isSingleUserMode ? singleUserQuery.isPending : usersQuery.isPending;
  const isError = isSingleUserMode ? singleUserQuery.isError : usersQuery.isError;
  const isFetching = isSingleUserMode ? singleUserQuery.isFetching : usersQuery.isFetching;
  const refetch = isSingleUserMode ? singleUserQuery.refetch : usersQuery.refetch;
  const pageCount = Math.ceil((data?.total ?? 0) / pagination.pageSize);

  /**
   * Kẹp trang hiện tại theo tổng mới nhất, thực hiện ngay trong lúc
   * render theo mẫu "điều chỉnh state khi dữ liệu đổi" của React (không
   * dùng effect): khi tổng giảm mà trang hiện tại vượt quá trang cuối
   * thì đưa trang về trang cuối; lần render sau điều kiện đã sai nên
   * dừng, và truy vấn với trang mới tự tải lại dữ liệu đúng trang. Đổi
   * lọc/tìm/cỡ trang đã tự reset về trang 0 ở onChange nên đường kẹp
   * này chủ yếu bao phủ thay đổi tổng từ bên ngoài.
   */
  if (data && !isSingleUserMode && pagination.pageIndex > Math.max(0, pageCount - 1)) {
    setPagination((p) => ({ ...p, pageIndex: Math.max(0, pageCount - 1) }));
  }

  /** Người dùng đang mở hộp thoại quản lý, suy từ dữ kiện bảng hiện tại để luôn thấy gán mới nhất sau gán/gỡ. */
  const manageUser = manageUserId === null ? null : (data?.users.find((u) => u.id === manageUserId) ?? null);

  /** Nhãn trạng thái dạng pill: đã xoá là destructive, bị khoá là secondary, còn lại là mặc định — cùng quy ước với trang danh sách người dùng. */
  function statusBadgeOf(user: UserWithAssignmentsListItem) {
    if (user.deleted) return <Badge variant="destructive">{t('userStatusDeleted')}</Badge>;
    if (user.suspended) return <Badge variant="secondary">{t('userStatusSuspended')}</Badge>;
    return <Badge>{t('statusActive')}</Badge>;
  }

  /** Xoá lọc theo người dùng: chỉ bỏ tham số `userId` khỏi URL, giữ các tham số khác, và về trang 1. */
  function clearUserFilter() {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete('userId');
        return next;
      },
      { preventScrollReset: true },
    );
    setPagination((p) => ({ ...p, pageIndex: 0 }));
  }

  const columns: DataColumn<UserWithAssignmentsListItem>[] = [
    {
      id: 'user',
      header: t('assignmentUserColumn'),
      cell: (row) => (
        <span className="flex items-center gap-2">
          <Avatar>
            <AvatarFallback>{initialsOf(row)}</AvatarFallback>
          </Avatar>
          <span>
            <span className="block font-semibold">{displayNameOf(row)}</span>
            <span className="block text-sm text-muted-foreground">{row.email ?? '—'}</span>
          </span>
        </span>
      ),
    },
    {
      id: 'role',
      header: t('assignmentRoleColumn'),
      cell: (row) =>
        row.assignments.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="flex flex-col gap-1">
            {row.assignments.map((assignment) => (
              <span key={assignment.id}>
                {assignment.roleName} · {t(contextLevelLabelKey(assignment.contextLevel), { level: assignment.contextLevel })}
              </span>
            ))}
          </span>
        ),
    },
    {
      id: 'status',
      header: t('status'),
      cell: (row) => statusBadgeOf(row),
    },
    {
      id: 'joinedAt',
      header: t('userRolesJoinedColumn'),
      cell: (row) => formatWithOptions(row.createdAt, 'vi', { day: 'numeric', month: 'long', year: 'numeric' }),
    },
    {
      id: 'actions',
      header: t('assignmentActionsColumn'),
      cell: (row) => (
        <Button type="button" variant="outline" size="sm" onClick={() => setManageUserId(row.id)}>
          {t('userRolesManage')}
        </Button>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader>
        {/* Tiêu đề mục bảng theo thước đo typography của trang vai trò: khoảng 18 px, độ đậm 600. */}
        <CardTitle className="text-lg font-semibold">{t('assignmentTableTitle')}</CardTitle>
        <CardDescription>{t('assignmentTableDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Thanh công cụ hai hàng: hàng 1 là toàn bộ bộ lọc có nhãn phía
            trên, hàng 2 là tìm kiếm bên trái và cỡ trang + nút chính
            bên phải; bề rộng hẹp thì gói dòng, không tràn ngang. */}
        <div data-testid="user-roles-toolbar">
          <div data-testid="user-roles-toolbar-filters" className="flex flex-wrap items-end gap-2">
            <Field className="w-auto">
              <FieldLabel htmlFor="user-roles-role-filter">{t('assignmentFilterRole')}</FieldLabel>
              <NativeSelect
                id="user-roles-role-filter"
                value={roleFilter}
                onChange={(e) => {
                  setRoleFilter(e.target.value);
                  setPagination((p) => ({ ...p, pageIndex: 0 }));
                }}
              >
                <NativeSelectOption value="">{t('assignmentFilterRoleAll')}</NativeSelectOption>
                {roles.map((r) => (
                  <NativeSelectOption key={r.id} value={r.id}>
                    {r.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field className="w-auto">
              <FieldLabel htmlFor="user-roles-status-filter">{t('userFilterStatus')}</FieldLabel>
              <NativeSelect
                id="user-roles-status-filter"
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
          </div>
          <div data-testid="user-roles-toolbar-search" className="mt-2 flex flex-wrap items-end justify-between gap-2">
            <Field className="w-72 max-w-full">
              <FieldLabel htmlFor="user-roles-search">{t('assignmentSearch')}</FieldLabel>
              <Input
                id="user-roles-search"
                placeholder={t('assignmentSearchPlaceholder')}
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPagination((p) => ({ ...p, pageIndex: 0 }));
                }}
              />
            </Field>
            <div className="flex flex-wrap items-end gap-2">
              <Field className="w-auto">
                <FieldLabel htmlFor="user-roles-pagesize">{t('userRolesPageSize')}</FieldLabel>
                <NativeSelect
                  id="user-roles-pagesize"
                  value={String(pagination.pageSize)}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setPagination({
                      pageIndex: 0,
                      pageSize: PAGE_SIZE_OPTIONS.includes(next as 10 | 25 | 50 | 100) ? next : 10,
                    });
                  }}
                >
                  {PAGE_SIZE_OPTIONS.map((n) => (
                    <NativeSelectOption key={n} value={String(n)}>
                      {String(n)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Button
                type="button"
                onClick={() => {
                  setAssignPresetUser(null);
                  setAssignOpen(true);
                }}
              >
                {t('assignRole')}
              </Button>
            </div>
          </div>
        </div>
        {/* Dải lọc theo người dùng: chỉ hiện ở chế độ lọc theo người
            dùng, nêu rõ người đang lọc kèm cách xoá lọc — tuyệt đối
            không hiện định danh kỹ thuật của người đó. */}
        {isSingleUserMode ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm">
            <span>
              {singleUserQuery.data
                ? t('userRolesUserFilter', { name: displayNameOf(singleUserQuery.data) })
                : t('userRolesUserNotFound')}
            </span>
            <Button type="button" variant="outline" size="sm" onClick={clearUserFilter}>
              {t('userRolesClearFilter')}
            </Button>
          </div>
        ) : null}
        {isError ? (
          <ErrorAlert variant="destructive" descriptionClassName="flex items-center justify-between gap-2">
            <span>{t('assignmentLoadFailed')}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
              {t('retry')}
            </Button>
          </ErrorAlert>
        ) : null}
        {isFetching && !isPending ? <p className="text-sm text-muted-foreground">{t('loading')}</p> : null}
        {isPending ? (
          <PageSkeleton label={t('loading')} rows={['h-9 w-full', 'h-9 w-full', 'h-9 w-full']} />
        ) : (
          <DataTable
            data={data?.users ?? []}
            columns={columns}
            labels={{
              columns: t('dashboard:tableColumns'),
              previous: t('dashboard:tablePrevious'),
              next: t('dashboard:tableNext'),
              empty: t('userRolesEmpty'),
              pageInfo: (page, pages) => t('dashboard:tablePageInfo', { page, pages }),
              rangeInfo: (from, to, total) => t('userRolesShowing', { from, to, total }),
            }}
            totalRows={data?.total ?? 0}
            getRowId={(row) => row.id}
            manualPagination
            pageCount={Math.max(pageCount, 1)}
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
          presetUser={assignPresetUser}
          onClose={() => {
            setAssignOpen(false);
            setAssignPresetUser(null);
          }}
        />
      ) : null}
      {manageUser !== null ? (
        <RoleUserDialog
          open
          user={manageUser}
          onClose={() => setManageUserId(null)}
          onAssignForUser={(user) => {
            setManageUserId(null);
            setAssignPresetUser({ id: user.id, username: user.username, email: user.email });
            setAssignOpen(true);
          }}
        />
      ) : null}
    </Card>
  );
}

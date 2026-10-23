import { useState, type FormEvent } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PaginationState } from '@tanstack/react-table';
import type { UserListResponse, UserProfile } from '@lms/contracts';
import { Button } from '@lms/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/ui/card';
import { Input } from '@lms/ui/components/ui/input';
import { Label } from '@lms/ui/components/ui/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { DataTable, type DataColumn } from '@/components/data-table';

/**
 * Trang quản trị người dùng: danh sách do server phân trang và tìm kiếm
 * (GET /users nhận search/page/pageSize) — trạng thái trang sống ở đây
 * và được nạp qua TanStack Query, bảng dùng chung chạy chế độ
 * manualPagination: TanStack Table giữ/giao tiếp trạng thái phân trang
 * và ẩn/hiện cột, server giữ việc cắt trang và lọc theo từ khoá. Trước
 * đây trang tự fetch bằng useEffect với page=1&pageSize=20 ghim cứng
 * nên người dùng ngoài 20 dòng đầu không bao giờ với tới được. Sắp xếp
 * không bật cho bảng này vì API chưa có hợp đồng sắp xếp — sắp xếp một
 * trang đơn lẻ sẽ gây hiểu nhầm là sắp xếp toàn cục. Mọi thao tác ghi
 * (tạo/khoá/mở khoá) vô hiệu hoá cache danh sách để bảng nạp lại đúng
 * trang hiện tại.
 */
export function AdminUsersPage() {
  const { t } = useTranslation('app');
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 20 });
  const [draft, setDraft] = useState({ username: '', email: '', password: '' });

  const usersQuery = useQuery({
    queryKey: queryKeys.adminUsers(pagination.pageIndex + 1, pagination.pageSize, search),
    queryFn: () =>
      apiJson<UserListResponse>(
        `/api/v1/users?search=${encodeURIComponent(search)}&page=${pagination.pageIndex + 1}&pageSize=${pagination.pageSize}`,
      ),
    placeholderData: keepPreviousData,
  });
  const data = usersQuery.data;
  const pageCount = Math.ceil((data?.total ?? 0) / pagination.pageSize);

  /** Sau mỗi thao tác ghi: nạp lại mọi trang danh sách người dùng đang cache. */
  async function invalidateUsers() {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
  }

  async function createUser(event: FormEvent) {
    event.preventDefault();
    await apiJson('/api/v1/users', { method: 'POST', body: JSON.stringify(draft) });
    setDraft({ username: '', email: '', password: '' });
    await invalidateUsers();
  }
  async function suspend(id: string, suspended: boolean) {
    await apiJson(`/api/v1/users/${id}/${suspended ? 'suspend' : 'unsuspend'}`, { method: 'POST' });
    await invalidateUsers();
  }

  const columns: DataColumn<UserProfile>[] = [
    {
      id: 'username',
      header: t('username'),
      cell: (u) => <strong>{u.username}</strong>,
    },
    {
      id: 'name',
      header: t('fullName'),
      cell: (u) => `${u.firstName} ${u.lastName}`,
    },
    {
      id: 'email',
      header: t('email'),
      cell: (u) => u.email ?? '—',
    },
    {
      id: 'status',
      header: t('status'),
      cell: (u) =>
        [u.suspended ? t('suspendedSuffix') : null, u.deleted ? t('deletedSuffix') : null].filter(Boolean).join(' ') ||
        t('statusActive'),
    },
    {
      id: 'actions',
      header: t('actions'),
      cell: (u) => (
        <Button type="button" variant="outline" onClick={() => void suspend(u.id, !u.suspended)}>
          {u.suspended ? t('unsuspend') : t('suspend')}
        </Button>
      ),
    },
  ];

  return (
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('usersTitle')}</CardTitle>
          <CardDescription>{t('usersDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              aria-label={t('searchUsers')}
              placeholder={t('searchUsersPlaceholder')}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPagination((p) => ({ ...p, pageIndex: 0 }));
              }}
            />
            <Button type="button" onClick={() => void usersQuery.refetch()}>
              {t('search')}
            </Button>
          </div>
          {usersQuery.isError && (
            <p role="alert" className="text-sm text-destructive">
              {t('usersLoadFailed')}
            </p>
          )}
          <p className="text-sm text-muted-foreground">{t('total', { total: data?.total ?? 0 })}</p>
        </CardContent>
        <DataTable
          data={data?.users ?? []}
          columns={columns}
          labels={{
            columns: t('dashboard:tableColumns'),
            previous: t('dashboard:tablePrevious'),
            next: t('dashboard:tableNext'),
            empty: t('dashboard:emptyTable'),
            pageInfo: (page, pages) => t('dashboard:tablePageInfo', { page, pages }),
          }}
          getRowId={(u) => u.id}
          manualPagination
          pageCount={pageCount}
          pagination={pagination}
          onPaginationChange={setPagination}
        />
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('createUser')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={createUser} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="new-username">{t('username')}</Label>
              <Input
                id="new-username"
                value={draft.username}
                onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-email">{t('email')}</Label>
              <Input
                id="new-email"
                type="email"
                value={draft.email}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-password">{t('password')}</Label>
              <Input
                id="new-password"
                type="password"
                value={draft.password}
                onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                required
              />
            </div>
            <Button type="submit">{t('create')}</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default AdminUsersPage;

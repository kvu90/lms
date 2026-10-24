import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PaginationState } from '@tanstack/react-table';
import type { UserListResponse, UserProfile } from '@lms/contracts';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent } from '@lms/ui/components/card';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Skeleton } from '@lms/ui/components/skeleton';
import { useTranslation } from 'react-i18next';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import { apiJson } from '#lib/api';
import { queryKeys } from '#lib/query-keys';
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
 * (khoá/mở khoá/xoá) vô hiệu hoá cache danh sách để bảng nạp lại đúng
 * trang hiện tại. Theo chuẩn §9: tạo mới là màn riêng
 * (/admin/users/new), sửa là màn riêng (/admin/users/:id/edit), danh
 * sách chỉ còn tìm kiếm + bảng + thao tác tại dòng (Sửa/Xoá/Khoá).
 */
export function AdminUsersPage() {
  const { t } = useTranslation('app');
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 20 });
  const [message, setMessage] = useState<string | null>(null);

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

  async function suspend(id: string, suspended: boolean) {
    await apiJson(`/api/v1/users/${id}/${suspended ? 'suspend' : 'unsuspend'}`, { method: 'POST' });
    await invalidateUsers();
  }

  /** Xoá mềm một người dùng qua DELETE /users/:id sau khi xác nhận (§9: Xoá ngay tại dòng). */
  async function deleteUser(user: UserProfile) {
    if (!window.confirm(t('confirmDeleteUser', { username: user.username }))) return;
    setMessage(null);
    try {
      await apiJson(`/api/v1/users/${user.id}`, { method: 'DELETE' });
      setMessage(t('userDeleted'));
      await invalidateUsers();
    } catch {
      setMessage(t('userDeleteFailed'));
    }
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
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" render={<Link to={`/admin/users/${u.id}/edit`} />}>
            {t('editAction')}
          </Button>
          <Button type="button" variant="outline" onClick={() => void suspend(u.id, !u.suspended)}>
            {u.suspended ? t('unsuspend') : t('suspend')}
          </Button>
          {!u.deleted ? (
            <Button type="button" variant="destructive" onClick={() => void deleteUser(u)}>
              {t('deleteAction')}
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <PageShell width="full">
      <PageHeader
        title={t('usersTitle')}
        description={t('usersDescription')}
        actions={
          <Button type="button" render={<Link to="/admin/users/new" />}>
            {t('createUser')}
          </Button>
        }
      />
      {message ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      <Card>
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
          {usersQuery.isError ? (
            <Alert variant="destructive">
              <AlertDescription className="flex items-center justify-between gap-2">
                <span>{t('usersLoadFailed')}</span>
                <Button type="button" variant="outline" size="sm" onClick={() => void usersQuery.refetch()}>
                  {t('retry')}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
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
    </PageShell>
  );
}

/** Màn tạo người dùng riêng (§9): POST /users rồi quay về danh sách. */
export function AdminUserNewPage() {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({ username: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);

  async function createUser(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await apiJson('/api/v1/users', { method: 'POST', body: JSON.stringify(draft) });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
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
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
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
  const queryClient = useQueryClient();
  const userQuery = useQuery({
    queryKey: ['admin', 'users', 'detail', userId],
    queryFn: () => apiJson<UserProfile>(`/api/v1/users/${userId}`),
    enabled: Boolean(userId),
  });
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
      await apiJson(`/api/v1/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          email: form.email,
          firstName: form.firstName,
          lastName: form.lastName,
          ...(form.password ? { password: form.password } : {}),
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      navigate('/admin/users');
    } catch {
      setError(t('userUpdateFailed'));
    }
  }

  if (userQuery.isPending) {
    return (
      <PageShell width="narrow">
        <PageHeader title={t('editUserTitle', { username: '' })} />
        <div className="space-y-2" aria-label={t('loading')}>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      </PageShell>
    );
  }
  if (userQuery.isError || !userQuery.data) {
    return (
      <PageShell width="narrow">
        <PageHeader title={t('editUserTitle', { username: '' })} />
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-2">
            <span>{t('userLoadFailed')}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void userQuery.refetch()}>
              {t('retry')}
            </Button>
          </AlertDescription>
        </Alert>
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
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
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

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default AdminUsersPage;

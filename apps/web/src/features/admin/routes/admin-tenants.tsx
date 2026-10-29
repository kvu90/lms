import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Tenant, TenantMembership } from '@lms/contracts';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@lms/ui/components/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@lms/ui/components/table';
import { useTranslation } from 'react-i18next';
import { ErrorAlert } from '#components/error-alert';
import { PageSkeleton } from '#components/page-skeleton';
import { PageHeader, PageShell } from '#components/page-shell';
import '#config/i18n';
import { ApiError } from '#lib/api';
import { formatDate } from '#utils/date-format';
import { tenantCapabilities, usePermissions } from '#lib/permissions';
import { appKeyMeta } from '#lib/route-meta';
import { currentTenantQueryOptions, tenantMembersQueryOptions, tenantUsersQueryOptions, tenantsQueryOptions, useAddTenantMember, useCreateTenant, useCreateTenantUser, useSetTenantMemberStatus } from '../queries/tenant-admin';
import type { TenantMemberStatus, TenantUserSummary } from '../types/tenant-admin';

/** Một dòng thành viên đã ghép membership với hồ sơ người dùng của cùng tenant. */
interface TenantMemberRow {
  membership: TenantMembership;
  user: TenantUserSummary | null;
}

/** Kiểm tra lỗi API có phải lỗi cấm quyền hay không để trang chọn thông điệp đúng. */
function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.problem.status === 403;
}

/**
 * Trang quản trị tenant tối thiểu.
 *
 * Luồng hiển thị được quyết định từ ảnh chụp quyền trước, sau đó mọi dữ
 * liệu đều lấy từ API tenant:
 * 1. Người có `tenant:viewall`/`tenant:manage` ở context hệ thống (hoặc
 *    site admin) dùng chế độ platform: danh sách `GET /tenants`, chọn
 *    một tenant, rồi đọc membership/người dùng của đúng tenant đã chọn.
 * 2. Người không có quyền platform nhưng có quyền tại tenant hiệu lực
 *    dùng chế độ tenant: `GET /tenants/current` là nguồn tenant duy
 *    nhất; trang không nạp danh sách platform và không có điều khiển
 *    chọn tenant khác.
 * 3. Người không có cả hai phạm vi quyền chỉ nhận trạng thái cấm và
 *    trang không bật bất kỳ truy vấn quản trị tenant nào.
 *
 * Các điều khiển ghi chỉ xuất hiện khi capability tương ứng có hiệu lực
 * tại phạm vi đang quản lý (`tenant:manage` phía platform hoặc tại
 * chính tenant đó). Đây chỉ là điều kiện trình bày: API kiểm tra lại
 * quyền ở mọi endpoint và trang không cập nhật lạc quan khi thao tác ghi
 * chưa được server xác nhận.
 */
export function AdminTenantsPage() {
  const { t } = useTranslation('app');
  const perms = usePermissions();
  const platformMode = perms.canViewPlatformTenants;
  const [selectedTenantId, setSelectedTenantId] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [tenantDraft, setTenantDraft] = useState({ name: '', slug: '', kind: 'center' as 'school' | 'center', plan: '' });
  const [existingUserId, setExistingUserId] = useState('');
  const [newUserDraft, setNewUserDraft] = useState({ username: '', email: '', password: '', firstName: '', lastName: '' });

  const tenantsQuery = useQuery({
    ...tenantsQueryOptions(),
    enabled: perms.ready && platformMode,
  });
  const currentTenantQuery = useQuery({
    ...currentTenantQueryOptions(),
    enabled: perms.ready && !platformMode && perms.canViewTenantAdmin,
  });

  const platformTenants = useMemo(() => tenantsQuery.data ?? [], [tenantsQuery.data]);

  // Tenant đầu tiên là lựa chọn mặc định ở chế độ platform để khu thành
  // viên có một đích xác định ngay khi danh sách tải xong; người dùng
  // đổi lựa chọn thì mọi truy vấn thành viên đi theo lựa chọn mới.
  useEffect(() => {
    if (!platformMode || platformTenants.length === 0) return;
    if (!platformTenants.some((tenant) => tenant.id === selectedTenantId)) {
      setSelectedTenantId(platformTenants[0]!.id);
    }
  }, [platformMode, platformTenants, selectedTenantId]);

  // Cả hai chế độ đều giữ bản ghi tenant đầy đủ `Tenant`: endpoint
  // current trả cùng DTO với danh sách platform, nên thẻ hiển thị ở
  // chế độ tenant đọc trạng thái vòng đời từ trường `status` như chế
  // độ platform.
  const selectedTenant: Tenant | null = platformMode
    ? (platformTenants.find((tenant) => tenant.id === selectedTenantId) ?? null)
    : (currentTenantQuery.data ?? null);
  const selectedTenantIdEffective = selectedTenant?.id ?? '';
  const selectedCaps = tenantCapabilities(perms.access, selectedTenantIdEffective);
  const canViewSelected =
    platformMode || selectedCaps.includes('tenant:viewall') || selectedCaps.includes('tenant:manage');
  const canManageSelected =
    perms.canManagePlatformTenants || selectedCaps.includes('tenant:manage');

  const membersQuery = useQuery({
    ...tenantMembersQueryOptions(selectedTenantIdEffective),
    enabled: perms.ready && Boolean(selectedTenant) && canViewSelected,
  });
  const usersQuery = useQuery({
    ...tenantUsersQueryOptions(selectedTenantIdEffective),
    enabled: perms.ready && Boolean(selectedTenant) && canViewSelected,
  });

  const createTenantMutation = useCreateTenant();
  const addMemberMutation = useAddTenantMember();
  const createUserMutation = useCreateTenantUser();
  const setMemberStatusMutation = useSetTenantMemberStatus();

  const memberRows: TenantMemberRow[] = useMemo(() => {
    const usersById = new Map((usersQuery.data ?? []).map((user) => [user.id, user]));
    return (membersQuery.data ?? []).map((membership) => ({
      membership,
      user: usersById.get(membership.userId) ?? null,
    }));
  }, [membersQuery.data, usersQuery.data]);

  /** Tạo tenant từ form platform; chỉ gửi `plan` khi người dùng đã nhập để giữ đúng hợp đồng tuỳ chọn của API. */
  function createTenant(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    createTenantMutation.mutate(
      {
        name: tenantDraft.name.trim(),
        slug: tenantDraft.slug.trim(),
        kind: tenantDraft.kind,
        ...(tenantDraft.plan.trim() ? { plan: tenantDraft.plan.trim() } : {}),
      },
      {
        onSuccess: (tenant) => {
          setSelectedTenantId(tenant.id);
          setTenantDraft({ name: '', slug: '', kind: 'center', plan: '' });
          setMessage(t('tenantCreated'));
        },
        onError: () => setMessage(t('tenantCreateFailed')),
      },
    );
  }

  /** Thêm một tài khoản toàn cục có sẵn vào đúng tenant đang quản lý bằng ID người dùng. */
  function addMember(event: FormEvent) {
    event.preventDefault();
    if (!selectedTenant) return;
    setMessage(null);
    addMemberMutation.mutate(
      { tenantId: selectedTenant.id, userId: existingUserId.trim() },
      {
        onSuccess: () => {
          setExistingUserId('');
          setMessage(t('tenantMemberAdded'));
        },
        onError: () => setMessage(t('tenantMemberAddFailed')),
      },
    );
  }

  /** Tạo tài khoản mới trong tenant; trường họ tên trống được bỏ khỏi payload vì hợp đồng tạo người dùng coi chúng là tuỳ chọn. */
  function createTenantUser(event: FormEvent) {
    event.preventDefault();
    if (!selectedTenant) return;
    setMessage(null);
    createUserMutation.mutate(
      {
        tenantId: selectedTenant.id,
        draft: {
          username: newUserDraft.username.trim(),
          email: newUserDraft.email.trim(),
          password: newUserDraft.password,
          ...(newUserDraft.firstName.trim() ? { firstName: newUserDraft.firstName.trim() } : {}),
          ...(newUserDraft.lastName.trim() ? { lastName: newUserDraft.lastName.trim() } : {}),
        },
      },
      {
        onSuccess: () => {
          setNewUserDraft({ username: '', email: '', password: '', firstName: '', lastName: '' });
          setMessage(t('tenantUserCreated'));
        },
        onError: () => setMessage(t('tenantUserCreateFailed')),
      },
    );
  }

  /** Đổi trạng thái membership của một thành viên trong đúng tenant đang quản lý. */
  function setMemberStatus(membership: TenantMembership, status: TenantMemberStatus) {
    if (!selectedTenant || membership.status === status) return;
    setMessage(null);
    setMemberStatusMutation.mutate(
      { tenantId: selectedTenant.id, userId: membership.userId, status },
      {
        onSuccess: () => setMessage(t('tenantMemberStatusUpdated')),
        onError: () => setMessage(t('tenantMemberStatusUpdateFailed')),
      },
    );
  }

  /** Nhãn loại tenant theo hợp đồng API (`school`, `center` hoặc `platform`). */
  function kindLabel(kind: Tenant['kind']): string {
    if (kind === 'center') return t('tenantKindCenter');
    if (kind === 'school') return t('tenantKindSchool');
    return t('tenantKindPlatform');
  }

  /** Nhãn trạng thái vòng đời của tenant. */
  function tenantStatusLabel(status: Tenant['status']): string {
    if (status === 'suspended') return t('tenantStatusSuspended');
    if (status === 'archived') return t('tenantStatusArchived');
    return t('tenantStatusActive');
  }

  /** Nhãn trạng thái membership. */
  function memberStatusLabel(status: TenantMembership['status']): string {
    if (status === 'suspended') return t('tenantMemberStatusSuspended');
    if (status === 'ended') return t('tenantMemberStatusEnded');
    return t('tenantMemberStatusActive');
  }

  const rootQuery = platformMode ? tenantsQuery : currentTenantQuery;
  const rootForbidden = isForbidden(rootQuery.error);
  const rootError = rootQuery.isError && !rootForbidden ? t('tenantsLoadFailed') : null;
  const membersForbidden = isForbidden(membersQuery.error) || isForbidden(usersQuery.error);
  const membersError =
    (membersQuery.isError || usersQuery.isError) && !membersForbidden ? t('tenantMembersLoadFailed') : null;

  if (!perms.ready) {
    return (
      <PageShell width="wide">
        <PageHeader title={t('tenantsTitle')} description={t('tenantsDescription')} />
        <PageSkeleton rows={['h-40 w-full', 'h-64 w-full']} label={t('loading')} />
      </PageShell>
    );
  }

  if (!perms.canViewTenantAdmin) {
    return (
      <PageShell width="narrow">
        <PageHeader title={t('tenantsTitle')} description={t('tenantsDescription')} />
        <ErrorAlert variant="destructive">{t('tenantsForbidden')}</ErrorAlert>
      </PageShell>
    );
  }

  return (
    <PageShell width="wide">
      <PageHeader title={t('tenantsTitle')} description={t('tenantsDescription')} />
      {message ? <ErrorAlert>{message}</ErrorAlert> : null}
      {rootForbidden ? <ErrorAlert variant="destructive">{t('tenantsForbidden')}</ErrorAlert> : null}
      {rootError ? (
        <ErrorAlert variant="destructive" descriptionClassName="flex items-center justify-between gap-2">
          <span>{rootError}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void rootQuery.refetch()}>
            {t('retry')}
          </Button>
        </ErrorAlert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>{platformMode ? t('tenantsTitle') : t('tenantCurrentTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            {rootQuery.isPending ? (
              <PageSkeleton rows={['h-16 w-full', 'h-16 w-full', 'h-16 w-full']} label={t('loading')} />
            ) : platformMode ? (
              platformTenants.length === 0 ? (
                <Empty className="p-6">
                  <EmptyHeader>
                    <EmptyTitle>{t('tenantsEmpty')}</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="flex flex-col divide-y">
                  {platformTenants.map((tenant) => (
                    <button
                      key={tenant.id}
                      type="button"
                      aria-pressed={tenant.id === selectedTenantIdEffective}
                      className="flex w-full flex-col gap-2 py-3 text-left hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between"
                      onClick={() => setSelectedTenantId(tenant.id)}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{tenant.name}</span>
                        <span className="block text-sm text-muted-foreground">
                          {tenant.slug} · {kindLabel(tenant.kind)}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {t('tenantCreatedAt')}: {formatDate(tenant.createdAt)} · {t('tenantUpdatedAt')}:{' '}
                          {formatDate(tenant.updatedAt)}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-wrap gap-2">
                        <Badge variant="outline">{tenant.plan ?? t('tenantPlanNone')}</Badge>
                        <Badge variant={tenant.status === 'active' ? 'default' : 'secondary'}>
                          {tenantStatusLabel(tenant.status)}
                        </Badge>
                      </span>
                    </button>
                  ))}
                </div>
              )
            ) : selectedTenant ? (
              <div className="flex flex-col gap-2">
                <p className="text-lg font-medium">{selectedTenant.name}</p>
                <p className="text-sm text-muted-foreground">
                  {selectedTenant.slug} · {kindLabel(selectedTenant.kind)}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Badge variant={selectedTenant.status === 'active' ? 'default' : 'secondary'}>
                    {tenantStatusLabel(selectedTenant.status)}
                  </Badge>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {platformMode && perms.canManagePlatformTenants ? (
          <Card>
            <CardHeader>
              <CardTitle>{t('tenantCreateTitle')}</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={(event) => void createTenant(event)}>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="tenant-name">{t('tenantName')}</FieldLabel>
                    <Input
                      id="tenant-name"
                      value={tenantDraft.name}
                      onChange={(event) => setTenantDraft({ ...tenantDraft, name: event.target.value })}
                      required
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="tenant-slug">{t('tenantSlug')}</FieldLabel>
                    <Input
                      id="tenant-slug"
                      value={tenantDraft.slug}
                      onChange={(event) => setTenantDraft({ ...tenantDraft, slug: event.target.value })}
                      required
                    />
                  </Field>
                  <Field>
                    <FieldLabel id="tenant-kind-label">{t('tenantKind')}</FieldLabel>
                    <Select
                      items={{ center: t('tenantKindCenter'), school: t('tenantKindSchool') }}
                      value={tenantDraft.kind}
                      onValueChange={(value) => {
                        if (value === 'school' || value === 'center') setTenantDraft({ ...tenantDraft, kind: value });
                      }}
                    >
                      <SelectTrigger aria-labelledby="tenant-kind-label" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="center">{t('tenantKindCenter')}</SelectItem>
                        <SelectItem value="school">{t('tenantKindSchool')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="tenant-plan">{t('tenantPlanOptional')}</FieldLabel>
                    <Input
                      id="tenant-plan"
                      value={tenantDraft.plan}
                      onChange={(event) => setTenantDraft({ ...tenantDraft, plan: event.target.value })}
                    />
                  </Field>
                  <div className="flex justify-end">
                    <Button type="submit" disabled={createTenantMutation.isPending}>
                      {t('tenantCreate')}
                    </Button>
                  </div>
                </FieldGroup>
              </form>
            </CardContent>
          </Card>
        ) : null}
      </div>

      {selectedTenant ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('tenantMembersTitle')}</CardTitle>
            <p className="text-sm text-muted-foreground">{t('tenantMembersDescription')}</p>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            {membersForbidden ? <ErrorAlert variant="destructive">{t('tenantsForbidden')}</ErrorAlert> : null}
            {membersError ? (
              <ErrorAlert variant="destructive" descriptionClassName="flex items-center justify-between gap-2">
                <span>{membersError}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void membersQuery.refetch();
                    void usersQuery.refetch();
                  }}
                >
                  {t('retry')}
                </Button>
              </ErrorAlert>
            ) : null}
            {!canViewSelected ? (
              // Ảnh chụp quyền đã sẵn sàng nhưng người dùng không có
              // quyền tại tenant đang chọn/hiệu lực (quyền tenant chỉ
              // nằm ở một tenant khác): hai truy vấn thành viên bị tắt
              // theo `canViewSelected` nên rơi xuống nhánh chờ sẽ treo
              // khung chờ vô hạn — hiện trạng thái cấm như các khu vực
              // khác của trang.
              <ErrorAlert variant="destructive">{t('tenantsForbidden')}</ErrorAlert>
            ) : membersQuery.isPending || usersQuery.isPending ? (
              <PageSkeleton rows={['h-12 w-full', 'h-12 w-full', 'h-12 w-full']} label={t('loading')} />
            ) : memberRows.length === 0 ? (
              <Empty className="p-6">
                <EmptyHeader>
                  <EmptyTitle>{t('tenantMembersEmpty')}</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('fullName')}</TableHead>
                    <TableHead>{t('username')}</TableHead>
                    <TableHead>{t('email')}</TableHead>
                    <TableHead>{t('status')}</TableHead>
                    <TableHead>{t('tenantJoinedAt')}</TableHead>
                    <TableHead>{t('tenantEndedAt')}</TableHead>
                    {canManageSelected ? <TableHead>{t('actions')}</TableHead> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {memberRows.map(({ membership, user }) => (
                    <TableRow key={membership.id}>
                      <TableCell>{user ? `${user.firstName} ${user.lastName}`.trim() || user.username : membership.userId}</TableCell>
                      <TableCell>{user?.username ?? '—'}</TableCell>
                      <TableCell>{user?.email ?? '—'}</TableCell>
                      <TableCell>{memberStatusLabel(membership.status)}</TableCell>
                      <TableCell>{formatDate(membership.joinedAt)}</TableCell>
                      <TableCell>{membership.endedAt ? formatDate(membership.endedAt) : '—'}</TableCell>
                      {canManageSelected ? (
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            {membership.status !== 'active' ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={setMemberStatusMutation.isPending}
                                onClick={() => setMemberStatus(membership, 'active')}
                              >
                                {t('tenantSetMemberActive')}
                              </Button>
                            ) : null}
                            {membership.status !== 'suspended' ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={setMemberStatusMutation.isPending}
                                onClick={() => setMemberStatus(membership, 'suspended')}
                              >
                                {t('tenantSuspendMember')}
                              </Button>
                            ) : null}
                            {membership.status !== 'ended' ? (
                              <Button
                                type="button"
                                variant="destructive"
                                size="sm"
                                disabled={setMemberStatusMutation.isPending}
                                onClick={() => setMemberStatus(membership, 'ended')}
                              >
                                {t('tenantEndMember')}
                              </Button>
                            ) : null}
                          </div>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            {canManageSelected ? (
              <div className="grid gap-6 lg:grid-cols-2">
                <form onSubmit={(event) => void addMember(event)}>
                  <FieldGroup>
                    <h3 className="font-medium">{t('tenantAddMemberTitle')}</h3>
                    <Field>
                      <FieldLabel htmlFor="tenant-existing-user-id">{t('userId')}</FieldLabel>
                      <Input
                        id="tenant-existing-user-id"
                        value={existingUserId}
                        onChange={(event) => setExistingUserId(event.target.value)}
                        required
                      />
                    </Field>
                    <div className="flex justify-end">
                      <Button type="submit" disabled={addMemberMutation.isPending}>
                        {t('tenantAddMember')}
                      </Button>
                    </div>
                  </FieldGroup>
                </form>

                <form onSubmit={(event) => void createTenantUser(event)}>
                  <FieldGroup>
                    <div>
                      <h3 className="font-medium">{t('tenantCreateUserTitle')}</h3>
                      <p className="text-sm text-muted-foreground">{t('tenantCreateUserDescription')}</p>
                    </div>
                    <Field>
                      <FieldLabel htmlFor="tenant-new-username">{t('username')}</FieldLabel>
                      <Input
                        id="tenant-new-username"
                        value={newUserDraft.username}
                        onChange={(event) => setNewUserDraft({ ...newUserDraft, username: event.target.value })}
                        required
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="tenant-new-email">{t('email')}</FieldLabel>
                      <Input
                        id="tenant-new-email"
                        type="email"
                        value={newUserDraft.email}
                        onChange={(event) => setNewUserDraft({ ...newUserDraft, email: event.target.value })}
                        required
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="tenant-new-password">{t('password')}</FieldLabel>
                      <Input
                        id="tenant-new-password"
                        type="password"
                        value={newUserDraft.password}
                        onChange={(event) => setNewUserDraft({ ...newUserDraft, password: event.target.value })}
                        required
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="tenant-new-first-name">{t('firstName')}</FieldLabel>
                      <Input
                        id="tenant-new-first-name"
                        value={newUserDraft.firstName}
                        onChange={(event) => setNewUserDraft({ ...newUserDraft, firstName: event.target.value })}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="tenant-new-last-name">{t('lastName')}</FieldLabel>
                      <Input
                        id="tenant-new-last-name"
                        value={newUserDraft.lastName}
                        onChange={(event) => setNewUserDraft({ ...newUserDraft, lastName: event.target.value })}
                      />
                    </Field>
                    <div className="flex justify-end">
                      <Button type="submit" disabled={createUserMutation.isPending}>
                        {t('createUser')}
                      </Button>
                    </div>
                  </FieldGroup>
                </form>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </PageShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default AdminTenantsPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR, cùng mẫu các trang quản trị khác).
export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';
export function meta() {
  return appKeyMeta('navTenants');
}

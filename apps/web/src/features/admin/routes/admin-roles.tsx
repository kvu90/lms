import { useEffect, useRef, useState } from 'react';
import { CAP, type Role } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@lms/ui/components/select';
import { PageSkeleton } from '#components/page-skeleton';
import { ErrorAlert } from '#components/error-alert';
import { useTranslation } from 'react-i18next';
import { DataTable, type DataColumn } from '#components/data-table';
import { PageHeader, PageShell } from '#components/page-shell';
import '#config/i18n';
import {
  useAccessCapabilities,
  useAccessContexts,
  useAccessRoles,
  useCreateAssignment,
  useRoleCapabilities,
} from '#lib/access';

/** Nhãn mức quyền dịch qua catalog ở thời điểm render (xem hook trong component). */

/**
 * Trang quản trị vai trò: danh sách vai + danh mục capability + cây
 * context là ba query TanStack (lib/access.ts, F-01) dùng chung khoá
 * factory với các bề mặt quản trị khác; ma trận capability của một vai là
 * query theo vai được chọn; gán vai là mutation làm mới các truy vấn
 * access và ảnh chụp capability thay vì im lặng như trước.
 */
export function AdminRolesPage() {
  const { t } = useTranslation('app');
  const PERMISSION_LABEL: Record<number, string> = {
    [CAP.ALLOW]: t('permAllow'),
    [CAP.INHERIT]: t('permInherit'),
    [CAP.PREVENT]: t('permPrevent'),
    [CAP.PROHIBIT]: t('permProhibit'),
  };
  /** Cột của ma trận capability trên DataTable dùng chung: lọc/sắp xếp theo tên capability (danh mục capability rất dài nên lọc là nhu cầu thật), phân trang thay cho bảng thô trước đây. */
  const matrixColumns: DataColumn<{ name: string; contextId: string; permission: string }>[] = [
    {
      id: 'capability',
      header: t('capability'),
      cell: (row) => <code>{row.name}</code>,
      sortValue: (row) => row.name,
      filterValue: (row) => row.name,
    },
    { id: 'context', header: t('context'), cell: (row) => row.contextId },
    {
      id: 'permission',
      header: t('permission'),
      cell: (row) => row.permission,
      filterValue: (row) => row.permission,
    },
  ];
  const [assign, setAssign] = useState({ userId: '', roleId: '', contextId: '' });
  const [matrixRole, setMatrixRole] = useState<Role | null>(null);

  const rolesQuery = useAccessRoles();
  const capabilitiesQuery = useAccessCapabilities();
  const contextsQuery = useAccessContexts();
  const matrixQuery = useRoleCapabilities(matrixRole?.id ?? null);
  const assignmentMutation = useCreateAssignment();

  const roles = rolesQuery.data ?? [];
  const capabilities = capabilitiesQuery.data ?? [];
  const contexts = contextsQuery.data ?? [];
  const matrix = matrixQuery.data ?? [];
  const loading = rolesQuery.isPending || capabilitiesQuery.isPending || contextsQuery.isPending;
  const loadFailed = rolesQuery.isError || capabilitiesQuery.isError || contextsQuery.isError;

  /** Mặc định context của form gán vai là context hệ thống (level 10), đặt một lần khi cây context về. */
  const contextDefaulted = useRef(false);
  useEffect(() => {
    if (contextDefaulted.current || !contextsQuery.data) return;
    contextDefaulted.current = true;
    const system = contextsQuery.data.find((ctx) => ctx.contextLevel === 10);
    if (system) setAssign((prev) => ({ ...prev, contextId: String(system.id) }));
  }, [contextsQuery.data]);

  function submitAssignment() {
    assignmentMutation.mutate(
      { userId: assign.userId, roleId: assign.roleId, contextId: assign.contextId },
      { onSuccess: () => setAssign((prev) => ({ ...prev, userId: '' })) },
    );
  }

  function showMatrix(roleRow: Role) {
    setMatrixRole(roleRow);
  }

  return (
    <PageShell width="full">
      <PageHeader title={t('rolesTitle')} description={t('rolesDescription')} />
      {loadFailed ? (
        <>
          <ErrorAlert variant="destructive">
            {t('rolesLoadFailed')}
          </ErrorAlert>
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
              <ul className="divide-y">
                {roles.map((r) => (
                  <li key={r.id} className="flex items-center justify-between py-2">
                    <span>
                      <strong>{r.name}</strong> <code>{r.shortName}</code>
                      {r.archetype ? ` ${t('archetypeSuffix', { archetype: r.archetype })}` : ''}
                    </span>
                    <Button type="button" variant="outline" onClick={() => showMatrix(r)}>
                      {t('capabilityMatrix')}
                    </Button>
                  </li>
                ))}
              </ul>
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

      <Card>
        <CardHeader>
          <CardTitle>{t('assignRoleTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="assign-userid">{t('userId')}</FieldLabel>
              <Input
                id="assign-userid"
                inputMode="numeric"
                value={assign.userId}
                onChange={(e) => setAssign({ ...assign, userId: e.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel id="assign-role-label">{t('role')}</FieldLabel>
              <Select
                items={Object.fromEntries(roles.map((r) => [r.id, r.shortName]))}
                value={assign.roleId === '' ? null : assign.roleId}
                onValueChange={(v) => setAssign({ ...assign, roleId: v ?? '' })}
              >
                <SelectTrigger aria-labelledby="assign-role-label" className="w-full">
                  <SelectValue placeholder={t('selectRole')} />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.shortName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel id="assign-context-label">{t('context')}</FieldLabel>
              <Select
                items={Object.fromEntries(
                  contexts.map((c) => [
                    c.id,
                    t('contextOption', { level: c.contextLevel, instance: c.instanceId, path: c.path }),
                  ]),
                )}
                value={assign.contextId === '' ? null : assign.contextId}
                onValueChange={(v) => setAssign({ ...assign, contextId: v ?? '' })}
              >
                <SelectTrigger aria-labelledby="assign-context-label" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {contexts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {t('contextOption', { level: c.contextLevel, instance: c.instanceId, path: c.path })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="flex justify-end">
              <Button type="button" onClick={() => submitAssignment()}>
                {t('assignRole')}
              </Button>
            </div>
          </FieldGroup>
        </CardContent>
      </Card>

      {matrixRole && (
        <Card>
          <CardHeader>
            <CardTitle>{t('matrixTitle', { shortName: matrixRole.shortName })}</CardTitle>
            <CardDescription>{t('matrixDescription')}</CardDescription>
          </CardHeader>
          <DataTable
            data={capabilities.map((cap) => {
              const row = matrix.find((m) => m.capability === cap.name);
              return {
                name: cap.name,
                contextId: row ? row.contextId : '—',
                permission: row ? (PERMISSION_LABEL[row.permission] ?? String(row.permission)) : t('permInherit'),
              };
            })}
            columns={matrixColumns}
            labels={{
              columns: t('dashboard:tableColumns'),
              previous: t('dashboard:tablePrevious'),
              next: t('dashboard:tableNext'),
              empty: t('dashboard:emptyTable'),
              filterPlaceholder: t('dashboard:tableFilterPlaceholder'),
              pageInfo: (page, pages) => t('dashboard:tablePageInfo', { page, pages }),
            }}
            getRowId={(row) => row.name}
          />
        </Card>
      )}
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

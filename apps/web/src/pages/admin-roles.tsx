import { useCallback, useEffect, useState } from 'react';
import { CAP, type Capability, type Role } from '@lms/contracts';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
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
import { Skeleton } from '@lms/ui/components/skeleton';
import { useTranslation } from 'react-i18next';
import { DataTable, type DataColumn } from '#components/data-table';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import { apiJson } from '#lib/api';

interface ContextRow {
  id: string;
  contextLevel: number;
  instanceId: string;
  path: string;
}
interface RoleCapabilityRow {
  roleId: string;
  capability: string;
  contextId: string;
  permission: number;
}

/** Nhãn mức quyền dịch qua catalog ở thời điểm render (xem hook trong component). */

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
  const [roles, setRoles] = useState<Role[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [contexts, setContexts] = useState<ContextRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [assign, setAssign] = useState({ userId: '', roleId: '', contextId: '' });
  const [matrixRole, setMatrixRole] = useState<Role | null>(null);
  const [matrix, setMatrix] = useState<RoleCapabilityRow[]>([]);

  const load = useCallback(async () => {
    try {
      const [r, c, x] = await Promise.all([
        apiJson<Role[]>('/api/v1/access/roles'),
        apiJson<Capability[]>('/api/v1/access/capabilities'),
        apiJson<ContextRow[]>('/api/v1/access/contexts'),
      ]);
      setRoles(r);
      setCapabilities(c);
      setContexts(x);
      const system = x.find((ctx) => ctx.contextLevel === 10);
      if (system) setAssign((prev) => ({ ...prev, contextId: String(system.id) }));
      setError(null);
    } catch {
      setError(t('rolesLoadFailed'));
    }
  }, []);

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, [load]);

  async function submitAssignment() {
    await apiJson('/api/v1/access/assignments', {
      method: 'POST',
      body: JSON.stringify({ userId: assign.userId, roleId: assign.roleId, contextId: assign.contextId }),
    });
    setAssign({ ...assign, userId: '' });
  }

  async function showMatrix(roleRow: Role) {
    setMatrixRole(roleRow);
    const rows = await apiJson<RoleCapabilityRow[]>(`/api/v1/access/roles/${roleRow.id}/capabilities`);
    setMatrix(rows);
  }

  return (
    <PageShell width="full">
      <PageHeader title={t('rolesTitle')} description={t('rolesDescription')} />
      {error ? (
        <>
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setLoading(true);
                void load().finally(() => setLoading(false));
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
            <div className="space-y-2" aria-label={t('loading')}>
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : (
            <>
              <ul className="divide-y">
                {roles.map((r) => (
                  <li key={r.id} className="flex items-center justify-between py-2">
                    <span>
                      <strong>{r.name}</strong> <code>{r.shortName}</code>
                      {r.archetype ? ` ${t('archetypeSuffix', { archetype: r.archetype })}` : ''}
                    </span>
                    <Button type="button" variant="outline" onClick={() => void showMatrix(r)}>
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
              <Button type="button" onClick={() => void submitAssignment()}>
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
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('navRoles');
}

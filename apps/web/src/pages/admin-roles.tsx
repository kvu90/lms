import { useCallback, useEffect, useState } from 'react';
import { CAP, type Capability, type Role } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { useTranslation } from 'react-i18next';
import { DataTable, type DataColumn } from '#components/data-table';
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
    void load();
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
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('rolesTitle')}</CardTitle>
          <CardDescription>{t('rolesDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('assignRoleTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="assign-userid">{t('userId')}</Label>
            <Input
              id="assign-userid"
              inputMode="numeric"
              value={assign.userId}
              onChange={(e) => setAssign({ ...assign, userId: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="assign-role">{t('role')}</Label>
            <select
              id="assign-role"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              value={assign.roleId}
              onChange={(e) => setAssign({ ...assign, roleId: e.target.value })}
            >
              <option value="">{t('selectRole')}</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.shortName}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="assign-context">{t('context')}</Label>
            <select
              id="assign-context"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              value={assign.contextId}
              onChange={(e) => setAssign({ ...assign, contextId: e.target.value })}
            >
              {contexts.map((c) => (
                <option key={c.id} value={c.id}>
                  {t('contextOption', { level: c.contextLevel, instance: c.instanceId, path: c.path })}
                </option>
              ))}
            </select>
          </div>
          <Button type="button" onClick={() => void submitAssignment()}>
            {t('assignRole')}
          </Button>
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
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default AdminRolesPage;

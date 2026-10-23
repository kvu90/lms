import { useCallback, useEffect, useState } from 'react';
import { CAP, type Capability, type Role } from '@lms/contracts';
import { Button } from '@lms/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/ui/card';
import { Input } from '@lms/ui/components/ui/input';
import { Label } from '@lms/ui/components/ui/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '@/lib/api';

interface ContextRow {
  id: string;
  contextlevel: number;
  instanceid: string;
  path: string;
}
interface RoleCapabilityRow {
  roleid: string;
  capability: string;
  contextid: string;
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
  const [roles, setRoles] = useState<Role[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [contexts, setContexts] = useState<ContextRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [assign, setAssign] = useState({ userid: '', roleid: '', contextid: '' });
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
      const system = x.find((ctx) => ctx.contextlevel === 10);
      if (system) setAssign((prev) => ({ ...prev, contextid: String(system.id) }));
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
      body: JSON.stringify({ userid: assign.userid, roleid: assign.roleid, contextid: assign.contextid }),
    });
    setAssign({ ...assign, userid: '' });
  }

  async function showMatrix(roleRow: Role) {
    setMatrixRole(roleRow);
    const rows = await apiJson<RoleCapabilityRow[]>(`/api/v1/access/roles/${roleRow.id}/capabilities`);
    setMatrix(rows);
  }

  return (
    <main className="@container/main flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
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
                  <strong>{r.name}</strong> <code>{r.shortname}</code>
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
              value={assign.userid}
              onChange={(e) => setAssign({ ...assign, userid: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="assign-role">{t('role')}</Label>
            <select
              id="assign-role"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              value={assign.roleid}
              onChange={(e) => setAssign({ ...assign, roleid: e.target.value })}
            >
              <option value="">{t('selectRole')}</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.shortname}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="assign-context">{t('context')}</Label>
            <select
              id="assign-context"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              value={assign.contextid}
              onChange={(e) => setAssign({ ...assign, contextid: e.target.value })}
            >
              {contexts.map((c) => (
                <option key={c.id} value={c.id}>
                  {t('contextOption', { level: c.contextlevel, instance: c.instanceid, path: c.path })}
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
            <CardTitle>{t('matrixTitle', { shortname: matrixRole.shortname })}</CardTitle>
            <CardDescription>{t('matrixDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left">
                  <th>{t('capability')}</th>
                  <th>{t('context')}</th>
                  <th>{t('permission')}</th>
                </tr>
              </thead>
              <tbody>
                {capabilities.map((cap) => {
                  const row = matrix.find((m) => m.capability === cap.name);
                  return (
                    <tr key={cap.name} className="border-t">
                      <td>
                        <code>{cap.name}</code>
                      </td>
                      <td>{row ? row.contextid : '—'}</td>
                      <td>{row ? (PERMISSION_LABEL[row.permission] ?? row.permission) : t('permInherit')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default AdminRolesPage;

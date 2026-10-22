import { useCallback, useEffect, useState } from 'react';
import { CAP, type Capability, type Role } from '@lms/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiJson } from '@/lib/api';

interface ContextRow { id: number; contextlevel: number; instanceid: number; path: string }
interface RoleCapabilityRow { roleid: number; capability: string; contextid: number; permission: number }

const PERMISSION_LABEL: Record<number, string> = {
  [CAP.ALLOW]: 'Allow', [CAP.INHERIT]: 'Inherit', [CAP.PREVENT]: 'Prevent', [CAP.PROHIBIT]: 'Prohibit',
};

export function AdminRolesPage() {
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
      setRoles(r); setCapabilities(c); setContexts(x);
      const system = x.find((ctx) => ctx.contextlevel === 10);
      if (system) setAssign((prev) => ({ ...prev, contextid: String(system.id) }));
      setError(null);
    } catch {
      setError('Could not load roles — you may lack the moodle/role:manage capability.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function submitAssignment() {
    await apiJson('/api/v1/access/assignments', {
      method: 'POST',
      body: JSON.stringify({ userid: Number(assign.userid), roleid: Number(assign.roleid), contextid: Number(assign.contextid) }),
    });
    setAssign({ ...assign, userid: '' });
  }

  async function showMatrix(roleRow: Role) {
    setMatrixRole(roleRow);
    const rows = await apiJson<RoleCapabilityRow[]>(`/api/v1/access/roles/${roleRow.id}/capabilities`);
    setMatrix(rows);
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <Card>
        <CardHeader>
          <CardTitle>Roles</CardTitle>
          <CardDescription>Standard Moodle core roles. Permissions are evaluated by the API over the context tree — this page is administration only.</CardDescription>
        </CardHeader>
        <CardContent>
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <ul className="divide-y">
            {roles.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-2">
                <span><strong>{r.name}</strong> <code>{r.shortname}</code>{r.archetype ? ` — archetype: ${r.archetype}` : ''}</span>
                <Button type="button" variant="outline" onClick={() => void showMatrix(r)}>Capability matrix</Button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Assign role at a context</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1"><Label htmlFor="assign-userid">User ID</Label>
            <Input id="assign-userid" inputMode="numeric" value={assign.userid} onChange={(e) => setAssign({ ...assign, userid: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="assign-role">Role</Label>
            <select id="assign-role" className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm" value={assign.roleid} onChange={(e) => setAssign({ ...assign, roleid: e.target.value })}>
              <option value="">Select a role…</option>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.shortname}</option>)}
            </select></div>
          <div className="space-y-1"><Label htmlFor="assign-context">Context</Label>
            <select id="assign-context" className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm" value={assign.contextid} onChange={(e) => setAssign({ ...assign, contextid: e.target.value })}>
              {contexts.map((c) => <option key={c.id} value={c.id}>level {c.contextlevel} · instance {c.instanceid} · {c.path}</option>)}
            </select></div>
          <Button type="button" onClick={() => void submitAssignment()}>Assign role</Button>
        </CardContent>
      </Card>

      {matrixRole && (
        <Card>
          <CardHeader>
            <CardTitle>Capability matrix — {matrixRole.shortname}</CardTitle>
            <CardDescription>Overrides stored per context (seeded archetype defaults live at the system context).</CardDescription>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead><tr className="text-left"><th>Capability</th><th>Context</th><th>Permission</th></tr></thead>
              <tbody>
                {capabilities.map((cap) => {
                  const row = matrix.find((m) => m.capability === cap.name);
                  return (
                    <tr key={cap.name} className="border-t">
                      <td><code>{cap.name}</code></td>
                      <td>{row ? row.contextid : '—'}</td>
                      <td>{row ? (PERMISSION_LABEL[row.permission] ?? row.permission) : 'Inherit'}</td>
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

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import type { Cohort, CourseCompletion, CourseGroup, EnrolInstance, UserEnrolment } from '@lms/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiJson } from '@/lib/api';

/** Course administration: groups, cohorts, manual enrolment with suspend/reactivate, and learner completion progress. */
export function CourseAdminPage() {
  const { id } = useParams();
  const courseId = Number(id);
  const [groups, setGroups] = useState<CourseGroup[]>([]);
  const [groupName, setGroupName] = useState('');
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [instances, setInstances] = useState<EnrolInstance[]>([]);
  const [enrolments, setEnrolments] = useState<UserEnrolment[]>([]);
  const [completions, setCompletions] = useState<CourseCompletion[]>([]);
  const [enrolUserId, setEnrolUserId] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [g, c, i, e, comp] = await Promise.all([
      apiJson<CourseGroup[]>(`/api/v1/courses/${courseId}/groups`).catch(() => []),
      apiJson<Cohort[]>('/api/v1/cohorts').catch(() => []),
      apiJson<EnrolInstance[]>(`/api/v1/courses/${courseId}/enrol/instances`).catch(() => []),
      apiJson<UserEnrolment[]>(`/api/v1/courses/${courseId}/enrolments`).catch(() => []),
      apiJson<CourseCompletion[]>(`/api/v1/courses/${courseId}/completion`).catch(() => []),
    ]);
    setGroups(g); setCohorts(c); setInstances(i); setEnrolments(e); setCompletions(comp);
  }, [courseId]);

  useEffect(() => { void reload(); }, [reload]);

  const manualInstance = instances.find((i) => i.enrol === 'manual');

  async function createGroup(event: FormEvent) {
    event.preventDefault();
    try {
      await apiJson(`/api/v1/courses/${courseId}/groups`, { method: 'POST', body: JSON.stringify({ name: groupName }) });
      setGroupName('');
      await reload();
      setMessage('Group created');
    } catch { setMessage('Could not create group'); }
  }

  async function ensureManualAndEnrol(event: FormEvent) {
    event.preventDefault();
    try {
      let instance = manualInstance;
      if (!instance) {
        instance = await apiJson<EnrolInstance>(`/api/v1/courses/${courseId}/enrol/instances`, {
          method: 'POST', body: JSON.stringify({ method: 'manual' }),
        });
      }
      await apiJson(`/api/v1/courses/${courseId}/enrol/instances/${instance.id}/enrol`, {
        method: 'POST', body: JSON.stringify({ userid: Number(enrolUserId) }),
      });
      await reload();
      setMessage('User enrolled');
    } catch { setMessage('Could not enrol user'); }
  }

  async function toggleSuspend(ue: UserEnrolment) {
    const action = ue.status === 1 ? 'reactivate' : 'suspend';
    try {
      await apiJson(`/api/v1/courses/${courseId}/enrol/instances/${ue.enrolid}/users/${ue.userid}/${action}`, { method: 'POST' });
      await reload();
    } catch { setMessage('Could not change enrolment status'); }
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <Card>
        <CardHeader><CardTitle>Groups</CardTitle><CardDescription>Groups in this course.</CardDescription></CardHeader>
        <CardContent>
          <ul>{groups.map((g) => <li key={g.id}>{g.name}</li>)}</ul>
          <form onSubmit={createGroup} className="mt-3 space-y-2">
            <Label htmlFor="group-name">New group name</Label>
            <Input id="group-name" value={groupName} onChange={(e) => setGroupName(e.target.value)} />
            <Button type="submit">Create group</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Cohorts</CardTitle><CardDescription>Site/category cohorts available for cohort sync enrolment.</CardDescription></CardHeader>
        <CardContent>
          <ul>{cohorts.map((c) => <li key={c.id}>{c.name} ({c.idnumber || 'no idnumber'})</li>)}</ul>
          {cohorts.length === 0 && <p>No cohorts yet.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Enrolment</CardTitle><CardDescription>Manual enrolment: add a user, suspend or reactivate them.</CardDescription></CardHeader>
        <CardContent>
          <form onSubmit={ensureManualAndEnrol} className="space-y-2">
            <Label htmlFor="enrol-userid">User ID to enrol</Label>
            <Input id="enrol-userid" value={enrolUserId} onChange={(e) => setEnrolUserId(e.target.value)} />
            <Button type="submit">Enrol user</Button>
          </form>
          <ul className="mt-4 space-y-2">
            {enrolments.map((ue) => (
              <li key={ue.id} className="flex items-center gap-3">
                <span>User {ue.userid} — {ue.status === 0 ? 'Active' : ue.status === 1 ? 'Suspended' : 'Withdrawn'} ({ue.enrolMethod ?? ''})</span>
                {ue.status !== 2 && (
                  <Button type="button" variant="outline" onClick={() => void toggleSuspend(ue)}>
                    {ue.status === 1 ? 'Reactivate' : 'Suspend'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Completion progress</CardTitle><CardDescription>Course completion per learner.</CardDescription></CardHeader>
        <CardContent>
          <ul>
            {completions.map((c) => (
              <li key={c.id}>User {c.userid}: {c.status}{c.timecompleted ? ` (completed ${c.timecompleted})` : ''}</li>
            ))}
          </ul>
          {completions.length === 0 && <p>No completion records yet.</p>}
          {message && <p role="status" className="pt-2 text-sm">{message}</p>}
        </CardContent>
      </Card>
    </main>
  );
}

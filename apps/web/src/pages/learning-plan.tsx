import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { apiJson } from '@/lib/api';

interface PlanView { id: number; name: string; status: number; templateid: number | null }
interface PlanDetail { plan: PlanView; competencies: { competency: { id: number; shortname: string }; usercomp: { id: number; grade: number | null; proficiency: boolean | null; status: number } | null }[]; reviews: { action: string; timecreated: string }[] }

const PLAN_STATUS: Record<number, string> = { 0: 'draft', 1: 'active', 2: 'waiting for review', 3: 'in review', 4: 'complete' };
const REVIEW_STATUS: Record<number, string> = { 0: 'no review', 1: 'waiting for review', 2: 'in review' };

/**
 * Learning plans (P4): the learner sees their plans, each competency's
 * proficiency (decided by the framework scale, never inferred from grades)
 * and review state, and can request a review of a competency — the action
 * that starts the reviewer workflow.
 */
export function LearningPlanPage() {
  const { user } = useAuth();
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!user) return;
    const list = await apiJson<PlanView[]>(`/api/v1/competencies/plans/user/${user.id}`);
    setPlans(list);
  }, [user]);

  useEffect(() => { void reload().catch(() => setError('Could not load learning plans')); }, [reload]);

  async function open(plan: PlanView) {
    const d = await apiJson<PlanDetail>(`/api/v1/competencies/plans/${plan.id}`);
    setDetail(d);
  }

  async function requestReview(planId: number) {
    await apiJson(`/api/v1/competencies/plans/${planId}/request-review`, { method: 'POST', body: '{}' });
    setMessage('Review requested.');
    await reload();
  }

  async function requestCompetencyReview(usercompId: number) {
    await apiJson(`/api/v1/competencies/usercomp/${usercompId}/evidence`, {
      method: 'POST', body: JSON.stringify({ action: 'evidence', description: 'Please review my evidence', sendForReview: true }),
    });
    setMessage('Competency sent for review.');
    if (detail) await open(detail.plan);
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-8">
      {error ? <p role="alert">{error}</p> : null}
      {message ? <p>{message}</p> : null}
      <Card>
        <CardHeader><CardTitle>My learning plans</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <ul className="space-y-1" aria-label="Learning plans">
            {plans.map((p) => (
              <li key={p.id} className="flex items-center gap-3 text-sm">
                <span className="font-medium">{p.name}</span>
                <span>{PLAN_STATUS[p.status] ?? p.status}</span>
                <Button type="button" variant="outline" onClick={() => void open(p)}>View</Button>
                {p.status === 1 ? <Button type="button" variant="outline" onClick={() => void requestReview(p.id)}>Request plan review</Button> : null}
              </li>
            ))}
            {plans.length === 0 ? <li>No learning plans yet.</li> : null}
          </ul>
        </CardContent>
      </Card>
      {detail ? (
        <Card>
          <CardHeader><CardTitle>{detail.plan.name} — competencies</CardTitle></CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead><tr><th className="text-left">Competency</th><th className="text-left">Proficiency</th><th className="text-left">Review</th><th /></tr></thead>
              <tbody>
                {detail.competencies.map((row) => (
                  <tr key={row.competency.id}>
                    <td>{row.competency.shortname}</td>
                    <td>{row.usercomp?.proficiency == null ? 'not yet' : row.usercomp.proficiency ? 'proficient' : 'not proficient'}</td>
                    <td>{row.usercomp ? (REVIEW_STATUS[row.usercomp.status] ?? row.usercomp.status) : '—'}</td>
                    <td>
                      {row.usercomp && row.usercomp.status === 0 ? (
                        <Button type="button" variant="outline" onClick={() => void requestCompetencyReview(row.usercomp!.id)}>Send for review</Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ) : null}
    </main>
  );
}

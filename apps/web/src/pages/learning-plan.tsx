import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '@/lib/api';

interface PlanView { id: string; name: string; status: number; templateid: string | null }
interface PlanDetail { plan: PlanView; competencies: { competency: { id: string; shortname: string }; usercomp: { id: string; grade: number | null; proficiency: boolean | null; status: number } | null }[]; reviews: { action: string; timecreated: string }[] }

/** Nhãn trạng thái dịch qua catalog ở thời điểm render (xem hook trong component). */

/**
 * Learning plans: the learner sees their plans, each competency's
 * proficiency (decided by the framework scale, never inferred from grades)
 * and review state, and can request a review of a competency — the action
 * that starts the reviewer workflow.
 */
export function LearningPlanPage() {
  const { t } = useTranslation('app');
  const PLAN_STATUS: Record<number, string> = {
    0: t('planStatusDraft'), 1: t('planStatusActive'), 2: t('planStatusWaiting'), 3: t('planStatusInReview'), 4: t('planStatusComplete'),
  };
  const REVIEW_STATUS: Record<number, string> = { 0: t('reviewStatusNone'), 1: t('reviewStatusWaiting'), 2: t('reviewStatusInReview') };
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

  useEffect(() => { void reload().catch(() => setError(t('plansLoadFailed'))); }, [reload]);

  async function open(plan: PlanView) {
    const d = await apiJson<PlanDetail>(`/api/v1/competencies/plans/${plan.id}`);
    setDetail(d);
  }

  async function requestReview(planId: string) {
    await apiJson(`/api/v1/competencies/plans/${planId}/request-review`, { method: 'POST', body: '{}' });
    setMessage(t('reviewRequested'));
    await reload();
  }

  async function requestCompetencyReview(usercompId: string) {
    await apiJson(`/api/v1/competencies/usercomp/${usercompId}/evidence`, {
      method: 'POST', body: JSON.stringify({ action: 'evidence', description: t('evidenceReviewDescription'), sendForReview: true }),
    });
    setMessage(t('competencySentForReview'));
    if (detail) await open(detail.plan);
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-8">
      {error ? <p role="alert">{error}</p> : null}
      {message ? <p>{message}</p> : null}
      <Card>
        <CardHeader><CardTitle>{t('myLearningPlans')}</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <ul className="space-y-1" aria-label={t('learningPlansLabel')}>
            {plans.map((p) => (
              <li key={p.id} className="flex items-center gap-3 text-sm">
                <span className="font-medium">{p.name}</span>
                <span>{PLAN_STATUS[p.status] ?? p.status}</span>
                <Button type="button" variant="outline" onClick={() => void open(p)}>{t('view')}</Button>
                {p.status === 1 ? <Button type="button" variant="outline" onClick={() => void requestReview(p.id)}>{t('requestPlanReview')}</Button> : null}
              </li>
            ))}
            {plans.length === 0 ? <li>{t('noLearningPlans')}</li> : null}
          </ul>
        </CardContent>
      </Card>
      {detail ? (
        <Card>
          <CardHeader><CardTitle>{t('planCompetenciesTitle', { name: detail.plan.name })}</CardTitle></CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead><tr><th className="text-left">{t('competency')}</th><th className="text-left">{t('proficiency')}</th><th className="text-left">{t('review')}</th><th /></tr></thead>
              <tbody>
                {detail.competencies.map((row) => (
                  <tr key={row.competency.id}>
                    <td>{row.competency.shortname}</td>
                    <td>{row.usercomp?.proficiency == null ? t('proficiencyNotYet') : row.usercomp.proficiency ? t('proficiencyYes') : t('proficiencyNo')}</td>
                    <td>{row.usercomp ? (REVIEW_STATUS[row.usercomp.status] ?? row.usercomp.status) : '—'}</td>
                    <td>
                      {row.usercomp && row.usercomp.status === 0 ? (
                        <Button type="button" variant="outline" onClick={() => void requestCompetencyReview(row.usercomp!.id)}>{t('sendForReview')}</Button>
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

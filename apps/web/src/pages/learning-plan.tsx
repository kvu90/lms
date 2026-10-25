import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Skeleton } from '@lms/ui/components/skeleton';
import { useAuth } from '#lib/auth';
import { usePermissions } from '#lib/permissions';
import { useTranslation } from 'react-i18next';
import { DataTable, type DataColumn } from '#components/data-table';
import { CompetencyAdmin } from '../components/learning-plan/competency-admin';
import { COMPETENCY_INDENT, type PlanDetail, type PlanView } from '../components/learning-plan/types';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import { apiJson } from '#lib/api';

/**
 * Learning plans: the learner sees their plans, each competency's
 * proficiency (decided by the framework scale, never inferred from grades)
 * and review state, and can request a review of a competency — the action
 * that starts the reviewer workflow.
 */
export function LearningPlanPage() {
  const { t } = useTranslation('app');
  const PLAN_STATUS: Record<number, string> = {
    0: t('planStatusDraft'),
    1: t('planStatusActive'),
    2: t('planStatusWaiting'),
    3: t('planStatusInReview'),
    4: t('planStatusComplete'),
  };
  const REVIEW_STATUS: Record<number, string> = {
    0: t('reviewStatusNone'),
    1: t('reviewStatusWaiting'),
    2: t('reviewStatusInReview'),
  };
  const { user } = useAuth();
  const perms = usePermissions();
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  /** Cột của bảng năng lực trong một kế hoạch trên DataTable dùng chung: sắp xếp/lọc theo tên năng lực và mức thành thạo, thao tác gửi duyệt giữ nguyên ở cột cuối. */
  const planCompetencyColumns: DataColumn<PlanDetail['competencies'][number]>[] = [
    {
      id: 'competency',
      header: t('competency'),
      cell: (row) => row.competency.shortName,
      sortValue: (row) => row.competency.shortName,
      filterValue: (row) => row.competency.shortName,
    },
    {
      id: 'proficiency',
      header: t('proficiency'),
      cell: (row) =>
        row.usercomp?.proficiency == null
          ? t('proficiencyNotYet')
          : row.usercomp.proficiency
            ? t('proficiencyYes')
            : t('proficiencyNo'),
      sortValue: (row) => (row.usercomp?.proficiency == null ? -1 : row.usercomp.proficiency ? 1 : 0),
    },
    {
      id: 'review',
      header: t('review'),
      cell: (row) => (row.usercomp ? (REVIEW_STATUS[row.usercomp.status] ?? row.usercomp.status) : '—'),
    },
    {
      id: 'actions',
      header: '',
      cell: (row) =>
        row.usercomp && row.usercomp.status === 0 ? (
          <Button type="button" variant="outline" onClick={() => void requestCompetencyReview(row.usercomp!.id)}>
            {t('sendForReview')}
          </Button>
        ) : null,
    },
  ];
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!user) return;
    const list = await apiJson<PlanView[]>(`/api/v1/competencies/plans/user/${user.id}`);
    setPlans(list);
  }, [user]);

  useEffect(() => {
    void reload()
      .catch(() => setError(t('plansLoadFailed')))
      .finally(() => setLoading(false));
  }, [reload, t]);

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
      method: 'POST',
      body: JSON.stringify({ action: 'evidence', description: t('evidenceReviewDescription'), sendForReview: true }),
    });
    setMessage(t('competencySentForReview'));
    if (detail) await open(detail.plan);
  }

  return (
    <PageShell width="wide">
      <PageHeader title={t('myLearningPlans')} />
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
                setError(null);
                setLoading(true);
                void reload()
                  .catch(() => setError(t('plansLoadFailed')))
                  .finally(() => setLoading(false));
              }}
            >
              {t('retry')}
            </Button>
          </div>
        </>
      ) : null}
      {message ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardContent className="space-y-2">
          {loading ? (
            <div className="space-y-2" aria-label={t('loading')}>
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : (
            <>
              <ul className="space-y-1" aria-label={t('learningPlansLabel')}>
                {plans.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 text-sm">
                    <span className="font-medium">{p.name}</span>
                    <span>{PLAN_STATUS[p.status] ?? p.status}</span>
                    <Button type="button" variant="outline" onClick={() => void open(p)}>
                      {t('view')}
                    </Button>
                    {p.status === 1 ? (
                      <Button type="button" variant="outline" onClick={() => void requestReview(p.id)}>
                        {t('requestPlanReview')}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {plans.length === 0 ? (
                <Empty className="p-6">
                  <EmptyHeader>
                    <EmptyTitle>{t('noLearningPlans')}</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
      {detail ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('planCompetenciesTitle', { name: detail.plan.name })}</CardTitle>
          </CardHeader>
          <DataTable
            data={detail.competencies}
            columns={planCompetencyColumns}
            labels={{
              columns: t('dashboard:tableColumns'),
              previous: t('dashboard:tablePrevious'),
              next: t('dashboard:tableNext'),
              empty: t('dashboard:emptyTable'),
              filterPlaceholder: t('dashboard:tableFilterPlaceholder'),
              pageInfo: (page, pages) => t('dashboard:tablePageInfo', { page, pages }),
            }}
            getRowId={(row) => row.competency.id}
          />
        </Card>
      ) : null}
      {perms.canAdminister ? <CompetencyAdmin /> : null}
    </PageShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default LearningPlanPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('navLearningPlan');
}

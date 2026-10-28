import { useState } from 'react';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { PageSkeleton } from '#components/page-skeleton';
import { ErrorAlert } from '#components/error-alert';
import { useAuth } from '#lib/auth';
import { usePermissions } from '#lib/permissions';
import { useTranslation } from 'react-i18next';
import { DataTable, type DataColumn } from '#components/data-table';
import { CompetencyAdmin } from '../components/learning-plan/competency-admin';
import { COMPETENCY_INDENT, type PlanDetail, type PlanView } from '../components/learning-plan/types';
import { PageHeader, PageShell } from '../components/page-shell';
import {
  useLearningPlanDetail,
  useRequestCompetencyReview,
  useRequestPlanReview,
  useUserLearningPlans,
} from '#lib/learning-plan-data';
import '../i18n';

/**
 * Kế hoạch học tập: học viên thấy các kế hoạch của mình, mức thành thạo
 * của từng competency (do thang của framework quyết định, không bao giờ suy ra từ điểm)
 * và trạng thái review, và có thể yêu cầu review một competency — hành động
 * khởi đầu quy trình của người review.
 *
 * Dữ liệu phần người học đọc qua tầng TanStack Query
 * (`lib/learning-plan-data.ts`): danh sách kế hoạch theo khoá của
 * người dùng trong phiên, chi tiết theo khoá của kế hoạch đang chọn
 * xem; gửi yêu cầu duyệt qua đột biến làm mới đúng bề mặt liên quan.
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
  const plansQuery = useUserLearningPlans(user?.id);
  const plans = plansQuery.data ?? [];
  const [selectedPlan, setSelectedPlan] = useState<PlanView | null>(null);
  const detailQuery = useLearningPlanDetail(selectedPlan?.id ?? null);
  const detail = detailQuery.data ?? null;
  const requestPlanReview = useRequestPlanReview();
  const requestCompetencyReviewMutation = useRequestCompetencyReview();
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
  const loading = plansQuery.isPending || (plansQuery.isError && plansQuery.isFetching);
  const error = plansQuery.isError && !plansQuery.isFetching ? t('plansLoadFailed') : null;

  function open(plan: PlanView) {
    setSelectedPlan(plan);
  }

  async function requestReview(planId: string) {
    if (!user) return;
    await requestPlanReview.mutateAsync({ planId, userId: user.id });
    setMessage(t('reviewRequested'));
  }

  async function requestCompetencyReview(usercompId: string) {
    if (!detail) return;
    await requestCompetencyReviewMutation.mutateAsync({
      usercompId,
      planId: detail.plan.id,
      description: t('evidenceReviewDescription'),
    });
    setMessage(t('competencySentForReview'));
  }

  return (
    <PageShell width="wide">
      <PageHeader title={t('myLearningPlans')} />
      {error ? (
        <>
          <ErrorAlert variant="destructive">
            {error}
          </ErrorAlert>
          <div>
            <Button type="button" variant="outline" onClick={() => void plansQuery.refetch()}>
              {t('retry')}
            </Button>
          </div>
        </>
      ) : null}
      {message ? (
        <ErrorAlert>
          {message}
        </ErrorAlert>
      ) : null}
      <Card>
        <CardContent className="space-y-2">
          {loading ? (
            <PageSkeleton label={t('loading')} rows={['h-8 w-full', 'h-8 w-full']} />
          ) : (
            <>
              <ul className="space-y-1" aria-label={t('learningPlansLabel')}>
                {plans.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 text-sm">
                    <span className="font-medium">{p.name}</span>
                    <span>{PLAN_STATUS[p.status] ?? p.status}</span>
                    <Button type="button" variant="outline" onClick={() => open(p)}>
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

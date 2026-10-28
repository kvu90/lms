import { useTranslation } from 'react-i18next';
import '../i18n';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Skeleton } from '@lms/ui/components/skeleton';
import { ErrorAlert } from '#components/error-alert';
import { PageHeader, PageShell } from '../components/page-shell';
import { useMyInsights } from '#lib/platform-data';

/**
 * Insights cho teacher (platform services): chỉ insight mà server đã
 * lọc theo capability mới tới client. Dữ liệu đọc qua tầng TanStack
 * Query (`lib/platform-data.ts`, khoá `myInsights`; `clientLoader` của
 * route nạp trước đúng khoá này). Trạng thái đang tải/báo lỗi giữ như
 * bản fetch thủ công: lần tải đầu hoặc lần thử lại đang chạy thì hiện
 * khung xương, lỗi chỉ hiện sau khi lần tải đã kết thúc.
 */
export function InsightsPage() {
  const { t: t } = useTranslation();
  const insightsQuery = useMyInsights();
  const insights = insightsQuery.data ?? [];
  const loading = insightsQuery.isPending || (insightsQuery.isError && insightsQuery.isFetching);
  const loadError = insightsQuery.isError && !insightsQuery.isFetching ? t('insightsLoadFailed') : null;
  return (
    <PageShell width="medium">
      <PageHeader title={t('insightsTitle')} />
      {loadError ? (
        <>
          <ErrorAlert variant="destructive">
            {loadError}
          </ErrorAlert>
          <div>
            <Button type="button" variant="outline" onClick={() => void insightsQuery.refetch()}>
              {t('retry')}
            </Button>
          </div>
        </>
      ) : null}
      <Card>
        <CardContent>
          {loading ? (
            <div className="space-y-2" aria-label={t('loading')}>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <>
              <ul aria-label={t('insightsTitle')} className="space-y-2">
                {insights.map((i) => (
                  <li key={i.id} className="rounded border p-2">
                    <p className="font-medium">{i.heading}</p>
                    <p className="text-sm">
                      Student {i.userId} · course {i.courseId}
                    </p>
                  </li>
                ))}
              </ul>
              {insights.length === 0 ? (
                <Empty className="p-6">
                  <EmptyHeader>
                    <EmptyTitle>{t('noInsights')}</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}

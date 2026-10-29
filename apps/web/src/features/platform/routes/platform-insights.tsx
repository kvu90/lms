import { useTranslation } from 'react-i18next';
import '#config/i18n';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { PageSkeleton } from '#components/page-skeleton';
import { ErrorAlert } from '#components/error-alert';
import { PageHeader, PageShell } from '#components/page-shell';
import { useMyInsights } from '../queries/platform';

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
            <PageSkeleton label={t('loading')} rows={['h-10 w-full', 'h-10 w-full']} />
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

/** Route module gộp (issue #500): nội dung trang bên dưới vốn ở module pages riêng, phần khung route (biên lỗi + tiêu đề) vốn ở wrapper routes riêng — hai module nhập một theo bản đồ features/. */
export { InsightsPage as default };

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';
import { platformKeyMeta } from '#lib/route-meta';
export function meta() {
  return platformKeyMeta('insightsTitle');
}

// clientLoader (F-01, rà soát #133): nạp trước dữ liệu đúng khoá trang sẽ đọc.
export { insightsPageClientLoader as clientLoader } from '../queries/platform';

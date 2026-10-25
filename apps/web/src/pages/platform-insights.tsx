import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Skeleton } from '@lms/ui/components/skeleton';
import { PageHeader, PageShell } from '../components/page-shell';
import { apiJson } from '#lib/api';

interface InsightView {
  id: string;
  userId: string;
  heading: string;
  courseId: string;
}

/** Insights cho teacher (platform services): chỉ insight mà server đã lọc theo capability mới tới client. */
export function InsightsPage() {
  const { t: t } = useTranslation();
  const [insights, setInsights] = useState<InsightView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setInsights(await apiJson<InsightView[]>('/api/v1/analytics/insights/me'));
  }, []);
  useEffect(() => {
    void load()
      .catch(() => setLoadError(t('insightsLoadFailed')))
      .finally(() => setLoading(false));
  }, [load, t]);
  return (
    <PageShell width="medium">
      <PageHeader title={t('insightsTitle')} />
      {loadError ? (
        <>
          <Alert variant="destructive">
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setLoadError(null);
                setLoading(true);
                void load()
                  .catch(() => setLoadError(t('insightsLoadFailed')))
                  .finally(() => setLoading(false));
              }}
            >
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

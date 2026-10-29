import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '#config/i18n';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { PageSkeleton } from '#components/page-skeleton';
import { ErrorAlert } from '#components/error-alert';
import { PageHeader, PageShell } from '#components/page-shell';
import { useCreatePrivacyRequest, useDecidePrivacyRequest, usePrivacyRequests } from '../queries/platform';

/**
 * Privacy requests (platform services): user tự gửi yêu cầu export/delete cho chính mình;
 * admin thấy mọi yêu cầu và duyệt/từ chối. Dữ liệu đọc qua tầng TanStack
 * Query (`lib/platform-data.ts`, khoá `privacyRequests`; `clientLoader`
 * của route nạp trước đúng khoá này); gửi yêu cầu và duyệt/từ chối qua
 * đột biến, thành công thì làm mới danh sách như lần tải lại thủ công
 * trước đây.
 */
export function PrivacyPage() {
  const { t: t } = useTranslation();
  const requestsQuery = usePrivacyRequests();
  const createRequest = useCreatePrivacyRequest();
  const decideRequest = useDecidePrivacyRequest();
  const requests = requestsQuery.data ?? [];
  const [sent, setSent] = useState<string | null>(null);
  const loading = requestsQuery.isPending || (requestsQuery.isError && requestsQuery.isFetching);
  const loadError = requestsQuery.isError && !requestsQuery.isFetching ? t('privacyLoadFailed') : null;
  async function send(type: 'export' | 'delete') {
    const created = await createRequest.mutateAsync(type);
    setSent(t('requestSent', { id: created.id, type: created.type, status: created.status }));
  }
  async function decide(id: string, decision: 'approved' | 'rejected') {
    await decideRequest.mutateAsync({ id, decision });
  }
  return (
    <PageShell width="medium">
      <PageHeader title={t('privacyTitle')} />
      {loadError ? (
        <>
          <ErrorAlert variant="destructive">
            {loadError}
          </ErrorAlert>
          <div>
            <Button type="button" variant="outline" onClick={() => void requestsQuery.refetch()}>
              {t('retry')}
            </Button>
          </div>
        </>
      ) : null}
      <Card>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Button type="button" onClick={() => void send('export')}>
              {t('requestExport')}
            </Button>
            <Button type="button" variant="outline" onClick={() => void send('delete')}>
              {t('requestDelete')}
            </Button>
          </div>
          {sent ? (
            <ErrorAlert>
              {sent}
            </ErrorAlert>
          ) : null}
          {loading ? (
            <PageSkeleton label={t('loading')} rows={['h-10 w-full', 'h-10 w-full']} />
          ) : (
            <>
              <ul aria-label={t('privacyRequests')} className="space-y-2">
                {requests.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 rounded border p-2">
                    <span>{t('requestLine', { id: r.id, userId: r.userId, type: r.type, status: r.status })}</span>
                    {r.status === 'pending' ? (
                      <>
                        <Button type="button" variant="outline" onClick={() => void decide(r.id, 'approved')}>
                          {t('approve')}
                        </Button>
                        <Button type="button" variant="outline" onClick={() => void decide(r.id, 'rejected')}>
                          {t('reject')}
                        </Button>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
              {requests.length === 0 ? (
                <Empty className="p-6">
                  <EmptyHeader>
                    <EmptyTitle>{t('noPrivacyRequestsYet')}</EmptyTitle>
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
export { PrivacyPage as default };

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';
import { platformKeyMeta } from '#lib/route-meta';
export function meta() {
  return platformKeyMeta('privacyTitle');
}

// clientLoader (F-01, rà soát #133): nạp trước dữ liệu đúng khoá trang sẽ đọc.
export { privacyPageClientLoader as clientLoader } from '../queries/platform';

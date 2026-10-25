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

interface PrivacyRequestView {
  id: string;
  userId: string;
  type: string;
  status: string;
}

/**
 * Privacy requests (platform services): user tự gửi yêu cầu export/delete cho chính mình;
 * admin thấy mọi yêu cầu và duyệt/từ chối.
 */
export function PrivacyPage() {
  const { t: t } = useTranslation();
  const [requests, setRequests] = useState<PrivacyRequestView[]>([]);
  const [sent, setSent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setRequests(await apiJson<PrivacyRequestView[]>('/api/v1/privacy/requests'));
  }, []);
  useEffect(() => {
    void reload()
      .catch(() => setLoadError(t('privacyLoadFailed')))
      .finally(() => setLoading(false));
  }, [reload, t]);
  async function send(type: 'export' | 'delete') {
    const created = await apiJson<PrivacyRequestView>('/api/v1/privacy/requests', {
      method: 'POST',
      body: JSON.stringify({ type }),
    });
    setSent(t('requestSent', { id: created.id, type: created.type, status: created.status }));
    await reload();
  }
  async function decide(id: string, decision: 'approved' | 'rejected') {
    await apiJson(`/api/v1/privacy/requests/${id}/decide`, { method: 'POST', body: JSON.stringify({ decision }) });
    await reload();
  }
  return (
    <PageShell width="medium">
      <PageHeader title={t('privacyTitle')} />
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
                void reload()
                  .catch(() => setLoadError(t('privacyLoadFailed')))
                  .finally(() => setLoading(false));
              }}
            >
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
            <Alert>
              <AlertDescription>{sent}</AlertDescription>
            </Alert>
          ) : null}
          {loading ? (
            <div className="space-y-2" aria-label={t('loading')}>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
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

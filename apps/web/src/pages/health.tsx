import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import type { HealthStatus } from '@lms/contracts';
import { Alert, AlertDescription, AlertTitle } from '@lms/ui/components/alert';
import { Card, CardContent } from '@lms/ui/components/card';
import { Skeleton } from '@lms/ui/components/skeleton';
import { PageHeader, PageShell } from '../components/page-shell';

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; health: HealthStatus };

export function HealthPage() {
  const { t } = useTranslation('app');
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/health')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as HealthStatus;
      })
      .then((health) => {
        if (!cancelled) setState({ kind: 'ready', health });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: error instanceof Error ? error.message : t('unknownError'),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PageShell width="narrow">
      <PageHeader title={t('healthTitle')} description={t('healthDescription')} />
      <Card>
        <CardContent>
          {state.kind === 'loading' && (
            <div className="space-y-2" aria-label={t('loading')}>
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-4 w-48" />
            </div>
          )}
          {state.kind === 'error' && (
            <Alert variant="destructive">
              <AlertTitle>{t('healthTitle')}</AlertTitle>
              <AlertDescription>{t('healthLoadFailed', { message: state.message })}</AlertDescription>
            </Alert>
          )}
          {state.kind === 'ready' && (
            <dl className="space-y-2">
              <div>
                <dt className="font-medium">{t('status')}</dt>
                <dd>{state.health.status}</dd>
              </div>
              <div>
                <dt className="font-medium">{t('database')}</dt>
                <dd>{state.health.checks.database}</dd>
              </div>
              <div>
                <dt className="font-medium">{t('redis')}</dt>
                <dd>{state.health.checks.redis}</dd>
              </div>
              <div>
                <dt className="font-medium">{t('timestamp')}</dt>
                <dd>{state.health.timestamp}</dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default HealthPage;

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import type { HealthStatus } from '@lms/contracts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/ui/card';

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
    <main className="mx-auto max-w-2xl p-8">
      <Card>
        <CardHeader>
          <CardTitle>{t('healthTitle')}</CardTitle>
          <CardDescription>{t('healthDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {state.kind === 'loading' && <p>{t('loading')}</p>}
          {state.kind === 'error' && <p role="alert">{t('healthLoadFailed', { message: state.message })}</p>}
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
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default HealthPage;

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLoaderData } from 'react-router';
import '../i18n';
import type { HealthStatus } from '@lms/contracts';
import { healthStatusSchema } from '@lms/contracts';
import { Alert, AlertDescription, AlertTitle } from '@lms/ui/components/alert';
import { Card, CardContent } from '@lms/ui/components/card';
import { Skeleton } from '@lms/ui/components/skeleton';
import { PageHeader, PageShell } from '../components/page-shell';
import { fetchApiJson } from '#lib/server-api';

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; health: HealthStatus };

/**
 * Loader phía server (SSR, Giai đoạn 3 của issue #7): trạng thái hệ
 * thống là dữ liệu công khai (endpoint @Public) nên lấy ngay trong
 * loader qua API nội bộ — HTML trả về đã chứa kết quả kiểm tra thay vì
 * khung giữ chỗ. API không với tới được → trả null, trang rơi về luồng
 * fetch phía client như trước.
 */
export async function loader(): Promise<{ health: HealthStatus | null }> {
  const body = await fetchApiJson('/api/v1/health');
  const parsed = healthStatusSchema.safeParse(body);
  return { health: parsed.success ? parsed.data : null };
}

export function HealthPage({ initialHealth }: { initialHealth?: HealthStatus | null } = {}) {
  const { t } = useTranslation('app');
  const [state, setState] = useState<State>(() =>
    initialHealth ? { kind: 'ready', health: initialHealth } : { kind: 'loading' },
  );

  useEffect(() => {
    // Loader đã cấp dữ liệu (SSR) thì KHÔNG fetch lại khi mount — request
    // trùng làm mất giá trị của loader (F-09 trong rà soát #133). Chỉ khi
    // loader không với tới được API (initialHealth null) mới rơi về luồng
    // fetch phía client như trước.
    if (initialHealth) return;
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
  }, [initialHealth]);

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

/**
 * Export mặc định cho route module React Router framework mode (xem
 * src/routes.ts): bọc mỏng đọc dữ liệu loader rồi truyền xuống
 * HealthPage thuần — test render trực tiếp HealthPage vẫn chạy như
 * trước.
 */
export default function HealthRoute() {
  const loaderData = useLoaderData<typeof loader>();
  return <HealthPage initialHealth={loaderData?.health ?? null} />;
}

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('navHealth');
}

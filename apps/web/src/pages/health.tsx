import { useEffect, useState } from 'react';
import type { HealthStatus } from '@lms/contracts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; health: HealthStatus };

export function HealthPage() {
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
            message: error instanceof Error ? error.message : 'Unknown error',
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
          <CardTitle>API health</CardTitle>
          <CardDescription>Live status from GET /api/v1/health</CardDescription>
        </CardHeader>
        <CardContent>
          {state.kind === 'loading' && <p>Loading…</p>}
          {state.kind === 'error' && <p role="alert">Failed to load health: {state.message}</p>}
          {state.kind === 'ready' && (
            <dl className="space-y-2">
              <div>
                <dt className="font-medium">Status</dt>
                <dd>{state.health.status}</dd>
              </div>
              <div>
                <dt className="font-medium">Database</dt>
                <dd>{state.health.checks.database}</dd>
              </div>
              <div>
                <dt className="font-medium">Redis</dt>
                <dd>{state.health.checks.redis}</dd>
              </div>
              <div>
                <dt className="font-medium">Timestamp</dt>
                <dd>{state.health.timestamp}</dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

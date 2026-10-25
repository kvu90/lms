import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthPage } from './health';

describe('HealthPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the API health returned by fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          status: 'ok',
          timestamp: '2026-10-22T00:00:00.000Z',
          checks: { database: 'up', redis: 'up' },
        }),
      }),
    );

    render(
      <MemoryRouter>
        <HealthPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('ok')).toBeInTheDocument();
    expect(screen.getByText('Cơ sở dữ liệu')).toBeInTheDocument();
    expect(screen.getAllByText('up')).toHaveLength(2);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/v1/health');
  });

  it('does not refetch on mount when the loader already supplied health (F-09)', async () => {
    cleanup();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'degraded',
        timestamp: '2026-10-22T01:00:00.000Z',
        checks: { database: 'up', redis: 'down' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <HealthPage
          initialHealth={{
            status: 'ok',
            timestamp: '2026-10-22T00:00:00.000Z',
            checks: { database: 'up', redis: 'up' },
          }}
        />
      </MemoryRouter>,
    );

    // Dữ liệu loader hiện ngay, và fetch phía client không hề chạy.
    expect(await screen.findByText('2026-10-22T00:00:00.000Z')).toBeInTheDocument();
    expect(screen.getAllByText('up')).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows an error state when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    render(
      <MemoryRouter>
        <HealthPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
  });
});

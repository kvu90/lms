import { describe, expect, it, vi } from 'vitest';
import { tenantAls } from '../tenant-als';
import { SpaceRoutingError, type ResolvedSpaceConnection } from './space-connection-resolver';
import type { SpaceDatabaseService } from './space-database.service';
import { SpaceJobRunner } from './space-job-runner';

/**
 * Ca đơn vị của bộ chạy job theo trung tâm (issue #582): khung
 * định tuyến được thay bằng vật giả ghi lại cách phiên được mở —
 * các ca khoá đúng quyết định phiên cho từng hình job: job của
 * trung tâm ở kho riêng chạy trong phiên theo trung tâm mang cả
 * tenant của job; job ở kho chung, job không mang slug và job mà
 * đích không còn phân giải được đều chạy trong ngữ cảnh platform
 * như hiện tại.
 */

const DEDICATED_TARGET: ResolvedSpaceConnection = {
  slug: 'trung-tam-a',
  spaceId: 'id-dang-ky-a',
  status: 'active',
  mode: 'dedicated',
  databaseName: 'lms_centre_a',
  connectionRole: 'centre_a_app',
  connectionString: 'postgres://centre_a_app:pw@db.internal:5432/lms_centre_a',
  schemaVersion: 'v3',
};

const SHARED_TARGET: ResolvedSpaceConnection = {
  ...DEDICATED_TARGET,
  slug: 'truong-mac-dinh',
  spaceId: 'id-dang-ky-truong',
  mode: 'shared',
  databaseName: 'lms_shared',
  connectionRole: 'lms_app',
  connectionString: undefined,
};

function makeRunner(options?: { target?: ResolvedSpaceConnection; resolveError?: Error }) {
  const sessions: Array<{ slug: string; context?: { tenantId?: string; userId?: string } }> = [];
  const spaceDb = {
    resolveTarget: vi.fn(async () => {
      if (options?.resolveError) throw options.resolveError;
      return options?.target ?? DEDICATED_TARGET;
    }),
    withSpaceDatabase: vi.fn(
      async (
        slug: string,
        fn: (db: unknown) => Promise<unknown>,
        context?: { tenantId?: string; userId?: string },
      ) => {
        sessions.push({ slug, context });
        // Mô phỏng đúng hợp đồng của khung thật: fn chạy trong
        // ngữ cảnh ALS mang slug và tenant của phiên.
        return tenantAls.run(
          { spaceSlug: slug, tenantId: context?.tenantId },
          async () => fn({}),
        );
      },
    ),
  };
  const runner = new SpaceJobRunner(spaceDb as unknown as SpaceDatabaseService);
  return { runner, spaceDb, sessions };
}

describe('Bộ chạy job theo trung tâm', () => {
  it('job của trung tâm ở kho riêng chạy trong phiên theo trung tâm: ngữ cảnh mang slug và tenant của job', async () => {
    const { runner, sessions } = makeRunner();
    const observed = await runner.runForJob(
      { spaceSlug: 'trung-tam-a', tenantId: 'tenant-a' },
      async () => tenantAls.getStore(),
    );
    expect(sessions).toEqual([{ slug: 'trung-tam-a', context: { tenantId: 'tenant-a' } }]);
    expect(observed?.spaceSlug).toBe('trung-tam-a');
    expect(observed?.tenantId).toBe('tenant-a');
  });

  it('job của trung tâm ở kho chung chạy trong ngữ cảnh platform như hiện tại, không mở phiên theo trung tâm', async () => {
    const { runner, spaceDb } = makeRunner({ target: SHARED_TARGET });
    const observed = await runner.runForJob(
      { spaceSlug: 'truong-mac-dinh', tenantId: 'tenant-truong' },
      async () => tenantAls.getStore(),
    );
    expect(spaceDb.withSpaceDatabase).not.toHaveBeenCalled();
    expect(observed?.platform).toBe(true);
    expect(observed?.spaceSlug).toBeUndefined();
  });

  it('job không mang slug trung tâm chạy trong ngữ cảnh platform như hiện tại và không phân giải gì', async () => {
    const { runner, spaceDb } = makeRunner();
    const observed = await runner.runForJob({ spaceSlug: null, tenantId: null }, async () =>
      tenantAls.getStore(),
    );
    expect(spaceDb.resolveTarget).not.toHaveBeenCalled();
    expect(observed?.platform).toBe(true);
  });

  it('đích của slug không còn phân giải được thì job vẫn chạy trong ngữ cảnh platform thay vì bị làm chết', async () => {
    const { runner, spaceDb } = makeRunner({
      resolveError: new SpaceRoutingError('space_routing.space_not_found', 'gone'),
    });
    const observed = await runner.runForJob(
      { spaceSlug: 'trung-tam-da-go', tenantId: 'tenant-x' },
      async () => tenantAls.getStore(),
    );
    expect(spaceDb.withSpaceDatabase).not.toHaveBeenCalled();
    expect(observed?.platform).toBe(true);
  });

  it('kết quả và lỗi của thân xử lý được truyền nguyên qua bộ chạy ở cả hai đường phiên', async () => {
    const { runner } = makeRunner();
    await expect(
      runner.runForJob({ spaceSlug: 'trung-tam-a', tenantId: 'tenant-a' }, async () => 'kq-rieng'),
    ).resolves.toBe('kq-rieng');
    await expect(
      runner.runForJob({ spaceSlug: null, tenantId: null }, async () => 'kq-chung'),
    ).resolves.toBe('kq-chung');
    const failure = new Error('thân xử lý lỗi');
    await expect(
      runner.runForJob({ spaceSlug: 'trung-tam-a', tenantId: 'tenant-a' }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});

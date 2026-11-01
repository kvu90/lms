import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../common/current-user.decorator';
import type { SpaceDatabaseService } from '../../db/routing/space-database.service';
import type { PermissionEvaluator } from '../access/permission-evaluator.service';
import { TenantGuard } from './tenant.guard';
import type { TenantContextService } from './tenant-context.service';
import type { TenantsRepository } from './tenants.repository';
import type { TenantsService } from './tenants.service';

interface FakeRequest {
  user?: AuthenticatedUser;
  tenantId?: string;
  headers: Record<string, string | undefined>;
}

function httpContext(request: FakeRequest): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => httpContextHandler,
    getClass: () => httpContextHandler,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function httpContextHandler() {}

function makeGuard(options?: {
  tenantById?: Record<string, { id: string; slug: string; status: string; kind: string } | undefined>;
  membershipStatus?: string;
}) {
  const repo = {
    getPlatformTenant: vi.fn(async () => ({ id: 'tenant-zero' })),
    getTenant: vi.fn(async (id: string) => options?.tenantById?.[id]),
    getMembership: vi.fn(async () => ({ status: options?.membershipStatus ?? 'active' })),
  };
  const tenants = {
    resolveDefaultTenant: vi.fn(async () => ({ id: 'tenant-default' })),
  };
  const evaluator = {
    isSiteAdmin: vi.fn(async () => false),
  };
  const tenantContext = {
    enter: vi.fn(),
  };
  const spaceDb = {
    resolveTarget: vi.fn(async () => {
      throw new Error('must not resolve a space for a plain host');
    }),
  };
  const guard = new TenantGuard(
    repo as unknown as TenantsRepository,
    tenants as unknown as TenantsService,
    evaluator as unknown as PermissionEvaluator,
    tenantContext as unknown as TenantContextService,
    spaceDb as unknown as SpaceDatabaseService,
  );
  return { guard, repo, tenantContext };
}

/**
 * Ca đơn vị của nhánh cũ trong TenantGuard (Phần A, issue #587):
 * `tid` đã khai trong phiên mà không tra được dòng tenant nào
 * phải fail-closed rõ ràng, không rơi lặng về tenant platform.
 */
describe('Guard phân giải tenant hiệu lực', () => {
  it('tid đã khai mà không tra được tenant thì bị từ chối 401 mã tenant.unknown, không ghim tenant platform', async () => {
    const { guard, tenantContext } = makeGuard({ tenantById: {} });
    const request: FakeRequest = {
      headers: { host: 'he-thong.example' },
      user: { id: 'u1', username: 'gv1', tenantId: 'tenant-da-xoa' },
    };
    const err = await guard.canActivate(httpContext(request)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).getResponse()).toMatchObject({ code: 'tenant.unknown' });
    expect(request.tenantId).toBeUndefined();
    expect(tenantContext.enter).not.toHaveBeenCalled();
  });

  it('tid tra được tenant school đang active và membership đang active thì ghim đúng tenant đó', async () => {
    const { guard, tenantContext } = makeGuard({
      tenantById: { 'tenant-a': { id: 'tenant-a', slug: 'trung-tam-a', status: 'active', kind: 'school' } },
      membershipStatus: 'active',
    });
    const request: FakeRequest = {
      headers: { host: 'he-thong.example' },
      user: { id: 'u1', username: 'gv1', tenantId: 'tenant-a' },
    };
    await expect(guard.canActivate(httpContext(request))).resolves.toBe(true);
    expect(request.tenantId).toBe('tenant-a');
    expect(tenantContext.enter).toHaveBeenCalledWith({ tenantId: 'tenant-a', userId: 'u1' });
  });
});

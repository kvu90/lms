import { describe, expect, it, vi } from 'vitest';
import type { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { CentreIdentityService } from './centre-identity.service';
import type { CentreIdentityRepository } from './centre-identity.repository';
import type { TenantsRepository } from './tenants.repository';
import type { UsersService } from '../users/users.service';

/**
 * Ca đơn vị của service nhận diện trung tâm (issue #583): khung định
 * tuyến, sổ tenant, kho nhận diện và service người dùng được thay
 * bằng vật giả — các ca khoá đúng luật gắn trung tâm của service:
 * đọc nhận diện KHÔNG chạm control plane khi trung tâm đã chuẩn bị
 * (đường sống sau khi control plane ngừng hoạt động), và vẫn phân
 * giải + chuẩn bị trước khi đọc khi trung tâm chưa chuẩn bị (đọc
 * thẳng khi chưa chuẩn bị sẽ rơi về kho chung — sai kho).
 */
function makeService(options?: { prepared?: boolean }) {
  const spaceDb = {
    isSpacePrepared: vi.fn(() => options?.prepared ?? false),
    resolveTarget: vi.fn(async () => ({ slug: 'trung-tam-a', status: 'active', mode: 'dedicated' })),
    getDatabaseForSpace: vi.fn(async () => ({})),
    getKyselyForSpace: vi.fn(async () => ({})),
  };
  const tenants = {
    getTenantBySlug: vi.fn(
      async (): Promise<{ id: string; slug: string; name: string } | undefined> => ({
        id: 'tenant-a',
        slug: 'trung-tam-a',
        name: 'Trung tâm A',
      }),
    ),
  };
  const centreRepo = {
    getIdentity: vi.fn(async () => ({ displayName: 'Trung tâm A — tên riêng', logoPath: null, brandColor: '#1d4ed8' })),
  };
  const users = { updateUser: vi.fn(async () => ({})) };
  const service = new CentreIdentityService(
    spaceDb as unknown as SpaceDatabaseService,
    tenants as unknown as TenantsRepository,
    centreRepo as unknown as CentreIdentityRepository,
    users as unknown as UsersService,
  );
  return { service, spaceDb, tenants, centreRepo };
}

describe('Service nhận diện trung tâm', () => {
  it('trung tâm đã chuẩn bị thì đọc nhận diện mà không phân giải hay chuẩn bị lại', async () => {
    const { service, spaceDb, tenants } = makeService({ prepared: true });
    const identity = await service.getIdentity('trung-tam-a');
    expect(identity).toMatchObject({ displayName: 'Trung tâm A — tên riêng', brandColor: '#1d4ed8' });
    expect(spaceDb.resolveTarget).not.toHaveBeenCalled();
    expect(spaceDb.getDatabaseForSpace).not.toHaveBeenCalled();
    expect(tenants.getTenantBySlug).toHaveBeenCalledWith('trung-tam-a');
  });

  it('trung tâm chưa chuẩn bị thì phân giải và chuẩn bị kho trước khi đọc nhận diện', async () => {
    const { service, spaceDb } = makeService({ prepared: false });
    const identity = await service.getIdentity('trung-tam-a');
    expect(identity).toMatchObject({ displayName: 'Trung tâm A — tên riêng' });
    expect(spaceDb.resolveTarget).toHaveBeenCalledWith('trung-tam-a');
    expect(spaceDb.getDatabaseForSpace).toHaveBeenCalledWith('trung-tam-a');
  });

  it('trung tâm đã chuẩn bị nhưng không có dòng tenant trong kho của nó thì trả 404', async () => {
    const { service, tenants } = makeService({ prepared: true });
    tenants.getTenantBySlug.mockResolvedValueOnce(undefined);
    await expect(service.getIdentity('trung-tam-a')).rejects.toThrow('Centre not found');
  });
});

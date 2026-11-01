import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { CoursesService } from '../courses/courses.service';
import type { EnrolService } from '../enrol/enrol.service';
import type { GroupsService } from '../groups/groups.service';
import type { RolesService } from '../access/roles.service';
import type { SpaceJoinCodeDirectoryRow } from '@lms/db/control-plane';
import type { ControlPlaneRepository } from '@lms/db/repositories/control-plane';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import type { TenantContextService } from '../tenants/tenant-context.service';
import type { TenantsService } from '../tenants/tenants.service';
import type { UsersService } from '../users/users.service';
import type { OutboxService } from '../../infra/events/outbox.service';
import type { SpaceDatabaseService } from '../../db/routing/space-database.service';
import type { ClassesRepository, ClassRow } from './classes.repository';
import { ClassesService } from './classes.service';

/**
 * Bộ spec cho điểm chặn 4 của hạng mục 3 (issue #587): ràng buộc
 * duy nhất toàn hệ của mã tham gia lớp phải giữ cả với lớp ở kho
 * chung, không chỉ với lớp ở kho riêng.
 *
 * Vì mã tham gia do hệ sinh ngẫu nhiên bằng crypto (không có đường
 * API nào cho phép gọi đặt trước một mã cụ thể), va chạm xác định
 * không dựng được qua API — spec kiểm chứng trực tiếp tại điểm
 * chốt duy nhất thi hành ràng buộc này (`claimJoinCodeForClass`,
 * chạy trước khi dòng lớp đổi trong `updateClass`): lớp ở kho
 * chung mang mã đã đăng ký cho một không gian khác trong thư mục
 * thì bị từ chối `class.join_code_taken`; mã chưa có trong thư
 * mục thì đi tiếp mà không đăng ký mã kho chung vào thư mục (đăng
 * ký sẽ phá đường phân giải ưu tiên thư mục); đường kho riêng giữ
 * nguyên hành vi đăng ký như cũ.
 */

const TENANT_ID = '00000000-0000-4000-8000-0000000000aa';
const TAKEN_CODE = 'ABCD1234';
const FREE_CODE = 'WXYZ9876';

/** Điểm chốt đăng ký/kiểm tra mã (hàm private của service — spec truy cập qua kiểu hẹp để tránh `any`). */
type ClaimGuard = {
  claimJoinCodeForClass: (row: ClassRow, joinCode: string) => Promise<string | null>;
};

function buildService(overrides: {
  target?: { slug: string; dedicated: boolean } | null;
  configured?: boolean;
  directoryEntry?: SpaceJoinCodeDirectoryRow | undefined;
  claimResult?: 'claimed' | 'already' | 'conflict';
}) {
  const spaceTargetForTenant = vi.fn().mockResolvedValue(overrides.target ?? null);
  const findJoinCodeDirectory = vi.fn().mockResolvedValue(overrides.directoryEntry);
  const claimJoinCodeDirectory = vi.fn().mockResolvedValue(overrides.claimResult ?? 'claimed');
  const service = new ClassesService(
    {} as unknown as ClassesRepository,
    {} as unknown as ContextsService,
    {} as unknown as PermissionEvaluator,
    {} as unknown as RolesService,
    {} as unknown as CoursesService,
    {} as unknown as GroupsService,
    {} as unknown as EnrolService,
    {} as unknown as UsersService,
    { spaceTargetForTenant } as unknown as TenantsService,
    {} as unknown as TenantContextService,
    {} as unknown as OutboxService,
    {} as unknown as SpaceDatabaseService,
    {
      isConfigured: () => overrides.configured ?? true,
      findJoinCodeDirectory,
      claimJoinCodeDirectory,
    } as unknown as ControlPlaneRepository,
  );
  return { service, spaceTargetForTenant, findJoinCodeDirectory, claimJoinCodeDirectory };
}

const row = { tenantId: TENANT_ID } as unknown as ClassRow;

const directoryEntry = (joinCode: string, spaceSlug: string) =>
  ({ joinCode, spaceSlug }) as unknown as SpaceJoinCodeDirectoryRow;

describe('Mã tham gia lớp giữ tính duy nhất toàn hệ (issue #587 hạng mục 3)', () => {
  it('lớp ở kho chung xoay mã đã đăng ký cho không gian khác trong thư mục thì bị từ chối class.join_code_taken', async () => {
    const { service, claimJoinCodeDirectory } = buildService({
      target: { slug: 'truong-chung', dedicated: false },
      directoryEntry: directoryEntry(TAKEN_CODE, 'trung-tam-khac'),
    });
    const guard = service as unknown as ClaimGuard;
    let caught: unknown;
    try {
      await guard.claimJoinCodeForClass(row, TAKEN_CODE);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getResponse()).toMatchObject({ code: 'class.join_code_taken' });
    // Chỉ kiểm tra, tuyệt đối không đăng ký mã kho chung vào thư mục.
    expect(claimJoinCodeDirectory).not.toHaveBeenCalled();
  });

  it('lớp ở kho chung xoay mã chưa có trong thư mục thì đi tiếp và không đăng ký mã kho chung vào thư mục', async () => {
    const { service, claimJoinCodeDirectory } = buildService({
      target: { slug: 'truong-chung', dedicated: false },
      directoryEntry: undefined,
    });
    const guard = service as unknown as ClaimGuard;
    await expect(guard.claimJoinCodeForClass(row, FREE_CODE)).resolves.toBeNull();
    expect(claimJoinCodeDirectory).not.toHaveBeenCalled();
  });

  it('lớp ở kho riêng xoay mã vẫn đăng ký như cũ và trả về slug của không gian', async () => {
    const { service, findJoinCodeDirectory, claimJoinCodeDirectory } = buildService({
      target: { slug: 'trung-tam-rieng', dedicated: true },
      claimResult: 'claimed',
    });
    const guard = service as unknown as ClaimGuard;
    await expect(guard.claimJoinCodeForClass(row, FREE_CODE)).resolves.toBe('trung-tam-rieng');
    expect(claimJoinCodeDirectory).toHaveBeenCalledWith(FREE_CODE, 'trung-tam-rieng');
    // Đường kho riêng không cần tra thư mục trước khi đăng ký.
    expect(findJoinCodeDirectory).not.toHaveBeenCalled();
  });

  it('control plane chưa cấu hình thì không tra thư mục cũng không đăng ký', async () => {
    const { service, spaceTargetForTenant, findJoinCodeDirectory, claimJoinCodeDirectory } = buildService({
      configured: false,
    });
    const guard = service as unknown as ClaimGuard;
    await expect(guard.claimJoinCodeForClass(row, FREE_CODE)).resolves.toBeNull();
    expect(spaceTargetForTenant).not.toHaveBeenCalled();
    expect(findJoinCodeDirectory).not.toHaveBeenCalled();
    expect(claimJoinCodeDirectory).not.toHaveBeenCalled();
  });
});

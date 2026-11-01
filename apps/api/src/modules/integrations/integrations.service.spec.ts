import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { ContextsService } from '../access/contexts.service';
import type { PermissionEvaluator } from '../access/permission-evaluator.service';
import type { CoursesService } from '../courses/courses.service';
import type { IntegrationsRepository, ServiceRow, TokenOwnerState, TokenRow } from '@lms/db/repositories/integrations';
import { hashToken, IntegrationsService } from './integrations.service';

/**
 * Kiểm tra trạng thái chủ token tại lúc dùng (read-time) trong `callFunction`.
 *
 * Luật nghiệp vụ: external token của webservice là thông tin xác thực duy
 * nhất của đường gọi `@Public()`, và token không bao giờ vượt capability của
 * chủ token. Nhưng capability chỉ là nửa sau của luật: khi chủ token bị đình
 * chỉ hoặc xoá, quyền của chủ đáng lẽ vô hiệu ngay — trong khi thao tác đình
 * chỉ/xoá chỉ lật cờ trên dòng user, không thu hồi token. Mọi bề mặt xác thực
 * khác (JWT, refresh, phiên web, MCP) đều nạp lại trạng thái tài khoản ở mỗi
 * request nên đình chỉ có hiệu lực tức thì; đường webservice phải cùng khuôn:
 * `callFunction` nạp trạng thái chủ token ở mỗi lời gọi và từ chối khi chủ đã
 * xoá hoặc đang bị đình chỉ. Đình chỉ là trạng thái khôi phục được nên KHÔNG
 * thu hồi cứng token: gỡ đình chỉ là token cũ gọi lại được, không cần cấp mới.
 * Ca HTTP trọn đường (đình chỉ/gỡ đình chỉ qua API quản trị user) nằm ở e2e
 * `platform-search-webservice-flow`.
 */

const RAW_TOKEN = 'unit-test-raw-token';
const OWNER_ID = '01900000-0000-7000-8000-0000000000aa';
const SERVICE_ID = '01900000-0000-7000-8000-0000000000bb';
const TOKEN_ID = '01900000-0000-7000-8000-0000000000cc';

/** Dựng service thật với repository/evaluator/context/khoá học giả lập trong bộ nhớ. */
function buildService() {
  let ownerState: TokenOwnerState | undefined = { suspended: false, deleted: false };
  const tokenRow = {
    id: TOKEN_ID,
    tokenHash: hashToken(RAW_TOKEN),
    userId: OWNER_ID,
    serviceId: SERVICE_ID,
    validUntil: null,
    ipRestriction: null,
    revoked: false,
    lastAccess: null,
    createdAt: new Date(),
  } as unknown as TokenRow;
  const serviceRow = {
    id: SERVICE_ID,
    name: 'Unit service',
    shortName: 'unit',
    enabled: true,
    functions: ['core_course_get_courses'],
  } as unknown as ServiceRow;
  const updateToken = vi.fn(async (_id: string, _patch: Record<string, unknown>) => {});
  const repo = {
    getTokenByHash: async () => tokenRow,
    getService: async () => serviceRow,
    updateToken,
    getTokenOwnerState: async () => ownerState,
  } as unknown as IntegrationsRepository;
  const evaluator = { hasCapability: async () => true } as unknown as PermissionEvaluator;
  const contexts = { ensureSystemContext: async () => ({ id: 'system-context' }) } as unknown as ContextsService;
  const listCourses = vi.fn(async () => [{ id: 'course-1' }]);
  const courses = { listCourses } as unknown as CoursesService;
  return {
    service: new IntegrationsService(repo, evaluator, contexts, courses),
    tokenRow,
    updateToken,
    listCourses,
    setOwnerState: (state: TokenOwnerState | undefined) => { ownerState = state; },
  };
}

const call = (service: IntegrationsService) =>
  service.callFunction({ token: RAW_TOKEN, functionName: 'core_course_get_courses', args: {} });

describe('IntegrationsService.callFunction — trạng thái tài khoản chủ token lúc gọi', () => {
  it('chủ token đang hoạt động vẫn gọi được hàm trong service như trước', async () => {
    const { service, listCourses } = buildService();
    await expect(call(service)).resolves.toEqual([{ id: 'course-1' }]);
    expect(listCourses).toHaveBeenCalledTimes(1);
  });

  it('chủ token bị đình chỉ bị từ chối với 401 và handler hàm không bao giờ chạy', async () => {
    const { service, listCourses, setOwnerState } = buildService();
    setOwnerState({ suspended: true, deleted: false });
    const err = await call(service).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).getResponse()).toMatchObject({ code: 'webservice.owner_inactive' });
    expect((err as UnauthorizedException).getStatus()).toBe(401);
    expect(listCourses).not.toHaveBeenCalled();
  });

  it('chủ token đã xoá bị từ chối với 401 và handler hàm không bao giờ chạy', async () => {
    const { service, listCourses, setOwnerState } = buildService();
    setOwnerState({ suspended: false, deleted: true });
    const err = await call(service).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).getResponse()).toMatchObject({ code: 'webservice.owner_inactive' });
    expect(listCourses).not.toHaveBeenCalled();
  });

  it('token mà dòng chủ đã không còn thì bị từ chối với 401', async () => {
    const { service, listCourses, setOwnerState } = buildService();
    setOwnerState(undefined);
    const err = await call(service).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).getResponse()).toMatchObject({ code: 'webservice.owner_inactive' });
    expect(listCourses).not.toHaveBeenCalled();
  });

  it('chủ đã khôi phục (hết đình chỉ) gọi lại được với cùng token — đình chỉ không bao giờ thu hồi token', async () => {
    const { service, tokenRow, updateToken, setOwnerState } = buildService();
    setOwnerState({ suspended: true, deleted: false });
    await expect(call(service)).rejects.toBeInstanceOf(UnauthorizedException);
    setOwnerState({ suspended: false, deleted: false });
    await expect(call(service)).resolves.toEqual([{ id: 'course-1' }]);
    // Trong suốt quá trình đình chỉ → gỡ đình chỉ, dòng token không hề bị
    // đánh dấu thu hồi: điểm kiểm chỉ đọc trạng thái chủ, không ghi lên token.
    expect(tokenRow.revoked).toBe(false);
    for (const [, patch] of updateToken.mock.calls) {
      expect(patch).not.toMatchObject({ revoked: true });
    }
  });
});

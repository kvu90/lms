import { describe, expect, it } from 'vitest';
import type { Cache } from 'cache-manager';
import type { OutboxService } from '../../infra/events/outbox.service';
import type { AccessRepository, ContextRow } from './access.repository';
import { ContextsService } from './contexts.service';
import { CAP_ALLOW } from './domain/permission';
import { PermissionEvaluator } from './permission-evaluator.service';
import type { PlanLimitsService } from './plan-limits.service';
import { RolesService } from './roles.service';

/**
 * Kiểm chứng nguyên tắc vô hiệu hoá cache quyền ở đường GỠ: thao tác
 * thu hồi quyền (gỡ gán vai, xoá role) phải có hiệu lực TỨC THÌ ở lần
 * kiểm tra capability tiếp theo, không chờ mục cache hết hạn.
 *
 * Bối cảnh cơ chế: `PermissionEvaluator.hasCapability` cache kết quả
 * theo khoá nhúng dấu version của các context trên path (TTL một
 * giờ). Version chỉ đổi khi `ContextsService.markContextDirty` bump
 * context liên quan. Đường gán (`assignRole`) và đường đặt override
 * đã bump từ trước; spec này chốt hai đường từng bị sót:
 *   - `RolesService.unassignRole` — mọi đường gỡ gán trong sản phẩm
 *     (API quản trị, rút ghi danh, đồng bộ danh sách lớp, thu hồi
 *     chia sẻ ngân hàng câu hỏi) đều chảy qua hàm này;
 *   - `RolesService.deleteRole` — xoá role phải bump mọi context
 *     từng có gán vai hoặc override của role đó.
 *
 * Thế giới kiểm chứng dựng trong bộ nhớ (tầng dữ liệu giả lập đếm số
 * lần bị hỏi) nhưng cả ba service đều là service THẬT:
 * `RolesService` + `ContextsService` + `PermissionEvaluator` — nên
 * chuỗi gán → cache → gỡ → kiểm lại chạy đúng ngữ nghĩa production,
 * và khẳng định "tầng dữ liệu được hỏi lại" đo được bằng bộ đếm.
 * Capability dùng trong spec là capability thật `grade:edit`.
 */

const SYSTEM_ID = '00000000-0000-4000-8000-000000000010';
const COURSE_ID = '00000000-0000-4000-8000-000000000050';
const ROLE_ID = 'role-grade-editor';
const USER_ROLE_ID = 'role-user';
const USER_ID = 'user-grade-editor';
const CAPABILITY = 'grade:edit';

interface AssignmentRow {
  id: string;
  roleId: string;
  userId: string;
  contextId: string;
  component: string;
  itemId: string | null;
  modifierId?: string;
}
interface OverrideRow { roleId: string; capability: string; contextId: string; permission: number }

function makeWorld() {
  const contexts: ContextRow[] = [
    { id: SYSTEM_ID, contextLevel: 10, instanceId: null, path: `/${SYSTEM_ID}`, depth: 1, version: 1 } as ContextRow,
    { id: COURSE_ID, contextLevel: 50, instanceId: 'course-1', path: `/${SYSTEM_ID}/${COURSE_ID}`, depth: 2, version: 1 } as ContextRow,
  ];
  const roles = new Map<string, { id: string; shortName: string; archetype?: string }>([
    [ROLE_ID, { id: ROLE_ID, shortName: 'gradeeditor', archetype: 'student' }],
    [USER_ROLE_ID, { id: USER_ROLE_ID, shortName: 'user', archetype: 'user' }],
  ]);
  const state = {
    assignments: [] as AssignmentRow[],
    overrides: [{ roleId: ROLE_ID, capability: CAPABILITY, contextId: SYSTEM_ID, permission: CAP_ALLOW }] as OverrideRow[],
    assignmentReads: 0,
    nextAssignmentSeq: 1,
  };

  const repo = {
    // --- contexts ---------------------------------------------------
    async getContextById(id: string) { return contexts.find((c) => c.id === id); },
    async getContextsByIds(ids: string[]) { return ids.map((id) => contexts.find((c) => c.id === id)).filter(Boolean) as ContextRow[]; },
    async bumpContextVersions(pathPrefix: string) {
      for (const c of contexts) {
        if (c.path === pathPrefix || c.path.startsWith(`${pathPrefix}/`)) c.version += 1;
      }
    },
    // --- cổng tenant / cấu hình ------------------------------------
    async getTenantGateInfo() { return undefined; },
    async getConfigValue() { return undefined; },
    // --- roles -------------------------------------------------------
    async getRoleById(id: string) { return roles.get(id); },
    async getRoleByShortname(shortName: string) { return [...roles.values()].find((r) => r.shortName === shortName); },
    async deleteRole(id: string) {
      state.assignments = state.assignments.filter((a) => a.roleId !== id);
      state.overrides = state.overrides.filter((o) => o.roleId !== id);
      roles.delete(id);
    },
    // --- assignments ---------------------------------------------------
    async insertAssignment(values: { roleId: string; userId: string; contextId: string; modifierId?: string; component?: string; itemId?: string | null }) {
      const row: AssignmentRow = {
        id: `assignment-${state.nextAssignmentSeq++}`,
        roleId: values.roleId, userId: values.userId, contextId: values.contextId,
        component: values.component ?? '', itemId: values.itemId ?? null, modifierId: values.modifierId,
      };
      state.assignments.push(row);
      return row;
    },
    async getAssignment(id: string) { return state.assignments.find((a) => a.id === id); },
    async deleteAssignment(id: string) { state.assignments = state.assignments.filter((a) => a.id !== id); },
    async listAssignments(filter: { userId?: string; contextId?: string }) {
      return state.assignments.filter((a) =>
        (filter.userId === undefined || a.userId === filter.userId) &&
        (filter.contextId === undefined || a.contextId === filter.contextId));
    },
    async listAssignmentsByRole(roleId: string) { return state.assignments.filter((a) => a.roleId === roleId); },
    async getAssignmentsForUserInContexts(userId: string, contextIds: string[]) {
      state.assignmentReads += 1;
      return state.assignments.filter((a) => a.userId === userId && contextIds.includes(a.contextId));
    },
    // --- overrides -------------------------------------------------------
    async listRoleCapabilities(roleId: string) { return state.overrides.filter((o) => o.roleId === roleId); },
    async getOverridesForRoles(roleIds: string[], capability: string, contextIds: string[]) {
      return state.overrides.filter((o) => roleIds.includes(o.roleId) && o.capability === capability && contextIds.includes(o.contextId));
    },
  };

  const cacheStore = new Map<string, unknown>();
  const cache = {
    async get(key: string) { return cacheStore.get(key); },
    async set(key: string, value: unknown) { cacheStore.set(key, value); },
    async del(key: string) { cacheStore.delete(key); },
  };
  const outbox = { async enqueueStandalone() { return undefined; } };
  // Role trong spec có archetype ngoài nhóm giảng dạy nên chốt slot gói
  // không bao giờ được gọi; stub rỗng là đủ và cố ý để lộ nếu bị gọi.
  const planLimits = {};

  const repoCast = repo as unknown as AccessRepository;
  const contextsService = new ContextsService(repoCast);
  const rolesService = new RolesService(repoCast, contextsService, outbox as unknown as OutboxService, planLimits as PlanLimitsService);
  const evaluator = new PermissionEvaluator(repoCast, contextsService, cache as unknown as Cache);
  return { state, rolesService, evaluator };
}

describe('Thu hồi quyền phải vô hiệu hoá cache đánh giá ngay (unassignRole / deleteRole)', () => {
  it('unassigning a role assignment makes the next capability check recompute and deny', async () => {
    const { state, rolesService, evaluator } = makeWorld();
    const assignment = (await rolesService.assignRole(USER_ID, ROLE_ID, COURSE_ID)) as { id: string };

    // Lượt kiểm đầu: có quyền, kết quả được ghi cache.
    await expect(evaluator.hasCapability(USER_ID, CAPABILITY, COURSE_ID)).resolves.toBe(true);
    const readsAfterFirstCheck = state.assignmentReads;
    // Lượt kiểm hai: vẫn true nhưng tầng dữ liệu KHÔNG bị hỏi lại — trúng cache.
    await expect(evaluator.hasCapability(USER_ID, CAPABILITY, COURSE_ID)).resolves.toBe(true);
    expect(state.assignmentReads).toBe(readsAfterFirstCheck);

    await rolesService.unassignRole(assignment.id);

    // Sau khi gỡ: quyền bị thu hồi TỨC THÌ — kết quả tính lại từ dữ
    // kiện thật (tầng dữ liệu bị hỏi lại) chứ không phải true từ cache.
    await expect(evaluator.hasCapability(USER_ID, CAPABILITY, COURSE_ID)).resolves.toBe(false);
    expect(state.assignmentReads).toBeGreaterThan(readsAfterFirstCheck);
  });

  it('deleting a role makes the next capability check recompute and deny', async () => {
    const { state, rolesService, evaluator } = makeWorld();
    await rolesService.assignRole(USER_ID, ROLE_ID, COURSE_ID);

    await expect(evaluator.hasCapability(USER_ID, CAPABILITY, COURSE_ID)).resolves.toBe(true);
    const readsAfterFirstCheck = state.assignmentReads;
    await expect(evaluator.hasCapability(USER_ID, CAPABILITY, COURSE_ID)).resolves.toBe(true);
    expect(state.assignmentReads).toBe(readsAfterFirstCheck);

    await rolesService.deleteRole(ROLE_ID);

    await expect(evaluator.hasCapability(USER_ID, CAPABILITY, COURSE_ID)).resolves.toBe(false);
    expect(state.assignmentReads).toBeGreaterThan(readsAfterFirstCheck);
  });
});

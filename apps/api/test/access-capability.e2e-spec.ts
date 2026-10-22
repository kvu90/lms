import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { PermissionEvaluator } from '../src/modules/access/permission-evaluator.service';
import { UsersService } from '../src/modules/users/users.service';
import {
  adminToken, assignRole, createContextViaApi, createTestApp, createRoleViaApi, createUserViaApi,
  hasCapability, http, roleIdByShortname, setOverride, systemContextId, uniqueName,
} from './identity-access-helpers';

const CAP = 'moodle/course:update';
const ALLOW = 1, PREVENT = -1, PROHIBIT = -1000;

/**
 * GOLDEN capability flow tests.
 * Oracle: lib/tests/accesslib_test.php (MOODLE_503_STABLE) —
 * test_permission_evaluation, test_assign_capability, test_role_assign,
 * test_is_siteadmin, test_get_guest_role.
 */
describe('Access: capability evaluation over the context tree (golden)', () => {
  let app: INestApplication;
  let admin: string;
  let systemId: string, catId: string, courseId: string, modId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    systemId = await systemContextId(app, admin);
    const inst = uuidv7();
    catId = (await createContextViaApi(app, admin, 40, inst, systemId)).id;
    courseId = (await createContextViaApi(app, admin, 50, inst, catId)).id;
    modId = (await createContextViaApi(app, admin, 70, inst, courseId)).id;
  });
  afterAll(async () => { await app.close(); });

  async function freshUserAndRole(): Promise<{ userId: string; roleId: string }> {
    const user = await createUserViaApi(app, admin);
    const roleId = await createRoleViaApi(app, admin);
    return { userId: user.id, roleId };
  }

  it('PROHIBIT at system beats ALLOW at module for the same role', async () => {
    const { userId, roleId } = await freshUserAndRole();
    await assignRole(app, admin, userId, roleId, modId);
    await setOverride(app, admin, roleId, CAP, modId, ALLOW);
    await setOverride(app, admin, roleId, CAP, systemId, PROHIBIT);
    expect(await hasCapability(app, admin, userId, CAP, modId)).toBe(false);
  });

  it('a leaf ALLOW cannot remove an ancestor PROHIBIT (course level)', async () => {
    const { userId, roleId } = await freshUserAndRole();
    await assignRole(app, admin, userId, roleId, systemId);
    await setOverride(app, admin, roleId, CAP, courseId, PROHIBIT);
    await setOverride(app, admin, roleId, CAP, modId, ALLOW);
    expect(await hasCapability(app, admin, userId, CAP, modId)).toBe(false);
    expect(await hasCapability(app, admin, userId, CAP, courseId)).toBe(false);
  });

  it('PREVENT at parent + ALLOW at leaf allows that role (nearest wins)', async () => {
    const { userId, roleId } = await freshUserAndRole();
    await assignRole(app, admin, userId, roleId, systemId);
    await setOverride(app, admin, roleId, CAP, courseId, PREVENT);
    await setOverride(app, admin, roleId, CAP, modId, ALLOW);
    expect(await hasCapability(app, admin, userId, CAP, modId)).toBe(true);
  });

  it('two roles: ALLOW in one + PREVENT in another (different levels) is allowed', async () => {
    const user = await createUserViaApi(app, admin);
    const roleA = await createRoleViaApi(app, admin);
    const roleB = await createRoleViaApi(app, admin);
    await assignRole(app, admin, user.id, roleA, systemId);
    await assignRole(app, admin, user.id, roleB, systemId);
    await setOverride(app, admin, roleA, CAP, courseId, ALLOW);
    await setOverride(app, admin, roleB, CAP, modId, PREVENT);
    expect(await hasCapability(app, admin, user.id, CAP, modId)).toBe(true);
  });

  it('two roles: ALLOW at leaf in role A + PROHIBIT at root in role B is denied', async () => {
    const user = await createUserViaApi(app, admin);
    const roleA = await createRoleViaApi(app, admin);
    const roleB = await createRoleViaApi(app, admin);
    await assignRole(app, admin, user.id, roleA, modId);
    await assignRole(app, admin, user.id, roleB, systemId);
    await setOverride(app, admin, roleA, CAP, modId, ALLOW);
    await setOverride(app, admin, roleB, CAP, systemId, PROHIBIT);
    expect(await hasCapability(app, admin, user.id, CAP, modId)).toBe(false);
  });

  it('a user with no role assignment is denied', async () => {
    const user = await createUserViaApi(app, admin);
    expect(await hasCapability(app, admin, user.id, CAP, modId)).toBe(false);
  });

  it('assignments only apply within their context subtree', async () => {
    const { userId, roleId } = await freshUserAndRole();
    await assignRole(app, admin, userId, roleId, courseId);
    await setOverride(app, admin, roleId, CAP, systemId, ALLOW);
    expect(await hasCapability(app, admin, userId, CAP, courseId)).toBe(true);
    expect(await hasCapability(app, admin, userId, CAP, systemId)).toBe(false);
  });

  it('site admin bypasses capability checks (doanything)', async () => {
    const res = await http(app).get('/api/v1/users/me').set('Authorization', `Bearer ${admin}`);
    const adminId = res.body.id as string;
    expect(await hasCapability(app, admin, adminId, CAP, modId)).toBe(true);
    expect(await hasCapability(app, admin, adminId, 'moodle/site:config', systemId)).toBe(true);
  });

  it('guest account evaluates through the guest role only', async () => {
    const users = app.get(UsersService);
    const evaluator = app.get(PermissionEvaluator);
    const guest = await users.ensureGuestUser();
    // Seeded archetype default: guest role ALLOWs moodle/course:view at system.
    expect(await evaluator.hasCapability(guest.id, 'moodle/course:view', systemId, { isGuest: true })).toBe(true);
    // …but the guest role grants nothing else, and the authenticated-user default must NOT leak in.
    expect(await evaluator.hasCapability(guest.id, 'moodle/user:viewdetails', systemId, { isGuest: true })).toBe(false);
  });

  it('changing an override changes the result (dirty marking invalidates the cache)', async () => {
    const { userId, roleId } = await freshUserAndRole();
    await assignRole(app, admin, userId, roleId, systemId);
    await setOverride(app, admin, roleId, CAP, courseId, ALLOW);
    expect(await hasCapability(app, admin, userId, CAP, courseId)).toBe(true); // primes the cache
    await setOverride(app, admin, roleId, CAP, courseId, PREVENT);
    expect(await hasCapability(app, admin, userId, CAP, courseId)).toBe(false);
    await setOverride(app, admin, roleId, CAP, courseId, ALLOW);
    expect(await hasCapability(app, admin, userId, CAP, courseId)).toBe(true);
  });

  it('standard Moodle roles are seeded and admin endpoints deny non-admins', async () => {
    const studentId = await roleIdByShortname(app, admin, 'student');
    expect(studentId).toBeGreaterThan(0);
    const user = await createUserViaApi(app, admin);
    const { login } = await import('./identity-access-helpers');
    const { accessToken } = await login(app, user.username, 'Passw0rd!');
    const res = await http(app).get('/api/v1/access/roles').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('access.capability_denied');
    expect(res.headers['content-type']).toContain('application/problem+json');
    void uniqueName;
  });
});

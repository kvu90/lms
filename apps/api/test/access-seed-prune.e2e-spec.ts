import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { RolesService } from '../src/modules/access/roles.service';
import {
  adminToken, createContextViaApi, createTestApp, roleIdByShortname, systemContextId,
} from './identity-access-helpers';

/**
 * Issue #35: capability identifiers are prefix-free (`<area>:<name>`).
 * Regression guard for the seed sync: a database previously seeded under a
 * legacy prefixed naming scheme must not keep stale rows after a re-seed —
 * neither in `capabilities` nor in `role_capabilities` (any context).
 * Legacy names are assembled by concatenation on purpose, so this spec does
 * not itself carry prefixed capability literals.
 */
describe('Access: seed prunes stale capability definitions (issue #35)', () => {
  let app: INestApplication;
  let pg: Client;

  beforeAll(async () => {
    app = await createTestApp();
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
  });
  afterAll(async () => { await pg.end(); await app.close(); });

  it('re-seeding a database polluted with legacy prefixed names removes them everywhere', async () => {
    const admin = await adminToken(app);
    const systemId = await systemContextId(app, admin);
    const managerId = await roleIdByShortname(app, admin, 'manager');
    // A second, non-system context: stale overrides there must go too.
    const catId = (await createContextViaApi(app, admin, 40, uuidv7(), systemId)).id;

    // Simulate the pre-rename state: definitions and overrides whose names
    // carry one of the retired prefixes (three legacy schemes).
    const staleCourse = 'moodle/' + 'course:update';
    const staleQuiz = 'mod/' + 'quiz:attempt';
    const staleCompletion = 'lms/' + 'completion:manage';
    await pg.query(
      `insert into capabilities (name, cap_type, context_level, component) values
         ($1, 'write', 50, 'core_course'),
         ($2, 'write', 70, 'mod_quiz'),
         ($3, 'write', 50, 'core_completion')
       on conflict (name) do nothing`,
      [staleCourse, staleQuiz, staleCompletion],
    );
    await pg.query(
      `insert into role_capabilities (context_id, role_id, capability, permission) values
         ($1, $2, $4, 1),
         ($3, $2, $5, 1),
         ($1, $2, $6, 1)`,
      [systemId, managerId, catId, staleCourse, staleQuiz, staleCompletion],
    );
    const before = await pg.query<{ n: string }>(
      `select count(*) as n from role_capabilities where capability like '%/%'`,
    );
    expect(Number(before.rows[0].n)).toBe(3);

    await app.get(RolesService).seedDefaults();

    const staleDefs = await pg.query<{ n: string }>(
      `select count(*) as n from capabilities where name like '%/%'`,
    );
    expect(Number(staleDefs.rows[0].n)).toBe(0);
    const staleOverrides = await pg.query<{ n: string }>(
      `select count(*) as n from role_capabilities where capability like '%/%'`,
    );
    expect(Number(staleOverrides.rows[0].n)).toBe(0);

    // The registry itself is intact: 100 definitions (94 trên main d5e20fc
    // — 88 gốc + 5 quyền assign:* của mod_assign, issue #88 +
    // contentbank:reviewcontent của Kho học liệu CB-1, issue #69 — cộng 3
    // quyền question:* của feat ngân hàng câu hỏi chung, PR #83, cộng 3
    // quyền quiz của Quiz Chặng 2+3, PR #84: quiz:manageoverrides,
    // quiz:viewmatrix, quiz:managematrix), every one prefix-free,
    // and the renamed defaults were re-seeded at the system context.
    // Provenance of the count: 97 (sau PR #83) + 3 new capabilities
    // added by Quiz Chặng 2+3 (issue #30).
    const defs = await pg.query<{ n: string }>(`select count(*) as n from capabilities`);
    // 100 sau Quiz Chặng 2+3 (PR #84) + 2 quyền của PH-0 (issue #116):
    // grade:publish, guardian:manage → 102.
    expect(Number(defs.rows[0].n)).toBe(102);
    const renamed = await pg.query<{ permission: number }>(
      `select permission from role_capabilities where context_id = $1 and role_id = $2 and capability = 'course:update'`,
      [systemId, managerId],
    );
    expect(renamed.rows).toHaveLength(1);
    expect(renamed.rows[0].permission).toBe(1);
  });
});

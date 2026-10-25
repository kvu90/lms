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

    // The registry itself is intact: 111 definitions trên main 7ff4691
    // (105 + 6 quyền exam:* của Ngân hàng đề EB-1, issue #113:
    // exam:view, exam:edit, exam:copy, exam:share, exam:moderate,
    // exam:deploy) + 1 quyền moderation:manage của vòng đời tin nhắn
    // theo vai (issue #124) → 112, every one prefix-free,
    // and the renamed defaults were re-seeded at the system context.
    const defs = await pg.query<{ n: string }>(`select count(*) as n from capabilities`);
    expect(Number(defs.rows[0].n)).toBe(112);
    const renamed = await pg.query<{ permission: number }>(
      `select permission from role_capabilities where context_id = $1 and role_id = $2 and capability = 'course:update'`,
      [systemId, managerId],
    );
    expect(renamed.rows).toHaveLength(1);
    expect(renamed.rows[0].permission).toBe(1);
  });
});

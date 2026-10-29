import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, uniqueName } from '../../support/identity-access-helpers';
import { RolesService } from '../../../src/modules/access/roles.service';
import { CONTEXT_LEVELS } from '../../../src/modules/access/domain/capabilities';
import { ClassesService } from '../../../src/modules/classes/classes.service';

const TEST_DB_URL = process.env.LMS_TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/lms_test_api';

/**
 * Hồi quy nguyên tử cho luồng TẠO LỚP (issue #490, DL-09).
 *
 * Bất biến nghiệp vụ: tạo lớp là một biên nguyên tử — backing cohort,
 * dòng lớp, context lớp, bộ override capability của 4 vai tại context
 * lớp, gán vai chủ lớp và sự kiện outbox `class_created` hoặc CÙNG
 * thành công, hoặc không bước nào được ghi. Trước bản sửa, các bước
 * ghi chạy rời nhau: lỗi ở bước gán vai (bước cuối) để lại lớp dở
 * dang — cohort + lớp + context + override đã tồn tại mà lớp chưa có
 * chủ.
 *
 * Cách gây lỗi: spy `RolesService.assignRole` ném lỗi — đây là bước
 * ghi gần cuối của luồng, sau khi cohort/lớp/context/override đã ghi,
 * nên nó phân biệt rõ hai thế giới: không có transaction thì trạng
 * thái dở dang còn nguyên (spec ĐỎ), có transaction thì mọi dấu vết
 * biến mất (spec XANH). Ca đối chứng tạo lớp thành công khẳng định
 * trạng thái cuối của luồng không đổi sau khi bọc transaction.
 */
describe('Tạo lớp — rollback nguyên tử khi một bước ghi giữa luồng lỗi (issue #490)', () => {
  let app: INestApplication;
  let pg: Client;
  let classes: ClassesService;
  let roles: RolesService;
  let adminId: string;

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await pg.query<{ count: string }>(sql, params);
    return Number(rows[0]!.count);
  }

  beforeAll(async () => {
    app = await createTestApp();
    pg = new Client({ connectionString: TEST_DB_URL });
    await pg.connect();
    classes = app.get(ClassesService);
    roles = app.get(RolesService);
    const { rows } = await pg.query<{ id: string }>("SELECT id FROM users WHERE username = 'admin'");
    adminId = rows[0]!.id;
  });

  afterAll(async () => {
    await pg.end();
    await app.close();
  });

  it('lỗi ở bước gán vai chủ lớp thì không còn lớp, cohort, context, override hay sự kiện nào được ghi', async () => {
    const name = uniqueName('cls-rollback');
    const contextsBefore = await count('SELECT count(*) AS count FROM context WHERE context_level = $1', [CONTEXT_LEVELS.CLASS]);
    const capsBefore = await count('SELECT count(*) AS count FROM role_capabilities');
    const outboxBefore = await count("SELECT count(*) AS count FROM outbox_events WHERE type = 'class_created'");

    const spy = vi.spyOn(roles, 'assignRole').mockRejectedValue(new Error('rollback probe'));
    try {
      await expect(classes.createClass(adminId, { name })).rejects.toThrow('rollback probe');
    } finally {
      spy.mockRestore();
    }

    expect(await count('SELECT count(*) AS count FROM classes WHERE name = $1', [name])).toBe(0);
    expect(await count("SELECT count(*) AS count FROM cohort WHERE name = $1 AND component = 'class'", [name])).toBe(0);
    expect(await count('SELECT count(*) AS count FROM context WHERE context_level = $1', [CONTEXT_LEVELS.CLASS])).toBe(contextsBefore);
    expect(await count('SELECT count(*) AS count FROM role_capabilities')).toBe(capsBefore);
    expect(await count("SELECT count(*) AS count FROM outbox_events WHERE type = 'class_created'")).toBe(outboxBefore);
  });

  it('tạo lớp thành công giữ nguyên trạng thái cuối: lớp, cohort neo context lớp, override, gán vai chủ lớp và sự kiện', async () => {
    const name = uniqueName('cls-ok');
    const view = await classes.createClass(adminId, { name });

    expect(await count('SELECT count(*) AS count FROM classes WHERE id = $1 AND name = $2', [view.id, name])).toBe(1);
    const ctx = await pg.query<{ id: string }>(
      'SELECT id FROM context WHERE context_level = $1 AND instance_id = $2',
      [CONTEXT_LEVELS.CLASS, view.id],
    );
    expect(ctx.rows).toHaveLength(1);
    const contextId = ctx.rows[0]!.id;
    // Backing cohort phải trỏ context lớp vừa tạo.
    expect(await count('SELECT count(*) AS count FROM cohort WHERE id = $1 AND context_id = $2', [view.cohortId, contextId])).toBe(1);
    // Bộ override của các vai lớp đã vật chất hoá tại context lớp.
    expect(await count('SELECT count(*) AS count FROM role_capabilities WHERE context_id = $1', [contextId])).toBeGreaterThan(0);
    // Chủ lớp giữ vai editingteacher tại context lớp.
    expect(await count(
      `SELECT count(*) AS count FROM role_assignments ra
       JOIN role r ON r.id = ra.role_id
       WHERE ra.user_id = $1 AND ra.context_id = $2 AND r.short_name = 'editingteacher'`,
      [adminId, contextId],
    )).toBe(1);
    expect(await count(
      "SELECT count(*) AS count FROM outbox_events WHERE type = 'class_created' AND payload->>'classId' = $1",
      [view.id],
    )).toBe(1);
  });
});

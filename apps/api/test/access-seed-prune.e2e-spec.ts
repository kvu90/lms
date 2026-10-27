import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { RolesService } from '../src/modules/access/roles.service';
import {
  adminToken, createContextViaApi, createTestApp, roleIdByShortname, systemContextId,
} from './identity-access-helpers';

/**
 * Issue #35: định danh capability không có tiền tố (`<area>:<name>`).
 * Rào chắn hồi quy cho đồng bộ seed: cơ sở dữ liệu từng được seed theo một
 * sơ đồ đặt tên có tiền tố cũ không được giữ các dòng lỗi thời sau khi seed lại —
 * cả trong `capabilities` lẫn trong `role_capabilities` (bất kỳ context nào).
 * Tên cũ được lắp ghép bằng nối chuỗi có chủ đích, để spec này tự nó
 * không mang literal capability có tiền tố.
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
    // Một context thứ hai, không thuộc hệ thống: các ghi đè lỗi thời ở đó cũng phải ra đi.
    const catId = (await createContextViaApi(app, admin, 40, uuidv7(), systemId)).id;

    // Mô phỏng trạng thái trước khi đổi tên: các định nghĩa và ghi đè mà tên của chúng
    // mang một trong các tiền tố đã loại bỏ (ba sơ đồ cũ).
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
    // theo vai (issue #124) → 112, + 1 quyền quiz:gradepaper của CAM-0
    // (issue #112) → 113, + 2 quyền tenant:manage / tenant:viewall
    // của nền multi-tenant (TENANT-0, issue #168) → 115, + 1 quyền
    // search:manage của đợt vá gác route ghi search (sổ #134, H2+H5)
    // → 116, − 3 quyền blog:create / blog:view / blog:manageentries
    // khi gỡ hẳn tính năng Blog (issue #173) → 113, + 8 quyền class:*
    // của lớp học hạng nhất (CLASS-0, issue #184: create/view/update/
    // delete/manageroster/assignwork/grade/share) → 121, every one
    // không có tiền tố,
    // và các mặc định đã đổi tên đã được seed lại tại context hệ thống.
    const defs = await pg.query<{ n: string }>(`select count(*) as n from capabilities`);
    expect(Number(defs.rows[0].n)).toBe(121);
    const renamed = await pg.query<{ permission: number }>(
      `select permission from role_capabilities where context_id = $1 and role_id = $2 and capability = 'course:update'`,
      [systemId, managerId],
    );
    expect(renamed.rows).toHaveLength(1);
    expect(renamed.rows[0].permission).toBe(1);
  });
});

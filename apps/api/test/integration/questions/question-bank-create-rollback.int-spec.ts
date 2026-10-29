import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, roleIdByShortname, systemContextId,
} from '../../support/identity-access-helpers';
import { RolesService } from '../../../src/modules/access/roles.service';
import { QuestionBanksService } from '../../../src/modules/questions/question-banks.service';

const TEST_DB_URL = process.env.LMS_TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/lms_test_api';

/**
 * Hồi quy nguyên tử cho luồng TẠO BANK câu hỏi (issue #490, DL-09).
 *
 * Bất biến nghiệp vụ: dựng một bank là một biên nguyên tử — context
 * của bank, dòng bank, category mặc định, override capability của
 * hai vai chuyên dụng (qbankmember/qbanklead) tại context bank, gán
 * vai lead cho chủ bank và sự kiện outbox `question_bank_created`
 * hoặc CÙNG thành công, hoặc không bước nào được ghi. Trước bản sửa,
 * chuỗi ghi chạy rời nhau: lỗi ở bước gán vai lead (bước cuối) để
 * lại bank dở dang — bank + category + quyền đã tồn tại mà bank chưa
 * có người phụ trách.
 *
 * Cách gây lỗi: spy `RolesService.assignRole` ném lỗi — bước ghi
 * cuối của luồng. Ca đối chứng gọi lại ngay sau đó phải tạo được
 * bank trọn vẹn, khẳng định lần tạo hỏng không để lại dấu vết nào
 * chặn lần tạo lại và trạng thái cuối khi thành công không đổi.
 */
describe('Tạo bank câu hỏi — rollback nguyên tử khi bước gán vai cuối luồng lỗi (issue #490)', () => {
  let app: INestApplication;
  let pg: Client;
  let banks: QuestionBanksService;
  let roles: RolesService;
  let staffId: string;

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await pg.query<{ count: string }>(sql, params);
    return Number(rows[0]!.count);
  }

  beforeAll(async () => {
    app = await createTestApp();
    pg = new Client({ connectionString: TEST_DB_URL });
    await pg.connect();
    banks = app.get(QuestionBanksService);
    roles = app.get(RolesService);
    // Người dùng staff mới (vai editingteacher tại context hệ thống)
    // — đủ tư cách giữ bank cá nhân, và chưa từng có bank nào.
    const admin = await adminToken(app);
    const staff = await createUserViaApi(app, admin);
    staffId = staff.id;
    const systemCtx = await systemContextId(app, admin);
    const teacherRoleId = await roleIdByShortname(app, admin, 'editingteacher');
    await assignRole(app, admin, staffId, teacherRoleId, systemCtx);
  });

  afterAll(async () => {
    await pg.end();
    await app.close();
  });

  it('lỗi ở bước gán vai lead thì không còn bank, category, context, override hay sự kiện nào được ghi', async () => {
    const banksBefore = await count('SELECT count(*) AS count FROM question_banks');
    const categoriesBefore = await count('SELECT count(*) AS count FROM question_categories');
    const contextsBefore = await count('SELECT count(*) AS count FROM context');
    const capsBefore = await count('SELECT count(*) AS count FROM role_capabilities');
    const outboxBefore = await count("SELECT count(*) AS count FROM outbox_events WHERE type = 'question_bank_created'");

    const spy = vi.spyOn(roles, 'assignRole').mockRejectedValue(new Error('rollback probe'));
    try {
      // Đường vào có lưới bắt lỗi riêng (đọc lại bank sau lỗi để hồi
      // phục đua tạo đồng thời) nên bằng chứng lỗi không nằm ở việc
      // promise có reject hay không, mà ở TRẠNG THÁI còn lại trong DB
      // sau khi luồng kết thúc — các khẳng định ngay dưới đây.
      await banks.ensurePersonalBank(staffId).catch(() => undefined);
    } finally {
      spy.mockRestore();
    }

    expect(await count('SELECT count(*) AS count FROM question_banks WHERE owner_id = $1', [staffId])).toBe(0);
    expect(await count('SELECT count(*) AS count FROM question_banks')).toBe(banksBefore);
    expect(await count('SELECT count(*) AS count FROM question_categories')).toBe(categoriesBefore);
    expect(await count('SELECT count(*) AS count FROM context')).toBe(contextsBefore);
    expect(await count('SELECT count(*) AS count FROM role_capabilities')).toBe(capsBefore);
    expect(await count("SELECT count(*) AS count FROM outbox_events WHERE type = 'question_bank_created'")).toBe(outboxBefore);
  });

  it('gọi lại sau lần tạo hỏng thì bank được tạo trọn vẹn: category mặc định, override hai vai, gán lead và sự kiện', async () => {
    const bank = await banks.ensurePersonalBank(staffId);
    expect(bank.scope).toBe('personal');
    expect(bank.ownerId).toBe(staffId);

    expect(await count('SELECT count(*) AS count FROM question_categories WHERE bank_id = $1', [bank.id])).toBe(1);
    expect(await count('SELECT count(*) AS count FROM role_capabilities WHERE context_id = $1', [bank.contextId])).toBeGreaterThan(0);
    expect(await count(
      `SELECT count(*) AS count FROM role_assignments ra
       JOIN role r ON r.id = ra.role_id
       WHERE ra.user_id = $1 AND ra.context_id = $2 AND r.short_name = 'qbanklead'`,
      [staffId, bank.contextId],
    )).toBe(1);
    expect(await count(
      "SELECT count(*) AS count FROM outbox_events WHERE type = 'question_bank_created' AND payload->>'bankId' = $1",
      [bank.id],
    )).toBe(1);
  });
});

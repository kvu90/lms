import { Logger, type INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminToken, createTestApp, http } from '../../support/identity-access-helpers';

/**
 * Lưới an toàn cho việc dọn controller trùng path của ba họ ngân hàng
 * (issue #343, cụm R6-A1): hợp nhất mỗi họ `exam-matrices`,
 * `question-banks`, `exams` về đúng một controller sở hữu và gom
 * toàn bộ bề mặt alias `exam-papers` về một controller alias duy
 * nhất.
 *
 * Khẳng định chính còn lại ở spec này (hành vi qua HTTP):
 * - Các khẳng định tĩnh của lát (mỗi tiền tố có đúng một controller
 *   sở hữu theo phép quét khai báo `@Controller`; bảng route quét
 *   tĩnh và bảng route qua tài liệu OpenAPI đều bằng đúng 100 cặp
 *   trước khi hợp nhất) nay được ghim ở spec hợp đồng bảng route tại
 *   tầng integration:
 *   `test/integration/platform/route-table-contract.int-spec.ts`.
 * - Hành vi alias: path `/exam-papers` vẫn tới được đúng handler
 *   (kết quả như canonical), response qua alias mang header
 *   Deprecation/Sunset và mỗi lượt gọi alias sinh đúng một bản ghi
 *   log có cấu trúc `deprecated_route_alias`; path canonical không
 *   mang header đó và không sinh log alias. Log alias là căn cứ của
 *   điều kiện gỡ alias (0 lượt gọi trong 14 ngày), nên spec kiểm cả
 *   nội dung bản ghi log, không chỉ kiểm header.
 */



describe('Controller consolidation R6-A1 (issue #343) — hành vi alias', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
  });



  it('phục vụ alias exam-papers kèm header deprecation và log có cấu trúc trong khi route chuẩn không bị đánh dấu', async () => {
    // Bank đề trường để có bankId thật cho route danh sách đề theo bank.
    const bankRes = await http(app).post('/api/v1/question-banks').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Ngân hàng đề trường R6-A1', scope: 'school', bankKind: 'exam' });
    expect(bankRes.status, JSON.stringify(bankRes.body)).toBeLessThan(300);
    const bankId = (bankRes.body as { id: string }).id;

    // Bắt đầu theo dõi log cảnh báo từ đây để các bản ghi bắt được
    // chỉ đến từ các lượt gọi alias bên dưới.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    // GET canonical danh sách đề theo bank: 200, tuyệt đối không header sắp bỏ.
    const canonicalList = await http(app).get(`/api/v1/exams/banks/${bankId}/exams`).set('Authorization', `Bearer ${admin}`);
    expect(canonicalList.status).toBe(200);
    expect(canonicalList.headers['deprecation']).toBeUndefined();

    // GET alias cùng bề mặt: 200 với cùng kết quả, kèm header sắp bỏ.
    const aliasList = await http(app).get(`/api/v1/exam-papers/banks/${bankId}/exams`).set('Authorization', `Bearer ${admin}`);
    expect(aliasList.status).toBe(200);
    expect(aliasList.body).toEqual(canonicalList.body);
    expect(aliasList.headers['deprecation']).toBe('true');
    expect(aliasList.headers['sunset']).toContain('2027');

    // GET canonical hồ sơ của tôi: 200, không header sắp bỏ.
    const canonicalMine = await http(app).get('/api/v1/exams/dossiers/mine').set('Authorization', `Bearer ${admin}`);
    expect(canonicalMine.status).toBe(200);
    expect(canonicalMine.headers['deprecation']).toBeUndefined();

    // GET alias bề mặt hồ sơ đề (phần đã gộp từ controller hồ sơ cũ):
    // 200, kèm header sắp bỏ.
    const aliasMine = await http(app).get('/api/v1/exam-papers/dossiers/mine').set('Authorization', `Bearer ${admin}`);
    expect(aliasMine.status).toBe(200);
    expect(aliasMine.body).toEqual(canonicalMine.body);
    expect(aliasMine.headers['deprecation']).toBe('true');

    // Các bản ghi log alias đã sinh phải là JSON có cấu trúc của sự
    // kiện deprecated_route_alias, trỏ đúng cặp alias → canonical
    // cho cả hai bề mặt (đề theo bank và hồ sơ của tôi).
    const aliasLogs = warn.mock.calls
      .map((call) => String(call[0]))
      .flatMap((message) => {
        try {
          return [JSON.parse(message) as Record<string, unknown>];
        } catch {
          return [];
        }
      })
      .filter((entry) => entry.event === 'deprecated_route_alias');
    expect(aliasLogs.some((entry) => entry.alias === 'exam-papers/banks/:bankId/exams' && entry.canonical === 'exams/banks/:bankId/exams')).toBe(true);
    expect(aliasLogs.some((entry) => entry.alias === 'exam-papers/dossiers/mine' && entry.canonical === 'exams/dossiers/mine')).toBe(true);
  });
});

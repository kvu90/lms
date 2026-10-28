import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, http } from '../support/identity-access-helpers';

/**
 * Version bất biến của ma trận (issue #228, lát S1) — đối chiếu tiêu
 * chí nghiệm thu S1 của issue: "ma trận có versions bất biến — sửa
 * ma trận tạo version mới, nội dung version cũ đọc lại được nguyên
 * vẹn; spec chứng minh sửa không ghi đè mất nội dung cũ".
 *
 * Luật được khoá ở đây:
 *  - Tạo ma trận sinh ngay hàng version 1 bất biến; ô thuộc về đúng
 *    một version qua matrix_version_id.
 *  - Ma trận còn draft: sửa ô/cấu hình tại chỗ trên version đang mở,
 *    không sinh version mới.
 *  - Ma trận đã rời draft: sửa ô hoặc sửa cấu hình nội dung = sinh
 *    version mới mang toàn bộ ô; version cũ đọc lại qua
 *    GET /exam-matrices/:id/versions/:version nguyên vẹn từng giá
 *    trị.
 *  - Copy ma trận: bản copy có version 1 bất biến của riêng nó.
 */
describe('Matrix immutable versions (issue #228 S1)', () => {
  let app: INestApplication;
  let admin: string;
  let pg: Client;
  let subjectId: string;
  let curriculumId: string;
  let nodeA: string;
  let nodeB: string;

  interface MatrixViewBody {
    id: string; version: number; status: string; totalScore: number;
    cells: { id: string; curriculumNodeId: string; cognitiveLevel: string; qtype: string; questionCount: number; cellScore: number }[];
  }

  const bearer = () => ({ Authorization: `Bearer ${admin}` });

  async function createMatrix(name: string): Promise<MatrixViewBody> {
    const res = await http(app).post('/api/v1/exam-matrices').set(bearer())
      .send({ name, subjectId, curriculumId, totalScore: 10 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as MatrixViewBody;
  }

  async function addCell(matrixId: string, nodeId: string, questionCount: number, cellScore: number): Promise<MatrixViewBody> {
    const res = await http(app).post(`/api/v1/exam-matrices/${matrixId}/cells`).set(bearer())
      .send({ curriculumNodeId: nodeId, cognitiveLevel: 'biet', qtype: 'multichoice', questionCount, cellScore });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as MatrixViewBody;
  }

  async function getVersion(matrixId: string, version: number): Promise<{ status: number; body: MatrixViewBody & { code?: string } }> {
    const res = await http(app).get(`/api/v1/exam-matrices/${matrixId}/versions/${version}`).set(bearer());
    return { status: res.status, body: res.body as MatrixViewBody & { code?: string } };
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();

    const contexts = await http(app).get('/api/v1/access/contexts').set(bearer());
    const systemCtx = (contexts.body as { id: string; contextLevel: number }[]).find((c) => c.contextLevel === 10)!;
    const subjRes = await http(app).post('/api/v1/curriculum/subjects').set(bearer())
      .send({ contextId: systemCtx.id, name: 'Toán học', slug: `toan-ver-${Date.now()}` });
    expect([200, 201]).toContain(subjRes.status);
    subjectId = subjRes.body.id as string;
    const currRes = await http(app).post('/api/v1/curriculum/curricula').set(bearer())
      .send({ subjectId, grade: 10 });
    curriculumId = currRes.body.id as string;
    const topicRes = await http(app).post('/api/v1/curriculum/nodes').set(bearer())
      .send({ curriculumId, title: 'Hàm số', kind: 'topic' });
    const topicId = topicRes.body.id as string;
    const lessonA = await http(app).post('/api/v1/curriculum/nodes').set(bearer())
      .send({ curriculumId, parentId: topicId, title: 'Hàm số bậc hai', kind: 'lesson' });
    nodeA = lessonA.body.id as string;
    const lessonB = await http(app).post('/api/v1/curriculum/nodes').set(bearer())
      .send({ curriculumId, parentId: topicId, title: 'Hàm số bậc nhất', kind: 'lesson' });
    nodeB = lessonB.body.id as string;
  });
  afterAll(async () => { await pg.end(); await app.close(); });

  it('tạo ma trận sinh version 1 bất biến và ô thuộc về version đó', async () => {
    const matrix = await createMatrix('Ma trận version 1');
    expect(matrix.version).toBe(1);
    const withCell = await addCell(matrix.id, nodeA, 2, 2);
    expect(withCell.cells).toHaveLength(1);

    const versionRows = await pg.query<{ id: string; version: number }>(
      'select id, version from exam_matrix_versions where matrix_id = $1', [matrix.id],
    );
    expect(versionRows.rows).toHaveLength(1);
    expect(versionRows.rows[0]!.version).toBe(1);
    const cellRows = await pg.query<{ matrix_version_id: string }>(
      'select matrix_version_id from exam_matrix_cells where matrix_id = $1', [matrix.id],
    );
    expect(cellRows.rows).toHaveLength(1);
    expect(cellRows.rows[0]!.matrix_version_id).toBe(versionRows.rows[0]!.id);

    const v1 = await getVersion(matrix.id, 1);
    expect(v1.status).toBe(200);
    expect(v1.body.version).toBe(1);
    expect(v1.body.cells).toHaveLength(1);
    expect(v1.body.cells[0]!.questionCount).toBe(2);
  });

  it('ma trận draft sửa ô tại chỗ, không sinh version mới', async () => {
    const matrix = await createMatrix('Ma trận draft');
    const withCell = await addCell(matrix.id, nodeA, 3, 3);
    const cellId = withCell.cells[0]!.id;
    const patched = await http(app).patch(`/api/v1/exam-matrices/${matrix.id}/cells/${cellId}`).set(bearer())
      .send({ questionCount: 4 });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect((patched.body as MatrixViewBody).version).toBe(1);
    const v2 = await getVersion(matrix.id, 2);
    expect(v2.status).toBe(404);
    expect(v2.body.code).toBe('quiz.matrix_version_not_found');
    const v1 = await getVersion(matrix.id, 1);
    expect(v1.body.cells[0]!.questionCount).toBe(4);
  });

  it('ma trận ready sửa ô thì sinh version mới, version cũ đọc lại nguyên vẹn', async () => {
    const matrix = await createMatrix('Ma trận ready sửa ô');
    await addCell(matrix.id, nodeA, 2, 2);
    const ready = await http(app).patch(`/api/v1/exam-matrices/${matrix.id}`).set(bearer()).send({ status: 'ready' });
    expect(ready.status, JSON.stringify(ready.body)).toBe(200);
    expect((ready.body as MatrixViewBody).version).toBe(1);

    const current = await http(app).get(`/api/v1/exam-matrices/${matrix.id}`).set(bearer());
    const cellId = (current.body as MatrixViewBody).cells[0]!.id;
    const patched = await http(app).patch(`/api/v1/exam-matrices/${matrix.id}/cells/${cellId}`).set(bearer())
      .send({ questionCount: 5 });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect((patched.body as MatrixViewBody).version).toBe(2);
    expect((patched.body as MatrixViewBody).cells[0]!.questionCount).toBe(5);

    // Version cũ còn nguyên giá trị cũ; version mới mang giá trị mới.
    const v1 = await getVersion(matrix.id, 1);
    expect(v1.status).toBe(200);
    expect(v1.body.cells).toHaveLength(1);
    expect(v1.body.cells[0]!.questionCount).toBe(2);
    const v2 = await getVersion(matrix.id, 2);
    expect(v2.body.cells[0]!.questionCount).toBe(5);

    // Ở tầng DB: hai bản ô cùng tồn tại, mỗi bản thuộc đúng một version.
    const cellRows = await pg.query<{ version: number; question_count: number }>(
      `select v.version, c.question_count from exam_matrix_cells c
         join exam_matrix_versions v on v.id = c.matrix_version_id
        where c.matrix_id = $1 order by v.version`, [matrix.id],
    );
    expect(cellRows.rows).toEqual([
      { version: 1, question_count: 2 },
      { version: 2, question_count: 5 },
    ]);
  });

  it('ma trận ready sửa cấu hình thì sinh version mới chụp cấu hình mới, version cũ giữ cấu hình cũ', async () => {
    const matrix = await createMatrix('Ma trận ready sửa cấu hình');
    await addCell(matrix.id, nodeB, 1, 10);
    await http(app).patch(`/api/v1/exam-matrices/${matrix.id}`).set(bearer()).send({ status: 'ready' });
    const patched = await http(app).patch(`/api/v1/exam-matrices/${matrix.id}`).set(bearer()).send({ totalScore: 9 });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect((patched.body as MatrixViewBody).version).toBe(2);
    expect((patched.body as MatrixViewBody).totalScore).toBe(9);

    const v1 = await getVersion(matrix.id, 1);
    expect(v1.body.totalScore).toBe(10);
    expect(v1.body.cells).toHaveLength(1);
    const v2 = await getVersion(matrix.id, 2);
    expect(v2.body.totalScore).toBe(9);
    expect(v2.body.cells).toHaveLength(1);
  });

  it('ma trận ready đổi tên cũng sinh version mới theo hợp đồng cũ, nội dung các version nguyên vẹn', async () => {
    const matrix = await createMatrix('Ma trận ready đổi tên');
    await addCell(matrix.id, nodeA, 2, 2);
    await http(app).patch(`/api/v1/exam-matrices/${matrix.id}`).set(bearer()).send({ status: 'ready' });
    const renamed = await http(app).patch(`/api/v1/exam-matrices/${matrix.id}`).set(bearer())
      .send({ name: 'Ma trận ready đổi tên (bản 2)' });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect((renamed.body as MatrixViewBody).version).toBe(2);

    // Cả hai version đều đọc được; ô và cấu hình mang nguyên trạng.
    const v1 = await getVersion(matrix.id, 1);
    expect(v1.status).toBe(200);
    expect(v1.body.cells).toHaveLength(1);
    expect(v1.body.cells[0]!.questionCount).toBe(2);
    expect(v1.body.totalScore).toBe(10);
    const v2 = await getVersion(matrix.id, 2);
    expect(v2.status).toBe(200);
    expect(v2.body.cells).toHaveLength(1);
    expect(v2.body.totalScore).toBe(10);
  });

  it('copy ma trận tạo version 1 bất biến riêng cho bản copy', async () => {
    const source = await createMatrix('Ma trận nguồn copy');
    await addCell(source.id, nodeA, 2, 2);
    await http(app).patch(`/api/v1/exam-matrices/${source.id}`).set(bearer()).send({ status: 'ready' });

    const copyRes = await http(app).post(`/api/v1/exam-matrices/${source.id}/copy`).set(bearer()).send({});
    expect(copyRes.status, JSON.stringify(copyRes.body)).toBe(201);
    const copy = copyRes.body as MatrixViewBody;
    expect(copy.version).toBe(1);
    expect(copy.cells).toHaveLength(1);

    const copyVersions = await pg.query<{ version: number }>(
      'select version from exam_matrix_versions where matrix_id = $1', [copy.id],
    );
    expect(copyVersions.rows).toEqual([{ version: 1 }]);
    const v1 = await getVersion(copy.id, 1);
    expect(v1.status).toBe(200);
    expect(v1.body.cells[0]!.questionCount).toBe(2);
  });
});

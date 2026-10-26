import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { Client } from 'pg';
import { STRONG_PASSWORD, adminToken, createTestApp, createUserViaApi, login } from './identity-access-helpers';

/**
 * Luồng nghiệp vụ của lát I-2 (issue #233) — GHI NGUYÊN TỬ khi nhập
 * ma trận, nối tiếp lát I-1 (mẫu + xem trước):
 *
 * - Giáo viên tải lại CHÍNH file đã xem trước → POST
 *   /exam-matrices/import ghi ma trận mới + toàn bộ ô trong một lần,
 *   đọc lại được bằng các endpoint hiện hữu (chi tiết, availability,
 *   bản đặc tả) với ô/điểm/tổng khớp đúng kết quả xem trước.
 * - Gửi lại cùng một nội dung (double submit/retry) KHÔNG nhân đôi
 *   ma trận: trả chính ma trận đã ghi.
 * - File bị sửa tay sau xem trước mà vi phạm luật hợp lệ → ghi bị từ
 *   chối 422 kèm lỗi cứng ĐỊNH VỊ (extension member
 *   `matrixImportIssues`) và DB không còn dấu vết nào của lần ghi đó.
 * - Người không có capability tạo ma trận tại môn → 403, không ghi.
 *
 * Dữ kiện tự dựng bằng API như spec của I-1: môn + chương trình khối
 * 10 + chủ đề có hai ĐVK, mỗi ĐVK có YCCĐ, 3 câu ready ở outcome đầu
 * của ĐVK 1 (availability của ô Biết/trắc nghiệm ở ĐVK 1 thiếu 1 câu —
 * số đếm khả dụng phải khớp trước và sau khi ghi).
 */

const http = (app: INestApplication) => request(app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let app: INestApplication;
let admin: string;
let subjectId: string;
let curriculumId: string;
let lesson1Id: string;
let lesson2Id: string;

/** Đếm thẳng trong DB (bật ngữ cảnh platform để qua RLS tenant). */
async function countMatricesByName(name: string): Promise<number> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("select set_config('app.platform', 'on', false)");
    const res = await client.query('select count(*)::int as n from exam_matrices where name = $1', [name]);
    return res.rows[0]!.n as number;
  } finally {
    await client.end();
  }
}

async function downloadTemplate(token: string): Promise<ExcelJS.Workbook> {
  const qs = new URLSearchParams({ subjectId, curriculumId }).toString();
  const res = await http(app)
    .get(`/api/v1/exam-matrices/template?${qs}`)
    .set(auth(token))
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  if (res.status !== 200) throw new Error(`template failed: ${res.status} ${JSON.stringify(res.body)}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.body as unknown as ExcelJS.Buffer);
  return wb;
}

/**
 * Điền file hợp lệ đúng ca của spec I-1: sheet `Ma trận` giữ cả khối
 * thông tin chung (B2 tên; B5 tổng 10 và B6 "Không" do mẫu điền sẵn;
 * mã môn/chương trình ở cột D — không đụng) lẫn lưới. Điểm mỗi câu ở
 * B7–B10; 9 ô có câu, tổng tự tính khớp đúng 10 điểm, tỉ lệ dạng khớp
 * khuôn 30/20/20/30. Cột: MC F–H, Đ–S I–K, Trả lời ngắn L–N, Tự luận
 * O–Q theo thứ tự Biết/Hiểu/Vận dụng; hàng 15 = ĐVK 1, 16 = ĐVK 2.
 */
function fillValid(wb: ExcelJS.Workbook, name: string): void {
  const ws = wb.getWorksheet('Ma trận')!;
  ws.getCell('B2').value = name;
  ws.getCell('B7').value = 0.25; // điểm mỗi câu Nhiều lựa chọn
  ws.getCell('B8').value = 1; // điểm mỗi chùm Đúng–Sai
  ws.getCell('B9').value = 0.5; // điểm mỗi câu Trả lời ngắn
  ws.getCell('B10').value = 1.5; // điểm mỗi câu Tự luận
  // ĐVK 1 (dòng 15)
  ws.getCell('F15').value = 4; // MC Biết
  ws.getCell('G15').value = 4; // MC Hiểu
  ws.getCell('J15').value = 1; // Đ–S Hiểu (chùm)
  ws.getCell('N15').value = 2; // Trả lời ngắn Vận dụng
  ws.getCell('Q15').value = 1; // Tự luận Vận dụng
  // ĐVK 2 (dòng 16)
  ws.getCell('F16').value = 4; // MC Biết
  ws.getCell('I16').value = 1; // Đ–S Biết (chùm)
  ws.getCell('M16').value = 2; // Trả lời ngắn Hiểu
  ws.getCell('Q16').value = 1; // Tự luận Vận dụng
}

async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function postImport(token: string, buffer: Buffer) {
  return http(app)
    .post('/api/v1/exam-matrices/import')
    .set(auth(token))
    .attach('file', buffer, 'ma-tran.xlsx');
}

async function postPreview(token: string, buffer: Buffer) {
  const res = await http(app)
    .post('/api/v1/exam-matrices/import/preview')
    .set(auth(token))
    .attach('file', buffer, 'ma-tran.xlsx')
    .expect(200);
  return res.body as {
    valid: boolean;
    cells: { curriculumNodeId: string; cognitiveLevel: string; qtype: string; questionCount: number; cellScore: number }[];
    availability: { curriculumNodeId: string; cognitiveLevel: string; qtype: string; required: number; available: number; deficit: number }[];
  };
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await adminToken(app);
  const ctx = await http(app).get('/api/v1/access/contexts').set(auth(admin)).expect(200);
  const system = (ctx.body as { id: string; contextLevel: number }[]).find((c) => c.contextLevel === 10)!;
  const suffix = Date.now().toString(36);
  const subject = await http(app).post('/api/v1/curriculum/subjects').set(auth(admin))
    .send({ contextId: system.id, name: 'Toán học', slug: `toan-i2-${suffix}` }).expect(201);
  subjectId = subject.body.id as string;
  const curriculum = await http(app).post('/api/v1/curriculum/curricula').set(auth(admin))
    .send({ subjectId, grade: 10 }).expect(201);
  curriculumId = curriculum.body.id as string;
  const node = (body: object) => http(app).post('/api/v1/curriculum/nodes').set(auth(admin)).send(body).expect(201);
  const topic = await node({ curriculumId, parentId: null, kind: 'topic', title: 'Hàm số', position: 1 });
  const lesson1 = await node({ curriculumId, parentId: topic.body.id, kind: 'lesson', title: 'Hàm số bậc hai', position: 1 });
  const lesson2 = await node({ curriculumId, parentId: topic.body.id, kind: 'lesson', title: 'Hàm số bậc nhất', position: 2 });
  lesson1Id = lesson1.body.id as string;
  lesson2Id = lesson2.body.id as string;
  const outcome = (nodeId: string, content: string) => http(app).post('/api/v1/curriculum/outcomes').set(auth(admin))
    .send({ nodeId, content }).expect(201);
  const o1 = await outcome(lesson1Id, 'Nhận biết được hàm số bậc hai');
  await outcome(lesson1Id, 'Vẽ được đồ thị hàm số bậc hai');
  await outcome(lesson2Id, 'Nhận biết được hàm số bậc nhất');

  const contexts = await http(app).get('/api/v1/access/contexts').set(auth(admin)).expect(200);
  const sys = (contexts.body as { id: string; contextLevel: number }[]).find((c) => c.contextLevel === 10)!;
  const category = await http(app).post('/api/v1/questions/categories').set(auth(admin))
    .send({ name: `Danh mục I-2 ${suffix}`, contextId: sys.id }).expect(201);
  for (let i = 0; i < 3; i++) {
    const r = await http(app).post('/api/v1/questions').set(auth(admin)).send({
      categoryId: category.body.id, qtype: 'multichoice', name: `Câu I-2 ${i + 1}`,
      questionText: `Câu I-2 ${i + 1}: chọn đáp án đúng.`, defaultMark: 1,
      answers: [{ text: 'Đúng', fraction: 1 }, { text: 'Sai', fraction: 0 }], options: { single: true },
    });
    if (r.status !== 201 && r.status !== 200) throw new Error(`question failed: ${r.status} ${JSON.stringify(r.body)}`);
    const qid = r.body.question.id as string;
    const tag = await http(app).post(`/api/v1/questions/${qid}/outcomes`).set(auth(admin))
      .send({ outcomeId: o1.body.id, cognitiveLevel: 'biet' });
    if (tag.status !== 201 && tag.status !== 200) throw new Error(`tag failed: ${tag.status} ${JSON.stringify(tag.body)}`);
  }
});

afterAll(async () => {
  await app.close();
});

describe('I-2: ghi nguyên tử khi nhập ma trận', () => {
  let validBuffer: Buffer;
  let matrixId: string;

  it('ghi thành công trọn bộ: view khớp preview, đọc lại bằng detail/availability/specification khớp', async () => {
    const wb = await downloadTemplate(admin);
    fillValid(wb, 'Ma trận nhập thử');
    validBuffer = await toBuffer(wb);
    const preview = await postPreview(admin, validBuffer);
    expect(preview.valid).toBe(true);
    expect(preview.cells).toHaveLength(9);

    const res = await postImport(admin, validBuffer).expect(201);
    const view = res.body as {
      id: string; name: string; status: string; bankId: string | null; levelSet: string;
      totalScore: number; scopeNodeIds: string[]; derivedFromMatrixId: string | null;
      cells: { id: string; curriculumNodeId: string; cognitiveLevel: string; qtype: string; questionCount: number; cellScore: number; position: number }[];
      warnings: string[];
    };
    matrixId = view.id;
    // Ma trận mới: draft, vào bank cá nhân của người nhập, đúng phạm
    // vi hai ĐVK theo thứ tự hàng trong file.
    expect(view.name).toBe('Ma trận nhập thử');
    expect(view.status).toBe('draft');
    expect(view.bankId).toBeTruthy();
    expect(view.derivedFromMatrixId).toBeNull();
    expect(view.levelSet).toBe('three');
    expect(view.totalScore).toBe(10);
    expect(view.scopeNodeIds).toEqual([lesson1Id, lesson2Id]);
    // Mọi ô khớp preview; position của ô = STT hàng của ĐVK trong file.
    expect(view.cells).toHaveLength(9);
    const key = (c: { curriculumNodeId: string; cognitiveLevel: string; qtype: string }) =>
      `${c.curriculumNodeId}|${c.cognitiveLevel}|${c.qtype}`;
    const byKey = new Map(view.cells.map((c) => [key(c), c]));
    for (const expected of preview.cells) {
      const got = byKey.get(key(expected));
      expect(got, `thiếu ô ${key(expected)}`).toBeTruthy();
      expect(got!.questionCount).toBe(expected.questionCount);
      expect(got!.cellScore).toBe(expected.cellScore);
      expect(got!.position).toBe(expected.curriculumNodeId === lesson1Id ? 1 : 2);
    }
    // Cảnh báo của view như đường tạo tay: tỉ lệ dạng câu khớp khuôn
    // nên không cảnh báo; tỉ lệ mức lệch khuôn nên có cảnh báo mức.
    expect(view.warnings.some((w) => w.includes('theo dạng câu'))).toBe(false);
    expect(view.warnings.some((w) => w.includes('theo mức'))).toBe(true);

    // Đọc lại bằng endpoint chi tiết hiện hữu: cùng một ma trận, ô khớp.
    const detail = await http(app).get(`/api/v1/exam-matrices/${matrixId}`).set(auth(admin)).expect(200);
    expect(detail.body.id).toBe(matrixId);
    expect(detail.body.cells).toHaveLength(9);

    // Availability sau ghi khớp số đếm đã tính ở bước xem trước.
    const avail = await http(app).get(`/api/v1/exam-matrices/${matrixId}/availability`).set(auth(admin)).expect(200);
    const availBody = avail.body as { cells: { cellId: string; required: number; available: number; deficit: number }[] };
    const cellById = new Map(view.cells.map((c) => [c.id, c]));
    expect(availBody.cells).toHaveLength(9);
    for (const row of availBody.cells) {
      const cell = cellById.get(row.cellId)!;
      const expected = preview.availability.find(
        (a) => a.curriculumNodeId === cell.curriculumNodeId && a.cognitiveLevel === cell.cognitiveLevel && a.qtype === cell.qtype,
      )!;
      expect(row.required).toBe(expected.required);
      expect(row.available).toBe(expected.available);
      expect(row.deficit).toBe(expected.deficit);
    }

    // Bản đặc tả hiện hữu dựng được từ ma trận vừa ghi.
    const spec = await http(app).get(`/api/v1/exam-matrices/${matrixId}/specification`).set(auth(admin)).expect(200);
    const nodeIds = (spec.body.topics as { nodes: { nodeId: string }[] }[]).flatMap((t) => t.nodes.map((n) => n.nodeId));
    expect(nodeIds).toContain(lesson1Id);
    expect(nodeIds).toContain(lesson2Id);
    expect(spec.body.totals.totalScore).toBe(10);
  });

  it('gửi lại cùng file (double submit/retry): trả chính ma trận đã ghi, DB không nhân đôi', async () => {
    const res = await postImport(admin, validBuffer).expect(201);
    expect(res.body.id).toBe(matrixId);
    expect(await countMatricesByName('Ma trận nhập thử')).toBe(1);
    const list = await http(app).get(`/api/v1/exam-matrices/by-subject/${subjectId}`).set(auth(admin)).expect(200);
    const named = (list.body as { name: string }[]).filter((m) => m.name === 'Ma trận nhập thử');
    expect(named).toHaveLength(1);
  });

  it('file bị sửa tay sau xem trước: 422 kèm lỗi định vị, DB không còn dấu vết', async () => {
    // Ô chứa chữ thay vì số: xem trước từng hợp lệ (bản chưa sửa),
    // bản gửi ghi đã bị sửa → server chạy lại luật và từ chối.
    const wb = await downloadTemplate(admin);
    fillValid(wb, 'Ma trận bị sửa tay');
    const clean = await postPreview(admin, await toBuffer(wb));
    expect(clean.valid).toBe(true);
    wb.getWorksheet('Ma trận')!.getCell('F15').value = 'bốn';
    const res = await postImport(admin, await toBuffer(wb)).expect(422);
    expect(res.body.status).toBe(422);
    expect(res.body.code).toBe('quiz.matrix_import_invalid');
    const issues = res.body.matrixImportIssues as { sheet: string | null; row: number | null; column: string | null; code: string }[];
    expect(Array.isArray(issues)).toBe(true);
    expect(issues.some((i) => i.code === 'quiz.matrix_import_cell_value_invalid' && i.row === 15 && i.column === 'F')).toBe(true);
    expect(await countMatricesByName('Ma trận bị sửa tay')).toBe(0);

    // Lệch tổng điểm khai báo: cũng từ chối toàn bộ, không ghi dở.
    const wb2 = await downloadTemplate(admin);
    fillValid(wb2, 'Ma trận lệch tổng');
    wb2.getWorksheet('Ma trận')!.getCell('B5').value = 9;
    const res2 = await postImport(admin, await toBuffer(wb2)).expect(422);
    expect(res2.body.code).toBe('quiz.matrix_import_invalid');
    const issues2 = res2.body.matrixImportIssues as { code: string }[];
    expect(issues2.some((i) => i.code === 'quiz.matrix_import_total_score_mismatch')).toBe(true);
    expect(await countMatricesByName('Ma trận lệch tổng')).toBe(0);
  });

  it('người thiếu capability tạo ma trận tại môn: 403 và không ghi', async () => {
    const suffix = Date.now().toString(36);
    const student = await createUserViaApi(app, admin, { username: `hs_i2_${suffix}` });
    expect(student.username).toBe(`hs_i2_${suffix}`);
    const studentToken = (await login(app, `hs_i2_${suffix}`, STRONG_PASSWORD)).accessToken;
    const wb = await downloadTemplate(admin);
    fillValid(wb, 'Ma trận của học sinh');
    const res = await postImport(studentToken, await toBuffer(wb)).expect(403);
    expect(res.body.code).toBe('access.capability_denied');
    expect(await countMatricesByName('Ma trận của học sinh')).toBe(0);
  });

  it('thiếu file: 400 quiz.matrix_import_file_required', async () => {
    const res = await http(app).post('/api/v1/exam-matrices/import').set(auth(admin)).expect(400);
    expect(res.body.code).toBe('quiz.matrix_import_file_required');
  });
});

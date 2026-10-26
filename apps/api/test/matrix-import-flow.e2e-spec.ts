import type { INestApplication } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, http } from './identity-access-helpers';

/**
 * Lát I-1 nhập ma trận từ file (issue #233): sinh workbook mẫu + parse
 * + xem trước, KHÔNG ghi DB. Luồng nghiệp vụ được kiểm:
 *  - giáo viên tải mẫu theo (môn, chương trình) → mẫu đã có sẵn hàng
 *    theo ĐƠN VỊ KIẾN THỨC với cột khoá "Mã ĐVK" (ma trận không gắn
 *    YCCĐ — YCCĐ chỉ để đối chiếu ở cột E);
 *  - điền đúng khuôn → preview khớp từng ô (số câu × điểm mỗi câu),
 *    tổng hai chiều tự tính lại, khả dụng ngân hàng theo ô;
 *  - file sai khuôn → lỗi cứng định vị đúng sheet/dòng/cột (ô chữ,
 *    Mã ĐVK bịa, lệch tổng điểm, checkbox Vận dụng cao không khớp
 *    lưới, thiếu điểm mỗi câu, ma trận rỗng);
 *  - preview không tạo ma trận nào trong hệ.
 */
describe('Matrix import I-1 (template + preview, no DB write)', () => {
  let app: INestApplication;
  let admin: string;

  interface Ctx {
    subjectId: string; curriculumId: string;
    lesson1Id: string; lesson2Id: string;
  }
  let ctx: Ctx;

  interface PreviewBody {
    valid: boolean;
    errors: { sheet: string | null; row: number | null; column: string | null; code: string; message: string }[];
    warnings: string[];
    name: string | null;
    levelSet: string | null;
    rows: { nodeId: string; nodeTitle: string; outcomes: { content: string }[] }[];
    cells: { curriculumNodeId: string; cognitiveLevel: string; qtype: string; questionCount: number; cellScore: number }[];
    totals: {
      byForm: { qtype: string; questionCount: number; score: number }[];
      byLevel: { cognitiveLevel: string; questionCount: number; score: number }[];
      totalScore: number; totalQuestions: number;
    };
    availability: { curriculumNodeId: string; cognitiveLevel: string; qtype: string; required: number; available: number; deficit: number }[];
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    const contexts = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const systemCtx = (contexts.body as { id: string; contextLevel: number }[]).find((c) => c.contextLevel === 10)!;

    const subjRes = await http(app).post('/api/v1/curriculum/subjects').set('Authorization', `Bearer ${admin}`)
      .send({ contextId: systemCtx.id, name: 'Toán học', slug: `toan-import-${Date.now()}` });
    const subjectId = subjRes.body.id as string;
    const currRes = await http(app).post('/api/v1/curricula').set('Authorization', `Bearer ${admin}`)
      .send({ subjectId, grade: 10 });
    const curriculumId = currRes.body.id as string;
    const topicRes = await http(app).post('/api/v1/curriculum/nodes').set('Authorization', `Bearer ${admin}`)
      .send({ curriculumId, title: 'Hàm số', kind: 'topic' });
    const topicId = topicRes.body.id as string;
    const lesson1Res = await http(app).post('/api/v1/curriculum/nodes').set('Authorization', `Bearer ${admin}`)
      .send({ curriculumId, parentId: topicId, title: 'Hàm số bậc hai', kind: 'lesson' });
    const lesson1Id = lesson1Res.body.id as string;
    const lesson2Res = await http(app).post('/api/v1/curriculum/nodes').set('Authorization', `Bearer ${admin}`)
      .send({ curriculumId, parentId: topicId, title: 'Hàm số bậc nhất', kind: 'lesson' });
    const lesson2Id = lesson2Res.body.id as string;
    const mkOutcome = async (nodeId: string, content: string) => {
      const r = await http(app).post('/api/v1/curriculum/outcomes').set('Authorization', `Bearer ${admin}`)
        .send({ nodeId, content });
      if (r.status !== 201 && r.status !== 200) throw new Error(`outcome failed: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.id as string;
    };
    const outcome1 = await mkOutcome(lesson1Id, 'Nhận biết được tính đồng biến, nghịch biến của hàm số bậc hai.');
    await mkOutcome(lesson1Id, 'Giải thích được mối liên hệ giữa đồ thị và dấu của hệ số a.');
    await mkOutcome(lesson2Id, 'Nhận biết được hàm số bậc nhất.');

    // 3 câu trắc nghiệm ready gắn YCCĐ của ĐVK 1 ở mức Biết — pool cho
    // ô (ĐVK 1 × Biết × Nhiều lựa chọn) khi preview tính khả dụng.
    const bankRes = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Matrix import bank', contextId: systemCtx.id });
    const bankCatId = bankRes.body.id as string;
    for (const name of ['MI1', 'MI2', 'MI3']) {
      const r = await http(app).post('/api/v1/questions').set('Authorization', `Bearer ${admin}`).send({
        categoryId: bankCatId, qtype: 'multichoice', name, questionText: `${name}: chọn đáp án đúng.`, defaultMark: 1,
        answers: [{ text: 'Đúng', fraction: 1 }, { text: 'Sai', fraction: 0 }], options: { single: true },
      });
      if (r.status !== 201 && r.status !== 200) throw new Error(`question failed: ${r.status} ${JSON.stringify(r.body)}`);
      const qid = r.body.question.id as string;
      const tag = await http(app).post(`/api/v1/questions/${qid}/outcomes`).set('Authorization', `Bearer ${admin}`)
        .send({ outcomeId: outcome1, cognitiveLevel: 'biet' });
      if (tag.status !== 201 && tag.status !== 200) throw new Error(`tag failed: ${tag.status} ${JSON.stringify(tag.body)}`);
    }
    ctx = { subjectId, curriculumId, lesson1Id, lesson2Id };
  });
  afterAll(async () => { await app.close(); });

  /** Tải workbook mẫu từ endpoint (đáp là file nhị phân). */
  async function downloadTemplate(query: Record<string, string>): Promise<ExcelJS.Workbook> {
    const qs = new URLSearchParams(query).toString();
    const res = await http(app).get(`/api/v1/exam-matrices/template?${qs}`)
      .set('Authorization', `Bearer ${admin}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(c));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    if (res.status !== 200) throw new Error(`template failed: ${res.status}`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as Buffer);
    return wb;
  }

  /** Điền một workbook mẫu thành file HỢP LỆ khớp tổng 10 điểm (dạng 30/20/20/30). Cột: MC F–H, Đ–S I–K, Trả lời ngắn L–N, Tự luận O–Q; mức theo thứ tự Biết/Hiểu/Vận dụng. */
  function fillValid(wb: ExcelJS.Workbook): ExcelJS.Workbook {
    const ws = wb.getWorksheet('Ma trận')!;
    ws.getCell('B2').value = 'Ma trận nhập thử';
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
    return wb;
  }

  async function preview(wb: ExcelJS.Workbook): Promise<PreviewBody> {
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await http(app).post('/api/v1/exam-matrices/import/preview')
      .set('Authorization', `Bearer ${admin}`)
      .attach('file', buffer, 'ma-tran.xlsx');
    if (res.status !== 200 && res.status !== 201) throw new Error(`preview failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as PreviewBody;
  }

  it('sinh mẫu: 3 sheet, hàng theo ĐVK với cột khoá + YCCĐ đối chiếu ở cột E', async () => {
    const wb = await downloadTemplate({ subjectId: ctx.subjectId, curriculumId: ctx.curriculumId });
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Hướng dẫn', 'Ma trận', 'Đặc tả']);
    const ws = wb.getWorksheet('Ma trận')!;
    expect(ws.getCell('A15').value).toBe(ctx.lesson1Id);
    expect(ws.getCell('A16').value).toBe(ctx.lesson2Id);
    expect(String(ws.getCell('D15').value)).toBe('Hàm số bậc hai');
    expect(String(ws.getCell('E15').value)).toContain('đồng biến');
    expect(ws.getCell('B6').value).toBe('Không'); // mặc định 3 mức — không có cột Vận dụng cao
    expect(ws.getCell('N14').value).toBe('Vận dụng');
  });

  it('sinh mẫu với Vận dụng cao: lưới có thêm cột Vận dụng cao cho từng dạng', async () => {
    const wb = await downloadTemplate({ subjectId: ctx.subjectId, curriculumId: ctx.curriculumId, levelSet: 'four' });
    const ws = wb.getWorksheet('Ma trận')!;
    expect(ws.getCell('B6').value).toBe('Có');
    const levelRow: string[] = [];
    for (let c = 6; c <= 21; c++) levelRow.push(String(ws.getCell(14, c).value ?? ''));
    expect(levelRow.filter((v) => v === 'Vận dụng cao')).toHaveLength(4);
  });

  it('preview file hợp lệ: khớp từng ô, tổng hai chiều tự tính lại, khả dụng theo ô, không ghi DB', async () => {
    const wb = fillValid(await downloadTemplate({ subjectId: ctx.subjectId, curriculumId: ctx.curriculumId }));
    const body = await preview(wb);
    expect(body.valid).toBe(true);
    expect(body.errors).toEqual([]);
    expect(body.name).toBe('Ma trận nhập thử');
    expect(body.levelSet).toBe('three');
    expect(body.rows.map((r) => r.nodeId)).toEqual([ctx.lesson1Id, ctx.lesson2Id]);
    expect(body.rows[0]!.outcomes).toHaveLength(2);
    expect(body.cells).toHaveLength(9);
    const cellOf = (node: string, level: string, qtype: string) =>
      body.cells.find((c) => c.curriculumNodeId === node && c.cognitiveLevel === level && c.qtype === qtype);
    expect(cellOf(ctx.lesson1Id, 'biet', 'multichoice')).toMatchObject({ questionCount: 4, cellScore: 1 });
    expect(cellOf(ctx.lesson1Id, 'hieu', 'truefalse')).toMatchObject({ questionCount: 1, cellScore: 1 });
    expect(cellOf(ctx.lesson2Id, 'van_dung', 'essay')).toMatchObject({ questionCount: 1, cellScore: 1.5 });
    expect(body.totals.totalScore).toBe(10);
    expect(body.totals.byForm.find((f) => f.qtype === 'multichoice')).toMatchObject({ questionCount: 12, score: 3 });
    expect(body.totals.byForm.find((f) => f.qtype === 'truefalse')).toMatchObject({ questionCount: 2, score: 2 });
    // Tỉ lệ theo dạng khớp mốc 7991 → không cảnh báo dạng; lệch mức thì có cảnh báo mức.
    expect(body.warnings.some((w) => w.includes('theo dạng câu'))).toBe(false);
    expect(body.warnings.some((w) => w.includes('theo mức'))).toBe(true);
    // Khả dụng: ô MC Biết của ĐVK 1 cần 4, ngân hàng có 3 câu ready → thiếu 1.
    const availability = body.availability.find(
      (a) => a.curriculumNodeId === ctx.lesson1Id && a.cognitiveLevel === 'biet' && a.qtype === 'multichoice',
    );
    expect(availability).toMatchObject({ required: 4, available: 3, deficit: 1 });
    // Preview KHÔNG ghi DB: danh sách ma trận theo môn vẫn trống.
    const list = await http(app).get(`/api/v1/exam-matrices/by-subject/${ctx.subjectId}`).set('Authorization', `Bearer ${admin}`);
    expect(list.body).toEqual([]);
  });

  it('preview lỗi: ô chứa chữ → lỗi cứng đúng dòng/cột', async () => {
    const wb = fillValid(await downloadTemplate({ subjectId: ctx.subjectId, curriculumId: ctx.curriculumId }));
    wb.getWorksheet('Ma trận')!.getCell('F15').value = 'bốn';
    const body = await preview(wb);
    expect(body.valid).toBe(false);
    const e = body.errors.find((x) => x.code === 'quiz.matrix_import_cell_value_invalid');
    expect(e).toMatchObject({ sheet: 'Ma trận', row: 15, column: 'F' });
  });

  it('preview lỗi: Mã ĐVK không tồn tại → báo lỗi ở preview, không tự tạo ĐVK', async () => {
    const wb = fillValid(await downloadTemplate({ subjectId: ctx.subjectId, curriculumId: ctx.curriculumId }));
    wb.getWorksheet('Ma trận')!.getCell('A15').value = '123e4567-e89b-42d3-a456-426614174000';
    const body = await preview(wb);
    expect(body.valid).toBe(false);
    expect(body.errors.find((x) => x.code === 'quiz.matrix_import_node_not_found')).toMatchObject({ row: 15, column: 'A' });
  });

  it('preview lỗi: tổng điểm khai khác tổng tính lại → lỗi cứng kèm tổng tính lại', async () => {
    const wb = fillValid(await downloadTemplate({ subjectId: ctx.subjectId, curriculumId: ctx.curriculumId }));
    wb.getWorksheet('Ma trận')!.getCell('B5').value = 9;
    const body = await preview(wb);
    expect(body.valid).toBe(false);
    const e = body.errors.find((x) => x.code === 'quiz.matrix_import_total_score_mismatch');
    expect(e?.message).toContain('10');
  });

  it('preview lỗi: khai "Có" Vận dụng cao nhưng lưới không có cột VDC → lỗi cứng', async () => {
    const wb = fillValid(await downloadTemplate({ subjectId: ctx.subjectId, curriculumId: ctx.curriculumId }));
    wb.getWorksheet('Ma trận')!.getCell('B6').value = 'Có';
    const body = await preview(wb);
    expect(body.valid).toBe(false);
    expect(body.errors.some((x) => x.code === 'quiz.matrix_import_levelset_mismatch')).toBe(true);
  });

  it('preview lỗi: dạng có câu nhưng thiếu điểm mỗi câu → lỗi cứng', async () => {
    const wb = fillValid(await downloadTemplate({ subjectId: ctx.subjectId, curriculumId: ctx.curriculumId }));
    wb.getWorksheet('Ma trận')!.getCell('B7').value = null;
    const body = await preview(wb);
    expect(body.valid).toBe(false);
    expect(body.errors.some((x) => x.code === 'quiz.matrix_import_score_per_question_missing')).toBe(true);
  });

  it('preview lỗi: lưới rỗng → ma trận rỗng bị chặn', async () => {
    const wb = await downloadTemplate({ subjectId: ctx.subjectId, curriculumId: ctx.curriculumId });
    const ws = wb.getWorksheet('Ma trận')!;
    ws.getCell('B2').value = 'Ma trận rỗng';
    ws.getCell('B7').value = 0.25;
    const body = await preview(wb);
    expect(body.valid).toBe(false);
    expect(body.errors.map((x) => x.code)).toEqual(['quiz.matrix_import_matrix_empty']);
  });

  it('preview lỗi: file không phải xlsx → lỗi cấp file', async () => {
    const res = await http(app).post('/api/v1/exam-matrices/import/preview')
      .set('Authorization', `Bearer ${admin}`)
      .attach('file', Buffer.from('đây không phải file excel'), 'ma-tran.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors[0].code).toBe('quiz.matrix_import_file_unreadable');
  });
});

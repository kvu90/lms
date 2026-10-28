import type { INestApplication } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from '../../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from '../../support/course-enrolment-helpers';
import { createGradeItem, getGradebook, setGrade } from '../../support/assessment-helpers';

/**
 * Xuất bảng điểm Excel vnEdu (issue #53; nguồn đổi ở issue #224).
 * Oracle: Thông tư 22/2021/TT-BGDĐT (Điều 5 thang 10 + làm tròn 1 chữ
 * số thập phân; Điều 9 công thức ĐTBmhk — bản công thức ĐTB DUY NHẤT
 * còn lại của hệ nằm trong domain/vnedu-export và test này kiểm trực
 * tiếp qua file xuất) và kết quả kiểm chứng mẫu ở comment Bước 0 của
 * issue #53. Test đối chiếu TỪNG Ô điểm trong file .xlsx với điểm theo
 * bài (qua GET gradebook — đường đọc độc lập): khớp 100% mới đạt.
 * Nguồn xuất (issue #224): chỉ bài ĐÃ CÔNG BỐ mới được xuất.
 */
describe('Xuất sổ điểm Excel vnEdu (issue #53)', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
  });
  afterAll(async () => { await app.close(); });

  async function setupCourse(studentCount = 2) {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const students: { id: string; username: string }[] = [];
    for (let i = 0; i < studentCount; i += 1) {
      const student = await createUserViaApi(app, admin);
      await enrolUser(app, admin, course.id, instance.id, student.id);
      students.push(student);
    }
    return { course, students };
  }

  /** POST xuất vnEdu đọc body dạng Buffer thô (file nhị phân) thay vì JSON. */
  function exportVneduFile(courseId: string, body: Record<string, unknown>, token = admin) {
    return http(app)
      .post(`/api/v1/courses/${courseId}/grade-exports`)
      .set('Authorization', `Bearer ${token}`)
      // Path canonical grade-exports khai nhà cung cấp trong thân yêu cầu: provider: 'vnedu', phần còn lại là payload vnEdu như cũ.
      .send({ provider: 'vnedu', ...body })
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
  }

  function exportVneduJson(courseId: string, body: Record<string, unknown>, token = admin) {
    return http(app)
      .post(`/api/v1/courses/${courseId}/grade-exports`)
      .set('Authorization', `Bearer ${token}`)
      // Path canonical grade-exports khai nhà cung cấp trong thân yêu cầu: provider: 'vnedu', phần còn lại là payload vnEdu như cũ.
      .send({ provider: 'vnedu', ...body });
  }

  async function loadSheet(buffer: Buffer): Promise<ExcelJS.Worksheet> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet('Bảng điểm');
    if (!sheet) throw new Error('workbook has no sheet named "Bảng điểm"');
    return sheet;
  }

  /** Dòng dữ liệu của một học sinh theo cột Mã học sinh (cột 2), dữ liệu bắt đầu từ dòng 6. */
  function rowOfStudent(sheet: ExcelJS.Worksheet, username: string): number {
    for (let r = 6; r <= sheet.rowCount; r += 1) {
      if (sheet.getCell(r, 2).value === username) return r;
    }
    throw new Error(`no data row for student ${username}`);
  }

  const round1 = (v: number): number => Math.round((v + Number.EPSILON) * 10) / 10;

  it('file xuất khớp gradebook 100%: cấu trúc TT22, quy đổi thang 10, ĐTBmhk đúng công thức, thiếu điểm thì trống', async () => {
    const { course, students } = await setupCourse();
    const [s1, s2] = students as [{ id: string; username: string }, { id: string; username: string }];
    const tx1 = await createGradeItem(app, admin, course.id, { itemName: 'Kiểm tra miệng', gradeMax: 10 });
    const tx2 = await createGradeItem(app, admin, course.id, { itemName: 'Kiểm tra 15 phút', gradeMax: 100 });
    const gk = await createGradeItem(app, admin, course.id, { itemName: 'Giữa kỳ', gradeMax: 10 });
    const ck = await createGradeItem(app, admin, course.id, { itemName: 'Cuối kỳ', gradeMax: 10 });
    // s1 có đủ điểm; s2 thiếu tx2 và ck.
    await setGrade(app, admin, tx1.id, s1.id, 8);
    await setGrade(app, admin, tx2.id, s1.id, 75);
    await setGrade(app, admin, gk.id, s1.id, 7);
    await setGrade(app, admin, ck.id, s1.id, 9);
    await setGrade(app, admin, tx1.id, s2.id, 9);
    await setGrade(app, admin, gk.id, s2.id, 6.5);

    const res = await exportVneduFile(course.id, {
      regularItemIds: [tx1.id, tx2.id],
      midtermItemId: gk.id,
      finalItemId: ck.id,
      semester: 1,
      schoolYear: '2026-2027',
      subjectName: 'Toán',
      className: '10A1',
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('.xlsx');

    const sheet = await loadSheet(res.body as Buffer);
    // Khối thông tin + đầu bảng hai tầng theo cấu trúc đã kiểm chứng ở Bước 0.
    expect(sheet.getCell(1, 1).value).toBe('BẢNG ĐIỂM MÔN HỌC');
    const info = String(sheet.getCell(2, 1).value);
    expect(info).toContain('Lớp: 10A1');
    expect(info).toContain('Môn học: Toán');
    expect(info).toContain('Học kỳ: I');
    expect(info).toContain('Năm học: 2026-2027');
    expect(sheet.getCell(4, 2).value).toBe('Mã học sinh');
    expect(sheet.getCell(4, 4).value).toBe('Điểm đánh giá thường xuyên');
    expect(sheet.getCell(4, 6).value).toBe('Điểm đánh giá định kỳ');
    expect(sheet.getCell(5, 4).value).toBe('Kiểm tra miệng');
    expect(sheet.getCell(5, 5).value).toBe('Kiểm tra 15 phút');
    expect(sheet.getCell(5, 6).value).toBe('ĐĐGgk (hệ số 2)');
    expect(sheet.getCell(5, 7).value).toBe('ĐĐGck (hệ số 3)');
    expect(sheet.getCell(4, 8).value).toBe('Điểm trung bình môn học kỳ (ĐTBmhk)');
    expect(sheet.rowCount).toBe(7); // 5 dòng đầu + đúng 2 học sinh, không dòng thừa

    // Đối chiếu từng ô với điểm theo bài qua GET gradebook (đường đọc
    // độc lập): ô = finalGrade quy đổi thang 10 theo gradeMax của mục,
    // làm tròn 1 số thập phân.
    const maxByItemName = new Map([['Kiểm tra miệng', 10], ['Kiểm tra 15 phút', 100], ['Giữa kỳ', 10], ['Cuối kỳ', 10]]);
    const colByItemName = new Map([['Kiểm tra miệng', 4], ['Kiểm tra 15 phút', 5], ['Giữa kỳ', 6], ['Cuối kỳ', 7]]);
    for (const student of [s1, s2]) {
      const book = await getGradebook(app, admin, course.id, student.id);
      const gradeByItemName = new Map(book.activities.map((a) => [a.item.itemName, a.grade?.finalGrade ?? null]));
      const sheetRow = rowOfStudent(sheet, student.username);
      const converted: (number | null)[] = [];
      for (const [itemName, sheetCol] of colByItemName) {
        const raw = gradeByItemName.get(itemName) ?? null;
        const expected = raw === null ? null : round1((raw / maxByItemName.get(itemName)!) * 10);
        converted.push(expected);
        const cell = sheet.getCell(sheetRow, sheetCol).value ?? null;
        expect(cell, `${student.username} / ${itemName}`).toBe(expected);
      }
      // ĐTBmhk theo Điều 9 từ chính các ô thành phần; thiếu điểm thì trống.
      const [txA, txB, mid, fin] = converted as [number | null, number | null, number | null, number | null];
      const expectedAvg = txA === null || txB === null || mid === null || fin === null
        ? null
        : round1((txA + txB + 2 * mid + 3 * fin) / (2 + 5));
      expect(sheet.getCell(sheetRow, 8).value ?? null, `${student.username} / ĐTBmhk`).toBe(expectedAvg);
    }
    // Giá trị kỳ vọng tính tay cho s1: (8 + 7.5 + 2×7 + 3×9) / 7 = 56.5/7 → 8.1.
    expect(sheet.getCell(rowOfStudent(sheet, s1.username), 8).value).toBe(8.1);
  });

  it('học viên không có quyền grade:viewall bị 403', async () => {
    const { course, students } = await setupCourse(1);
    const [s1] = students as [{ id: string; username: string }];
    const tx = await createGradeItem(app, admin, course.id, { itemName: 'TX', gradeMax: 10 });
    const gk = await createGradeItem(app, admin, course.id, { itemName: 'GK', gradeMax: 10 });
    const ck = await createGradeItem(app, admin, course.id, { itemName: 'CK', gradeMax: 10 });
    const studentToken = (await login(app, s1.username, STRONG_PASSWORD)).accessToken;
    const res = await exportVneduJson(course.id, {
      regularItemIds: [tx.id], midtermItemId: gk.id, finalItemId: ck.id, semester: 1,
    }, studentToken);
    expect(res.status).toBe(403);
  });

  it('ánh xạ không hợp lệ bị 400: trùng mục giữa hai loại cột, mục của khoá khác, thiếu mục thường xuyên', async () => {
    const { course } = await setupCourse(0);
    const tx = await createGradeItem(app, admin, course.id, { itemName: 'TX', gradeMax: 10 });
    const gk = await createGradeItem(app, admin, course.id, { itemName: 'GK', gradeMax: 10 });
    const ck = await createGradeItem(app, admin, course.id, { itemName: 'CK', gradeMax: 10 });

    const duplicate = await exportVneduJson(course.id, {
      regularItemIds: [gk.id], midtermItemId: gk.id, finalItemId: ck.id, semester: 1,
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.code).toBe('grades.vnedu_duplicate_item');

    const other = await setupCourse(0);
    const foreignItem = await createGradeItem(app, admin, other.course.id, { itemName: 'Foreign', gradeMax: 10 });
    const foreign = await exportVneduJson(course.id, {
      regularItemIds: [tx.id], midtermItemId: foreignItem.id, finalItemId: ck.id, semester: 1,
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.code).toBe('grades.vnedu_item_not_in_course');

    const noRegular = await exportVneduJson(course.id, {
      regularItemIds: [], midtermItemId: gk.id, finalItemId: ck.id, semester: 1,
    });
    expect(noRegular.status).toBe(400);
  });

  it('nguồn xuất (issue #224): bài ở policy manual CHƯA công bố bị từ chối; công bố rồi thì xuất được', async () => {
    const { course, students } = await setupCourse(1);
    const [s1] = students as [{ id: string; username: string }];
    const tx = await createGradeItem(app, admin, course.id, { itemName: 'TX', gradeMax: 10 });
    const gk = await createGradeItem(app, admin, course.id, { itemName: 'GK', gradeMax: 10 });
    const ck = await createGradeItem(app, admin, course.id, { itemName: 'CK', gradeMax: 10 });
    await setGrade(app, admin, tx.id, s1.id, 8);
    await setGrade(app, admin, gk.id, s1.id, 7);
    await setGrade(app, admin, ck.id, s1.id, 9);

    // GK đặt policy manual và chưa công bố → cả lượt xuất bị từ chối.
    const policy = await http(app).put(`/api/v1/grade-items/${gk.id}/posting-policy`)
      .set('Authorization', `Bearer ${admin}`).send({ policy: 'manual' });
    expect(policy.status).toBe(200);
    const blocked = await exportVneduJson(course.id, {
      regularItemIds: [tx.id], midtermItemId: gk.id, finalItemId: ck.id, semester: 1,
    });
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe('grades.vnedu_item_not_published');

    // Công bố GK → xuất thành công.
    const pub = await http(app).post(`/api/v1/grade-items/${gk.id}/publish`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(pub.status).toBe(201);
    const ok = await exportVneduFile(course.id, {
      regularItemIds: [tx.id], midtermItemId: gk.id, finalItemId: ck.id, semester: 1,
    });
    expect(ok.status).toBe(200);
  });
});

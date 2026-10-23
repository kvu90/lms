import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from './course-enrolment-helpers';
import { createGradeItem, getGradebook, setGrade } from './assessment-helpers';
import { parseCsv } from '../src/modules/grades/domain/grade-csv';

/**
 * Gradebook export/import CSV + hàm công thức bổ sung (issue #24).
 * Oracle: MoodleDocs "Grade calculations" (if/power/round/mod/pi — xem
 * grade-formula.spec) và luồng grade export/import của Moodle (xuất theo
 * người học × mục điểm kèm điểm tổng; nhập khớp người học bằng định danh,
 * cột khớp mục điểm, lỗi theo dòng không chặn cả tệp).
 */
describe('Gradebook export/import CSV & new formula functions', () => {
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
    const students = [];
    for (let i = 0; i < studentCount; i += 1) {
      const student = await createUserViaApi(app, admin);
      await enrolUser(app, admin, course.id, instance.id, student.id);
      students.push(student);
    }
    return { course, students };
  }

  function importCsv(courseId: string, csv: string, token = admin) {
    return http(app).post(`/api/v1/courses/${courseId}/grades/import`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from(csv, 'utf-8'), { filename: 'grades.csv', contentType: 'text/csv' });
  }

  it('export: một dòng mỗi người học, một cột mỗi item (tổng khoá ở cuối), ô trống khi chưa có điểm; học viên không có quyền viewall bị 403', async () => {
    const { course, students } = await setupCourse();
    const [s1, s2] = students as { id: string; username: string }[];
    const quiz = await createGradeItem(app, admin, course.id, { itemName: 'Quiz', idNumber: 'quiz1', gradeMax: 100 });
    const essay = await createGradeItem(app, admin, course.id, { itemName: 'Essay', gradeMax: 50 });
    await setGrade(app, admin, quiz.id, s1.id, 85);
    await setGrade(app, admin, essay.id, s1.id, 40);

    const res = await http(app).get(`/api/v1/courses/${course.id}/grades/export`).set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');

    const table = parseCsv(res.text);
    expect(table[0]).toEqual(['userId', 'username', 'firstName', 'lastName', 'email', 'Quiz [quiz1]', 'Essay', 'Course total']);
    const rowOf = (username: string) => table.find((r) => r[1] === username)!;
    // s1: 85 + 40, tổng natural = 125/150; s2 chưa có điểm nào.
    expect(rowOf(s1.username).slice(5)).toEqual(['85', '40', '125']);
    expect(rowOf(s2.username).slice(5)).toEqual(['', '', '']);

    const studentToken = (await login(app, s1.username, STRONG_PASSWORD)).accessToken;
    const denied = await http(app).get(`/api/v1/courses/${course.id}/grades/export`).set('Authorization', `Bearer ${studentToken}`);
    expect(denied.status).toBe(403);
  });

  it('import: dòng đúng vào điểm qua đường nhập tay, ô trống bị bỏ qua, dòng lỗi (user lạ, điểm không phải số) được báo cáo mà không chặn tệp', async () => {
    const { course, students } = await setupCourse(3);
    const [s1, s2, s3] = students as { id: string; username: string }[];
    const quiz = await createGradeItem(app, admin, course.id, { itemName: 'Quiz', idNumber: 'quiz1', gradeMax: 100 });
    await createGradeItem(app, admin, course.id, { itemName: 'Essay', gradeMax: 50 });

    const csv = [
      'username,Quiz [quiz1],Essay,Course total,Unknown Col',
      `${s1.username},90,45,999,1`,
      `${s2.username},70,,999,1`,
      'ghostuser,10,10,999,1',
      `${s3.username},xyz,30,999,1`,
    ].join('\n');
    const res = await importCsv(course.id, csv);
    expect(res.status).toBe(201);
    expect(res.body.ignoredColumns).toEqual(['Course total', 'Unknown Col']);
    expect(res.body.imported).toBe(4); // s1 cả hai ô, s2 một ô, s3 một ô (Essay)
    expect(res.body.skipped).toBe(1); // ô Essay trống của s2
    expect(res.body.errors).toHaveLength(2);
    expect(res.body.errors).toContainEqual(expect.objectContaining({ row: 4, code: 'grades.import_user_not_found' }));
    expect(res.body.errors).toContainEqual(expect.objectContaining({ row: 5, column: 'Quiz [quiz1]', code: 'grades.import_not_a_number' }));

    const book1 = await getGradebook(app, admin, course.id, s1.id);
    const leaf = (uid: string, book: Awaited<ReturnType<typeof getGradebook>>, itemId: string) =>
      book.categories[0]?.items.find((i) => i.item.id === itemId)?.grade?.finalGrade;
    expect(leaf(s1.id, book1, quiz.id)).toBe(90);
    expect(book1.courseTotal?.grade?.finalGrade).toBe(135); // 90 + 45
    const book2 = await getGradebook(app, admin, course.id, s2.id);
    expect(leaf(s2.id, book2, quiz.id)).toBe(70);
    const book3 = await getGradebook(app, admin, course.id, s3.id);
    expect(book3.courseTotal?.grade?.finalGrade).toBe(30); // chỉ Essay vào được

    const studentToken = (await login(app, s1.username, STRONG_PASSWORD)).accessToken;
    const denied = await importCsv(course.id, csv, studentToken);
    expect(denied.status).toBe(403);
  });

  it('import: tôn trọng điểm đang overridden — ô đó thành lỗi grades.grade_overridden, điểm giữ nguyên', async () => {
    const { course, students } = await setupCourse(1);
    const [s1] = students as { id: string; username: string }[];
    const exam = await createGradeItem(app, admin, course.id, { itemName: 'Exam', gradeMax: 100 });
    const grade = await setGrade(app, admin, exam.id, s1.id, 40);
    const patched = await http(app).patch(`/api/v1/courses/grades/grades/${grade.id}`).set('Authorization', `Bearer ${admin}`)
      .send({ overridden: true, finalGrade: 88 });
    expect(patched.status).toBe(200);

    const res = await importCsv(course.id, `username,Exam\n${s1.username},55\n`);
    expect(res.status).toBe(201);
    expect(res.body.imported).toBe(0);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0]).toMatchObject({ row: 2, column: 'Exam', code: 'grades.grade_overridden' });

    const book = await getGradebook(app, admin, course.id, s1.id);
    expect(book.categories[0]?.items.find((i) => i.item.id === exam.id)?.grade?.finalGrade).toBe(88);
  });

  it('công thức mới chạy đầu-cuối: calculated item dùng power/if/round/mod được lưu và tính đúng; hàm lạ vẫn bị 400', async () => {
    const { course, students } = await setupCourse(1);
    const [s1] = students as { id: string; username: string }[];
    const base = await createGradeItem(app, admin, course.id, { itemName: 'Base', idNumber: 'base', gradeMax: 10 });
    const pow = await createGradeItem(app, admin, course.id, {
      itemName: 'Squared', itemType: 'calculated', idNumber: 'pow2', gradeMax: 1000, calculation: '=power([[base]],2)',
    });
    const verdict = await createGradeItem(app, admin, course.id, {
      itemName: 'Verdict', itemType: 'calculated', idNumber: 'verdict', gradeMax: 100,
      calculation: '=if([[base]]>=5, round([[base]]*10), mod([[base]],3))',
    });
    await setGrade(app, admin, base.id, s1.id, 7);
    const book = await getGradebook(app, admin, course.id, s1.id);
    const finalOf = (itemId: string) => book.categories[0]?.items.find((i) => i.item.id === itemId)?.grade?.finalGrade;
    expect(finalOf(pow.id)).toBe(49); // 7^2
    expect(finalOf(verdict.id)).toBe(70); // 7 >= 5 → round(70)

    // Nhánh sai của if: base = 4 → mod(4, 3) = 1.
    await setGrade(app, admin, base.id, s1.id, 4);
    const book2 = await getGradebook(app, admin, course.id, s1.id);
    expect(book2.categories[0]?.items.find((i) => i.item.id === verdict.id)?.grade?.finalGrade).toBe(1);
    expect(book2.categories[0]?.items.find((i) => i.item.id === pow.id)?.grade?.finalGrade).toBe(16);

    const bad = await http(app).post(`/api/v1/courses/${course.id}/grades/items`).set('Authorization', `Bearer ${admin}`)
      .send({ itemName: 'Bad', itemType: 'calculated', calculation: '=foo([[base]])' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('grades.calculation_unknown_function');
  });
});

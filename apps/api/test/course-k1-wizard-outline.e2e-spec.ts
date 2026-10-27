import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD, uniqueName } from './identity-access-helpers';
import { createCategory, createCm, createCourse, createEnrolInstance, createSection, enrolUser, getFirstSectionId } from './course-enrolment-helpers';
import { addExamSlot, createExamDraft, createReadyQuestion, pinExam } from './exam-pin-helpers';

/**
 * K1 (issue #68): wizard tạo khoá — nhân bản khoá theo bảng Re-run,
 * dùng lại nội dung từ khoá khác, Builder Outline (đổi thứ tự, nhân
 * bản tại dòng), khoá mẫu tổ/trường và gác ngày mở `open_at`.
 * Oracle nghiệp vụ: bảng sao chép Re-run trong thân issue #68 (có cấu
 * trúc/nội dung/cài đặt/chính sách điểm — KHÔNG người học/bài làm/tiến
 * độ; bản sao nháp; hạn lùi theo mốc mới).
 */
describe('K1: nhân bản khoá, outline, mẫu và ngày mở', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => { app = await createTestApp(); admin = await adminToken(app); });
  afterAll(async () => { await app.close(); });

  async function contentOf(courseId: string, token: string) {
    const res = await http(app).get(`/api/v1/courses/${courseId}/content`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body;
  }

  it('nhân bản khoá: chép cấu trúc + quiz + chính sách điểm, lùi hạn theo mốc mới, không chép người học, bản sao là nháp', async () => {
    const cat = await createCategory(app, admin);
    const source = await createCourse(app, admin, cat.id, { startDate: '2026-03-02', endDate: '2026-05-30' });
    const s0 = await getFirstSectionId(app, admin, source.id);
    const s1 = await createSection(app, admin, source.id, { name: 'Tuần 1' });
    const page = await createCm(app, admin, source.id, s1.id, { component: 'mod_page', name: 'Trang mở đầu' });
    // Hạn mở của module: 2026-03-10 → kỳ vọng lùi đúng delta của ngày bắt đầu mới.
    await http(app).patch(`/api/v1/courses/${source.id}/modules/${page.id}`).set('Authorization', `Bearer ${admin}`)
      .send({ openAt: '2026-03-10T00:00:00.000Z' }).expect(200);
    const kQuestion = await createReadyQuestion(app, admin, 'Câu tuần 1');
    const kDraft = await createExamDraft(app, admin, 'Kiểm tra tuần 1', 10);
    await addExamSlot(app, admin, kDraft, { questionId: kQuestion });
    const sourceQuiz = await pinExam(app, admin, source.id, kDraft, {
      sectionId: s1.id, timeOpen: '2026-03-12T00:00:00.000Z', timeClose: '2026-03-13T00:00:00.000Z',
    });
    // Chính sách điểm: một item thủ công trong sổ điểm của khoá nguồn.
    const itemRes = await http(app).post(`/api/v1/courses/${source.id}/grade-items`).set('Authorization', `Bearer ${admin}`)
      .send({ itemName: 'Bài tập về nhà', itemType: 'manual', gradeMax: 20 });
    expect(itemRes.status).toBe(201);
    // Tiêu chí hoàn thành theo ngày của khoá nguồn — mốc này cũng phải lùi theo delta.
    const criteriaRes = await http(app).put(`/api/v1/courses/${source.id}/completion/criteria`).set('Authorization', `Bearer ${admin}`)
      .send({ method: 1, criteria: [{ criteriaType: 'date', date: '2026-04-15' }] });
    expect(criteriaRes.status).toBe(200);
    // Người học trong khoá nguồn — bản sao KHÔNG được chứa.
    const student = await createUserViaApi(app, admin);
    const instance = await createEnrolInstance(app, admin, source.id);
    await enrolUser(app, admin, source.id, instance.id, student.id);

    const newShort = uniqueName('copy');
    const dupRes = await http(app).post(`/api/v1/courses/${source.id}/copy`).set('Authorization', `Bearer ${admin}`)
      .send({ fullName: 'Bản sao khoá', shortName: newShort, startDate: '2026-09-07' });
    expect(dupRes.status).toBe(201);
    const copy = dupRes.body;
    expect(copy.shortName).toBe(newShort);
    expect(copy.visible).toBe(false); // bản sao luôn là nháp
    expect(copy.isTemplate).toBe(false);
    // Delta: 2026-03-02 → 2026-09-07 = +189 ngày; hạn kết thúc 2026-05-30 → 2026-12-05.
    expect(String(copy.startDate).slice(0, 10)).toBe('2026-09-07');
    expect(String(copy.endDate).slice(0, 10)).toBe('2026-12-05');

    const content = await contentOf(copy.id, admin);
    expect(content.sections).toHaveLength(2);
    const copiedS1 = content.sections.find((s: { name: string | null }) => s.name === 'Tuần 1');
    expect(copiedS1).toBeTruthy();
    expect(copiedS1.modules).toHaveLength(2);
    const copiedPage = copiedS1.modules.find((m: { component: string }) => m.component === 'mod_page');
    expect(String(copiedPage.openAt).slice(0, 10)).toBe('2026-09-15'); // 2026-03-10 + 189 ngày
    const copiedQuizCm = copiedS1.modules.find((m: { component: string }) => m.component === 'mod_quiz');
    expect(copiedQuizCm.instanceId).toBeTruthy();
    expect(copiedQuizCm.instanceId).not.toBe(sourceQuiz.id); // instance quiz mới, không dùng chung
    const quizzesRes = await http(app).get(`/api/v1/courses/${copy.id}/exam-pins`).set('Authorization', `Bearer ${admin}`);
    expect(quizzesRes.body).toHaveLength(1);
    expect(String(quizzesRes.body[0].timeOpen).slice(0, 10)).toBe('2026-09-17'); // 2026-03-12 + 189 ngày
    expect(String(quizzesRes.body[0].timeClose).slice(0, 10)).toBe('2026-09-18');

    // Chính sách điểm được chép (item thủ công + item của quiz), điểm thì không.
    const itemsRes = await http(app).get(`/api/v1/courses/${copy.id}/grade-items`).set('Authorization', `Bearer ${admin}`);
    const names = itemsRes.body.map((i: { itemName: string }) => i.itemName);
    expect(names).toContain('Bài tập về nhà');

    // Không người học trong bản sao.
    const enrolRes = await http(app).get(`/api/v1/courses/${copy.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect(enrolRes.status).toBe(200);
    expect(enrolRes.body).toHaveLength(0);
    // Ngày của tiêu chí hoàn thành lùi đúng delta: 2026-04-15 + 189 ngày = 2026-10-21.
    const copyCriteria = await http(app).get(`/api/v1/courses/${copy.id}/completion/criteria`).set('Authorization', `Bearer ${admin}`);
    expect(copyCriteria.status).toBe(200);
    const dateCriterion = copyCriteria.body.criteria.find((c: { criteriaType: string }) => c.criteriaType === 'date');
    expect(String(dateCriterion.date).slice(0, 10)).toBe('2026-10-21');
    void s0;
  });

  it('đổi thứ tự section/module có hiệu lực ngay và từ chối danh sách thiếu mục', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const s1 = await createSection(app, admin, course.id, { name: 'Phần A' });
    const s2 = await createSection(app, admin, course.id, { name: 'Phần B' });
    const content0 = await contentOf(course.id, admin);
    const s0 = content0.sections[0];
    const reorder = await http(app).post(`/api/v1/courses/${course.id}/reorder-sections`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionIds: [s2.id, s1.id, s0.id] });
    expect(reorder.status).toBe(201);
    const after = await contentOf(course.id, admin);
    expect(after.sections.map((s: { name: string | null }) => s.name)).toEqual(['Phần B', 'Phần A', null]);
    const bad = await http(app).post(`/api/v1/courses/${course.id}/reorder-sections`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionIds: [s1.id] });
    expect(bad.status).toBe(400);

    const m1 = await createCm(app, admin, course.id, s2.id, { name: 'M1' });
    const m2 = await createCm(app, admin, course.id, s2.id, { name: 'M2' });
    const m3 = await createCm(app, admin, course.id, s2.id, { name: 'M3' });
    const rm = await http(app).post(`/api/v1/courses/${course.id}/sections/${s2.id}/reorder-modules`).set('Authorization', `Bearer ${admin}`)
      .send({ moduleIds: [m3.id, m1.id, m2.id] });
    expect(rm.status).toBe(201);
    const afterM = await contentOf(course.id, admin);
    const secB = afterM.sections.find((s: { id: string }) => s.id === s2.id);
    expect(secB.modules.map((m: { name: string }) => m.name)).toEqual(['M3', 'M1', 'M2']);
  });

  it('nhân bản section và module ngay tại dòng', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const s1 = await createSection(app, admin, course.id, { name: 'Gốc' });
    await createCm(app, admin, course.id, s1.id, { name: 'Mục 1' });
    const m2 = await createCm(app, admin, course.id, s1.id, { name: 'Mục 2' });
    const dupSection = await http(app).post(`/api/v1/courses/${course.id}/sections/${s1.id}/copy`).set('Authorization', `Bearer ${admin}`).send({});
    expect(dupSection.status).toBe(201);
    expect(dupSection.body.section).toBe(s1.section + 1);
    let content = await contentOf(course.id, admin);
    const sectionsWith2 = content.sections.filter((s: { modules: unknown[] }) => s.modules.length === 2);
    expect(sectionsWith2).toHaveLength(2);

    // Item điểm 'mod' của module có idNumber: nhân bản trong CÙNG khoá
    // không được vi phạm unique (courseId, idNumber) của grade_items.
    const modItem = await http(app).post(`/api/v1/courses/${course.id}/grade-items`).set('Authorization', `Bearer ${admin}`)
      .send({ itemName: 'Điểm mục 2', itemType: 'mod', cmId: m2.id, idNumber: 'MUC-2', gradeMax: 10 });
    expect(modItem.status).toBe(201);
    const dupCm = await http(app).post(`/api/v1/courses/${course.id}/modules/${m2.id}/copy`).set('Authorization', `Bearer ${admin}`).send({});
    expect(dupCm.status).toBe(201);
    content = await contentOf(course.id, admin);
    const original = content.sections.find((s: { id: string }) => s.id === s1.id);
    expect(original.modules.map((m: { name: string }) => m.name)).toEqual(['Mục 1', 'Mục 2', 'Mục 2']);
  });

  it('dùng lại từ khoá khác: chép section nguyên vẹn và module lẻ gom theo section nguồn', async () => {
    const cat = await createCategory(app, admin);
    const source = await createCourse(app, admin, cat.id);
    const sA = await createSection(app, admin, source.id, { name: 'Kho dùng lại' });
    await createCm(app, admin, source.id, sA.id, { name: 'Dùng lại 1' });
    await createCm(app, admin, source.id, sA.id, { name: 'Dùng lại 2' });
    const sB = await createSection(app, admin, source.id, { name: 'Nguồn lẻ' });
    const loose = await createCm(app, admin, source.id, sB.id, { name: 'Mục lẻ' });
    const target = await createCourse(app, admin, cat.id);
    const res = await http(app).post(`/api/v1/courses/${target.id}/import-content`).set('Authorization', `Bearer ${admin}`)
      .send({ sourceCourseId: source.id, sectionIds: [sA.id], moduleIds: [loose.id] });
    expect(res.status).toBe(201);
    const content = await contentOf(target.id, admin);
    const names = content.sections.map((s: { name: string | null }) => s.name);
    expect(names).toContain('Kho dùng lại');
    expect(names).toContain('Nguồn lẻ');
    const reused = content.sections.find((s: { name: string | null }) => s.name === 'Kho dùng lại');
    expect(reused.modules).toHaveLength(2);
    const looseSection = content.sections.find((s: { name: string | null }) => s.name === 'Nguồn lẻ');
    expect(looseSection.modules.map((m: { name: string }) => m.name)).toEqual(['Mục lẻ']);
  });

  it('ngày mở theo lịch: học viên chưa thấy section/module tới ngày mở, giáo viên thấy kèm trạng thái scheduled', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const s1 = await createSection(app, admin, course.id, { name: 'Chưa mở', openAt: future });
    const cm = await createCm(app, admin, course.id, s1.id, { name: 'Bài chưa mở' });
    const student = await createUserViaApi(app, admin);
    const instance = await createEnrolInstance(app, admin, course.id);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const studentLogin = await login(app, student.username, STRONG_PASSWORD);

    const teacherView = await contentOf(course.id, admin);
    const scheduled = teacherView.sections.find((s: { id: string }) => s.id === s1.id);
    expect(scheduled.status).toBe('scheduled');
    expect(scheduled.modules[0].status).toBe('open'); // module không đặt lịch riêng thì vẫn "open" theo chính nó

    const studentView = await contentOf(course.id, studentLogin.accessToken);
    expect(studentView.sections.find((s: { id: string }) => s.id === s1.id)).toBeUndefined();
    const access = await http(app).get(`/api/v1/courses/${course.id}/modules/${cm.id}/access`).set('Authorization', `Bearer ${studentLogin.accessToken}`);
    expect(access.status).toBe(403);
  });

  it('khoá mẫu: ẩn khỏi danh sách thường, hiện ở danh sách mẫu cho người có quyền tạo khoá, nhân bản từ mẫu ra khoá thật', async () => {
    const cat = await createCategory(app, admin);
    const template = await createCourse(app, admin, cat.id, { fullName: 'Mẫu tổ Toán' });
    await http(app).patch(`/api/v1/courses/${template.id}`).set('Authorization', `Bearer ${admin}`)
      .send({ isTemplate: true }).expect(200);
    const list = await http(app).get('/api/v1/courses').set('Authorization', `Bearer ${admin}`);
    expect(list.body.some((c: { id: string }) => c.id === template.id)).toBe(false);
    const templates = await http(app).get('/api/v1/courses/templates').set('Authorization', `Bearer ${admin}`);
    expect(templates.body.some((c: { id: string }) => c.id === template.id)).toBe(true);
    const plain = await createUserViaApi(app, admin);
    const plainLogin = await login(app, plain.username, STRONG_PASSWORD);
    const plainTemplates = await http(app).get('/api/v1/courses/templates').set('Authorization', `Bearer ${plainLogin.accessToken}`);
    expect(plainTemplates.body).toHaveLength(0);
    const dup = await http(app).post(`/api/v1/courses/${template.id}/copy`).set('Authorization', `Bearer ${admin}`)
      .send({ fullName: 'Khoá từ mẫu', shortName: uniqueName('fromtpl') });
    expect(dup.status).toBe(201);
    expect(dup.body.isTemplate).toBe(false);
  });

  it('người dùng thường không nhân bản được khoá', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const plain = await createUserViaApi(app, admin);
    const plainLogin = await login(app, plain.username, STRONG_PASSWORD);
    const res = await http(app).post(`/api/v1/courses/${course.id}/copy`).set('Authorization', `Bearer ${plainLogin.accessToken}`)
      .send({ fullName: 'Cấm', shortName: uniqueName('denied') });
    expect(res.status).toBe(403);
  });
});

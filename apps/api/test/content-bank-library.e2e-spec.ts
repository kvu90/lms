import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId, uniqueName,
} from './identity-access-helpers';
import { createCategory, createCourse, getFirstSectionId } from './course-enrolment-helpers';

/**
 * Issue #69 (CB-1) — Kho học liệu tổ/trường trên khung Content Bank.
 *
 * Vòng đời được kiểm chứng tận API:
 * - học liệu scope tổ (cohort) bắt đầu ở draft, đồng nghiệp trong tổ
 *   KHÔNG thấy khi draft lẫn khi chờ duyệt; chỉ tác giả + người duyệt
 *   (tổ trưởng: contentbank:reviewcontent + cohort:manage tại context
 *   của tổ) thấy;
 * - gửi duyệt bắt metadata chương trình đủ (môn–khối–node + file) +
 *   metadata sư phạm (mô tả–từ khoá–đối tượng–vị trí trong bài, CB1-B3);
 *   scope trường bắt thêm trường bản quyền/nguồn gốc (CB1-B1): chưa đủ
 *   bản quyền thì chưa mở được scope trường;
 * - loại học liệu là 5 nhóm Điều 7 TT 09/2021 (CB1-B2) + cấp học độc
 *   lập; duyệt theo checklist tiêu chí Bộ, từ chối bắt buộc có lý do
 *   (CB1-B3); học liệu dẫn xuất giữ derived_from về học liệu gốc;
 * - duyệt xong học liệu mới hiện với thành viên tổ và cắm được vào khoá
 *   của đồng nghiệp bằng BẢN SAO file (module mod_resource + file riêng
 *   trong context của module; sửa bản gốc sau đó không đổi bản đã cắm);
 * - sửa học liệu đã duyệt → quay về draft, biến mất khỏi danh sách của
 *   đồng nghiệp;
 * - scope trường tương tự (duyệt bởi người có reviewcontent ở hệ thống);
 * - học liệu kiểu bộ câu hỏi chỉ THAM CHIẾU category của ngân hàng câu
 *   hỏi — cắm vào khoá bị từ chối;
 * - người không có vai trò (học sinh) không tạo được học liệu, không
 *   xem được học liệu chưa duyệt.
 *
 * Bổ sung theo phân xử điểm mở probe v86 (issue #69 mở lại): giáo viên
 * CHỈ có vai tại context khoá tạo được học liệu trong kho cá nhân của
 * mình theo đường mặc định của UI (không contextId); học liệu trường
 * approved+public mở cho mọi người dùng đã đăng nhập (kể cả học sinh
 * chỉ có vai ở khoá) — trạng thái draft/pending vẫn gác chặt.
 */
describe('Content bank library (CB-1, issue #69)', () => {
  let app: INestApplication;
  let admin: string;
  let sysCtx: string;
  let subjectId: string;
  let nodeId: string;
  let cohortId: string;
  let categoryId: string;

  let authorToken: string;
  let colleagueToken: string;
  let leadToken: string;
  let outsiderToken: string;
  let studentToken: string;
  let colleagueId: string;
  let courseId: string;
  let sectionId: string;
  // Chữ ký probe live v86 (điểm mở quyền CB-1): giáo viên/học sinh CHỈ
  // có vai tại context khoá, không có gán vai nào ở hệ thống.
  let courseTeacherToken: string;
  let courseStudentToken: string;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const fileBody = { fileName: 'phieu-bai-tap.pdf', contentBase64: Buffer.from('cb1-file-content').toString('base64'), mimeType: 'application/pdf' };

  async function makeTeacher(member: boolean): Promise<{ id: string; token: string }> {
    const user = await createUserViaApi(app, admin);
    await assignRole(app, admin, user.id, await roleIdByShortname(app, admin, 'editingteacher'), sysCtx);
    if (member) {
      const res = await http(app).post(`/api/v1/cohorts/${cohortId}/members`).set(bearer(admin)).send({ userId: user.id });
      expect(res.status).toBe(201);
    }
    const token = (await login(app, user.username, STRONG_PASSWORD)).accessToken;
    return { id: user.id, token };
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    sysCtx = await systemContextId(app, admin);

    // Metadata chương trình tối thiểu (admin dựng): môn → chương trình khối 10 → node.
    const subject = await http(app).post('/api/v1/curriculum/subjects').set(bearer(admin))
      .send({ contextId: sysCtx, name: 'Toán CB1', slug: uniqueName('toan-cb1') });
    expect(subject.status).toBe(201);
    subjectId = subject.body.id as string;
    const curriculum = await http(app).post('/api/v1/curriculum/curricula').set(bearer(admin))
      .send({ subjectId, grade: 10 });
    expect(curriculum.status).toBe(201);
    const node = await http(app).post('/api/v1/curriculum/nodes').set(bearer(admin))
      .send({ curriculumId: curriculum.body.id, title: 'Hàm số', kind: 'topic', position: 1 });
    expect(node.status).toBe(201);
    nodeId = node.body.id as string;

    // Tổ chuyên môn = cohort.
    const cohort = await http(app).post('/api/v1/cohorts').set(bearer(admin)).send({ name: uniqueName('To Toan CB1') });
    expect(cohort.status).toBe(201);
    cohortId = cohort.body.id as string;
    const cohortCtx = cohort.body.contextId as string;

    // Category ngân hàng câu hỏi để tham chiếu (bộ câu hỏi không chứa câu hỏi).
    const category = await http(app).post('/api/v1/questions/categories').set(bearer(admin))
      .send({ contextId: sysCtx, name: uniqueName('CB1 category') });
    expect(category.status).toBe(201);
    categoryId = category.body.id as string;

    const author = await makeTeacher(true);
    authorToken = author.token;
    const colleague = await makeTeacher(true);
    colleagueToken = colleague.token;
    colleagueId = colleague.id;
    // Tổ trưởng: thành viên tổ + vai manager tại CONTEXT CỦA TỔ (đó là
    // dấu hiệu phân biệt người duyệt với giáo viên thường của tổ).
    const lead = await createUserViaApi(app, admin);
    await assignRole(app, admin, lead.id, await roleIdByShortname(app, admin, 'manager'), cohortCtx);
    const addLead = await http(app).post(`/api/v1/cohorts/${cohortId}/members`).set(bearer(admin)).send({ userId: lead.id });
    expect(addLead.status).toBe(201);
    leadToken = (await login(app, lead.username, STRONG_PASSWORD)).accessToken;
    outsiderToken = (await makeTeacher(false)).token;

    const student = await createUserViaApi(app, admin);
    await assignRole(app, admin, student.id, await roleIdByShortname(app, admin, 'student'), sysCtx);
    studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;

    // Khoá của đồng nghiệp để cắm học liệu: gán editingteacher tại context khoá.
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    courseId = course.id;
    sectionId = await getFirstSectionId(app, admin, courseId);
    const contexts = await http(app).get('/api/v1/access/contexts').set(bearer(admin));
    const courseCtx = (contexts.body as { id: string; contextLevel: number; instanceId: string }[])
      .find((c) => c.contextLevel === 50 && c.instanceId === courseId);
    expect(courseCtx).toBeDefined();
    await assignRole(app, admin, colleagueId, await roleIdByShortname(app, admin, 'editingteacher'), courseCtx!.id);

    // Giáo viên + học sinh chỉ có vai tại context khoá này (đúng mô
    // hình gán vai của seed/đời thật khiến probe v86 lộ hai lỗi quyền).
    const courseTeacher = await createUserViaApi(app, admin);
    await assignRole(app, admin, courseTeacher.id, await roleIdByShortname(app, admin, 'editingteacher'), courseCtx!.id);
    courseTeacherToken = (await login(app, courseTeacher.username, STRONG_PASSWORD)).accessToken;
    const courseStudent = await createUserViaApi(app, admin);
    await assignRole(app, admin, courseStudent.id, await roleIdByShortname(app, admin, 'student'), courseCtx!.id);
    courseStudentToken = (await login(app, courseStudent.username, STRONG_PASSWORD)).accessToken;
  }, 180_000);
  afterAll(async () => { await app.close(); });

  const fullChecklist = { contentAccurate: true, sourceClear: true, pedagogyAesthetics: true, mobileReady: true };
  /** Metadata sư phạm bắt buộc khi gửi duyệt scope tổ/trường (CB1-B3). */
  const pedagogicalMeta = {
    description: 'Phiếu bài tập luyện tập hàm số bậc nhất',
    keywords: ['hàm số', 'luyện tập'],
    targetAudience: 'students',
    lessonPosition: 'practice',
  };

  async function createOrgItem(token: string, withMetadata = true): Promise<{ id: string }> {
    const res = await http(app).post('/api/v1/contentbank').set(bearer(token)).send({
      name: uniqueName('Phieu bai tap'),
      resourceType: 'question_set',
      scope: 'org',
      spaceId: cohortId,
      ...(withMetadata ? { subjectId, grade: 10, level: 'upper_secondary', curriculumNodeId: nodeId, ...pedagogicalMeta } : {}),
    });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  }

  async function listIds(token: string, query: string): Promise<string[]> {
    const res = await http(app).get(`/api/v1/contentbank?${query}`).set(bearer(token));
    expect(res.status).toBe(200);
    return (res.body as { id: string }[]).map((r) => r.id);
  }

  it('org lifecycle: draft and pending stay hidden from colleagues, approved becomes visible and insertable as a copy', async () => {
    const item = await createOrgItem(authorToken);
    const created = await http(app).get(`/api/v1/contentbank/${item.id}`).set(bearer(authorToken));
    expect(created.body.reviewStatus).toBe('draft');
    expect(created.body.visibility).toBe('draft');
    expect(created.body.scope).toBe('org');

    const up = await http(app).post(`/api/v1/contentbank/${item.id}/file`).set(bearer(authorToken)).send(fileBody);
    expect(up.status).toBe(201);
    expect(up.body.fileId).toBeTruthy();
    // Metadata kỹ thuật tự sinh từ file (CB1-B2).
    expect(up.body.techFormat).toBe('pdf');
    expect(up.body.sizeBytes).toBe(Buffer.byteLength('cb1-file-content'));

    // Draft: đồng nghiệp cùng tổ không thấy, người ngoài tổ cũng không.
    expect(await listIds(colleagueToken, `scope=org&spaceId=${cohortId}`)).not.toContain(item.id);
    const deniedDraft = await http(app).get(`/api/v1/contentbank/${item.id}`).set(bearer(outsiderToken));
    expect(deniedDraft.status).toBe(403);

    const submit = await http(app).post(`/api/v1/contentbank/${item.id}/submit`).set(bearer(authorToken)).send({});
    expect(submit.status).toBe(201);
    expect(submit.body.reviewStatus).toBe('pending');

    // Chờ duyệt: đồng nghiệp vẫn không thấy; tổ trưởng (người duyệt) thấy.
    expect(await listIds(colleagueToken, `scope=org&spaceId=${cohortId}`)).not.toContain(item.id);
    expect(await listIds(leadToken, `scope=org&spaceId=${cohortId}`)).toContain(item.id);

    // Đồng nghiệp thường không tự duyệt được.
    const selfReview = await http(app).post(`/api/v1/contentbank/${item.id}/review`).set(bearer(colleagueToken)).send({ decision: 'approved' });
    expect(selfReview.status).toBe(403);

    const review = await http(app).post(`/api/v1/contentbank/${item.id}/review`).set(bearer(leadToken)).send({ decision: 'approved', note: 'Đạt', checklist: fullChecklist });
    expect(review.status).toBe(201);
    expect(review.body.reviewStatus).toBe('approved');
    expect(review.body.visibility).toBe('public');
    expect(review.body.reviewChecklist).toEqual(fullChecklist);

    // Đã duyệt: đồng nghiệp thấy và xem được.
    expect(await listIds(colleagueToken, `scope=org&spaceId=${cohortId}`)).toContain(item.id);
    const view = await http(app).get(`/api/v1/contentbank/${item.id}`).set(bearer(colleagueToken));
    expect(view.status).toBe(200);

    // "Thêm từ kho": cắm vào khoá của đồng nghiệp bằng bản sao file.
    const insert = await http(app).post(`/api/v1/contentbank/${item.id}/insert`).set(bearer(colleagueToken))
      .send({ courseId, sectionId });
    expect(insert.status).toBe(201);
    expect(insert.body.cmId).toBeTruthy();
    expect(insert.body.fileId).toBeTruthy();
    expect(insert.body.fileId).not.toBe(up.body.fileId);

    const copied = await http(app).get(`/api/v1/files/${insert.body.fileId}`).set(bearer(colleagueToken));
    expect(copied.status).toBe(200);
    expect(copied.body.fileName).toBe('phieu-bai-tap.pdf');

    const content = await http(app).get(`/api/v1/courses/${courseId}/content`).set(bearer(colleagueToken));
    const modules = (content.body.sections as { modules: { id: string; component: string; name: string }[] }[])
      .flatMap((s) => s.modules);
    const cm = modules.find((m) => m.id === insert.body.cmId);
    expect(cm?.component).toBe('mod_resource');

    // Sửa bản gốc sau khi cắm: bản trong khoá giữ nguyên tên; bản gốc quay về draft và biến mất với đồng nghiệp.
    const rename = await http(app).patch(`/api/v1/contentbank/${item.id}`).set(bearer(authorToken)).send({ name: 'Tên mới sau duyệt' });
    expect(rename.status).toBe(200);
    expect(rename.body.reviewStatus).toBe('draft');
    expect(await listIds(colleagueToken, `scope=org&spaceId=${cohortId}`)).not.toContain(item.id);
    const content2 = await http(app).get(`/api/v1/courses/${courseId}/content`).set(bearer(colleagueToken));
    const modules2 = (content2.body.sections as { modules: { id: string; name: string }[] }[]).flatMap((s) => s.modules);
    expect(modules2.find((m) => m.id === insert.body.cmId)?.name).toBe(cm?.name);
  });

  it('submit requires complete program metadata', async () => {
    const item = await createOrgItem(authorToken, false);
    const submit = await http(app).post(`/api/v1/contentbank/${item.id}/submit`).set(bearer(authorToken)).send({});
    expect(submit.status).toBe(400);
    expect(submit.body.code).toBe('contentbank.metadata_incomplete');
  });

  it('rejected items carry the note and can be resubmitted', async () => {
    const item = await createOrgItem(authorToken);
    await http(app).post(`/api/v1/contentbank/${item.id}/file`).set(bearer(authorToken)).send(fileBody);
    await http(app).post(`/api/v1/contentbank/${item.id}/submit`).set(bearer(authorToken)).send({});
    const reject = await http(app).post(`/api/v1/contentbank/${item.id}/review`).set(bearer(leadToken))
      .send({ decision: 'rejected', note: 'Thiếu đáp án' });
    expect(reject.status).toBe(201);
    expect(reject.body.reviewStatus).toBe('rejected');
    expect(reject.body.reviewNote).toBe('Thiếu đáp án');
    const resubmit = await http(app).post(`/api/v1/contentbank/${item.id}/submit`).set(bearer(authorToken)).send({});
    expect(resubmit.status).toBe(201);
    expect(resubmit.body.reviewStatus).toBe('pending');
  });

  it('school scope: hidden while pending for students, visible school-wide after approval', async () => {
    const created = await http(app).post('/api/v1/contentbank').set(bearer(authorToken)).send({
      name: uniqueName('Tai lieu truong'), resourceType: 'multimedia_lecture', scope: 'school',
      subjectId, grade: 10, level: 'upper_secondary', curriculumNodeId: nodeId, ...pedagogicalMeta,
      originalAuthor: 'Nguyễn Văn A', sourceKind: 'self', license: 'Chỉ dùng nội bộ trường',
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    await http(app).post(`/api/v1/contentbank/${id}/file`).set(bearer(authorToken)).send(fileBody);
    await http(app).post(`/api/v1/contentbank/${id}/submit`).set(bearer(authorToken)).send({});

    expect(await listIds(studentToken, 'scope=school')).not.toContain(id);
    const denied = await http(app).get(`/api/v1/contentbank/${id}`).set(bearer(studentToken));
    expect(denied.status).toBe(403);

    // Admin duyệt thay mặt cấp trường.
    const review = await http(app).post(`/api/v1/contentbank/${id}/review`).set(bearer(admin)).send({ decision: 'approved', checklist: fullChecklist });
    expect(review.status).toBe(201);
    expect(await listIds(studentToken, 'scope=school')).toContain(id);
  });

  it('school scope cannot be submitted without complete copyright fields (CB1-B1)', async () => {
    const created = await http(app).post('/api/v1/contentbank').set(bearer(authorToken)).send({
      name: uniqueName('Tai lieu thieu ban quyen'), resourceType: 'multimedia_lecture', scope: 'school',
      subjectId, grade: 10, curriculumNodeId: nodeId, ...pedagogicalMeta,
      // Có tác giả gốc nhưng thiếu nguồn gốc + giấy phép; nguồn trích dẫn
      // mà không ghi nguồn cụ thể cũng bị chặn.
      originalAuthor: 'Sưu tầm', sourceKind: 'cited',
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    await http(app).post(`/api/v1/contentbank/${id}/file`).set(bearer(authorToken)).send(fileBody);
    const submit = await http(app).post(`/api/v1/contentbank/${id}/submit`).set(bearer(authorToken)).send({});
    expect(submit.status).toBe(400);
    expect(submit.body.code).toBe('contentbank.metadata_incomplete');
    const detail = String(submit.body.detail ?? submit.body.message ?? '');
    expect(detail).toContain('license');
    expect(detail).toContain('sourceCitation');
  });

  it('review gates: rejection needs a reason, approval needs the full checklist (CB1-B3)', async () => {
    const item = await createOrgItem(authorToken);
    await http(app).post(`/api/v1/contentbank/${item.id}/file`).set(bearer(authorToken)).send(fileBody);
    await http(app).post(`/api/v1/contentbank/${item.id}/submit`).set(bearer(authorToken)).send({});

    const rejectNoNote = await http(app).post(`/api/v1/contentbank/${item.id}/review`).set(bearer(leadToken))
      .send({ decision: 'rejected' });
    expect(rejectNoNote.status).toBe(400);
    expect(rejectNoNote.body.code).toBe('contentbank.review_note_required');

    const approveNoChecklist = await http(app).post(`/api/v1/contentbank/${item.id}/review`).set(bearer(leadToken))
      .send({ decision: 'approved', note: 'Đạt' });
    expect(approveNoChecklist.status).toBe(400);
    expect(approveNoChecklist.body.code).toBe('contentbank.review_checklist_incomplete');

    const partial = await http(app).post(`/api/v1/contentbank/${item.id}/review`).set(bearer(leadToken))
      .send({ decision: 'approved', checklist: { ...fullChecklist, mobileReady: false } });
    expect(partial.status).toBe(400);
  });

  it('derived items keep the derived_from trace to the source item (CB1-B1)', async () => {
    const source = await http(app).post('/api/v1/contentbank').set(bearer(authorToken)).send({
      name: uniqueName('Hoc lieu goc'), resourceType: 'reference', scope: 'personal',
      originalAuthor: 'Trần Thị B', sourceKind: 'self', license: 'Chỉ dùng nội bộ trường',
    });
    expect(source.status).toBe(201);
    const derived = await http(app).post('/api/v1/contentbank').set(bearer(authorToken)).send({
      name: uniqueName('Hoc lieu dan xuat'), resourceType: 'reference', scope: 'personal',
      originalAuthor: 'Trần Thị B', sourceKind: 'derived', derivedFromId: source.body.id,
      sourceCitation: 'Dẫn xuất từ học liệu gốc trong kho', license: 'Chỉ dùng nội bộ trường',
    });
    expect(derived.status).toBe(201);
    expect(derived.body.derivedFromId).toBe(source.body.id);
    expect(derived.body.sourceKind).toBe('derived');

    const bogus = await http(app).post('/api/v1/contentbank').set(bearer(authorToken)).send({
      name: uniqueName('Dan xuat ao'), resourceType: 'reference', scope: 'personal',
      sourceKind: 'derived', derivedFromId: '01900000-0000-7000-8000-000000000099',
    });
    expect(bogus.status).toBe(400);
    expect(bogus.body.code).toBe('contentbank.derived_from_not_found');
  });

  it('derived_from cannot point to itself or form a cycle, and self-derived school items fail the submit gate (CB1-B1)', async () => {
    const mkPersonal = async (extra: Record<string, unknown> = {}) => {
      const res = await http(app).post('/api/v1/contentbank').set(bearer(authorToken)).send({
        name: uniqueName('Hoc lieu vong dan xuat'), resourceType: 'reference', scope: 'personal', ...extra,
      });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    const aId = await mkPersonal();
    const bId = await mkPersonal();

    // Tự tham chiếu qua update → bị chặn, bản ghi giữ derivedFromId null.
    const selfRef = await http(app).patch(`/api/v1/contentbank/${aId}`).set(bearer(authorToken))
      .send({ sourceKind: 'derived', derivedFromId: aId });
    expect(selfRef.status).toBe(400);
    expect(selfRef.body.code).toBe('contentbank.derived_from_self_reference');
    const afterSelf = await http(app).get(`/api/v1/contentbank/${aId}`).set(bearer(authorToken));
    expect(afterSelf.body.derivedFromId).toBeNull();

    // Chuỗi hợp lệ A → B vẫn qua (derived hợp lệ không bị chặn oan).
    const linkA = await http(app).patch(`/api/v1/contentbank/${aId}`).set(bearer(authorToken))
      .send({ sourceKind: 'derived', derivedFromId: bId });
    expect(linkA.status).toBe(200);
    expect(linkA.body.derivedFromId).toBe(bId);

    // Vòng 2 nút B → A (trong khi A → B) → bị chặn ở cả update lẫn create-kèm-chuỗi:
    // update B trỏ về A tạo vòng A→B→A.
    const cycle = await http(app).patch(`/api/v1/contentbank/${bId}`).set(bearer(authorToken))
      .send({ sourceKind: 'derived', derivedFromId: aId });
    expect(cycle.status).toBe(400);
    expect(cycle.body.code).toBe('contentbank.derived_from_cycle');
    const afterCycle = await http(app).get(`/api/v1/contentbank/${bId}`).set(bearer(authorToken));
    expect(afterCycle.body.derivedFromId).toBeNull();

    // Cổng submit B1 không bị phá: học liệu trường khai derived trỏ về
    // chính mình bị chặn ngay ở update nên derivedFromId vẫn trống →
    // gửi duyệt vẫn 400 metadata_incomplete (thiếu derivedFromId thật).
    const school = await http(app).post('/api/v1/contentbank').set(bearer(authorToken)).send({
      name: uniqueName('Tai lieu truong tu dan xuat'), resourceType: 'multimedia_lecture', scope: 'school',
      subjectId, grade: 10, level: 'upper_secondary', curriculumNodeId: nodeId, ...pedagogicalMeta,
      originalAuthor: 'Nguyễn Văn A', sourceKind: 'derived', license: 'Chỉ dùng nội bộ trường',
    });
    expect(school.status).toBe(201);
    const schoolId = school.body.id as string;
    await http(app).post(`/api/v1/contentbank/${schoolId}/file`).set(bearer(authorToken)).send(fileBody);
    const cheat = await http(app).patch(`/api/v1/contentbank/${schoolId}`).set(bearer(authorToken))
      .send({ derivedFromId: schoolId });
    expect(cheat.status).toBe(400);
    expect(cheat.body.code).toBe('contentbank.derived_from_self_reference');
    const submit = await http(app).post(`/api/v1/contentbank/${schoolId}/submit`).set(bearer(authorToken)).send({});
    expect(submit.status).toBe(400);
    expect(submit.body.code).toBe('contentbank.metadata_incomplete');
    expect(String(submit.body.detail ?? submit.body.message ?? '')).toContain('derivedFromId');
  });

  it('question_set items only reference the question bank and cannot be inserted as course resources', async () => {
    const created = await http(app).post('/api/v1/contentbank').set(bearer(authorToken)).send({
      name: uniqueName('Bo cau hoi tham chieu'), resourceType: 'question_set', scope: 'personal',
      questionCategoryId: categoryId,
    });
    expect(created.status).toBe(201);
    expect(created.body.questionCategoryId).toBe(categoryId);
    const insert = await http(app).post(`/api/v1/contentbank/${created.body.id}/insert`).set(bearer(authorToken))
      .send({ courseId, sectionId });
    expect(insert.status).toBe(400);
    expect(insert.body.code).toBe('contentbank.question_set_not_insertable');
  });

  it('personal items are private to their author; users without roles cannot create library items', async () => {
    const created = await http(app).post('/api/v1/contentbank').set(bearer(authorToken)).send({
      name: uniqueName('Hoc lieu ca nhan'), resourceType: 'reference', scope: 'personal',
    });
    expect(created.status).toBe(201);
    expect(created.body.reviewStatus).toBe('approved');
    // Người dùng thường (vai học sinh ở hệ thống, không có quyền sửa nội
    // dung) không xem được học liệu cá nhân của người khác.
    const view = await http(app).get(`/api/v1/contentbank/${created.body.id}`).set(bearer(studentToken));
    expect(view.status).toBe(403);

    const plain = await createUserViaApi(app, admin);
    const plainToken = (await login(app, plain.username, STRONG_PASSWORD)).accessToken;
    const denied = await http(app).post('/api/v1/contentbank').set(bearer(plainToken)).send({ name: 'X', scope: 'personal' });
    expect(denied.status).toBe(403);
  });

  it('personal bank: teacher whose only role is at a course context creates without contextId; course-only student still cannot (probe v86)', async () => {
    // Đường mặc định của UI: không contextId, scope personal. Giáo viên
    // chỉ có editingteacher tại context khoá vẫn dùng được kho của mình.
    const created = await http(app).post('/api/v1/contentbank').set(bearer(courseTeacherToken)).send({
      name: uniqueName('Hoc lieu ca nhan GV khoa'), resourceType: 'reference', scope: 'personal',
    });
    expect(created.status).toBe(201);
    expect(created.body.scope).toBe('personal');
    expect(created.body.reviewStatus).toBe('approved');
    const own = await http(app).get(`/api/v1/contentbank/${created.body.id}`).set(bearer(courseTeacherToken));
    expect(own.status).toBe(200);

    // Chiều giữ nguyên: học sinh (vai student chỉ ở context khoá) tạo → 403.
    const denied = await http(app).post('/api/v1/contentbank').set(bearer(courseStudentToken)).send({
      name: uniqueName('Hoc sinh tu tao'), resourceType: 'reference', scope: 'personal',
    });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('access.capability_denied');
  });

  it('school scope: approved+public opens to course-only students and teachers; draft/pending stay hidden from them (probe v86)', async () => {
    const created = await http(app).post('/api/v1/contentbank').set(bearer(authorToken)).send({
      name: uniqueName('Tai lieu truong cong khai'), resourceType: 'multimedia_lecture', scope: 'school',
      subjectId, grade: 10, level: 'upper_secondary', curriculumNodeId: nodeId, ...pedagogicalMeta,
      originalAuthor: 'Nguyễn Văn A', sourceKind: 'self', license: 'Chỉ dùng nội bộ trường',
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    await http(app).post(`/api/v1/contentbank/${id}/file`).set(bearer(authorToken)).send(fileBody);

    // Draft: học sinh chỉ có vai ở khoá không xem được, không thấy trong danh sách.
    const draftView = await http(app).get(`/api/v1/contentbank/${id}`).set(bearer(courseStudentToken));
    expect(draftView.status).toBe(403);
    expect(draftView.body.code).toBe('contentbank.view_denied');
    expect(await listIds(courseStudentToken, 'scope=school')).not.toContain(id);

    const submit = await http(app).post(`/api/v1/contentbank/${id}/submit`).set(bearer(authorToken)).send({});
    expect(submit.status).toBe(201);
    // Pending: vẫn chặn cả xem lẫn danh sách.
    const pendingView = await http(app).get(`/api/v1/contentbank/${id}`).set(bearer(courseStudentToken));
    expect(pendingView.status).toBe(403);
    expect(await listIds(courseStudentToken, 'scope=school')).not.toContain(id);

    const review = await http(app).post(`/api/v1/contentbank/${id}/review`).set(bearer(admin)).send({ decision: 'approved', checklist: fullChecklist });
    expect(review.status).toBe(201);
    expect(review.body.visibility).toBe('public');

    // Approved + public: học sinh lẫn giáo viên (chỉ có vai ở khoá) đều
    // đọc được theo id và thấy trong danh sách scope trường.
    const studentView = await http(app).get(`/api/v1/contentbank/${id}`).set(bearer(courseStudentToken));
    expect(studentView.status).toBe(200);
    expect(await listIds(courseStudentToken, 'scope=school')).toContain(id);
    const teacherView = await http(app).get(`/api/v1/contentbank/${id}`).set(bearer(courseTeacherToken));
    expect(teacherView.status).toBe(200);
    expect(await listIds(courseTeacherToken, 'scope=school')).toContain(id);
  });

  it('spaces endpoint lists personal, my departments and school', async () => {
    const res = await http(app).get('/api/v1/contentbank/spaces').set(bearer(authorToken));
    expect(res.status).toBe(200);
    const spaces = res.body as { scope: string; spaceId: string | null; canReview: boolean }[];
    expect(spaces.some((s) => s.scope === 'personal')).toBe(true);
    expect(spaces.some((s) => s.scope === 'org' && s.spaceId === cohortId)).toBe(true);
    expect(spaces.some((s) => s.scope === 'school')).toBe(true);
    const outsiderSpaces = await http(app).get('/api/v1/contentbank/spaces').set(bearer(outsiderToken));
    expect((outsiderSpaces.body as { spaceId: string | null }[]).some((s) => s.spaceId === cohortId)).toBe(false);
  });
});

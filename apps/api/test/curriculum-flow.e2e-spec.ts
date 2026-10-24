import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, hasCapability, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId, uniqueName,
} from './identity-access-helpers';

/**
 * Curriculum GDPT 2018 — Chặng 1 của issue #20 (port từ giaokhoa).
 * Oracle: mô hình giaokhoa đã kiểm chứng tận schema
 * (packages/database/src/schema/curriculum.ts): subjects (slug duy nhất) →
 * curricula (duy nhất theo môn + khối 1–12) → curriculum_nodes (cây, khoá
 * ngoại ghép giữ node con trong cùng chương trình) → learning_outcomes.
 * Phần LMS bổ sung: môn neo context + capability lms/curriculum:view|manage
 * qua PermissionEvaluator (mẫu ngân hàng câu hỏi/stimulus), node có kind
 * (strand = mạch nội dung) và thời lượng/% thời lượng cho số hoá GDPT 2018.
 */

interface NodeView {
  id: string; title: string; kind: string; parentId: string | null;
  durationPeriods: number | null; durationPercent: number | null;
  outcomes: { id: string; content: string; position: number }[];
  children: NodeView[];
}

describe('Curriculum flow (subjects → curricula → node tree → outcomes)', () => {
  let app: INestApplication;
  let admin: string;
  let systemCtxId: string;
  let plainToken: string;
  let plainId: string;
  let teacherToken: string;
  let teacherId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    systemCtxId = await systemContextId(app, admin);

    const plain = await createUserViaApi(app, admin);
    plainId = plain.id;
    plainToken = (await login(app, plain.username, STRONG_PASSWORD)).accessToken;

    const teacher = await createUserViaApi(app, admin);
    teacherId = teacher.id;
    // Gán role TRƯỚC mọi lần kiểm tra quyền của user này (evaluator có cache).
    await assignRole(app, admin, teacher.id, await roleIdByShortname(app, admin, 'editingteacher'), systemCtxId);
    teacherToken = (await login(app, teacher.username, STRONG_PASSWORD)).accessToken;
  });
  afterAll(async () => { await app.close(); });

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('builds a full GDPT programme tree and reads it back', async () => {
    // Môn học neo vào context hệ thống.
    const slug = uniqueName('toan');
    const subjectRes = await http(app).post('/api/v1/curriculum/subjects').set(bearer(admin))
      .send({ contextId: systemCtxId, name: 'Toán', slug });
    expect(subjectRes.status).toBe(201);
    const subject = subjectRes.body as { id: string; contextId: string; position: number };
    expect(subject.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(subject.contextId).toBe(systemCtxId);
    expect(subject.position).toBe(1);

    // Slug là duy nhất toàn hệ.
    const dupSlug = await http(app).post('/api/v1/curriculum/subjects').set(bearer(admin))
      .send({ contextId: systemCtxId, name: 'Toán trùng', slug });
    expect(dupSlug.status).toBe(409);
    expect(dupSlug.body.code).toBe('curriculum.subject_slug_taken');

    // Chương trình khối 10; mỗi cặp môn + khối chỉ có một chương trình.
    const currRes = await http(app).post('/api/v1/curriculum/curricula').set(bearer(admin))
      .send({ subjectId: subject.id, grade: 10 });
    expect(currRes.status).toBe(201);
    const curriculum = currRes.body as { id: string; subjectId: string; grade: number };
    expect(curriculum.grade).toBe(10);
    const dupGrade = await http(app).post('/api/v1/curriculum/curricula').set(bearer(admin))
      .send({ subjectId: subject.id, grade: 10 });
    expect(dupGrade.status).toBe(409);
    expect(dupGrade.body.code).toBe('curriculum.grade_exists');
    // Khối ngoài 1–12 bị từ chối ở biên validate.
    const badGrade = await http(app).post('/api/v1/curriculum/curricula').set(bearer(admin))
      .send({ subjectId: subject.id, grade: 13 });
    expect(badGrade.status).toBe(400);

    // Cây: mạch nội dung (strand, có % thời lượng) → chủ đề → bài.
    const strandRes = await http(app).post('/api/v1/curriculum/nodes').set(bearer(admin))
      .send({ curriculumId: curriculum.id, title: 'Số và Đại số', kind: 'strand', position: 1, durationPercent: 40, durationPeriods: 28 });
    expect(strandRes.status).toBe(201);
    const strand = strandRes.body as NodeView;
    expect(strand.kind).toBe('strand');
    expect(strand.durationPercent).toBe(40);
    expect(strand.durationPeriods).toBe(28);
    expect(strand.parentId).toBeNull();

    const topicRes = await http(app).post('/api/v1/curriculum/nodes').set(bearer(admin))
      .send({ curriculumId: curriculum.id, parentId: strand.id, title: 'Hàm số và đồ thị', kind: 'topic', position: 1 });
    expect(topicRes.status).toBe(201);
    const topic = topicRes.body as NodeView;

    const lessonRes = await http(app).post('/api/v1/curriculum/nodes').set(bearer(admin))
      .send({ curriculumId: curriculum.id, parentId: topic.id, title: 'Hàm số bậc hai', kind: 'lesson', position: 1 });
    expect(lessonRes.status).toBe(201);
    const lesson = lessonRes.body as NodeView;

    // Yêu cầu cần đạt treo dưới node chủ đề.
    const oc1 = await http(app).post('/api/v1/curriculum/outcomes').set(bearer(admin))
      .send({ nodeId: topic.id, content: 'Nhận biết được khái niệm hàm số.', position: 1 });
    expect(oc1.status).toBe(201);
    const oc2 = await http(app).post('/api/v1/curriculum/outcomes').set(bearer(admin))
      .send({ nodeId: topic.id, content: 'Vẽ được đồ thị hàm số bậc hai.', position: 2 });
    expect(oc2.status).toBe(201);

    // Đọc lại trọn cây: cấu trúc lồng nhau + outcomes đúng thứ tự.
    const treeRes = await http(app).get(`/api/v1/curriculum/curricula/${curriculum.id}/tree`).set(bearer(admin));
    expect(treeRes.status).toBe(200);
    const tree = treeRes.body as { curriculum: { id: string }; subject: { id: string }; nodes: NodeView[] };
    expect(tree.curriculum.id).toBe(curriculum.id);
    expect(tree.subject.id).toBe(subject.id);
    expect(tree.nodes).toHaveLength(1);
    const root = tree.nodes[0]!;
    expect(root.id).toBe(strand.id);
    expect(root.kind).toBe('strand');
    expect(root.children).toHaveLength(1);
    const topicView = root.children[0]!;
    expect(topicView.id).toBe(topic.id);
    expect(topicView.outcomes.map((o) => o.content)).toEqual([
      'Nhận biết được khái niệm hàm số.',
      'Vẽ được đồ thị hàm số bậc hai.',
    ]);
    expect(topicView.children.map((c) => c.id)).toEqual([lesson.id]);

    // Danh sách theo cấp cha cũng đọc lại được.
    const subjectsRes = await http(app).get('/api/v1/curriculum/subjects').query({ contextId: systemCtxId }).set(bearer(admin));
    expect(subjectsRes.status).toBe(200);
    expect((subjectsRes.body as { id: string }[]).some((s) => s.id === subject.id)).toBe(true);
    const curriculaRes = await http(app).get('/api/v1/curriculum/curricula').query({ subjectId: subject.id }).set(bearer(admin));
    expect((curriculaRes.body as { grade: number }[]).map((c) => c.grade)).toEqual([10]);

    // Sửa node: đổi % thời lượng.
    const patchNode = await http(app).patch(`/api/v1/curriculum/nodes/${topic.id}`).set(bearer(admin))
      .send({ durationPercent: 55.5 });
    expect(patchNode.status).toBe(200);
    expect((patchNode.body as NodeView).durationPercent).toBe(55.5);

    // Node cha thuộc chương trình khác bị chặn tường minh (400).
    const otherCurr = await http(app).post('/api/v1/curriculum/curricula').set(bearer(admin))
      .send({ subjectId: subject.id, grade: 11 });
    expect(otherCurr.status).toBe(201);
    const otherNode = await http(app).post('/api/v1/curriculum/nodes').set(bearer(admin))
      .send({ curriculumId: (otherCurr.body as { id: string }).id, title: 'Mạch hình học', kind: 'strand' });
    expect(otherNode.status).toBe(201);
    const crossParent = await http(app).post('/api/v1/curriculum/nodes').set(bearer(admin))
      .send({ curriculumId: curriculum.id, parentId: (otherNode.body as NodeView).id, title: 'Node lạc' });
    expect(crossParent.status).toBe(400);
    expect(crossParent.body.code).toBe('curriculum.node_parent_mismatch');

    // Xoá node chủ đề: cả subtree (bài) và outcomes biến mất khỏi cây; xoá môn thì chương trình cũng đi theo.
    const delNode = await http(app).delete(`/api/v1/curriculum/nodes/${topic.id}`).set(bearer(admin));
    expect(delNode.status).toBe(200);
    const treeAfter = await http(app).get(`/api/v1/curriculum/curricula/${curriculum.id}/tree`).set(bearer(admin));
    const nodesAfter = (treeAfter.body as { nodes: NodeView[] }).nodes;
    expect(nodesAfter).toHaveLength(1);
    expect(nodesAfter[0]!.children).toHaveLength(0);
    const goneOutcome = await http(app).get(`/api/v1/curriculum/outcomes/${(oc1.body as { id: string }).id}`).set(bearer(admin));
    expect(goneOutcome.status).toBe(404);

    const delSubject = await http(app).delete(`/api/v1/curriculum/subjects/${subject.id}`).set(bearer(admin));
    expect(delSubject.status).toBe(200);
    const goneCurr = await http(app).get(`/api/v1/curriculum/curricula/${curriculum.id}`).set(bearer(admin));
    expect(goneCurr.status).toBe(404);
  });

  it('gates reads and writes by capability at the subject context', async () => {
    // Kiểm tra thẳng qua evaluator API: user thường không có cả view lẫn manage;
    // editingteacher được view theo archetype nhưng không có manage.
    expect(await hasCapability(app, admin, plainId, 'lms/curriculum:view', systemCtxId)).toBe(false);
    expect(await hasCapability(app, admin, plainId, 'lms/curriculum:manage', systemCtxId)).toBe(false);
    expect(await hasCapability(app, admin, teacherId, 'lms/curriculum:view', systemCtxId)).toBe(true);
    expect(await hasCapability(app, admin, teacherId, 'lms/curriculum:manage', systemCtxId)).toBe(false);

    // User không quyền: đọc bị từ chối 403 với mã capability_denied.
    const plainList = await http(app).get('/api/v1/curriculum/subjects').query({ contextId: systemCtxId }).set(bearer(plainToken));
    expect(plainList.status).toBe(403);
    expect(plainList.body.code).toBe('access.capability_denied');
    // User không quyền: ghi bị từ chối 403.
    const plainCreate = await http(app).post('/api/v1/curriculum/subjects').set(bearer(plainToken))
      .send({ contextId: systemCtxId, name: 'Ngữ văn', slug: uniqueName('ngu-van') });
    expect(plainCreate.status).toBe(403);
    expect(plainCreate.body.code).toBe('access.capability_denied');

    // Giáo viên (có view, không manage): đọc được, ghi bị từ chối.
    const teacherList = await http(app).get('/api/v1/curriculum/subjects').query({ contextId: systemCtxId }).set(bearer(teacherToken));
    expect(teacherList.status).toBe(200);
    const teacherCreate = await http(app).post('/api/v1/curriculum/subjects').set(bearer(teacherToken))
      .send({ contextId: systemCtxId, name: 'Lịch sử', slug: uniqueName('lich-su') });
    expect(teacherCreate.status).toBe(403);
    expect(teacherCreate.body.code).toBe('access.capability_denied');
  });
});

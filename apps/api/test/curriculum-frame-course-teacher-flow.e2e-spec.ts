import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId, uniqueName,
} from './identity-access-helpers';
import { createCategory, createCourse } from './course-enrolment-helpers';
import { courseContextId } from './engagement-helpers';

/**
 * K0a (issue #66) — hồi quy điểm chặn của review độc lập (comment
 * 6382849325): giáo viên theo đúng mô hình gán vai THẬT của seed
 * (editingteacher TẠI CONTEXT KHOÁ, như teacher1 dạy DEMO101) phải nạp
 * được khung vào khoá mình dạy và đọc được bề mặt chọn khung cho khoá
 * đó — dù không có bất kỳ vai nào tại context hệ thống. Spec cũ che
 * điểm này vì gán coursecreator tại context hệ thống (kéo theo
 * curriculum:view tại hệ thống). Các ca chặn giữ nguyên: học sinh 403
 * mọi bề mặt, giáo viên khoá khác 403 với khoá không phải của mình,
 * cổng quản trị cây (curriculum:manage) không nới cho giáo viên.
 */

/** Node của một YCCĐ dạng Tiptap doc trong dataset (doc/paragraph/text + bulletList/listItem cho ý con). */
interface OutcomeDocNode {
  type: string;
  text?: string;
  content?: OutcomeDocNode[];
}
interface OutcomeDoc {
  type: 'doc';
  content?: OutcomeDocNode[];
}

interface ProgramRecord {
  id: string; grade: number; stream: string; section: string | null; topic: string | null;
  content: string; outcomes: (string | OutcomeDoc)[]; outcome_text: string;
}
const toan = JSON.parse(
  readFileSync(join(process.cwd(), 'src/modules/curriculum/program-data/program-toan.json'), 'utf8'),
) as { records: ProgramRecord[] };

/**
 * Text của một YCCĐ dạng doc — ORACLE trích độc lập trong spec (không
 * dùng code nạp, giữ tính độc lập của oracle): mỗi paragraph là một
 * dòng, listItem cho dòng của paragraph của nó rồi tới các dòng của
 * bulletList lồng bên trong (đệ quy); các dòng nối bằng '\n', cắt
 * khoảng trắng hai đầu — đúng semantics text canonical mà hệ lưu vào
 * `learning_outcomes.content` ở lát này (cột text; bản doc đầy đủ chỉ
 * lưu ở lát JSONB xếp sau đợt #161).
 */
function docOutcomeText(doc: OutcomeDoc): string {
  const lines: string[] = [];
  const walk = (node: OutcomeDocNode): void => {
    if (node.type === 'paragraph') {
      lines.push((node.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join(''));
      return;
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return lines.join('\n').trim();
}

/** Các dòng YCCĐ kỳ vọng của một bản ghi (phần tử dạng doc trích text bằng docOutcomeText). */
function outcomeTexts(r: ProgramRecord): string[] {
  if (r.outcomes.length > 0) {
    return r.outcomes.map((o) => (typeof o === 'string' ? o : docOutcomeText(o)));
  }
  if (r.outcome_text.trim().length > 0) return [r.outcome_text];
  return [];
}
function expectedUnitOutcomes(grade: number, stream: string, section?: string, topic?: string): string[] {
  return toan.records
    .filter((r) => r.grade === grade && r.stream === stream
      && (section === undefined || r.section === section)
      && (topic === undefined || r.topic === topic))
    .flatMap(outcomeTexts);
}

interface TreeNode {
  id: string; title: string; kind: string;
  outcomes: { id: string; content: string; position: number }[];
  children: TreeNode[];
}
function findByPath(nodes: TreeNode[], titles: string[]): TreeNode | undefined {
  let level = nodes;
  let found: TreeNode | undefined;
  for (const title of titles) {
    found = level.find((n) => n.title === title);
    if (!found) return undefined;
    level = found.children;
  }
  return found;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('K0a frame access for course-level teachers (seed role model, issue #66 review blocker)', () => {
  let app: INestApplication;
  let admin: string;
  let systemCtxId: string;
  let subjectId: string;
  let curriculum5Id: string;
  let tree5: TreeNode[];
  let courseA: string;
  let courseB: string;
  let teacherA: string;
  let teacherB: string;
  let studentA: string;
  let plainToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    systemCtxId = await systemContextId(app, admin);
    const imp = await http(app).post('/api/v1/curriculum/program-import').set(bearer(admin)).send({ datasetKey: 'toan' });
    expect(imp.status).toBe(201);

    const subjects = await http(app).get(`/api/v1/curriculum/subjects?contextId=${systemCtxId}`).set(bearer(admin));
    subjectId = (subjects.body as { id: string; slug: string }[]).find((s) => s.slug === 'toan')!.id;
    const curricula = await http(app).get(`/api/v1/curriculum/curricula?subjectId=${subjectId}`).set(bearer(admin));
    curriculum5Id = (curricula.body as { id: string; grade: number }[]).find((c) => c.grade === 5)!.id;
    const tree = await http(app).get(`/api/v1/curriculum/curricula/${curriculum5Id}/tree`).set(bearer(admin));
    expect(tree.status).toBe(200);
    tree5 = (tree.body as { nodes: TreeNode[] }).nodes;

    // Hai khoá do admin tạo; giáo viên được gán editingteacher TẠI
    // CONTEXT của đúng khoá mình dạy — nguyên mô hình seed teacher1.
    const category = await createCategory(app, admin);
    courseA = (await createCourse(app, admin, category.id, { subjectId, grade: 5 })).id;
    courseB = (await createCourse(app, admin, category.id, { subjectId, grade: 5 })).id;
    const editingTeacherRole = await roleIdByShortname(app, admin, 'editingteacher');
    const studentRole = await roleIdByShortname(app, admin, 'student');
    const ctxA = await courseContextId(app, admin, courseA);
    const ctxB = await courseContextId(app, admin, courseB);

    const userA = await createUserViaApi(app, admin);
    await assignRole(app, admin, userA.id, editingTeacherRole, ctxA);
    teacherA = (await login(app, userA.username, STRONG_PASSWORD)).accessToken;
    const userB = await createUserViaApi(app, admin);
    await assignRole(app, admin, userB.id, editingTeacherRole, ctxB);
    teacherB = (await login(app, userB.username, STRONG_PASSWORD)).accessToken;
    const userS = await createUserViaApi(app, admin);
    await assignRole(app, admin, userS.id, studentRole, ctxA);
    studentA = (await login(app, userS.username, STRONG_PASSWORD)).accessToken;
    const plain = await createUserViaApi(app, admin);
    plainToken = (await login(app, plain.username, STRONG_PASSWORD)).accessToken;
  }, 180_000);
  afterAll(async () => { await app.close(); });

  it('course teacher reads the whole frame-picker surface for their own course via forCourseId', async () => {
    const subjects = await http(app).get(`/api/v1/curriculum/subjects?contextId=${systemCtxId}&forCourseId=${courseA}`).set(bearer(teacherA));
    expect(subjects.status).toBe(200);
    expect((subjects.body as { slug: string }[]).some((s) => s.slug === 'toan')).toBe(true);
    const curricula = await http(app).get(`/api/v1/curriculum/curricula?subjectId=${subjectId}&forCourseId=${courseA}`).set(bearer(teacherA));
    expect(curricula.status).toBe(200);
    const tree = await http(app).get(`/api/v1/curriculum/curricula/${curriculum5Id}/tree?forCourseId=${courseA}`).set(bearer(teacherA));
    expect(tree.status).toBe(200);
    expect((tree.body as { nodes: TreeNode[] }).nodes.length).toBeGreaterThan(0);
  });

  it('course teacher applies a frame to their own course and sees the anchored outcomes', async () => {
    const topic = findByPath(tree5, ['Số và phép tính', 'Phân số', 'Số thập phân']);
    expect(topic).toBeTruthy();
    const res = await http(app).post(`/api/v1/courses/${courseA}/curriculum-frame`).set(bearer(teacherA))
      .send({ curriculumId: curriculum5Id, nodeIds: [topic!.id] });
    expect(res.status).toBe(201);
    const created = res.body as { name: string; frame: { outcomes: { content: string }[] } }[];
    expect(created.length).toBe(1);
    expect(created[0]!.name).toBe('Số thập phân');
    expect(created[0]!.frame.outcomes.map((o) => o.content))
      .toEqual(expectedUnitOutcomes(5, 'Số và phép tính', 'Phân số', 'Số thập phân'));

    const content = await http(app).get(`/api/v1/courses/${courseA}/content`).set(bearer(teacherA));
    expect(content.status).toBe(200);
    const sections = (content.body as { sections: { name: string | null; frame: { outcomes: { content: string }[] } | null }[] }).sections;
    const applied = sections.find((s) => s.name === 'Số thập phân');
    expect(applied?.frame?.outcomes.map((o) => o.content))
      .toEqual(expectedUnitOutcomes(5, 'Số và phép tính', 'Phân số', 'Số thập phân'));
  });

  it('the new branch is bound to the target course: no plain reads, no other course', async () => {
    const plainSubjects = await http(app).get(`/api/v1/curriculum/subjects?contextId=${systemCtxId}`).set(bearer(teacherA));
    expect(plainSubjects.status).toBe(403);
    const plainTree = await http(app).get(`/api/v1/curriculum/curricula/${curriculum5Id}/tree`).set(bearer(teacherA));
    expect(plainTree.status).toBe(403);
    const otherTree = await http(app).get(`/api/v1/curriculum/curricula/${curriculum5Id}/tree?forCourseId=${courseB}`).set(bearer(teacherA));
    expect(otherTree.status).toBe(403);
    const otherSubjects = await http(app).get(`/api/v1/curriculum/subjects?contextId=${systemCtxId}&forCourseId=${courseB}`).set(bearer(teacherA));
    expect(otherSubjects.status).toBe(403);
    const topic = findByPath(tree5, ['Số và phép tính', 'Phân số', 'Số thập phân'])!;
    const applyOther = await http(app).post(`/api/v1/courses/${courseB}/curriculum-frame`).set(bearer(teacherA))
      .send({ curriculumId: curriculum5Id, nodeIds: [topic.id] });
    expect(applyOther.status).toBe(403);
    // Đối chứng dương: giáo viên của chính khoá B thì nạp được.
    const applyOwn = await http(app).post(`/api/v1/courses/${courseB}/curriculum-frame`).set(bearer(teacherB))
      .send({ curriculumId: curriculum5Id, nodeIds: [topic.id] });
    expect(applyOwn.status).toBe(201);
  });

  it('students and unrelated users stay denied on every frame surface', async () => {
    const topic = findByPath(tree5, ['Số và phép tính', 'Phân số', 'Số thập phân'])!;
    for (const token of [studentA, plainToken]) {
      const subjects = await http(app).get(`/api/v1/curriculum/subjects?contextId=${systemCtxId}&forCourseId=${courseA}`).set(bearer(token));
      expect(subjects.status).toBe(403);
      const tree = await http(app).get(`/api/v1/curriculum/curricula/${curriculum5Id}/tree?forCourseId=${courseA}`).set(bearer(token));
      expect(tree.status).toBe(403);
      const apply = await http(app).post(`/api/v1/courses/${courseA}/curriculum-frame`).set(bearer(token))
        .send({ curriculumId: curriculum5Id, nodeIds: [topic.id] });
      expect(apply.status).toBe(403);
    }
  });

  it('programme administration gates stay shut for course teachers (curriculum:manage not widened)', async () => {
    const imp = await http(app).post('/api/v1/curriculum/program-import').set(bearer(teacherA)).send({ datasetKey: 'toan' });
    expect(imp.status).toBe(403);
    const status = await http(app).get('/api/v1/curriculum/program-import').set(bearer(teacherA));
    expect(status.status).toBe(403);
    const createSubject = await http(app).post('/api/v1/curriculum/subjects').set(bearer(teacherA))
      .send({ contextId: systemCtxId, name: 'Môn ma', slug: uniqueName('ghost') });
    expect(createSubject.status).toBe(403);
    const topic = findByPath(tree5, ['Số và phép tính', 'Phân số', 'Số thập phân'])!;
    const patchNode = await http(app).patch(`/api/v1/curriculum/nodes/${topic.id}`).set(bearer(teacherA))
      .send({ title: 'Sửa thử bởi giáo viên khoá' });
    expect(patchNode.status).toBe(403);
    const deleteOutcome = await http(app).delete(`/api/v1/curriculum/outcomes/${topic.children[0]!.outcomes[0]!.id}`).set(bearer(teacherA));
    expect(deleteOutcome.status).toBe(403);
  });
});

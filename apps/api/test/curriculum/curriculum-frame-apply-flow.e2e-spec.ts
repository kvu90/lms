import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId, uniqueName,
} from '../support/identity-access-helpers';
import { createCategory } from '../support/course-enrolment-helpers';
import { contextIdByLevelInstance } from '../support/engagement-helpers';

/**
 * K0a (issue #66) — nạp khung chương trình vào khoá (bản sao có neo).
 * Oracle độc lập: dataset Toán đã kiểm chứng vendor trong repo — YCCĐ
 * kỳ vọng của một đơn vị khung được tính thẳng từ dataset (các bản ghi
 * thuộc đường tổ tiên của đơn vị, theo thứ tự file), không qua code nạp.
 * Tiêu chí của issue: giáo viên tạo khoá Toán một khối từ khung, section
 * mang đúng YCCĐ của chủ đề; sửa cây chương trình sau đó KHÔNG đổi cấu
 * trúc khoá đã nạp — spec kiểm cả hai, và khôi phục nguyên trạng cây
 * sau khi sửa thử để không làm bẩn dữ liệu cho spec khác.
 * Mô hình gán vai của người dùng thử: `coursecreator` tại CONTEXT DANH
 * MỤC (đúng cách gán thật — không gán tại context hệ thống, vì gán ở hệ
 * thống còn kéo theo curriculum:view tại hệ thống và đã che điểm chặn
 * review #66: giáo viên cấp khoá bị 403 khi nạp khung).
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
 * `learning_outcomes.content` nay là cột jsonb lưu trực tiếp tài liệu
 * này; text canonical trích từ tài liệu bằng đúng semantics này.
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
/** YCCĐ kỳ vọng của đơn vị (stream, section?, topic?) ở một khối — tính từ dataset. */
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

describe('K0a curriculum frame application (programme → course sections, anchored copy)', () => {
  let app: INestApplication;
  let admin: string;
  let systemCtxId: string;
  let teacherToken: string;
  let plainToken: string;
  let subjectId: string;
  let curriculum5Id: string;
  let tree5: TreeNode[];
  let categoryId: string;
  let courseId: string;
  let classId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    systemCtxId = await systemContextId(app, admin);
    // Nạp dataset Toán (idempotent — spec nạp dữ liệu có thể đã chạy trước trong cùng DB).
    const imp = await http(app).post('/api/v1/curriculum/program-import').set(bearer(admin)).send({ datasetKey: 'toan' });
    expect(imp.status).toBe(201);

    // Danh mục riêng của spec + giáo viên coursecreator TẠI CONTEXT DANH
    // MỤC (không tại hệ thống — xem ghi chú đầu file). Id môn/chương
    // trình/cây lấy bằng admin: đó là dữ liệu mồi, không phải hành vi
    // cần kiểm; hành vi của giáo viên được kiểm ở các test dưới.
    const category = await createCategory(app, admin);
    categoryId = category.id;
    const categoryCtxId = await contextIdByLevelInstance(app, admin, 40, categoryId);
    const teacher = await createUserViaApi(app, admin);
    await assignRole(app, admin, teacher.id, await roleIdByShortname(app, admin, 'coursecreator'), categoryCtxId);
    teacherToken = (await login(app, teacher.username, STRONG_PASSWORD)).accessToken;
    // CLASS-0 (đóng gói PR #200): khoá dạy thật phải thuộc một lớp. GV
    // coursecreator tại context danh mục không có class:create tại
    // context tenant nên lớp do admin tạo, chủ lớp là chính GV này —
    // chủ lớp có editingteacher tại context lớp nên tạo/sửa khoá trong
    // lớp được như đường sản phẩm.
    const cls = await http(app).post('/api/v1/classes').set(bearer(admin)).send({ name: uniqueName('cls'), ownerId: teacher.id });
    expect(cls.status).toBe(201);
    classId = cls.body.id as string;
    const plain = await createUserViaApi(app, admin);
    plainToken = (await login(app, plain.username, STRONG_PASSWORD)).accessToken;

    const subjects = await http(app).get(`/api/v1/curriculum/subjects?contextId=${systemCtxId}`).set(bearer(admin));
    subjectId = (subjects.body as { id: string; slug: string }[]).find((s) => s.slug === 'toan')!.id;
    const curricula = await http(app).get(`/api/v1/curriculum/curricula?subjectId=${subjectId}`).set(bearer(admin));
    curriculum5Id = (curricula.body as { id: string; grade: number }[]).find((c) => c.grade === 5)!.id;
    const tree = await http(app).get(`/api/v1/curriculum/curricula/${curriculum5Id}/tree`).set(bearer(admin));
    expect(tree.status).toBe(200);
    tree5 = (tree.body as { nodes: TreeNode[] }).nodes;
  }, 180_000);
  afterAll(async () => { await app.close(); });

  it('teacher creates a grade-5 Toán course carrying subject × grade', async () => {
    const res = await http(app).post('/api/v1/courses').set(bearer(teacherToken)).send({
      fullName: 'Toán 5 — khung K0a', shortName: uniqueName('toan5'), category: categoryId,
      subjectId, grade: 5, classId,
    });
    expect(res.status).toBe(201);
    expect(res.body.subjectId).toBe(subjectId);
    expect(res.body.grade).toBe(5);
    courseId = res.body.id as string;

    const bogus = await http(app).post('/api/v1/courses').set(bearer(teacherToken)).send({
      fullName: 'Khoá neo môn ma', shortName: uniqueName('ghost'), category: categoryId,
      subjectId: '01961e2a-7b3c-7def-8abc-0123456789ab', grade: 5, classId,
    });
    expect(bogus.status).toBe(400);
    expect(bogus.body.code).toBe('course.subject_not_found');
  });

  it('teacher reads the frame picker for their own course via forCourseId, but not the plain tree', async () => {
    // Bề mặt chọn khung trong quản trị khoá: kèm forCourseId = khoá mình
    // có course:update thì đọc được cả 3 GET; không kèm thì vẫn 403 vì
    // giáo viên này không có curriculum:view tại context hệ thống.
    const subjects = await http(app).get(`/api/v1/curriculum/subjects?contextId=${systemCtxId}&forCourseId=${courseId}`).set(bearer(teacherToken));
    expect(subjects.status).toBe(200);
    const curricula = await http(app).get(`/api/v1/curriculum/curricula?subjectId=${subjectId}&forCourseId=${courseId}`).set(bearer(teacherToken));
    expect(curricula.status).toBe(200);
    const tree = await http(app).get(`/api/v1/curriculum/curricula/${curriculum5Id}/tree?forCourseId=${courseId}`).set(bearer(teacherToken));
    expect(tree.status).toBe(200);
    const plainTree = await http(app).get(`/api/v1/curriculum/curricula/${curriculum5Id}/tree`).set(bearer(teacherToken));
    expect(plainTree.status).toBe(403);
  });

  it('applies a topic frame: one section carrying exactly the topic outcomes from the dataset', async () => {
    const topic = findByPath(tree5, ['Số và phép tính', 'Phân số', 'Số thập phân']);
    expect(topic).toBeTruthy();
    const res = await http(app).post(`/api/v1/courses/${courseId}/curriculum-frame`).set(bearer(teacherToken))
      .send({ curriculumId: curriculum5Id, nodeIds: [topic!.id] });
    expect(res.status).toBe(201);
    const created = res.body as { section: number; name: string; frame: { nodeId: string; nodeTitle: string; outcomes: { content: string }[] } }[];
    expect(created.length).toBe(1);
    expect(created[0]!.section).toBe(1);
    expect(created[0]!.name).toBe('Số thập phân');
    expect(created[0]!.frame.nodeId).toBe(topic!.id);
    expect(created[0]!.frame.outcomes.map((o) => o.content))
      .toEqual(expectedUnitOutcomes(5, 'Số và phép tính', 'Phân số', 'Số thập phân'));
  });

  it('inserts a section-level frame at a position and the outline shows anchored outcomes', async () => {
    const sectionNode = findByPath(tree5, ['Số và phép tính', 'Phân số']);
    expect(sectionNode).toBeTruthy();
    const res = await http(app).post(`/api/v1/courses/${courseId}/curriculum-frame`).set(bearer(teacherToken))
      .send({ curriculumId: curriculum5Id, nodeIds: [sectionNode!.id], insertAtSection: 1 });
    expect(res.status).toBe(201);
    expect((res.body as { section: number }[])[0]!.section).toBe(1);

    const content = await http(app).get(`/api/v1/courses/${courseId}/content`).set(bearer(teacherToken));
    expect(content.status).toBe(200);
    const sections = (content.body as { sections: { section: number; name: string | null; frame: { outcomes: { content: string }[] } | null }[] }).sections;
    expect(sections.map((s) => s.section)).toEqual([0, 1, 2]);
    expect(sections[1]!.name).toBe('Phân số');
    expect(sections[2]!.name).toBe('Số thập phân');
    expect(sections[1]!.frame?.outcomes.map((o) => o.content))
      .toEqual(expectedUnitOutcomes(5, 'Số và phép tính', 'Phân số'));
    expect(sections[2]!.frame?.outcomes.map((o) => o.content))
      .toEqual(expectedUnitOutcomes(5, 'Số và phép tính', 'Phân số', 'Số thập phân'));
    expect(sections[0]!.frame).toBeNull();
  });

  it('editing the programme tree afterwards does NOT change the applied course (snapshots hold)', async () => {
    const topic = findByPath(tree5, ['Số và phép tính', 'Phân số', 'Số thập phân'])!;
    const lesson = topic.children.find((n) => n.kind === 'lesson')!;
    const outcome = lesson.outcomes[0]!;
    const renamed = await http(app).patch(`/api/v1/curriculum/nodes/${topic.id}`).set(bearer(admin))
      .send({ title: 'Số thập phân (ĐÃ SỬA THỬ)' });
    expect(renamed.status).toBe(200);
    const edited = await http(app).patch(`/api/v1/curriculum/outcomes/${outcome.id}`).set(bearer(admin))
      .send({ content: 'YCCĐ ĐÃ SỬA THỬ — không được rò vào khoá' });
    expect(edited.status).toBe(200);
    try {
      const content = await http(app).get(`/api/v1/courses/${courseId}/content`).set(bearer(teacherToken));
      const sections = (content.body as { sections: { name: string | null; frame: { outcomes: { content: string }[] } | null }[] }).sections;
      const topicSection = sections.find((s) => s.frame && s.name === 'Số thập phân');
      expect(topicSection).toBeTruthy();
      expect(topicSection!.frame?.outcomes.map((o) => o.content))
        .toEqual(expectedUnitOutcomes(5, 'Số và phép tính', 'Phân số', 'Số thập phân'));
      expect(sections.some((s) => s.name?.includes('ĐÃ SỬA THỬ'))).toBe(false);
    } finally {
      // Khôi phục nguyên trạng cây chương trình cho các spec khác trong cùng DB.
      await http(app).patch(`/api/v1/curriculum/nodes/${topic.id}`).set(bearer(admin)).send({ title: 'Số thập phân' });
      await http(app).patch(`/api/v1/curriculum/outcomes/${outcome.id}`).set(bearer(admin)).send({ content: outcome.content });
    }
  });

  it('denies frame application without course:update and rejects non-selectable nodes', async () => {
    const topic = findByPath(tree5, ['Số và phép tính', 'Phân số', 'Số thập phân'])!;
    const plain = await http(app).post(`/api/v1/courses/${courseId}/curriculum-frame`).set(bearer(plainToken))
      .send({ curriculumId: curriculum5Id, nodeIds: [topic.id] });
    expect(plain.status).toBe(403);
    const lesson = topic.children.find((n) => n.kind === 'lesson')!;
    const lessonPick = await http(app).post(`/api/v1/courses/${courseId}/curriculum-frame`).set(bearer(teacherToken))
      .send({ curriculumId: curriculum5Id, nodeIds: [lesson.id] });
    expect(lessonPick.status).toBe(400);
    expect(lessonPick.body.code).toBe('course.frame_node_not_selectable');
    const bogusCurr = await http(app).post(`/api/v1/courses/${courseId}/curriculum-frame`).set(bearer(teacherToken))
      .send({ curriculumId: '01961e2a-7b3c-7def-8abc-0123456789ab', nodeIds: [topic.id] });
    expect(bogusCurr.status).toBe(404);
  });
});

import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId, uniqueName,
} from './identity-access-helpers';
import { createCategory, fixtureClassId } from './course-enrolment-helpers';
import { contextIdByLevelInstance } from './engagement-helpers';

/**
 * K0a (việc nối tiếp issue #66) — nạp khung chương trình phải IDEMPOTENT
 * theo node: nạp lại một node đã có section trong khoá thì bỏ qua node
 * đó (không sinh section trùng mang cùng neo), và kết quả trả về chỉ
 * đếm các section THẬT SỰ vừa tạo. Trộn node cũ + node mới trong một
 * lượt nạp: chỉ node mới thành section, neo cũ giữ nguyên vị trí.
 * Mô hình người dùng thử bám spec nạp khung gốc: coursecreator tại
 * context danh mục.
 */

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

interface ContentSection {
  section: number; name: string | null;
  frame: { nodeId: string; nodeTitle: string; outcomes: { content: string }[] } | null;
}

describe('K0a curriculum frame re-application is idempotent per node', () => {
  let app: INestApplication;
  let teacherToken: string;
  let curriculum5Id: string;
  let tree5: TreeNode[];
  let courseId: string;

  async function applyFrame(nodeIds: string[], insertAtSection?: number) {
    return http(app).post(`/api/v1/courses/${courseId}/curriculum-frame`).set(bearer(teacherToken))
      .send({ curriculumId: curriculum5Id, nodeIds, ...(insertAtSection !== undefined ? { insertAtSection } : {}) });
  }
  async function outline(): Promise<ContentSection[]> {
    const content = await http(app).get(`/api/v1/courses/${courseId}/content`).set(bearer(teacherToken));
    expect(content.status).toBe(200);
    return (content.body as { sections: ContentSection[] }).sections;
  }

  beforeAll(async () => {
    app = await createTestApp();
    const admin = await adminToken(app);
    const systemCtxId = await systemContextId(app, admin);
    // Nạp dataset Toán (idempotent — spec khác có thể đã nạp trong cùng DB).
    const imp = await http(app).post('/api/v1/curriculum/program-import').set(bearer(admin)).send({ datasetKey: 'toan' });
    expect(imp.status).toBe(201);

    const category = await createCategory(app, admin);
    const categoryCtxId = await contextIdByLevelInstance(app, admin, 40, category.id);
    const teacher = await createUserViaApi(app, admin);
    await assignRole(app, admin, teacher.id, await roleIdByShortname(app, admin, 'coursecreator'), categoryCtxId);
    teacherToken = (await login(app, teacher.username, STRONG_PASSWORD)).accessToken;

    const subjects = await http(app).get(`/api/v1/curriculum/subjects?contextId=${systemCtxId}`).set(bearer(admin));
    const subjectId = (subjects.body as { id: string; slug: string }[]).find((s) => s.slug === 'toan')!.id;
    const curricula = await http(app).get(`/api/v1/curriculum/curricula?subjectId=${subjectId}`).set(bearer(admin));
    curriculum5Id = (curricula.body as { id: string; grade: number }[]).find((c) => c.grade === 5)!.id;
    const tree = await http(app).get(`/api/v1/curriculum/curricula/${curriculum5Id}/tree`).set(bearer(admin));
    expect(tree.status).toBe(200);
    tree5 = (tree.body as { nodes: TreeNode[] }).nodes;

    const res = await http(app).post('/api/v1/courses').set(bearer(teacherToken)).send({
      fullName: 'Toán 5 — nạp khung idempotent', shortName: uniqueName('toan5idem'), category: category.id,
      subjectId, grade: 5, classId: await fixtureClassId(app, teacherToken),
    });
    expect(res.status).toBe(201);
    courseId = res.body.id as string;
  }, 180_000);
  afterAll(async () => { await app.close(); });

  it('first application creates one anchored section for the topic', async () => {
    const topic = findByPath(tree5, ['Số và phép tính', 'Phân số', 'Số thập phân']);
    expect(topic).toBeTruthy();
    const res = await applyFrame([topic!.id]);
    expect(res.status).toBe(201);
    const created = res.body as { section: number; frame: { nodeId: string } }[];
    expect(created.length).toBe(1);
    expect(created[0]!.frame.nodeId).toBe(topic!.id);
  });

  it('re-applying the same node creates NO duplicate section and reports zero created', async () => {
    const topic = findByPath(tree5, ['Số và phép tính', 'Phân số', 'Số thập phân'])!;
    const res = await applyFrame([topic.id]);
    expect(res.status).toBe(201);
    expect((res.body as unknown[]).length).toBe(0);

    const sections = await outline();
    expect(sections.map((s) => s.section)).toEqual([0, 1]);
    expect(sections.filter((s) => s.frame?.nodeId === topic.id).length).toBe(1);
  });

  it('re-applying with insertAtSection is also a no-op for the outline', async () => {
    const topic = findByPath(tree5, ['Số và phép tính', 'Phân số', 'Số thập phân'])!;
    const res = await applyFrame([topic.id], 1);
    expect(res.status).toBe(201);
    expect((res.body as unknown[]).length).toBe(0);

    const sections = await outline();
    expect(sections.map((s) => s.section)).toEqual([0, 1]);
    expect(sections[1]!.frame?.nodeId).toBe(topic.id);
  });

  it('a mixed batch (already-applied node + new node) creates only the new section', async () => {
    const topic = findByPath(tree5, ['Số và phép tính', 'Phân số', 'Số thập phân'])!;
    const sectionNode = findByPath(tree5, ['Số và phép tính', 'Phân số'])!;
    const res = await applyFrame([topic.id, sectionNode.id]);
    expect(res.status).toBe(201);
    const created = res.body as { section: number; name: string; frame: { nodeId: string } }[];
    expect(created.length).toBe(1);
    expect(created[0]!.frame.nodeId).toBe(sectionNode.id);
    expect(created[0]!.section).toBe(2);

    const sections = await outline();
    expect(sections.map((s) => s.section)).toEqual([0, 1, 2]);
    expect(sections.filter((s) => s.frame?.nodeId === topic.id).length).toBe(1);
    expect(sections.filter((s) => s.frame?.nodeId === sectionNode.id).length).toBe(1);
    expect(sections[1]!.frame?.nodeId).toBe(topic.id);
    expect(sections[2]!.frame?.nodeId).toBe(sectionNode.id);
  });

  it('a duplicate node inside a single request still creates only one section', async () => {
    const stream = findByPath(tree5, ['Số và phép tính'])!;
    const res = await applyFrame([stream.id, stream.id]);
    expect(res.status).toBe(201);
    const created = res.body as { frame: { nodeId: string } }[];
    expect(created.filter((c) => c.frame.nodeId === stream.id).length).toBe(1);
    const sections = await outline();
    expect(sections.filter((s) => s.frame?.nodeId === stream.id).length).toBe(1);
  });
});

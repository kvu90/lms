import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId,
} from './identity-access-helpers';

/**
 * K0a (issue #66) — cơ chế nạp dữ liệu chương trình chuẩn GDPT 2018.
 * Oracle: chính các file dataset đã kiểm chứng nguyên văn với văn bản
 * ban hành kèm Thông tư 32/2018/TT-BGDĐT (hồ sơ kiểm chứng của dự án:
 * Toán 300/300, Ngữ văn 238/238, 0 chênh lệch chữ) — bản sao vendor tại
 * `src/modules/curriculum/program-data/`. Spec này đối chiếu TỪNG bản
 * ghi qua API cây: vị trí trong cây (mạch → section → topic → nội dung),
 * toàn bộ YCCĐ theo thứ tự, và truy vết nguồn (source_ref chứa mã bản
 * ghi + trang) — khớp 100% mới đạt, theo đúng tiêu chí xong của issue.
 */

interface ProgramRecord {
  id: string; subject: string; grade: number; stream: string;
  section: string | null; topic: string | null; content: string;
  outcomes: string[]; outcome_text: string;
  source: { document: string; file: string; pdf_pages: number[] };
}
interface ProgramDataset { records: ProgramRecord[] }

function loadDataset(fileName: string): ProgramDataset {
  return JSON.parse(readFileSync(join(process.cwd(), 'src/modules/curriculum/program-data', fileName), 'utf8')) as ProgramDataset;
}

/** Các dòng YCCĐ kỳ vọng của một bản ghi — cùng quy tắc với cơ chế nạp (outcomes[] → từng dòng; rỗng + outcome_text → một dòng; cả hai rỗng → không dòng). */
function expectedOutcomeTexts(r: ProgramRecord): string[] {
  if (r.outcomes.length > 0) return [...r.outcomes];
  if (r.outcome_text.trim().length > 0) return [r.outcome_text];
  return [];
}

/** Đường tổ tiên kỳ vọng của một bản ghi: mạch (stream) → section → topic. */
function expectedPath(r: ProgramRecord): string[] {
  const path = [r.stream];
  if (r.section) path.push(r.section);
  if (r.topic) path.push(r.topic);
  return path;
}

interface TreeNode {
  id: string; title: string; kind: string;
  outcomes: { id: string; content: string; position: number; sourceKind: string; sourceRef: string | null }[];
  children: TreeNode[];
}
interface FlatLesson { path: string[]; title: string; outcomes: TreeNode['outcomes'] }

function flattenLessons(nodes: TreeNode[], prefix: string[], out: FlatLesson[]): void {
  for (const node of nodes) {
    if (node.kind === 'lesson') out.push({ path: prefix, title: node.title, outcomes: node.outcomes });
    flattenLessons(node.children, [...prefix, node.title], out);
  }
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('K0a program import (verified GDPT 2018 datasets → programme tree)', () => {
  let app: INestApplication;
  let admin: string;
  let systemCtxId: string;
  let plainToken: string;
  let teacherToken: string;
  const toan = loadDataset('program-toan.json');
  const nguvan = loadDataset('program-nguvan.json');

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    systemCtxId = await systemContextId(app, admin);
    const plain = await createUserViaApi(app, admin);
    plainToken = (await login(app, plain.username, STRONG_PASSWORD)).accessToken;
    const teacher = await createUserViaApi(app, admin);
    await assignRole(app, admin, teacher.id, await roleIdByShortname(app, admin, 'editingteacher'), systemCtxId);
    teacherToken = (await login(app, teacher.username, STRONG_PASSWORD)).accessToken;
  }, 120_000);
  afterAll(async () => { await app.close(); });

  async function treeLessons(subjectSlug: string, grade: number): Promise<FlatLesson[]> {
    const subjects = await http(app).get(`/api/v1/curriculum/subjects?contextId=${systemCtxId}`).set(bearer(admin));
    expect(subjects.status).toBe(200);
    const subject = (subjects.body as { id: string; slug: string }[]).find((s) => s.slug === subjectSlug);
    expect(subject, `subject ${subjectSlug}`).toBeTruthy();
    const curricula = await http(app).get(`/api/v1/curriculum/curricula?subjectId=${subject!.id}`).set(bearer(admin));
    const curriculum = (curricula.body as { id: string; grade: number }[]).find((c) => c.grade === grade);
    expect(curriculum, `curriculum grade ${grade}`).toBeTruthy();
    const tree = await http(app).get(`/api/v1/curriculum/curricula/${curriculum!.id}/tree`).set(bearer(admin));
    expect(tree.status).toBe(200);
    const out: FlatLesson[] = [];
    flattenLessons((tree.body as { nodes: TreeNode[] }).nodes, [], out);
    return out;
  }

  /** Đối chiếu toàn bộ bản ghi của một dataset với cây đã nạp, từng bản ghi một. */
  async function verifyDatasetAgainstTree(slug: string, dataset: ProgramDataset): Promise<void> {
    const grades = [...new Set(dataset.records.map((r) => r.grade))].sort((a, b) => a - b);
    let lessonTotal = 0;
    for (const grade of grades) {
      const lessons = await treeLessons(slug, grade);
      const records = dataset.records.filter((r) => r.grade === grade);
      expect(lessons.length, `grade ${grade} lesson count`).toBe(records.length);
      expect(
        lessons.reduce((n, l) => n + l.outcomes.length, 0),
        `grade ${grade} outcome count`,
      ).toBe(records.reduce((n, r) => n + expectedOutcomeTexts(r).length, 0));
      lessonTotal += lessons.length;
      for (const record of records) {
        const texts = expectedOutcomeTexts(record);
        // Truy bản ghi qua truy vết nguồn: mọi YCCĐ của nó mang source_ref chứa mã bản ghi.
        const mine = lessons.flatMap((l) => l.outcomes.map((o) => ({ lesson: l, outcome: o })))
          .filter((x) => x.outcome.sourceRef?.includes(`bản ghi ${record.id}`));
        if (texts.length === 0) {
          expect(mine.length, `${record.id} must have no outcomes`).toBe(0);
          // Node nội dung vẫn phải tồn tại đúng vị trí với tựa nguyên văn.
          const atPath = lessons.filter((l) => l.title === record.content
            && JSON.stringify(l.path) === JSON.stringify(expectedPath(record)));
          expect(atPath.length, `${record.id} lesson at path`).toBe(1);
          continue;
        }
        expect(mine.length, `${record.id} outcome count`).toBe(texts.length);
        const lesson = mine[0]!.lesson;
        expect(lesson.title, `${record.id} lesson title`).toBe(record.content);
        expect(lesson.path, `${record.id} lesson path`).toEqual(expectedPath(record));
        const ordered = [...mine].sort((a, b) => a.outcome.position - b.outcome.position);
        expect(ordered.map((x) => x.outcome.content), `${record.id} outcome texts`).toEqual(texts);
        for (const x of mine) {
          expect(x.outcome.sourceKind).toBe('program');
          for (const page of record.source.pdf_pages) {
            expect(x.outcome.sourceRef).toContain(String(page));
          }
        }
      }
    }
    expect(lessonTotal).toBe(dataset.records.length);
  }

  it('reports dataset status before import and denies users without curriculum capabilities', async () => {
    const status = await http(app).get('/api/v1/curriculum/program-import').set(bearer(admin));
    expect(status.status).toBe(200);
    const rows = status.body as { datasetKey: string; totalRecords: number; importedRecords: number; subjectId: string | null }[];
    const toanRow = rows.find((r) => r.datasetKey === 'toan');
    const nguvanRow = rows.find((r) => r.datasetKey === 'nguvan');
    expect(toanRow?.totalRecords).toBe(300);
    expect(nguvanRow?.totalRecords).toBe(238);
    // importedRecords có thể đã > 0 nếu một spec khác trong cùng DB đã nạp — chỉ chốt tổng số bản ghi ở đây.

    const plainStatus = await http(app).get('/api/v1/curriculum/program-import').set(bearer(plainToken));
    expect(plainStatus.status).toBe(403);
    expect(plainStatus.body.code).toBe('access.capability_denied');
    const plainImport = await http(app).post('/api/v1/curriculum/program-import').set(bearer(plainToken)).send({ datasetKey: 'toan' });
    expect(plainImport.status).toBe(403);
    expect(plainImport.body.code).toBe('access.capability_denied');
    // Giáo viên có curriculum:view nhưng không có curriculum:manage → đọc trạng thái được, nạp bị từ chối.
    const teacherStatus = await http(app).get('/api/v1/curriculum/program-import').set(bearer(teacherToken));
    expect(teacherStatus.status).toBe(200);
    const teacherImport = await http(app).post('/api/v1/curriculum/program-import').set(bearer(teacherToken)).send({ datasetKey: 'toan' });
    expect(teacherImport.status).toBe(403);
    // Dataset không có trong manifest → 404 tường minh.
    const bogus = await http(app).post('/api/v1/curriculum/program-import').set(bearer(admin)).send({ datasetKey: 'sinh-hoc' });
    expect(bogus.status).toBe(404);
    expect(bogus.body.code).toBe('curriculum.program_dataset_not_found');
  });

  it('imports Toán and matches every verified record in the tree (incl. the faithful TOAN-0096 typo)', async () => {
    const res = await http(app).post('/api/v1/curriculum/program-import').set(bearer(admin)).send({ datasetKey: 'toan' });
    expect(res.status).toBe(201);
    const result = res.body as { totalRecords: number; created: number; updated: number; skipped: number; outcomesWritten: number };
    expect(result.totalRecords).toBe(300);
    expect(result.created + result.updated + result.skipped).toBe(300);
    const expectedOutcomes = toan.records.reduce((n, r) => n + expectedOutcomeTexts(r).length, 0);
    if (result.created === 300) expect(result.outcomesWritten).toBe(expectedOutcomes);

    await verifyDatasetAgainstTree('toan', toan);

    // TOAN-0096: lỗi in "thí 2 nghiệm" có thật trong PDF của Bộ — nạp phải giữ nguyên văn, không tự sửa.
    const lessons5 = await treeLessons('toan', 5);
    const typo = lessons5.flatMap((l) => l.outcomes).find((o) => o.sourceRef?.includes('bản ghi TOAN-0096'));
    expect(typo?.content).toContain('thí 2 nghiệm');
  }, 180_000);

  it('re-importing Toán is a no-op: every record skipped, tree counts unchanged', async () => {
    const before = await http(app).get('/api/v1/curriculum/program-import').set(bearer(admin));
    const beforeRow = (before.body as { datasetKey: string; importedRecords: number }[]).find((r) => r.datasetKey === 'toan');
    expect(beforeRow?.importedRecords).toBe(300);
    const res = await http(app).post('/api/v1/curriculum/program-import').set(bearer(admin)).send({ datasetKey: 'toan' });
    expect(res.status).toBe(201);
    const result = res.body as { created: number; updated: number; skipped: number };
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(300);
    const lessons5 = await treeLessons('toan', 5);
    expect(lessons5.length).toBe(toan.records.filter((r) => r.grade === 5).length);
  }, 180_000);

  it('imports Ngữ văn (incl. primary Tiếng Việt records) and matches every verified record', async () => {
    const res = await http(app).post('/api/v1/curriculum/program-import').set(bearer(admin)).send({ datasetKey: 'nguvan' });
    expect(res.status).toBe(201);
    const result = res.body as { totalRecords: number; created: number; updated: number; skipped: number };
    expect(result.totalRecords).toBe(238);
    expect(result.created + result.updated + result.skipped).toBe(238);
    await verifyDatasetAgainstTree('ngu-van', nguvan);
  }, 180_000);
});

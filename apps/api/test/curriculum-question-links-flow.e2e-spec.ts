import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD, systemContextId, uniqueName,
} from './identity-access-helpers';

/**
 * Curriculum Chặng 2 của issue #20 (theo hồ sơ thiết kế tổng hợp, mục A):
 * hai bảng nối ở cấp DANH TÍNH câu hỏi (question_subjects,
 * question_learning_outcomes), mức độ nhận thức nằm trên dòng nối
 * câu × YCCĐ (biet/hieu/van_dung + van_dung_cao dự phòng), truy vết
 * nguồn nguyên văn chương trình cho learning_outcomes (A.3), và sửa lỗi
 * updateNode chưa chặn vòng cha–con gián tiếp (A.7).
 */

const RANDOM_UUID = '018e0000-0000-7000-8000-000000000000';

interface LinksView { questionId: string; subjectIds: string[]; outcomes: { outcomeId: string; cognitiveLevel: string }[] }
interface OutcomeRow { id: string; sourceKind: string; sourceRef: string | null; derivedFromId: string | null }

describe('Curriculum phase 2 (question ↔ programme links)', () => {
  let app: INestApplication;
  let admin: string;
  let systemCtxId: string;
  let plainToken: string;
  let pg: Client;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    systemCtxId = await systemContextId(app, admin);
    const plain = await createUserViaApi(app, admin);
    plainToken = (await login(app, plain.username, STRONG_PASSWORD)).accessToken;
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
  });
  afterAll(async () => { await pg.end(); await app.close(); });

  /** Dựng một môn + chương trình khối 10 + cây strand → topic → lesson, mỗi node một outcome; trả mọi id. */
  async function mkTree(): Promise<{ subjectId: string; curriculumId: string; topicId: string; lessonId: string; outcomeTopic: string; outcomeLesson: string }> {
    const subjectRes = await http(app).post('/api/v1/curriculum/subjects').set(bearer(admin))
      .send({ contextId: systemCtxId, name: 'Môn kiểm chứng', slug: uniqueName('mon') });
    expect(subjectRes.status).toBe(201);
    const subjectId = (subjectRes.body as { id: string }).id;
    const currRes = await http(app).post('/api/v1/curriculum/curricula').set(bearer(admin))
      .send({ subjectId, grade: 10 });
    expect(currRes.status).toBe(201);
    const curriculumId = (currRes.body as { id: string }).id;
    const mkNode = async (parentId: string | null, title: string, kind: string) => {
      const res = await http(app).post('/api/v1/curriculum/nodes').set(bearer(admin))
        .send({ curriculumId, parentId, title, kind });
      expect(res.status).toBe(201);
      return (res.body as { id: string }).id;
    };
    const strandId = await mkNode(null, 'Mạch số', 'strand');
    const topicId = await mkNode(strandId, 'Hàm số', 'topic');
    const lessonId = await mkNode(topicId, 'Tính đơn điệu của hàm số', 'lesson');
    const mkOutcome = async (nodeId: string, content: string) => {
      const res = await http(app).post('/api/v1/curriculum/outcomes').set(bearer(admin))
        .send({ nodeId, content });
      expect(res.status).toBe(201);
      return (res.body as { id: string }).id;
    };
    const outcomeTopic = await mkOutcome(topicId, 'Nhận biết được khái niệm hàm số.');
    const outcomeLesson = await mkOutcome(lessonId, 'Xét được tính đơn điệu của hàm số.');
    return { subjectId, curriculumId, topicId, lessonId, outcomeTopic, outcomeLesson };
  }

  async function mkCategory(): Promise<string> {
    const res = await http(app).post('/api/v1/questions/categories').set(bearer(admin))
      .send({ name: uniqueName('cat'), contextId: systemCtxId });
    expect(res.status).toBeLessThan(300);
    return (res.body as { id: string }).id;
  }

  async function mkQuestion(categoryId: string, qtype: 'multichoice' | 'truefalse'): Promise<string> {
    const body = qtype === 'multichoice'
      ? {
          categoryId, qtype, name: uniqueName('qmc'), questionText: 'Thủ đô của Pháp là?',
          answers: [{ text: 'Paris', fraction: 1 }, { text: 'London', fraction: 0 }],
        }
      : { categoryId, qtype, name: uniqueName('qtf'), questionText: 'Trời đang mưa.', answer: { correct: true } };
    const res = await http(app).post('/api/v1/questions').set(bearer(admin)).send(body);
    expect(res.status).toBeLessThan(300);
    return (res.body as { question: { id: string } }).question.id;
  }

  const getLinks = async (questionId: string, token = admin) =>
    http(app).get(`/api/v1/questions/${questionId}/curriculum-links`).set(bearer(token));

  it('runs the full subject + outcome link lifecycle at question identity level', async () => {
    const tree = await mkTree();
    const other = await mkTree();
    const categoryId = await mkCategory();
    const q = await mkQuestion(categoryId, 'multichoice');

    // Ban đầu chưa gắn gì.
    const empty = await getLinks(q);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ questionId: q, subjectIds: [], outcomes: [] });

    // Gắn môn; gắn trùng → 409; môn không tồn tại → 404.
    const attach = await http(app).post(`/api/v1/questions/${q}/subjects`).set(bearer(admin)).send({ subjectId: tree.subjectId });
    expect(attach.status).toBe(201);
    expect((attach.body as LinksView).subjectIds).toEqual([tree.subjectId]);
    const dup = await http(app).post(`/api/v1/questions/${q}/subjects`).set(bearer(admin)).send({ subjectId: tree.subjectId });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('question.subject_link_exists');
    const ghost = await http(app).post(`/api/v1/questions/${q}/subjects`).set(bearer(admin)).send({ subjectId: RANDOM_UUID });
    expect(ghost.status).toBe(404);
    expect(ghost.body.code).toBe('curriculum.subject_not_found');

    // Gắn YCCĐ kèm mức; gắn trùng → 409; mức không hợp lệ → 400 ở biên validate.
    const link = await http(app).post(`/api/v1/questions/${q}/outcomes`).set(bearer(admin))
      .send({ outcomeId: tree.outcomeTopic, cognitiveLevel: 'biet' });
    expect(link.status).toBe(201);
    expect((link.body as LinksView).outcomes).toEqual([{ outcomeId: tree.outcomeTopic, cognitiveLevel: 'biet' }]);
    const dupLink = await http(app).post(`/api/v1/questions/${q}/outcomes`).set(bearer(admin))
      .send({ outcomeId: tree.outcomeTopic, cognitiveLevel: 'hieu' });
    expect(dupLink.status).toBe(409);
    expect(dupLink.body.code).toBe('question.outcome_link_exists');
    const badLevel = await http(app).post(`/api/v1/questions/${q}/outcomes`).set(bearer(admin))
      .send({ outcomeId: tree.outcomeLesson, cognitiveLevel: 'kho' });
    expect(badLevel.status).toBe(400);

    // KHÔNG còn quy tắc lệch môn (vòng sửa F1): gắn YCCĐ thuộc môn khác
    // hẳn môn đã khai tường minh vẫn được — môn của câu khi lọc là hợp
    // nhất khai tường minh và môn suy ngược từ YCCĐ đã gắn. Gắn rồi gỡ
    // ngay để các khẳng định phía dưới giữ nguyên trạng thái.
    const crossSubject = await http(app).post(`/api/v1/questions/${q}/outcomes`).set(bearer(admin))
      .send({ outcomeId: other.outcomeTopic, cognitiveLevel: 'hieu' });
    expect(crossSubject.status).toBe(201);
    const detachCross = await http(app).delete(`/api/v1/questions/${q}/outcomes/${other.outcomeTopic}`).set(bearer(admin));
    expect(detachCross.status).toBe(200);
    expect((detachCross.body as LinksView).outcomes).toEqual([{ outcomeId: tree.outcomeTopic, cognitiveLevel: 'biet' }]);

    // Đổi mức trên dòng nối; đổi mức của dòng chưa gắn → 404.
    const relevel = await http(app).patch(`/api/v1/questions/${q}/outcomes/${tree.outcomeTopic}`).set(bearer(admin))
      .send({ cognitiveLevel: 'van_dung' });
    expect(relevel.status).toBe(200);
    expect((relevel.body as LinksView).outcomes).toEqual([{ outcomeId: tree.outcomeTopic, cognitiveLevel: 'van_dung' }]);
    const relevelGhost = await http(app).patch(`/api/v1/questions/${q}/outcomes/${tree.outcomeLesson}`).set(bearer(admin))
      .send({ cognitiveLevel: 'hieu' });
    expect(relevelGhost.status).toBe(404);
    expect(relevelGhost.body.code).toBe('question.outcome_link_not_found');

    // Sửa câu (ra version mới) KHÔNG làm mất gắn kết — gắn ở cấp danh tính.
    const edit = await http(app).patch(`/api/v1/questions/${q}`).set(bearer(admin)).send({ name: 'Câu đã sửa tên' });
    expect(edit.status).toBe(200);
    const afterEdit = await getLinks(q);
    expect((afterEdit.body as LinksView).subjectIds).toEqual([tree.subjectId]);
    expect((afterEdit.body as LinksView).outcomes).toEqual([{ outcomeId: tree.outcomeTopic, cognitiveLevel: 'van_dung' }]);

    // Gỡ gắn YCCĐ rồi gỡ gắn môn; gỡ lần hai → 404.
    const detachOutcome = await http(app).delete(`/api/v1/questions/${q}/outcomes/${tree.outcomeTopic}`).set(bearer(admin));
    expect(detachOutcome.status).toBe(200);
    expect((detachOutcome.body as LinksView).outcomes).toEqual([]);
    const detachOutcome2 = await http(app).delete(`/api/v1/questions/${q}/outcomes/${tree.outcomeTopic}`).set(bearer(admin));
    expect(detachOutcome2.status).toBe(404);
    expect(detachOutcome2.body.code).toBe('question.outcome_link_not_found');
    const detachSubject = await http(app).delete(`/api/v1/questions/${q}/subjects/${tree.subjectId}`).set(bearer(admin));
    expect(detachSubject.status).toBe(200);
    expect((detachSubject.body as LinksView).subjectIds).toEqual([]);
    const detachSubject2 = await http(app).delete(`/api/v1/questions/${q}/subjects/${tree.subjectId}`).set(bearer(admin));
    expect(detachSubject2.status).toBe(404);
    expect(detachSubject2.body.code).toBe('question.subject_link_not_found');

    // Câu hỏi không tồn tại → 404.
    const ghostQ = await getLinks(RANDOM_UUID);
    expect(ghostQ.status).toBe(404);
    expect(ghostQ.body.code).toBe('question.not_found');
  });

  it('allows an outcome link without a prior subject link (subject is derived from the outcome)', async () => {
    const tree = await mkTree();
    const categoryId = await mkCategory();
    const q = await mkQuestion(categoryId, 'truefalse');
    const link = await http(app).post(`/api/v1/questions/${q}/outcomes`).set(bearer(admin))
      .send({ outcomeId: tree.outcomeLesson, cognitiveLevel: 'hieu' });
    expect(link.status).toBe(201);
    expect((link.body as LinksView).subjectIds).toEqual([]);
    expect((link.body as LinksView).outcomes).toEqual([{ outcomeId: tree.outcomeLesson, cognitiveLevel: 'hieu' }]);
    // Lọc theo môn vẫn tìm thấy câu qua YCCĐ thuộc môn đó.
    const bySubject = await http(app).get('/api/v1/questions').query({ subjectId: tree.subjectId }).set(bearer(admin));
    expect(bySubject.status).toBe(200);
    expect((bySubject.body as { question: { id: string } }[]).map((v) => v.question.id)).toContain(q);
  });

  it('keeps both subject doors open after an outcome of another subject is linked (F1 regression)', async () => {
    const treeA = await mkTree();
    const treeB = await mkTree();
    const categoryId = await mkCategory();

    // Cửa 1 — gắn YCCĐ của môn B TRƯỚC, khai môn A SAU: trước vòng sửa,
    // gắn tiếp YCCĐ thứ hai của B bị 400 outcome_subject_mismatch dù câu
    // đã mang sẵn một YCCĐ của B. Nay cả ba thao tác đều 201.
    const q1 = await mkQuestion(categoryId, 'multichoice');
    const linkB1 = await http(app).post(`/api/v1/questions/${q1}/outcomes`).set(bearer(admin))
      .send({ outcomeId: treeB.outcomeTopic, cognitiveLevel: 'biet' });
    expect(linkB1.status).toBe(201);
    const attachA = await http(app).post(`/api/v1/questions/${q1}/subjects`).set(bearer(admin))
      .send({ subjectId: treeA.subjectId });
    expect(attachA.status).toBe(201);
    const linkB2 = await http(app).post(`/api/v1/questions/${q1}/outcomes`).set(bearer(admin))
      .send({ outcomeId: treeB.outcomeLesson, cognitiveLevel: 'hieu' });
    expect(linkB2.status).toBe(201);
    const links1 = await getLinks(q1);
    expect((links1.body as LinksView).subjectIds).toEqual([treeA.subjectId]);
    expect((links1.body as LinksView).outcomes).toEqual(expect.arrayContaining([
      { outcomeId: treeB.outcomeTopic, cognitiveLevel: 'biet' },
      { outcomeId: treeB.outcomeLesson, cognitiveLevel: 'hieu' },
    ]));
    // Môn của câu khi lọc là hợp nhất: lọc theo B vẫn thấy câu qua YCCĐ.
    const bySubjectB = await http(app).get('/api/v1/questions').query({ subjectId: treeB.subjectId }).set(bearer(admin));
    expect((bySubjectB.body as { question: { id: string } }[]).map((v) => v.question.id)).toContain(q1);

    // Cửa 2 — câu khai {A, B} và đã gắn YCCĐ của B; gỡ môn B → 200, rồi
    // gắn tiếp YCCĐ của B phải 201 (trước vòng sửa bị 400 như cửa 1).
    const q2 = await mkQuestion(categoryId, 'truefalse');
    const attachA2 = await http(app).post(`/api/v1/questions/${q2}/subjects`).set(bearer(admin))
      .send({ subjectId: treeA.subjectId });
    expect(attachA2.status).toBe(201);
    const attachB2 = await http(app).post(`/api/v1/questions/${q2}/subjects`).set(bearer(admin))
      .send({ subjectId: treeB.subjectId });
    expect(attachB2.status).toBe(201);
    const linkQ2 = await http(app).post(`/api/v1/questions/${q2}/outcomes`).set(bearer(admin))
      .send({ outcomeId: treeB.outcomeTopic, cognitiveLevel: 'biet' });
    expect(linkQ2.status).toBe(201);
    const detachB = await http(app).delete(`/api/v1/questions/${q2}/subjects/${treeB.subjectId}`).set(bearer(admin));
    expect(detachB.status).toBe(200);
    expect((detachB.body as LinksView).subjectIds).toEqual([treeA.subjectId]);
    const linkQ2b = await http(app).post(`/api/v1/questions/${q2}/outcomes`).set(bearer(admin))
      .send({ outcomeId: treeB.outcomeLesson, cognitiveLevel: 'van_dung' });
    expect(linkQ2b.status).toBe(201);
    const links2 = await getLinks(q2);
    expect((links2.body as LinksView).outcomes).toEqual(expect.arrayContaining([
      { outcomeId: treeB.outcomeTopic, cognitiveLevel: 'biet' },
      { outcomeId: treeB.outcomeLesson, cognitiveLevel: 'van_dung' },
    ]));
  });

  it('gates link writes by question edit capability at the category context', async () => {
    const tree = await mkTree();
    const categoryId = await mkCategory();
    const q = await mkQuestion(categoryId, 'multichoice');
    const denied = await http(app).post(`/api/v1/questions/${q}/subjects`).set(bearer(plainToken)).send({ subjectId: tree.subjectId });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('access.capability_denied');
    const deniedOutcome = await http(app).post(`/api/v1/questions/${q}/outcomes`).set(bearer(plainToken))
      .send({ outcomeId: tree.outcomeTopic, cognitiveLevel: 'biet' });
    expect(deniedOutcome.status).toBe(403);
  });

  it('filters the bank by subject, outcome, cognitive level, qtype and status', async () => {
    const tree = await mkTree();
    const categoryId = await mkCategory();
    const mc = await mkQuestion(categoryId, 'multichoice');
    const tf = await mkQuestion(categoryId, 'truefalse');
    await http(app).post(`/api/v1/questions/${mc}/subjects`).set(bearer(admin)).send({ subjectId: tree.subjectId });
    await http(app).post(`/api/v1/questions/${mc}/outcomes`).set(bearer(admin))
      .send({ outcomeId: tree.outcomeTopic, cognitiveLevel: 'biet' });
    await http(app).post(`/api/v1/questions/${tf}/outcomes`).set(bearer(admin))
      .send({ outcomeId: tree.outcomeTopic, cognitiveLevel: 'hieu' });

    const ids = (body: unknown) => (body as { question: { id: string } }[]).map((v) => v.question.id);
    const bySubject = await http(app).get('/api/v1/questions').query({ subjectId: tree.subjectId }).set(bearer(admin));
    expect(ids(bySubject.body)).toEqual(expect.arrayContaining([mc, tf]));
    const byOutcome = await http(app).get('/api/v1/questions').query({ outcomeId: tree.outcomeTopic }).set(bearer(admin));
    expect(ids(byOutcome.body)).toEqual(expect.arrayContaining([mc, tf]));
    // outcomeId + cognitiveLevel phải khớp trên CÙNG một dòng nối.
    const sameRow = await http(app).get('/api/v1/questions')
      .query({ outcomeId: tree.outcomeTopic, cognitiveLevel: 'hieu' }).set(bearer(admin));
    expect(ids(sameRow.body)).toContain(tf);
    expect(ids(sameRow.body)).not.toContain(mc);
    const byLevelOnly = await http(app).get('/api/v1/questions').query({ cognitiveLevel: 'van_dung_cao' }).set(bearer(admin));
    expect(ids(byLevelOnly.body)).not.toContain(mc);
    expect(ids(byLevelOnly.body)).not.toContain(tf);
    // Lọc thêm theo dạng câu.
    const byType = await http(app).get('/api/v1/questions')
      .query({ subjectId: tree.subjectId, qtype: 'truefalse' }).set(bearer(admin));
    expect(ids(byType.body)).toContain(tf);
    expect(ids(byType.body)).not.toContain(mc);
    // Lọc theo trạng thái bank entry.
    const byStatus = await http(app).get('/api/v1/questions')
      .query({ subjectId: tree.subjectId, status: 'ready' }).set(bearer(admin));
    expect(ids(byStatus.body)).toEqual(expect.arrayContaining([mc, tf]));
    const byBadStatus = await http(app).get('/api/v1/questions')
      .query({ subjectId: tree.subjectId, status: 'archived' }).set(bearer(admin));
    expect(ids(byBadStatus.body)).not.toContain(mc);
    // Bộ lọc không hợp lệ → 400 tường minh.
    const badUuid = await http(app).get('/api/v1/questions').query({ subjectId: 'khong-phai-uuid' }).set(bearer(admin));
    expect(badUuid.status).toBe(400);
    expect(badUuid.body.code).toBe('question.invalid_filter');
    const badLevelFilter = await http(app).get('/api/v1/questions').query({ cognitiveLevel: 'kho' }).set(bearer(admin));
    expect(badLevelFilter.status).toBe(400);
    expect(badLevelFilter.body.code).toBe('question.invalid_cognitive_level');
  });

  it('counts ready questions per (level x qtype) for an outcome', async () => {
    const tree = await mkTree();
    const categoryId = await mkCategory();
    const mcBiet = await mkQuestion(categoryId, 'multichoice');
    const tfBiet = await mkQuestion(categoryId, 'truefalse');
    const mcHieu = await mkQuestion(categoryId, 'multichoice');
    for (const [q, level] of [[mcBiet, 'biet'], [tfBiet, 'biet'], [mcHieu, 'hieu']] as const) {
      const res = await http(app).post(`/api/v1/questions/${q}/outcomes`).set(bearer(admin))
        .send({ outcomeId: tree.outcomeTopic, cognitiveLevel: level });
      expect(res.status).toBe(201);
    }
    const countsRes = await http(app).get(`/api/v1/curriculum/outcomes/${tree.outcomeTopic}/question-counts`).set(bearer(admin));
    expect(countsRes.status).toBe(200);
    const counts = (countsRes.body as { counts: { cognitiveLevel: string; qtype: string; count: number }[] }).counts;
    expect(counts).toEqual(expect.arrayContaining([
      { cognitiveLevel: 'biet', qtype: 'multichoice', count: 1 },
      { cognitiveLevel: 'biet', qtype: 'truefalse', count: 1 },
      { cognitiveLevel: 'hieu', qtype: 'multichoice', count: 1 },
    ]));
    expect(counts).toHaveLength(3);

    // Câu rời trạng thái ready thì không còn được đếm.
    await pg.query(`update question_bank_entries set status = 'draft' where question_id = $1`, [mcHieu]);
    const afterDraft = await http(app).get(`/api/v1/curriculum/outcomes/${tree.outcomeTopic}/question-counts`).set(bearer(admin));
    const countsAfter = (afterDraft.body as { counts: { cognitiveLevel: string; qtype: string; count: number }[] }).counts;
    expect(countsAfter).toHaveLength(2);
    expect(countsAfter.some((c) => c.cognitiveLevel === 'hieu')).toBe(false);

    // Quyền đọc cây curriculum được tôn trọng; outcome không tồn tại → 404.
    const denied = await http(app).get(`/api/v1/curriculum/outcomes/${tree.outcomeTopic}/question-counts`).set(bearer(plainToken));
    expect(denied.status).toBe(403);
    const ghost = await http(app).get(`/api/v1/curriculum/outcomes/${RANDOM_UUID}/question-counts`).set(bearer(admin));
    expect(ghost.status).toBe(404);
    expect(ghost.body.code).toBe('curriculum.outcome_not_found');
  });

  it('stores source tracing on learning outcomes (program vs derived)', async () => {
    const tree = await mkTree();
    // Mặc định: nguyên văn chương trình.
    const originRes = await http(app).get(`/api/v1/curriculum/outcomes/${tree.outcomeTopic}`).set(bearer(admin));
    expect(originRes.status).toBe(200);
    const origin = originRes.body as OutcomeRow;
    expect(origin.sourceKind).toBe('program');
    expect(origin.sourceRef).toBeNull();
    expect(origin.derivedFromId).toBeNull();

    // YCCĐ tách mức bởi tổ chuyên môn: trỏ về gốc + trích dẫn nguồn.
    const derivedRes = await http(app).post('/api/v1/curriculum/outcomes').set(bearer(admin)).send({
      nodeId: tree.topicId, content: 'Nhận biết được khái niệm hàm số (mức Biết).', position: 9,
      sourceKind: 'derived', sourceRef: 'TT 32/2018/TT-BGDĐT — CT môn Toán, lớp 10', derivedFromId: tree.outcomeTopic,
    });
    expect(derivedRes.status).toBe(201);
    const derived = derivedRes.body as OutcomeRow;
    expect(derived.sourceKind).toBe('derived');
    expect(derived.sourceRef).toBe('TT 32/2018/TT-BGDĐT — CT môn Toán, lớp 10');
    expect(derived.derivedFromId).toBe(tree.outcomeTopic);

    // derivedFromId chỉ dùng với sourceKind = derived.
    const mismatch = await http(app).post('/api/v1/curriculum/outcomes').set(bearer(admin)).send({
      nodeId: tree.topicId, content: 'YCCĐ sai kiểu nguồn.', sourceKind: 'program', derivedFromId: tree.outcomeTopic,
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.code).toBe('curriculum.outcome_derived_from_mismatch');
    // Gốc không tồn tại → 404.
    const ghostOrigin = await http(app).post('/api/v1/curriculum/outcomes').set(bearer(admin)).send({
      nodeId: tree.topicId, content: 'YCCĐ mồ côi.', sourceKind: 'derived', derivedFromId: RANDOM_UUID,
    });
    expect(ghostOrigin.status).toBe(404);
    expect(ghostOrigin.body.code).toBe('curriculum.outcome_not_found');
    // Tự suy từ chính mình → 400.
    const selfDerived = await http(app).patch(`/api/v1/curriculum/outcomes/${derived.id}`).set(bearer(admin))
      .send({ derivedFromId: derived.id });
    expect(selfDerived.status).toBe(400);
    expect(selfDerived.body.code).toBe('curriculum.outcome_derived_from_self');
    // Sửa truy vết nguồn qua PATCH chạy được.
    const reRef = await http(app).patch(`/api/v1/curriculum/outcomes/${derived.id}`).set(bearer(admin))
      .send({ sourceRef: 'TT 32/2018/TT-BGDĐT — CT môn Toán, lớp 10 (bản sửa đổi TT 13/2022)' });
    expect(reRef.status).toBe(200);
    expect((reRef.body as OutcomeRow).sourceRef).toContain('TT 13/2022');
  });

  it('requires derivedFromId whenever sourceKind is derived, on create and on PATCH (F2)', async () => {
    const tree = await mkTree();
    // Tạo mới: derived không kèm gốc → 400.
    const noOrigin = await http(app).post('/api/v1/curriculum/outcomes').set(bearer(admin)).send({
      nodeId: tree.topicId, content: 'YCCĐ phái sinh không gốc.', sourceKind: 'derived',
    });
    expect(noOrigin.status).toBe(400);
    expect(noOrigin.body.code).toBe('curriculum.outcome_derived_from_required');
    // Tạo mới: derived kèm gốc có thật → 201.
    const withOrigin = await http(app).post('/api/v1/curriculum/outcomes').set(bearer(admin)).send({
      nodeId: tree.topicId, content: 'YCCĐ phái sinh có gốc.', sourceKind: 'derived', derivedFromId: tree.outcomeTopic,
    });
    expect(withOrigin.status).toBe(201);
    expect((withOrigin.body as OutcomeRow).derivedFromId).toBe(tree.outcomeTopic);

    // PATCH chỉ lật kind sang 'derived', không kèm gốc, và bản ghi hiện
    // tại (program) chưa có gốc → trạng thái gộp thiếu gốc → 400.
    const flipNoOrigin = await http(app).patch(`/api/v1/curriculum/outcomes/${tree.outcomeLesson}`).set(bearer(admin))
      .send({ sourceKind: 'derived' });
    expect(flipNoOrigin.status).toBe(400);
    expect(flipNoOrigin.body.code).toBe('curriculum.outcome_derived_from_required');
    // Bản ghi không đổi sau PATCH bị từ chối.
    const unchanged = await http(app).get(`/api/v1/curriculum/outcomes/${tree.outcomeLesson}`).set(bearer(admin));
    expect((unchanged.body as OutcomeRow).sourceKind).toBe('program');
    expect((unchanged.body as OutcomeRow).derivedFromId).toBeNull();
    // PATCH lật kind KÈM gốc → 200.
    const flipWithOrigin = await http(app).patch(`/api/v1/curriculum/outcomes/${tree.outcomeLesson}`).set(bearer(admin))
      .send({ sourceKind: 'derived', derivedFromId: tree.outcomeTopic });
    expect(flipWithOrigin.status).toBe(200);
    expect((flipWithOrigin.body as OutcomeRow).sourceKind).toBe('derived');
    expect((flipWithOrigin.body as OutcomeRow).derivedFromId).toBe(tree.outcomeTopic);
    // Bản ghi đã là derived có gốc: PATCH không đụng truy vết → 200
    // (trạng thái gộp vẫn đủ gốc).
    const touchDerived = await http(app).patch(`/api/v1/curriculum/outcomes/${tree.outcomeLesson}`).set(bearer(admin))
      .send({ content: 'Xét được tính đơn điệu của hàm số (bản phái sinh).' });
    expect(touchDerived.status).toBe(200);
    // PATCH gỡ gốc khỏi bản ghi derived → trạng thái gộp thiếu gốc → 400.
    const clearOrigin = await http(app).patch(`/api/v1/curriculum/outcomes/${tree.outcomeLesson}`).set(bearer(admin))
      .send({ derivedFromId: null });
    expect(clearOrigin.status).toBe(400);
    expect(clearOrigin.body.code).toBe('curriculum.outcome_derived_from_required');
  });

  it('blocks indirect parent cycles in updateNode but still allows valid reparenting', async () => {
    const tree = await mkTree();
    // Chuỗi hiện tại: strand → topic → lesson.
    const strandRes = await http(app).get(`/api/v1/curriculum/curricula/${tree.curriculumId}/tree`).set(bearer(admin));
    const strandId = (strandRes.body as { nodes: { id: string }[] }).nodes[0]!.id;
    // Vòng qua 3 nấc: đặt strand (tổ tiên xa nhất) làm con của lesson (hậu duệ sâu nhất).
    const cycle3 = await http(app).patch(`/api/v1/curriculum/nodes/${strandId}`).set(bearer(admin))
      .send({ parentId: tree.lessonId });
    expect(cycle3.status).toBe(400);
    expect(cycle3.body.code).toBe('curriculum.node_parent_cycle');
    // Vòng 2 nấc: đặt topic làm con của chính con nó (lesson).
    const cycle2 = await http(app).patch(`/api/v1/curriculum/nodes/${tree.topicId}`).set(bearer(admin))
      .send({ parentId: tree.lessonId });
    expect(cycle2.status).toBe(400);
    expect(cycle2.body.code).toBe('curriculum.node_parent_cycle');
    // Tự làm cha vẫn bị chặn như trước.
    const selfParent = await http(app).patch(`/api/v1/curriculum/nodes/${tree.topicId}`).set(bearer(admin))
      .send({ parentId: tree.topicId });
    expect(selfParent.status).toBe(400);
    expect(selfParent.body.code).toBe('curriculum.node_parent_self');
    // Đổi cha hợp lệ không bị chặn nhầm: đưa lesson lên thẳng dưới strand.
    const valid = await http(app).patch(`/api/v1/curriculum/nodes/${tree.lessonId}`).set(bearer(admin))
      .send({ parentId: strandId });
    expect(valid.status).toBe(200);
    expect((valid.body as { parentId: string }).parentId).toBe(strandId);
    // Cây vẫn đọc được trọn vẹn sau các lần đổi cha.
    const treeAfter = await http(app).get(`/api/v1/curriculum/curricula/${tree.curriculumId}/tree`).set(bearer(admin));
    expect(treeAfter.status).toBe(200);
    const roots = (treeAfter.body as { nodes: { id: string; children: { id: string }[] }[] }).nodes;
    expect(roots).toHaveLength(1);
    expect(roots[0]!.children.map((c) => c.id).sort()).toEqual([tree.lessonId, tree.topicId].sort());
  });
});

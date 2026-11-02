import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCentreKysely, type CentreDb } from '../client';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { CompetenciesRepository } from './competencies';

/**
 * Spec tích hợp của CompetenciesRepository phía Kysely (issue
 * #646, nhóm G6). Database kho trung tâm dựng từ rỗng bằng cầu nối
 * migration của package trên cụm PostgreSQL thật; mọi ca chạy qua
 * repository production. Các ca khoá: ghi jsonb (object và MẢNG ở
 * cấp cao nhất — ca lỗi mảng PostgreSQL của driver), upsert
 * onConflict có cập nhật của liên kết khoá/module, doNothing của
 * liên kết mẫu/kế hoạch, và ngữ nghĩa NULL tường minh của
 * `findUsercomp`.
 */
const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : undefined);

const TEST_DB = 'lms_db_g646_competencies';
const CONTEXT_ID = '01934f2a-7b6d-7c1e-9c4a-2f5d8e6a2001';
const USER_ID = '01934f2a-7b6d-7c1e-9c4a-2f5d8e6a2002';
const COURSE_ID = '01934f2a-7b6d-7c1e-9c4a-2f5d8e6a2003';

let pool: Pool;
let db: CentreDb;
let repo: CompetenciesRepository;

beforeAll(async () => {
  if (!adminUrl) throw new Error('Thiếu LMS_DB_TEST_ADMIN_URL/DATABASE_URL cho spec tích hợp');
  const url = await buildTestDatabase({ adminUrl, database: TEST_DB, store: 'centre' });
  pool = new Pool({ connectionString: url });
  db = createCentreKysely(pool);
  repo = new CompetenciesRepository(db);
}, 300_000);

afterAll(async () => {
  await db.destroy().catch(() => undefined);
  if (adminUrl) await dropTestDatabase(adminUrl, TEST_DB).catch(() => undefined);
});

describe('CompetenciesRepository (Kysely)', () => {
  it('ghi khung năng lực với scaleConfiguration jsonb dạng object rồi đọc lại nguyên vẹn', async () => {
    const scale = { values: ['Chưa đạt', 'Đạt', 'Tốt'], proficient: [1, 2] };
    const framework = await repo.insertFramework({
      shortName: 'NL số', contextId: CONTEXT_ID, scaleConfiguration: scale,
    });
    const read = await repo.getFramework(framework.id);
    expect(read).toEqual(framework);
    expect(read?.scaleConfiguration).toEqual(scale);
  });

  it('ghi ruleConfig là MẢNG ở cấp cao nhất vào jsonb rồi đọc lại đúng mảng (không lỗi mảng PostgreSQL)', async () => {
    const framework = await repo.insertFramework({ shortName: 'NL mảng', contextId: CONTEXT_ID });
    const parent = await repo.insertCompetency({ frameworkId: framework.id, shortName: 'NL cha' });
    const ruleConfig = [{ points: 2, outcome: 'competent' }, { points: 5, outcome: 'proficient' }];
    const competency = await repo.insertCompetency({
      frameworkId: framework.id, shortName: 'NL con', parentId: parent.id, ruleType: 'points', ruleConfig,
    });
    const read = await repo.getCompetency(competency.id);
    expect(read?.ruleConfig).toEqual(ruleConfig);
    const children = await repo.listChildren(parent.id);
    expect(children.map((c) => c.id)).toEqual([competency.id]);
  });

  it('insertCourseLink lần hai trên cùng cặp (khoá, năng lực) cập nhật ruleOutcome thay vì tạo dòng mới', async () => {
    const framework = await repo.insertFramework({ shortName: 'NL link', contextId: CONTEXT_ID });
    const competency = await repo.insertCompetency({ frameworkId: framework.id, shortName: 'NL đích' });
    await repo.insertCourseLink({ courseId: COURSE_ID, competencyId: competency.id, ruleOutcome: 'nothing' });
    const second = await repo.insertCourseLink({ courseId: COURSE_ID, competencyId: competency.id, ruleOutcome: 'competent' });
    expect(second.ruleOutcome).toBe('competent');
    const links = await repo.listCourseLinks(COURSE_ID);
    expect(links.filter((l) => l.competencyId === competency.id)).toHaveLength(1);
  });

  it('addTemplateCompetency gọi trùng không lỗi và không nhân đôi liên kết (doNothing)', async () => {
    const framework = await repo.insertFramework({ shortName: 'NL mẫu', contextId: CONTEXT_ID });
    const competency = await repo.insertCompetency({ frameworkId: framework.id, shortName: 'NL trong mẫu' });
    const template = await repo.insertTemplate({ shortName: 'Mẫu G6', contextId: CONTEXT_ID });
    await repo.addTemplateCompetency(template.id, competency.id);
    await repo.addTemplateCompetency(template.id, competency.id);
    const linked = await repo.listTemplateCompetencies(template.id);
    expect(linked.map((c) => c.id)).toEqual([competency.id]);
  });

  it('findUsercomp khớp NULL tường minh: plan rỗng chỉ tìm thấy khi hỏi bằng null, không khớp plan khác', async () => {
    const framework = await repo.insertFramework({ shortName: 'NL usercomp', contextId: CONTEXT_ID });
    const competency = await repo.insertCompetency({ frameworkId: framework.id, shortName: 'NL vị thế' });
    const created = await repo.insertUsercomp({
      userId: USER_ID, competencyId: competency.id, planId: null, courseId: COURSE_ID, status: 0,
    });
    const byNull = await repo.findUsercomp(USER_ID, competency.id, null, COURSE_ID);
    expect(byNull?.id).toBe(created.id);
    const byPlan = await repo.findUsercomp(USER_ID, competency.id, '01934f2a-7b6d-7c1e-9c4a-2f5d8e6a2099', COURSE_ID);
    expect(byPlan).toBeUndefined();
    const byNullCourse = await repo.findUsercomp(USER_ID, competency.id, null, null);
    expect(byNullCourse).toBeUndefined();
  });

  it('updatePlan chỉ áp trường được truyền: trường vắng mặt giữ nguyên, null tường minh ghi thành NULL', async () => {
    const due = new Date('2027-01-15T00:00:00.000Z');
    const plan = await repo.insertPlan({ name: 'Kế hoạch G6', userId: USER_ID, dueDate: due });
    await repo.updatePlan(plan.id, { name: undefined, dueDate: null });
    const read = await repo.getPlan(plan.id);
    expect(read?.name).toBe('Kế hoạch G6');
    expect(read?.dueDate).toBeNull();
  });

  it('insertEvidence rồi listEvidence đọc lại đúng dòng bằng chứng của usercomp', async () => {
    const framework = await repo.insertFramework({ shortName: 'NL bằng chứng', contextId: CONTEXT_ID });
    const competency = await repo.insertCompetency({ frameworkId: framework.id, shortName: 'NL có bằng chứng' });
    const usercomp = await repo.insertUsercomp({ userId: USER_ID, competencyId: competency.id, status: 0 });
    const evidence = await repo.insertEvidence({
      userCompetencyId: usercomp.id, actionUserId: USER_ID, action: 'evidence_added',
      description: 'Nộp bài tập', grade: 8,
    });
    const listed = await repo.listEvidence(usercomp.id);
    expect(listed).toEqual([evidence]);
  });
});

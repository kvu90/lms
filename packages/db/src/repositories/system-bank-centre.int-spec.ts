import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCentreKysely, type CentreDb } from '../client';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { SystemBankCentreRepository } from './system-bank-centre';

/**
 * Spec tích hợp của repository PHÍA TRUNG TÂM của kho ngân hàng
 * hệ thống trên Kysely (hạng mục G10, issue #650).
 *
 * Database trung tâm được dựng từ rỗng bằng chính cầu nối
 * migration của package (carrier đóng băng của kho centre) trên
 * cụm PostgreSQL thật của môi trường test (biến
 * `LMS_DB_TEST_ADMIN_URL` ghi đè cụm khi cần, mặc định suy từ
 * `DATABASE_URL` của package). Kết nối chạy bằng quyền quản trị
 * của cụm test như spec pilot — RLS theo tenant không thuộc phạm
 * vi của spec này (hành vi GUC/RLS của handle đã khoá ở spec khói
 * của harness). Mọi ca chạy qua repository production ở
 * `system-bank-centre.ts`.
 *
 * Các ca khoá hành vi của đường chuyển đổi:
 * - Truy vết nhập bản chụp: ghi dòng import trỏ đúng câu nguồn +
 *   phiên bản nguồn + checksum gói; lật `pristine` → `derived`.
 * - Vết nhận sự kiện rút câu: ghi nhận trùng là idempotent theo
 *   cặp (sự kiện, trung tâm) và danh sách đã ghi nhận đọc lại
 *   được theo đúng slug trung tâm.
 * - Bản cài gói YCCĐ: upsert môn/chương trình/node/YCCĐ theo id
 *   giữ nguyên (cài lại cập nhật nội dung tại chỗ, gồm nội dung
 *   YCCĐ là tài liệu jsonb), vết cài ghi phiên bản trước và cài
 *   lại cùng phiên bản chỉ làm mới vết.
 * - Tra slug trung tâm theo tenant id của kho chung.
 */
const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : undefined);

const CENTRE_DB = 'lms_db_g650_centre';
const TENANT_ID = '01965000-0000-7000-8000-000000000201';
const CONTEXT_ID = '01965000-0000-7000-8000-000000000202';
const SUBJECT_ID = '01965000-0000-7000-8000-000000000203';
const CURRICULUM_ID = '01965000-0000-7000-8000-000000000204';
const NODE_ID = '01965000-0000-7000-8000-000000000205';
const OUTCOME_ID = '01965000-0000-7000-8000-000000000206';
const CATEGORY_ID = '01965000-0000-7000-8000-000000000207';
const QUESTION_ID = '01965000-0000-7000-8000-000000000208';
const SOURCE_QUESTION_ID = '01965000-0000-7000-8000-000000000209';
const SOURCE_VERSION_ID = '01965000-0000-7000-8000-000000000210';
const EVENT_ID = '01965000-0000-7000-8000-000000000211';
const ADMIN_ID = '01965000-0000-7000-8000-0000000002ff';

let pool: Pool;
let db: CentreDb;
let repo: SystemBankCentreRepository;

function doc(text: string): { type: string; content: Array<{ type: string; content: Array<{ type: string; text: string }> }> } {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

beforeAll(async () => {
  if (!adminUrl) {
    throw new Error('Thiếu kết nối quản trị cho spec phía trung tâm: đặt LMS_DB_TEST_ADMIN_URL hoặc DATABASE_URL.');
  }
  const centreUrl = await buildTestDatabase({ adminUrl, database: CENTRE_DB, store: 'centre' });
  pool = new Pool({ connectionString: centreUrl });
  db = createCentreKysely(pool);
  repo = new SystemBankCentreRepository(db);
  // Dữ kiện nền tối thiểu: tenant (cho tra slug), môn + chương
  // trình + node (cho upsert/tìm), và chuỗi cha tối thiểu của dòng
  // truy vết nhập (category → question) vì `system_question_imports`
  // mang khoá ngoại tới `question.id`.
  await db.insertInto('tenants').values({ id: TENANT_ID, slug: 'trung-tam-650', name: 'Trung tâm 650', kind: 'centre' }).execute();
  await db
    .insertInto('question_categories')
    .values({ id: CATEGORY_ID, context_id: CONTEXT_ID, name: 'Bank cá nhân' })
    .execute();
  await db.insertInto('question').values({ id: QUESTION_ID, category: CATEGORY_ID, qtype: 'multichoice' }).execute();
}, 300_000);

afterAll(async () => {
  await db?.destroy().catch(() => undefined);
  if (adminUrl) await dropTestDatabase(adminUrl, CENTRE_DB);
});

describe('Repository phía trung tâm của kho ngân hàng hệ thống (issue #650)', () => {
  it('tra slug trung tâm theo tenant id: có tenant thì trả slug, vắng thì trả null', async () => {
    expect(await repo.resolveTenantSlug(TENANT_ID)).toBe('trung-tam-650');
    expect(await repo.resolveTenantSlug('01965000-0000-7000-8000-000000000299')).toBeNull();
  });

  it('ghi dòng truy vết nhập bản chụp giữ nguyên nguồn (câu nguồn, phiên bản nguồn, checksum) rồi lật sang derived', async () => {
    const row = await repo.insertImportRow({
      questionId: QUESTION_ID,
      sourceQuestionId: SOURCE_QUESTION_ID,
      sourceVersionId: SOURCE_VERSION_ID,
      sourceVersionNumber: 3,
      packageChecksum: 'checksum-source-v3',
      importedVersionNumber: 1,
      importedBy: ADMIN_ID,
      kind: 'pristine',
    });
    expect(row).toMatchObject({
      questionId: QUESTION_ID,
      sourceQuestionId: SOURCE_QUESTION_ID,
      sourceVersionId: SOURCE_VERSION_ID,
      sourceVersionNumber: 3,
      packageChecksum: 'checksum-source-v3',
      kind: 'pristine',
    });
    await repo.flipImportToDerived(QUESTION_ID);
    const flipped = await repo.getImportRow(QUESTION_ID);
    expect(flipped?.kind).toBe('derived');
  });

  it('ghi nhận sự kiện: trùng cặp sự kiện + trung tâm là idempotent, danh sách đã ghi nhận đọc theo đúng slug', async () => {
    const first = await repo.insertEventReceipt({ eventId: EVENT_ID, centreSlug: 'trung-tam-650' });
    const again = await repo.insertEventReceipt({ eventId: EVENT_ID, centreSlug: 'trung-tam-650' });
    expect(again.id).toBe(first.id);
    expect(await repo.listEventReceiptEventIds('trung-tam-650')).toContain(EVENT_ID);
    expect(await repo.listEventReceiptEventIds('trung-tam-khac')).not.toContain(EVENT_ID);
  });

  it('upsert môn, chương trình, node và YCCĐ theo id giữ nguyên: cài lại cập nhật nội dung tại chỗ', async () => {
    await db
      .insertInto('subjects')
      .values({ id: SUBJECT_ID, context_id: CONTEXT_ID, name: 'Toán', slug: 'toan-650' })
      .execute();
    const subject = await repo.findSubjectBySlug('toan-650');
    expect(subject?.id).toBe(SUBJECT_ID);
    expect(subject?.contextId).toBe(CONTEXT_ID);

    await repo.upsertCurriculum({ id: CURRICULUM_ID, subjectId: SUBJECT_ID, grade: 12 });
    await repo.upsertCurriculum({ id: CURRICULUM_ID, subjectId: SUBJECT_ID, grade: 12 });
    const curriculum = await repo.findCurriculumBySubjectGrade(SUBJECT_ID, 12);
    expect(curriculum?.id).toBe(CURRICULUM_ID);
    expect(await repo.findCurriculumBySubjectGrade(SUBJECT_ID, 11)).toBeNull();

    await repo.upsertCurriculumNode({
      id: NODE_ID,
      curriculumId: CURRICULUM_ID,
      parentId: null,
      title: 'Hàm số',
      kind: 'topic',
      position: 1,
      durationPeriods: 10,
      durationPercent: null,
    });
    await repo.upsertLearningOutcome({
      id: OUTCOME_ID,
      nodeId: NODE_ID,
      position: 1,
      content: doc('YCCĐ v1'),
      sourceKind: 'program',
      sourceRef: 'CT Toán 12',
    });
    expect(await repo.outcomeExists(OUTCOME_ID)).toBe(true);
    await repo.upsertLearningOutcome({
      id: OUTCOME_ID,
      nodeId: NODE_ID,
      position: 1,
      content: doc('YCCĐ v2'),
      sourceKind: 'program',
      sourceRef: 'CT Toán 12',
    });
    const rows = await db.selectFrom('learning_outcomes').select(['content']).where('id', '=', OUTCOME_ID).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toEqual(doc('YCCĐ v2'));
  });

  it('vết cài gói: lần đầu previousVersion null, lần cài sau ghi phiên bản trước, cài lại cùng phiên bản chỉ làm mới vết', async () => {
    const first = await repo.recordOutcomePackageInstall({
      packageVersion: '2026.11.02.1',
      previousVersion: null,
      scope: 'all',
      installedBy: ADMIN_ID,
    });
    expect(first.previousVersion).toBeNull();
    const second = await repo.recordOutcomePackageInstall({
      packageVersion: '2026.11.02.2',
      previousVersion: first.packageVersion,
      scope: 'all',
      installedBy: ADMIN_ID,
    });
    expect(second.previousVersion).toBe('2026.11.02.1');
    const current = await repo.getOutcomePackageInstall();
    expect(current?.packageVersion).toBe('2026.11.02.2');
    const refreshed = await repo.recordOutcomePackageInstall({
      packageVersion: '2026.11.02.2',
      previousVersion: '2026.11.02.1',
      scope: 'toan-650',
      installedBy: ADMIN_ID,
    });
    expect(refreshed.id).toBe(second.id);
    expect(refreshed.scope).toBe('toan-650');
  });
});

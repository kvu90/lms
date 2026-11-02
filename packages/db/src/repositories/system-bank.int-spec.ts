import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SystemBankPackage } from '@lms/contracts';
import { createSystemBankKysely, type SystemBankDb } from '../client';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { SystemBankRepository } from './system-bank';

/**
 * Spec tích hợp của repository kho NGÂN HÀNG HỆ THỐNG trên Kysely
 * (hạng mục G10, issue #650).
 *
 * Database kho ngân hàng được dựng từ rỗng bằng chính cầu nối
 * migration của package (carrier đóng băng của kho system-bank)
 * trên cụm PostgreSQL thật của môi trường test (biến
 * `LMS_DB_TEST_ADMIN_URL` ghi đè cụm khi cần, mặc định suy từ
 * `DATABASE_URL` của package). Mọi ca chạy qua repository
 * production ở `system-bank.ts` — không mô phỏng handle.
 *
 * Các ca khoá hành vi của đường chuyển đổi:
 * - Phát hành câu + phiên bản: insert bỏ khoá chính nhận id
 *   UUIDv7 do database sinh; id tường minh (đường di trú) giữ
 *   nguyên; phiên bản cũ bất biến khi phiên bản mới được tạo.
 * - Rút câu + sự kiện + sổ importer: truy vết nguồn giữ nguyên —
 *   sự kiện rút trỏ đúng câu nguồn, danh sách trung tâm đã nhập
 *   đọc lại được, ghi importer trùng là idempotent.
 * - Khám phá chỉ thấy câu đang phát hành (câu đã rút biến mất).
 * - Gói YCCĐ: tạo gói kèm items trong một transaction, đọc lại
 *   khớp từng trường — gồm nội dung YCCĐ là MẢNG jsonb ở cấp cao
 *   nhất (đường ghi phải qua serialize + `::jsonb`, driver `pg`
 *   hiểu mảng trần là mảng PostgreSQL).
 */
const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : undefined);

const BANK_DB = 'lms_db_g650_bank';
const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ADMIN_ID = '01965000-0000-7000-8000-000000000001';
const EXPLICIT_QUESTION_ID = '01965000-0000-7000-8000-0000000000aa';

let pool: Pool;
let db: SystemBankDb;
let repo: SystemBankRepository;

/** Gói câu multichoice mẫu theo hợp đồng `SystemBankPackage`. */
function samplePackage(text: string, outcomeId?: string): SystemBankPackage {
  return {
    questionText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
    generalFeedback: null,
    stimulusContent: null,
    answers: [
      { answer: { type: 'doc', content: [] }, isCorrect: true, feedback: null, sortOrder: 0 },
      { answer: { type: 'doc', content: [] }, isCorrect: false, feedback: null, sortOrder: 1 },
    ],
    answerKey: null,
    options: null,
    outcomes: outcomeId ? [{ outcomeId, cognitiveLevel: 'hieu' }] : [],
  };
}

beforeAll(async () => {
  if (!adminUrl) {
    throw new Error('Thiếu kết nối quản trị cho spec kho ngân hàng: đặt LMS_DB_TEST_ADMIN_URL hoặc DATABASE_URL.');
  }
  const bankUrl = await buildTestDatabase({ adminUrl, database: BANK_DB, store: 'system-bank' });
  pool = new Pool({ connectionString: bankUrl });
  db = createSystemBankKysely(pool);
  repo = new SystemBankRepository(db);
}, 300_000);

afterAll(async () => {
  await db?.destroy().catch(() => undefined);
  if (adminUrl) await dropTestDatabase(adminUrl, BANK_DB);
});

describe('Repository kho ngân hàng hệ thống (issue #650)', () => {
  it('phát hành câu không truyền id: database sinh id UUIDv7, gói phiên bản 1 đọc lại nguyên vẹn', async () => {
    const pkg = samplePackage('Câu một');
    const { question, version } = await repo.createQuestionWithFirstVersion({
      qtype: 'multichoice',
      createdBy: ADMIN_ID,
      package: pkg,
      checksum: 'checksum-v1',
    });
    expect(question.id).toMatch(UUIDV7_PATTERN);
    expect(question.status).toBe('published');
    expect(version.version).toBe(1);
    expect(version.checksum).toBe('checksum-v1');
    expect(version.package).toEqual(pkg);
    const reread = await repo.getQuestion(question.id);
    expect(reread?.id).toBe(question.id);
  });

  it('liên kết YCCĐ của gói được ghi cùng phiên bản: khám phá lọc theo YCCĐ và mức độ tìm thấy câu', async () => {
    const outcomeId = '01965000-0000-7000-8000-0000000000bb';
    const { question } = await repo.createQuestionWithFirstVersion({
      qtype: 'multichoice',
      createdBy: ADMIN_ID,
      package: samplePackage('Câu gắn chuẩn', outcomeId),
      checksum: 'checksum-outcome',
    });
    const byOutcome = await repo.listPublishedQuestionsWithVersions({ outcomeId });
    expect(byOutcome.map((entry) => entry.question.id)).toContain(question.id);
    const byOutcomeAndLevel = await repo.listPublishedQuestionsWithVersions({ outcomeId, cognitiveLevel: 'hieu' });
    expect(byOutcomeAndLevel.map((entry) => entry.question.id)).toContain(question.id);
    const wrongLevel = await repo.listPublishedQuestionsWithVersions({ outcomeId, cognitiveLevel: 'biet' });
    expect(wrongLevel.map((entry) => entry.question.id)).not.toContain(question.id);
  });

  it('phát hành câu có id tường minh thì giữ nguyên id (đường di trú giữ truy vết nguồn)', async () => {
    const { question } = await repo.createQuestionWithFirstVersion({
      id: EXPLICIT_QUESTION_ID,
      qtype: 'essay',
      createdBy: null,
      package: samplePackage('Câu di trú'),
      checksum: 'checksum-migrated',
    });
    expect(question.id).toBe(EXPLICIT_QUESTION_ID);
  });

  it('tạo phiên bản mới không sửa phiên bản cũ: v1 giữ nguyên gói, danh sách phiên bản tăng dần', async () => {
    const { question } = await repo.createQuestionWithFirstVersion({
      qtype: 'multichoice',
      createdBy: ADMIN_ID,
      package: samplePackage('Bản gốc'),
      checksum: 'checksum-a',
    });
    const v2 = await repo.createVersion(question.id, samplePackage('Bản sửa'), 'checksum-b');
    expect(v2.version).toBe(2);
    const v1 = await repo.getVersionByNumber(question.id, 1);
    expect(v1?.package).toEqual(samplePackage('Bản gốc'));
    expect(v1?.checksum).toBe('checksum-a');
    const versions = await repo.listVersions(question.id);
    expect(versions.map((row) => row.version)).toEqual([1, 2]);
    const latest = await repo.getLatestVersion(question.id);
    expect(latest?.version).toBe(2);
  });

  it('rút câu + ghi sự kiện + sổ importer: truy vết nguồn giữ nguyên và ghi importer trùng là idempotent', async () => {
    const { question } = await repo.createQuestionWithFirstVersion({
      qtype: 'multichoice',
      createdBy: ADMIN_ID,
      package: samplePackage('Câu sẽ rút'),
      checksum: 'checksum-w',
    });
    const first = await repo.recordImporter({ sourceQuestionId: question.id, centreSlug: 'trung-tam-a', importedBy: ADMIN_ID });
    const again = await repo.recordImporter({ sourceQuestionId: question.id, centreSlug: 'trung-tam-a', importedBy: ADMIN_ID });
    expect(again.id).toBe(first.id);
    await repo.recordImporter({ sourceQuestionId: question.id, centreSlug: 'trung-tam-b', importedBy: ADMIN_ID });
    expect(await repo.listImporterSlugs(question.id)).toEqual(expect.arrayContaining(['trung-tam-a', 'trung-tam-b']));
    expect(await repo.listImportedQuestionIds('trung-tam-a')).toContain(question.id);
    expect(await repo.listImportedQuestionIds('trung-tam-c')).not.toContain(question.id);

    const updated = await repo.markWithdrawn(question.id, { reason: 'Nội dung lỗi thời', by: ADMIN_ID });
    expect(updated?.status).toBe('withdrawn');
    const event = await repo.recordEvent({
      type: 'question_withdrawn',
      sourceQuestionId: question.id,
      payload: { reason: 'Nội dung lỗi thời', withdrawnBy: ADMIN_ID },
    });
    expect(event.sourceQuestionId).toBe(question.id);
    const events = await repo.listEventsForQuestions([question.id]);
    expect(events.map((row) => row.id)).toContain(event.id);
    expect(events[0]?.payload).toMatchObject({ reason: 'Nội dung lỗi thời' });
  });

  it('khám phá chỉ liệt kê câu đang phát hành kèm mọi phiên bản, câu đã rút không xuất hiện', async () => {
    const live = await repo.createQuestionWithFirstVersion({
      qtype: 'shortanswer',
      createdBy: ADMIN_ID,
      package: samplePackage('Câu còn phát hành'),
      checksum: 'checksum-live',
    });
    const gone = await repo.createQuestionWithFirstVersion({
      qtype: 'shortanswer',
      createdBy: ADMIN_ID,
      package: samplePackage('Câu rút khỏi khám phá'),
      checksum: 'checksum-gone',
    });
    await repo.markWithdrawn(gone.question.id, { reason: 'Rút', by: ADMIN_ID });
    const entries = await repo.listPublishedQuestionsWithVersions({ qtype: 'shortanswer' });
    const ids = entries.map((entry) => entry.question.id);
    expect(ids).toContain(live.question.id);
    expect(ids).not.toContain(gone.question.id);
    const liveEntry = entries.find((entry) => entry.question.id === live.question.id);
    expect(liveEntry?.versions.map((row) => row.version)).toEqual([1]);
  });

  it('gói YCCĐ: tạo gói kèm items rồi đọc lại khớp từng trường, kể cả nội dung YCCĐ là mảng jsonb cấp cao nhất', async () => {
    const outcomeContent = [{ code: 'YCCD-1', text: 'Nội dung dạng mảng' }];
    const pkg = await repo.createPackageWithItems({
      version: '2026.11.02.1',
      scope: 'all',
      checksum: 'checksum-package',
      outcomeCount: 1,
      createdBy: ADMIN_ID,
      curricula: [{ curriculumId: '01965000-0000-7000-8000-000000000101', subjectSlug: 'toan', grade: 12 }],
      nodes: [
        {
          nodeId: '01965000-0000-7000-8000-000000000102',
          curriculumId: '01965000-0000-7000-8000-000000000101',
          parentId: null,
          title: 'Hàm số',
          kind: 'topic',
          position: 1,
          durationPeriods: 10,
          durationPercent: null,
        },
      ],
      outcomes: [
        {
          outcomeId: '01965000-0000-7000-8000-000000000103',
          nodeId: '01965000-0000-7000-8000-000000000102',
          position: 1,
          content: outcomeContent,
          sourceKind: 'program',
          sourceRef: 'CT Toán 12',
        },
      ],
      mappings: [],
    });
    expect(pkg.version).toBe('2026.11.02.1');
    expect(pkg.outcomeCount).toBe(1);
    const byVersion = await repo.getPackageByVersion('2026.11.02.1');
    expect(byVersion?.id).toBe(pkg.id);
    const items = await repo.getPackageItems(pkg.id);
    expect(items.curricula).toHaveLength(1);
    expect(items.curricula[0]).toMatchObject({ subjectSlug: 'toan', grade: 12 });
    expect(items.nodes).toHaveLength(1);
    expect(items.nodes[0]).toMatchObject({ title: 'Hàm số', durationPeriods: 10 });
    expect(items.outcomes).toHaveLength(1);
    expect(items.outcomes[0]?.content).toEqual(outcomeContent);
    const packages = await repo.listPackages();
    expect(packages.map((row) => row.version)).toContain('2026.11.02.1');
  });

  it('gói YCCĐ rỗng từng phần vẫn tạo được: guards mảng rỗng giữ nguyên như đường cũ', async () => {
    const pkg = await repo.createPackageWithItems({
      version: '2026.11.02.2',
      scope: 'toan',
      checksum: 'checksum-empty',
      outcomeCount: 0,
      createdBy: ADMIN_ID,
      curricula: [],
      nodes: [],
      outcomes: [],
      mappings: [],
    });
    const items = await repo.getPackageItems(pkg.id);
    expect(items.curricula).toEqual([]);
    expect(items.nodes).toEqual([]);
    expect(items.outcomes).toEqual([]);
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  curricula,
  curriculumNodes,
  learningOutcomes,
  subjects,
} from '@lms/db';
import {
  systemBankEvents,
  systemQuestionImporters,
} from '@lms/db/system-bank';
import { tenantAls } from '../../../src/modules/tenants/tenant-als';
import { SystemBankCentreRepository } from '../../../src/modules/system-bank/system-bank-centre.repository';
import { SystemBankConnection } from '../../../src/modules/system-bank/system-bank.connection';
import { checksumPackage } from '../../../src/modules/system-bank/system-bank-package';
import { SystemBankRepository } from '../../../src/modules/system-bank/system-bank.repository';
import { SystemBankService } from '../../../src/modules/system-bank/system-bank.service';

/**
 * Ca tích hợp của KHO NGÂN HÀNG HỆ THỐNG (issue #585): service phía
 * ngân hàng + repository phía trung tâm chạy trên database thật, tự
 * cấp phát trên cùng cụm với database nghiệp vụ test, toàn bộ bằng
 * TÊN MỚI của riêng đợt này: một database kho ngân hàng
 * (`lms_test_bank_585`) với role riêng và một database trung tâm
 * (`lms_test_centre_585`) với role riêng, CONNECT của PUBLIC bị thu
 * hồi và chỉ cấp lại cho role của kho đó, migration kho ngân hàng áp
 * vào kho ngân hàng và baseline nghiệp vụ (đã gồm 3 bảng vệ tinh
 * trung tâm) áp vào kho trung tâm, đều bằng chính role chủ kho như
 * đường triển khai thật. Shim `uuidv7()` chỉ áp khi server dưới PG18.
 *
 * Các ca khoá các tiêu chí nghiệm thu ở tầng service/repository:
 * (1) sửa câu hệ thống tạo version mới, version cũ đọc lại không
 * đổi, checksum tính lại khớp checksum lưu; (2) rút câu: khám phá
 * không còn thấy câu, sự kiện rút được ghi, danh sách trung tâm đã
 * nhập đọc được từ dòng importer; (3) gói YCCĐ: phát hành từ cây
 * chương trình rồi cài lại — nội dung cập nhật tại chỗ theo id, vết
 * cài ghi phiên bản trước; (4) cài gói khi môn chưa có ở trung tâm
 * thì fail-closed; (5) cài gói khi trung tâm đã có chương trình
 * (môn, khối) khác id thì fail-closed. Đường nhập bản chụp (cần
 * QuestionsService thật) và đường bank-off thuộc tầng e2e.
 */
const BANK_DATABASE = 'lms_test_bank_585';
const BANK_ROLE = 'lms_bank_test_585';
const BANK_PASSWORD = 'bank585test';
const CENTRE_DATABASE = 'lms_test_centre_585';
const CENTRE_ROLE = 'lms_centre_test_585';
const CENTRE_PASSWORD = 'centre585test';
const ADMIN_ID = '01958500-0000-7000-8000-000000000001';
const SYSTEM_ID = '01958500-0000-7000-8000-000000000002';
const SUBJECT_ID = '01958500-0000-7000-8000-000000000010';
const CURRICULUM_ID = '01958500-0000-7000-8000-000000000011';
const NODE_ID = '01958500-0000-7000-8000-000000000012';
const OUTCOME_ID = '01958500-0000-7000-8000-000000000013';
const SUBJECT_SLUG = 'toan-585';

const UUIDV7_SHIM = `CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$ DECLARE ts_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint; b bytea; BEGIN b := decode(lpad(to_hex(ts_ms), 12, '0'), 'hex') || gen_random_bytes(10); b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112); b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128); RETURN encode(b, 'hex')::uuid; END; $$ LANGUAGE plpgsql VOLATILE`;

function clusterUrl(database: string, username?: string, secret?: string): string {
  const base = new URL(process.env.DATABASE_URL!);
  base.pathname = `/${database}`;
  if (username) base.username = username;
  if (secret) base.password = secret;
  return base.toString();
}

function quoted(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function withClient<T>(connectionString: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function applySqlFile(connectionString: string, filePath: string): Promise<void> {
  await withClient(connectionString, async (client) => {
    const version = await client.query<{ server_version_num: string }>('SHOW server_version_num');
    if (Number(version.rows[0]!.server_version_num) < 180000) {
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await client.query(UUIDV7_SHIM);
    }
    const sqlText = readFileSync(filePath, 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.query(trimmed);
    }
  });
}

function doc(text: string): {
  type: 'doc';
  content: Array<{ type: string; content: Array<{ type: string; text: string }> }>;
} {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

describe('Kho ngân hàng hệ thống (issue #585)', () => {
  let bankPool: Pool;
  let centrePool: Pool;
  let bankConnection: SystemBankConnection;
  let service: SystemBankService;
  let bankDb: NodePgDatabase;
  let centreDb: NodePgDatabase;

  beforeAll(async () => {
    const adminUrl = clusterUrl('postgres');
    for (const [database, role, password] of [
      [BANK_DATABASE, BANK_ROLE, BANK_PASSWORD],
      [CENTRE_DATABASE, CENTRE_ROLE, CENTRE_PASSWORD],
    ] as const) {
      await withClient(adminUrl, async (client) => {
        await client.query(`DROP DATABASE IF EXISTS ${quoted(database)} WITH (FORCE)`);
        await client.query(`DROP ROLE IF EXISTS ${quoted(role)}`);
        await client.query(`CREATE ROLE ${quoted(role)} LOGIN PASSWORD '${password}'`);
        await client.query(`CREATE DATABASE ${quoted(database)} OWNER ${quoted(role)}`);
        await client.query(`REVOKE CONNECT ON DATABASE ${quoted(database)} FROM PUBLIC`);
        await client.query(`GRANT CONNECT ON DATABASE ${quoted(database)} TO ${quoted(role)}`);
      });
    }
    const bankMigrationDir = readdirSync(join(__dirname, '../../../drizzle-system-bank')).filter((name) =>
      name !== 'meta',
    );
    if (bankMigrationDir.length !== 1) throw new Error(`expected exactly one system-bank migration dir, found ${bankMigrationDir.length}`);
    await applySqlFile(
      clusterUrl(BANK_DATABASE, BANK_ROLE, BANK_PASSWORD),
      join(__dirname, '../../../drizzle-system-bank', bankMigrationDir[0]!, 'migration.sql'),
    );
    await applySqlFile(
      clusterUrl(CENTRE_DATABASE, CENTRE_ROLE, CENTRE_PASSWORD),
      join(__dirname, '../../../drizzle/20261025163710_baseline/migration.sql'),
    );
    bankPool = new Pool({ connectionString: clusterUrl(BANK_DATABASE, BANK_ROLE, BANK_PASSWORD) });
    centrePool = new Pool({ connectionString: clusterUrl(CENTRE_DATABASE, CENTRE_ROLE, CENTRE_PASSWORD) });
    bankDb = drizzle({ client: bankPool });
    centreDb = drizzle({ client: centrePool });
    bankConnection = new SystemBankConnection({
      get: (key: string) =>
        key === 'SYSTEM_BANK_DATABASE_URL'
          ? clusterUrl(BANK_DATABASE, BANK_ROLE, BANK_PASSWORD)
          : undefined,
    } as never);
    const connection = bankConnection;
    const repo = new SystemBankRepository(connection);
    const centreRepo = new SystemBankCentreRepository(centreDb as never);
    const evaluator = { requireCapability: async () => {}, hasCapability: async () => true };
    const contexts = { ensureSystemContext: async () => ({ id: SYSTEM_ID }) };
    const tenantDb = { withPlatform: async <T>(fn: (tx: never) => Promise<T>) => centreDb.transaction(fn as never) as Promise<T> };
    service = new SystemBankService(
      repo,
      centreRepo,
      connection,
      evaluator as never,
      contexts as never,
      tenantDb as never,
      undefined as never,
      undefined as never,
    );
    await centreDb.insert(subjects).values({ id: SUBJECT_ID, contextId: SYSTEM_ID, name: 'Toán 585', slug: SUBJECT_SLUG });
    await centreDb.insert(curricula).values({ id: CURRICULUM_ID, subjectId: SUBJECT_ID, grade: 12 });
    await centreDb.insert(curriculumNodes).values({
      id: NODE_ID,
      curriculumId: CURRICULUM_ID,
      parentId: null,
      title: 'Hàm số',
      kind: 'topic',
      position: 1,
    });
    await centreDb.insert(learningOutcomes).values({
      id: OUTCOME_ID,
      nodeId: NODE_ID,
      content: doc('YCCĐ v1'),
      position: 1,
      sourceKind: 'program',
      sourceRef: 'CT Toán 12',
    });
  // Migrate cả baseline nghiệp vụ (983 statement) nên hook vượt quá
  // hookTimeout 30s mặc định của project int — nới riêng cho hook này.
  }, 180000);

  afterAll(async () => {
    // Đóng pool của kết nối kho ngân hàng TRƯỚC khi xoá database, nếu
    // không các kết nối idle bị DROP DATABASE ... WITH (FORCE) cắt
    // ngang (FATAL 57P01) và vitest báo lỗi dù mọi ca đã xanh.
    await bankConnection?.onModuleDestroy();
    await bankPool?.end();
    await centrePool?.end();
    const adminUrl = clusterUrl('postgres');
    for (const [database, role] of [
      [BANK_DATABASE, BANK_ROLE],
      [CENTRE_DATABASE, CENTRE_ROLE],
    ] as const) {
      await withClient(adminUrl, async (client) => {
        await client.query(`DROP DATABASE IF EXISTS ${quoted(database)} WITH (FORCE)`);
        await client.query(`DROP ROLE IF EXISTS ${quoted(role)}`);
      });
    }
  });

  const multichoicePackage = (text: string) => ({
    questionText: doc(text),
    generalFeedback: null,
    stimulusContent: null,
    answers: [
      { answer: doc('Đúng'), isCorrect: true, feedback: null, sortOrder: 0 },
      { answer: doc('Sai 1'), isCorrect: false, feedback: null, sortOrder: 1 },
      { answer: doc('Sai 2'), isCorrect: false, feedback: null, sortOrder: 2 },
      { answer: doc('Sai 3'), isCorrect: false, feedback: null, sortOrder: 3 },
    ],
    answerKey: null,
    options: null,
    outcomes: [],
  });

  it('phát hành câu + phiên bản mới: phiên bản cũ đọc lại không đổi, checksum tính lại khớp checksum lưu', async () => {
    const created = await service.publishQuestion(ADMIN_ID, { qtype: 'multichoice', package: multichoicePackage('Câu gốc') });
    const questionId = created.question.id;
    await service.publishVersion(ADMIN_ID, questionId, { package: multichoicePackage('Câu sửa') });
    const v1 = await service.getVersion(questionId, 1);
    const v2 = await service.getVersion(questionId, 2);
    expect(v1.package).toMatchObject({ questionText: doc('Câu gốc') });
    expect(v2.package).toMatchObject({ questionText: doc('Câu sửa') });
    expect(checksumPackage(v1.package as never)).toBe(v1.checksum);
    expect(checksumPackage(v2.package as never)).toBe(v2.checksum);
    expect(v1.checksum).not.toBe(v2.checksum);
    const versions = await service.listVersions(questionId);
    expect(versions.map((row) => row.version)).toEqual([1, 2]);
  });

  it('rút câu: khám phá không còn thấy, sự kiện rút được ghi, danh sách trung tâm đã nhập đọc được', async () => {
    const created = await service.publishQuestion(ADMIN_ID, { qtype: 'multichoice', package: multichoicePackage('Câu sẽ rút') });
    const questionId = created.question.id;
    await service.publishVersion(ADMIN_ID, questionId, { package: multichoicePackage('Câu sẽ rút v2') });
    await bankDb.insert(systemQuestionImporters).values([
      { sourceQuestionId: questionId, centreSlug: 'trung-tam-a', importedBy: ADMIN_ID },
      { sourceQuestionId: questionId, centreSlug: 'trung-tam-b', importedBy: ADMIN_ID },
    ]);
    const withdrawn = await service.withdrawQuestion(ADMIN_ID, questionId, { reason: 'Nội dung lỗi thời' });
    expect(withdrawn.question.status).toBe('withdrawn');
    expect(withdrawn.notifiedCentres).toEqual(expect.arrayContaining(['trung-tam-a', 'trung-tam-b']));
    const discovered = await tenantAls.run({ tenantId: '01958500-0000-7000-8000-000000000099' }, () =>
      service.discover({ qtype: 'multichoice', limit: 100, offset: 0 }),
    );
    expect(discovered.items.find((item) => item.id === questionId)).toBeUndefined();
    const stillReadable = await service.getQuestion(questionId);
    expect(stillReadable.status).toBe('withdrawn');
    const events = await bankDb.select().from(systemBankEvents).where(eq(systemBankEvents.sourceQuestionId, questionId));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('question_withdrawn');
    const oldVersion = await service.getVersion(questionId, 1);
    expect(oldVersion.package).toMatchObject({ questionText: doc('Câu sẽ rút') });
  });

  it('gói YCCĐ: phát hành rồi cài lại — nội dung cập nhật tại chỗ theo id, vết cài ghi phiên bản trước', async () => {
    const released = await service.createOutcomePackage(ADMIN_ID, { version: '2026.10.31.1', scope: SUBJECT_SLUG, mappings: [] });
    expect(released.counts.outcomes).toBe(1);
    expect(released.package.checksum).toBeTruthy();
    const installed = await service.installOutcomePackage(ADMIN_ID, '2026.10.31.1');
    expect(installed.install.packageVersion).toBe('2026.10.31.1');
    expect(installed.install.previousVersion).toBeNull();
    await centreDb
      .update(learningOutcomes)
      .set({ content: doc('YCCĐ v2') })
      .where(eq(learningOutcomes.id, OUTCOME_ID));
    const released2 = await service.createOutcomePackage(ADMIN_ID, { version: '2026.10.31.2', scope: SUBJECT_SLUG, mappings: [] });
    expect(released2.counts.outcomes).toBe(1);
    const installed2 = await service.installOutcomePackage(ADMIN_ID, '2026.10.31.2');
    expect(installed2.install.previousVersion).toBe('2026.10.31.1');
    const outcome = await centreDb.select().from(learningOutcomes).where(eq(learningOutcomes.id, OUTCOME_ID));
    expect(outcome).toHaveLength(1);
    expect(outcome[0]!.content).toMatchObject(doc('YCCĐ v2'));
    const packages = await service.listOutcomePackages();
    expect(packages.map((row) => row.version)).toEqual(expect.arrayContaining(['2026.10.31.1', '2026.10.31.2']));
  });

  it('cài gói khi môn chưa có ở trung tâm thì fail-closed', async () => {
    await service.createOutcomePackage(ADMIN_ID, { version: '2026.10.31.9', scope: SUBJECT_SLUG, mappings: [] });
    await centreDb.delete(subjects).where(eq(subjects.id, SUBJECT_ID));
    await expect(service.installOutcomePackage(ADMIN_ID, '2026.10.31.9')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'system_bank.subject_not_installed' }),
    });
  });

  it('cài gói khi trung tâm đã có chương trình (môn, khối) khác id thì fail-closed', async () => {
    await centreDb.insert(subjects).values({ id: SUBJECT_ID, contextId: SYSTEM_ID, name: 'Toán 585', slug: SUBJECT_SLUG });
    await centreDb.insert(curricula).values({ id: '01958500-0000-7000-8000-000000000021', subjectId: SUBJECT_ID, grade: 12 });
    await expect(service.installOutcomePackage(ADMIN_ID, '2026.10.31.1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'system_bank.curriculum_conflict' }),
    });
  });
});

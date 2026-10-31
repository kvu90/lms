import type { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken,
  assignRole,
  createTestApp,
  createUserViaApi,
  http,
  login,
  roleIdByShortname,
  STRONG_PASSWORD,
  systemContextId,
  uniqueName,
} from '../../support/identity-access-helpers';
import { addExamSlot, createExamDraft } from '../../support/exam-pin-helpers';

/**
 * Ca đầu-cuối của KHO NGÂN HÀNG HỆ THỐNG (issue #585): ứng dụng thật
 * chạy với một database kho ngân hàng riêng dựng riêng cho đợt này
 * (`lms_test_bank_585`, role riêng, CONNECT của PUBLIC bị thu hồi,
 * migration kho ngân hàng áp bằng chính role chủ kho như đường triển
 * khai thật), đọc qua biến `SYSTEM_BANK_DATABASE_URL` đặt trước khi
 * ứng dụng khởi động. Shim `uuidv7()` chỉ áp khi server dưới PG18.
 *
 * Các ca khoá các tiêu chí nghiệm thu ở phía HTTP: (1) phát hành câu
 * + phiên bản mới, phiên bản cũ đọc lại không đổi; (2) giáo viên khám
 * phá theo dạng câu và nhập bản chụp — đủ nội dung + truy vết,
 * checksum khớp gói nguồn; (3) checksum lệch thì nhập bị từ chối;
 * (4) rút câu: khám phá + nhập mới không còn thấy, sự kiện rút được
 * ghi và trung tâm ghi nhận; (5) sửa câu đã nhập ở trung tâm thành
 * bản phái sinh, phiên bản nguyên trạng còn nguyên; (6) bank-off:
 * ứng dụng không cấu hình kho ngân hàng vẫn đọc câu đã nhập và tạo
 * đề từ câu đó (đường thi chỉ đọc kho trung tâm). Chạy bài thi và
 * chấm điểm đầy đủ thuộc các suite quiz hiện hữu (chúng chỉ vận hành
 * trên slot trong kho trung tâm); ca này khoá phần delta của PR:
 * đường trung tâm không gọi kho ngân hàng.
 */
const BANK_DATABASE = 'lms_test_bank_585';
const BANK_ROLE = 'lms_bank_test_585';
const BANK_PASSWORD = 'bank585test';

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

function doc(text: string) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function multichoicePackage(text: string) {
  return {
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
  };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('Ngân hàng hệ thống thành kho riêng + API (issue #585)', () => {
  let app: INestApplication;
  let appNoBank: INestApplication | null = null;
  let admin: string;
  let teacher: { id: string; token: string };
  let pg: Client;
  let bankPg: Client;

  beforeAll(async () => {
    const adminUrl = clusterUrl('postgres');
    await withClient(adminUrl, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${quoted(BANK_DATABASE)} WITH (FORCE)`);
      await client.query(`DROP ROLE IF EXISTS ${quoted(BANK_ROLE)}`);
      await client.query(`CREATE ROLE ${quoted(BANK_ROLE)} LOGIN PASSWORD '${BANK_PASSWORD}'`);
      await client.query(`CREATE DATABASE ${quoted(BANK_DATABASE)} OWNER ${quoted(BANK_ROLE)}`);
      await client.query(`REVOKE CONNECT ON DATABASE ${quoted(BANK_DATABASE)} FROM PUBLIC`);
      await client.query(`GRANT CONNECT ON DATABASE ${quoted(BANK_DATABASE)} TO ${quoted(BANK_ROLE)}`);
    });
    const bankMigrationDir = (await import('node:fs')).readdirSync(
      join(__dirname, '../../../drizzle-system-bank'),
    ).filter((name) => name !== 'meta');
    if (bankMigrationDir.length !== 1) throw new Error(`expected exactly one system-bank migration dir, found ${bankMigrationDir.length}`);
    await applySqlFile(
      clusterUrl(BANK_DATABASE, BANK_ROLE, BANK_PASSWORD),
      join(__dirname, '../../../drizzle-system-bank', bankMigrationDir[0]!, 'migration.sql'),
    );
    process.env.SYSTEM_BANK_DATABASE_URL = clusterUrl(BANK_DATABASE, BANK_ROLE, BANK_PASSWORD);
    app = await createTestApp();
    admin = await adminToken(app);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    bankPg = new Client({ connectionString: clusterUrl(BANK_DATABASE, BANK_ROLE, BANK_PASSWORD) });
    await bankPg.connect();
    const u = await createUserViaApi(app, admin);
    await assignRole(app, admin, u.id, await roleIdByShortname(app, admin, 'teacher'), await systemContextId(app, admin));
    const session = await login(app, u.username, STRONG_PASSWORD);
    teacher = { id: u.id, token: session.accessToken };
  });

  afterAll(async () => {
    await bankPg?.end();
    await pg?.end();
    await app?.close();
    await appNoBank?.close();
    delete process.env.SYSTEM_BANK_DATABASE_URL;
    const adminUrl = clusterUrl('postgres');
    await withClient(adminUrl, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${quoted(BANK_DATABASE)} WITH (FORCE)`);
      await client.query(`DROP ROLE IF EXISTS ${quoted(BANK_ROLE)}`);
    });
  });

  async function publish(text: string) {
    const res = await http(app).post('/api/v1/system-bank/questions').set(bearer(admin)).send({
      qtype: 'multichoice',
      package: multichoicePackage(text),
    });
    expect(res.status).toBe(201);
    return res.body as { question: { id: string }; version: { id: string; checksum: string } };
  }

  it('phát hành câu + phiên bản mới: phiên bản cũ đọc lại không đổi', async () => {
    const created = await publish('Câu hệ thống gốc');
    const questionId = created.question.id;
    const v2 = await http(app).post(`/api/v1/system-bank/questions/${questionId}/versions`).set(bearer(admin)).send({
      package: multichoicePackage('Câu hệ thống sửa'),
    });
    expect(v2.status).toBe(201);
    const v1 = await http(app).get(`/api/v1/system-bank/questions/${questionId}/versions/1`).set(bearer(admin));
    expect(v1.status).toBe(200);
    expect(v1.body.package.questionText).toMatchObject(doc('Câu hệ thống gốc'));
    const v2read = await http(app).get(`/api/v1/system-bank/questions/${questionId}/versions/2`).set(bearer(admin));
    expect(v2read.status).toBe(200);
    expect(v2read.body.package.questionText).toMatchObject(doc('Câu hệ thống sửa'));
    expect(v2read.body.checksum).not.toBe(v1.body.checksum);
  });

  it('giáo viên khám phá theo dạng câu và nhập bản chụp: đủ nội dung + truy vết, checksum khớp gói nguồn', async () => {
    const created = await publish('Câu để nhập');
    const questionId = created.question.id;
    const discovery = await http(app).get('/api/v1/system-bank/discovery?qtype=multichoice&limit=100').set(bearer(teacher.token));
    expect(discovery.status).toBe(200);
    const found = (discovery.body.items as { id: string; versions: { version: number; checksum: string }[] }[])
      .find((item) => item.id === questionId);
    expect(found).toBeDefined();
    expect(found!.versions.map((row) => row.version)).toEqual([1]);
    const imported = await http(app).post('/api/v1/system-bank/import').set(bearer(teacher.token)).send({
      sourceQuestionId: questionId,
      sourceVersionNumber: 1,
    });
    expect(imported.status).toBe(201);
    expect(imported.body.import.kind).toBe('pristine');
    expect(imported.body.import.sourceQuestionId).toBe(questionId);
    expect(imported.body.import.sourceVersionNumber).toBe(1);
    expect(imported.body.import.packageChecksum).toBe(created.version.checksum);
    expect(imported.body.import.importedVersionNumber).toBe(1);
    const centreQuestionId = imported.body.question.question.id as string;
    const read = await http(app).get(`/api/v1/questions/${centreQuestionId}`).set(bearer(teacher.token));
    expect(read.status).toBe(200);
    expect(read.body.latestVersion.questionText).toMatchObject(doc('Câu để nhập'));
  });

  it('checksum lệch thì nhập bị từ chối', async () => {
    const created = await publish('Câu để phá checksum');
    const questionId = created.question.id;
    await bankPg.query(
      `UPDATE system_question_versions SET checksum = 'deadbeef' WHERE question_id = $1 AND version = 1`,
      [questionId],
    );
    const imported = await http(app).post('/api/v1/system-bank/import').set(bearer(teacher.token)).send({
      sourceQuestionId: questionId,
      sourceVersionNumber: 1,
    });
    expect(imported.status).toBe(400);
    expect((imported.body as { code?: string }).code).toBe('system_bank.checksum_mismatch');
  });

  it('rút câu: khám phá + nhập mới không còn thấy, sự kiện rút được ghi và trung tâm ghi nhận', async () => {
    const created = await publish('Câu sẽ rút');
    const questionId = created.question.id;
    const imported = await http(app).post('/api/v1/system-bank/import').set(bearer(teacher.token)).send({
      sourceQuestionId: questionId,
    });
    expect(imported.status).toBe(201);
    const withdrawn = await http(app).post(`/api/v1/system-bank/questions/${questionId}/withdraw`).set(bearer(admin)).send({
      reason: 'Nội dung lỗi thời',
    });
    expect(withdrawn.status).toBe(201);
    const discovery = await http(app).get('/api/v1/system-bank/discovery?qtype=multichoice&limit=100').set(bearer(teacher.token));
    expect((discovery.body.items as { id: string }[]).find((item) => item.id === questionId)).toBeUndefined();
    const reimport = await http(app).post('/api/v1/system-bank/import').set(bearer(teacher.token)).send({
      sourceQuestionId: questionId,
    });
    expect(reimport.status).toBe(400);
    expect((reimport.body as { code?: string }).code).toBe('system_bank.question_withdrawn');
    const events = await bankPg.query(
      `SELECT id FROM system_bank_events WHERE source_question_id = $1 AND type = 'question_withdrawn'`,
      [questionId],
    );
    expect(events.rowCount).toBe(1);
    const eventId = events.rows[0]!.id as string;
    const ack = await http(app).post(`/api/v1/system-bank/events/${eventId}/acknowledge`).set(bearer(teacher.token)).send();
    expect(ack.status).toBe(201);
    const receipts = await pg.query(
      `SELECT id FROM system_bank_event_receipts WHERE event_id = $1`,
      [eventId],
    );
    expect(receipts.rowCount).toBe(1);
  });

  it('sửa câu đã nhập ở trung tâm: thành bản phái sinh, phiên bản nguyên trạng còn nguyên', async () => {
    const created = await publish('Câu để sửa ở trung tâm');
    const imported = await http(app).post('/api/v1/system-bank/import').set(bearer(teacher.token)).send({
      sourceQuestionId: created.question.id,
    });
    expect(imported.status).toBe(201);
    const centreQuestionId = imported.body.question.question.id as string;
    const updated = await http(app).patch(`/api/v1/questions/${centreQuestionId}`).set(bearer(teacher.token)).send({
      questionText: doc('Câu đã sửa ở trung tâm'),
    });
    expect(updated.status).toBe(200);
    const versions = await http(app).get(`/api/v1/questions/${centreQuestionId}/versions`).set(bearer(teacher.token));
    expect(versions.status).toBe(200);
    const versionNumbers = (versions.body as { version: number }[]).map((row) => row.version);
    expect(versionNumbers).toEqual(expect.arrayContaining([1, 2]));
    const v1 = await http(app).get(`/api/v1/questions/${centreQuestionId}`).set(bearer(teacher.token));
    expect(v1.body.latestVersion.version).toBe(2);
    const rows = await pg.query(
      `SELECT kind, imported_version_number FROM system_question_imports WHERE question_id = $1`,
      [centreQuestionId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]!.kind).toBe('derived');
    expect(rows.rows[0]!.imported_version_number).toBe(1);
  });

  it('bank-off: app không cấu hình kho ngân hàng vẫn đọc câu đã nhập và tạo đề từ câu đó', async () => {
    const created = await publish('Câu cho bank-off');
    const imported = await http(app).post('/api/v1/system-bank/import').set(bearer(teacher.token)).send({
      sourceQuestionId: created.question.id,
    });
    expect(imported.status).toBe(201);
    const centreQuestionId = imported.body.question.question.id as string;
    delete process.env.SYSTEM_BANK_DATABASE_URL;
    appNoBank = await createTestApp();
    // Token JWT ký bằng JWT_SECRET của tiến trình nên token từ app1 vẫn
    // hợp lệ trên app2 (cùng env, cùng DB nghiệp vụ shard).
    const read = await http(appNoBank).get(`/api/v1/questions/${centreQuestionId}`).set(bearer(teacher.token));
    expect(read.status).toBe(200);
    expect(read.body.latestVersion.questionText).toMatchObject(doc('Câu cho bank-off'));
    const draft = await createExamDraft(appNoBank, teacher.token, `Đề bank-off ${uniqueName('')}`);
    const slots = await addExamSlot(appNoBank, teacher.token, draft, { questionId: centreQuestionId });
    expect(slots.slots).toHaveLength(1);
    expect(slots.slots[0]!.questionId).toBe(centreQuestionId);
  });
});

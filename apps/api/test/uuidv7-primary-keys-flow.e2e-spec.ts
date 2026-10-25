import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from './course-enrolment-helpers';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './identity-access-helpers';

/**
 * Kiểm chứng nền tảng khóa chính UUIDv7 (ADR-013).
 * Nguồn: báo cáo nghiên cứu nội bộ postgresql-18-uuidv7 §4.6 — đây là test
 * kiểm chứng nền tảng, KHÔNG phải oracle Moodle.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONN = process.env.DATABASE_URL;

describe('UUIDv7 primary keys (PostgreSQL 18 platform verification)', () => {
  let app: INestApplication;
  let admin: string;
  let pg: Client;
  const run = `u7${Date.now().toString(36)}`;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    pg = new Client({ connectionString: CONN });
    await pg.connect();
  });
  afterAll(async () => { await pg.end(); await app.close(); });

  it('(1) raw SQL inserts without an id get version-7 ids, and the single baseline migration defaults every PK to uuidv7()', async () => {
    const cat = await pg.query(
      `insert into course_categories (name) values ($1) returning id, uuid_extract_version(id) as v`,
      [`${run}-cat`],
    );
    expect(cat.rows[0].v).toBe(7);
    const course = await pg.query(
      `insert into course (category, full_name, short_name) values ($1, $2, $3) returning id, uuid_extract_version(id) as v`,
      [cat.rows[0].id, `${run} course`, `${run}c`],
    );
    expect(course.rows[0].v).toBe(7);
    const tag = await pg.query(
      `insert into tag (name, raw_name) values ($1, $1) returning id, uuid_extract_version(id) as v`,
      [`${run}-tag`],
    );
    expect(tag.rows[0].v).toBe(7);
    const outbox = await pg.query(
      `insert into outbox_events (aggregate, type, payload) values ('course', $1, '{}'::jsonb) returning id, uuid_extract_version(id) as v`,
      [`${run}.created`],
    );
    expect(outbox.rows[0].v).toBe(7);

    const drizzleDir = join(process.cwd(), 'drizzle');
    const migrations = readdirSync(drizzleDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(drizzleDir, d.name, 'migration.sql'));
    expect(migrations).toHaveLength(1);
    const sqlText = readFileSync(migrations[0]!, 'utf8');
    // 160 bảng nghiệp vụ có PK uuidv7: 109 trước đây + session, account, verification,
    // two_factor (đợt Better Auth giai đoạn 1, issue #7) + subjects,
    // curricula, curriculum_nodes, learning_outcomes (đợt GDPT 2018, issue #20)
    // + course_completion_crit_compl (đợt đủ 8 loại tiêu chí completion, issue #23)
    // + message_conversation_reports (đợt Lớp B của issue #33; bảng
    // message_contact_requests cùng đợt là bảng nối thuần tuý, PK phức hợp)
    // + question_subjects, question_learning_outcomes (Chặng 2 của issue #20 —
    // hai bảng nối câu hỏi ↔ chương trình có id đại diện theo thiết kế A.1)
    // + curriculum_program_records, course_section_anchors,
    // course_section_anchor_outcomes (đợt K0a nạp khung chương trình, issue #66)
    // + books, book_nodes,
    // book_mappings, book_records,
    // course_section_book_anchors, course_section_book_items,
    // course_section_book_item_outcomes (đợt K0b tầng SGK, issue #67)
    // + 12 bảng đợt C2 Bài tập nộp tệp/ảnh (issue #88): assignments,
    // assign_submissions, assign_submission_files, assign_grades,
    // assign_annotations, assign_rubrics, assign_rubric_criteria,
    // assign_rubric_levels, assign_rubric_evaluations,
    // assign_grade_revisions, assign_feedback_messages, teacher_comment_bank
    // + pages, resources, course_last_access, course_module_progress,
    // learning_records (đợt K2 player + tiến độ học, issue #85)
    // + blog_post_placements, blog_post_references (đợt BL1 mô hình
    // space/status blog, issue #87).
    // (Đếm lại trên baseline hợp nhất sau rebase lên main be8002b:
    // 158 bảng tổng, 150 bảng có PK mặc định uuidv7().)
    // + vn_gradebooks, vn_term_results (đợt GB-VN-1 sổ điểm TT 22,
    // issue #95) → 160 bảng tổng, 152 bảng có PK mặc định uuidv7()
    // + question_banks, question_bank_contributions, quiz_slot_version_events
    // (feat ngân hàng câu hỏi chung, PR #83) → 163 bảng tổng, 155 bảng có PK
    // mặc định uuidv7().
    // + exam_matrices, exam_matrix_cells, quiz_overrides, quiz_feedbacks,
    // quiz_attempt_events (Quiz Chặng 2+3, issue #30, PR #84) → 168 bảng
    // tổng, 160 bảng có PK mặc định uuidv7().
    // + vn_activity_mappings, vn_candidate_actions (đợt GB-VN-2 luồng
    // hoạt động → cột, issue #104) → 170 bảng tổng, 162 bảng có PK
    // mặc định uuidv7().
    // + grade_publications, guardian_links (đợt PH-0 nền công bố +
    // giám hộ, issue #116) → 172 bảng tổng, 164 bảng có PK mặc định
    // uuidv7().
    // + exam_matrix_contributions (Ngân hàng ma trận MB-1, issue #111)
    // → 173 bảng tổng, 165 bảng có PK mặc định uuidv7().
    // + mcp_idempotency_keys (lát MCP-0 nền MCP server, issue #110)
    // → 174 bảng tổng, 166 bảng có PK mặc định uuidv7().
    // + user_dashboard_state, user_course_card_prefs (đợt DASH1
    // dashboard việc cần làm, issue #121 — hai bảng PK phức hợp theo
    // (user, course), không cột id) → 176 bảng tổng, 166 bảng có PK
    // mặc định uuidv7().
    // + exam_papers, exam_paper_versions, exam_paper_slots,
    // exam_paper_contributions (EB-1 Ngân hàng đề, issue #113) → 180
    // bảng tổng, 170 bảng có PK mặc định uuidv7().
    // + message_moderator_actions (vòng đời tin nhắn theo vai, issue
    // #124; message_user_deletions là bảng nối thuần túy, PK phức hợp,
    // không tính) → 182 bảng tổng, 171 bảng có PK mặc định uuidv7()
    // trên nền 7ff4691 (180 của EB-1 + 2 bảng vòng đời, 1 PK uuidv7).
    // + guardian_view_state (đợt PH-1 bề mặt phụ huynh, issue #130 —
    // PK phức hợp (guardian, student), không cột id) → 183 bảng tổng,
    // 171 bảng có PK mặc định uuidv7().
    // + exam_deployments (EB-2 mã đề ở tầng triển khai, issue #153)
    // → 184 bảng tổng, 172 bảng có PK mặc định uuidv7().
    // + guardian_digests (đợt PH-2 digest phụ huynh, issue #159 — hàng
    // chạy digest + vết chống lặp, PK id uuidv7) → trên cây hợp nhất:
    // 185 bảng tổng, 173 bảng có PK mặc định uuidv7().
    expect(sqlText.match(/DEFAULT uuidv7\(\)/g)?.length).toBe(173);
    // Chỉ hai cột seq phụ được dùng identity; không PK nghiệp vụ nào dùng sequence/identity.
    expect(sqlText.match(/GENERATED ALWAYS AS IDENTITY/g)?.length).toBe(2);
    expect(sqlText).not.toMatch(/CREATE SEQUENCE/);
  });

  it('(1b) the live catalog defaults every entity id to uuidv7(), and pure join tables carry no surrogate id', async () => {
    const defaults = await pg.query<{ table_name: string; column_default: string | null }>(
      `SELECT c.relname AS table_name, pg_get_expr(d.adbin, d.adrelid) AS column_default
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'id'
         LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
        WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    expect(defaults.rows.length).toBe(173);
    for (const row of defaults.rows) {
      expect(row.column_default, `table ${row.table_name}`).toBe('uuidv7()');
    }
    // Bảng nối thuần túy (ADR-013): không cột id — PK phức hợp từ hai FK,
    // trừ hai bảng mà PK đồng thời là FK duy nhất thì giữ PK một cột.
    const joinTables: Record<string, number> = {
      cohort_members: 2,
      groupings_groups: 2,
      message_conversation_members: 2,
      message_contact_requests: 2,
      message_users_blocked: 2,
      course_completion_settings: 1,
      tag_correlation: 1,
    };
    for (const [joinTable, pkColumns] of Object.entries(joinTables)) {
      expect(defaults.rows.map((r) => r.table_name)).not.toContain(joinTable);
      const pk = await pg.query<{ attname: string }>(
        `SELECT a.attname FROM pg_constraint con
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
          WHERE con.contype = 'p' AND con.conrelid = $1::regclass`,
        [joinTable],
      );
      expect(pk.rows.length, `join table ${joinTable} PK shape`).toBe(pkColumns);
    }
  });

  it('(2) ids are monotonic within one session: 2,000 sequential inserts on one connection sort in insertion order', async () => {
    // Một Client = một connection = một session: đúng phạm vi đảm bảo của uuidv7().
    const inserted: string[] = [];
    for (let i = 0; i < 2000; i += 1) {
      const r = await pg.query(`insert into tag (name, raw_name) values ($1, $1) returning id`, [`${run}-mono-${i}`]);
      inserted.push(r.rows[0].id as string);
    }
    const sorted = await pg.query(`select id from tag where name like $1 order by id`, [`${run}-mono-%`]);
    expect(sorted.rows.map((r) => r.id as string)).toEqual(inserted);
    await pg.query(`delete from tag where name like $1`, [`${run}-mono-%`]);
  }, 60_000);

  it('(3) mixing DB defaults and app-side $defaultFn ids never collides, and seq stays unique and increasing', async () => {
    const ids = new Set<string>();
    const seqs: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      const appSide = i % 2 === 0;
      const r = appSide
        ? await pg.query(
            `insert into outbox_events (id, aggregate, type, payload) values ($1, 'mix', $2, '{}'::jsonb) returning id, seq`,
            [uuidv7(), `${run}.mix`],
          )
        : await pg.query(
            `insert into outbox_events (aggregate, type, payload) values ('mix', $1, '{}'::jsonb) returning id, seq`,
            [`${run}.mix`],
          );
      ids.add(r.rows[0].id as string);
      seqs.push(r.rows[0].seq as number);
    }
    expect(ids.size).toBe(60);
    for (const id of ids) expect(id).toMatch(UUID_RE);
    expect(new Set(seqs).size).toBe(60);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    await pg.query(`delete from outbox_events where type = $1`, [`${run}.mix`]);
  });

  it('(3b) bulk mixed generation stays unique: 100k ids from DB defaults, app-side values and parallel connections', async () => {
    await pg.query(`create table if not exists u7_probe (id uuid primary key default uuidv7(), marker text not null)`);
    try {
      await pg.query(`insert into u7_probe (marker) select $1 from generate_series(1, 40000)`, [`${run}-bulk-db`]);
      const appIds = Array.from({ length: 30000 }, () => uuidv7());
      await pg.query(`insert into u7_probe (id, marker) select unnest($1::uuid[]), $2`, [appIds, `${run}-bulk-app`]);
      const clients = await Promise.all(
        Array.from({ length: 3 }, async () => {
          const c = new Client({ connectionString: CONN });
          await c.connect();
          return c;
        }),
      );
      try {
        await Promise.all(
          clients.map((c, idx) =>
            c.query(`insert into u7_probe (marker) select $1 from generate_series(1, 10000)`, [`${run}-bulk-par-${idx}`]),
          ),
        );
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
      const agg = await pg.query<{ total: string; distinct_ids: string }>(
        `select count(*) as total, count(distinct id) as distinct_ids from u7_probe where marker like $1`,
        [`${run}-bulk-%`],
      );
      expect(Number(agg.rows[0].total)).toBe(100000);
      expect(agg.rows[0].distinct_ids).toBe(agg.rows[0].total);
    } finally {
      await pg.query(`drop table if exists u7_probe`);
    }
  }, 60_000);

  it('(4) uuid_extract_timestamp agrees with created_at within ±2s', async () => {
    const r = await pg.query(
      `insert into event_log (event_type, payload) values ($1, '{}'::jsonb)
       returning id, created_at, uuid_extract_timestamp(id) as embedded`,
      [`${run}.probe`],
    );
    const row = r.rows[0] as { created_at: Date; embedded: Date };
    const driftMs = Math.abs(new Date(row.embedded).getTime() - new Date(row.created_at).getTime());
    expect(driftMs).toBeLessThanOrEqual(2000);
    await pg.query(`delete from event_log where event_type = $1`, [`${run}.probe`]);
  });

  it('(5) keyset pagination on (created_at, id) neither duplicates nor loses rows when inserts land mid-paging', async () => {
    const base = new Date('2026-01-01T00:00:00.000Z').getTime();
    const originalIds: string[] = [];
    // 30 dòng, mốc thời gian trùng nhau theo nhóm 5 để buộc dùng id làm tie-break.
    for (let i = 0; i < 30; i += 1) {
      const ts = new Date(base + Math.floor(i / 5) * 1000);
      const r = await pg.query(
        `insert into event_log (event_type, created_at, payload) values ($1, $2, '{}'::jsonb) returning id`,
        [`${run}.page`, ts],
      );
      originalIds.push(r.rows[0].id as string);
    }
    interface PageRow { id: string; created_at: Date }
    const seen: string[] = [];
    let cursor: { t: Date; id: string } | null = null;
    let pages = 0;
    for (;;) {
      const r: { rows: PageRow[] } = cursor === null
        ? await pg.query(
            `select id, created_at from event_log where event_type = $1 order by created_at, id limit 7`,
            [`${run}.page`],
          )
        : await pg.query(
            `select id, created_at from event_log where event_type = $1 and (created_at, id) > ($2, $3)
             order by created_at, id limit 7`,
            [`${run}.page`, cursor.t, cursor.id],
          );
      if (r.rows.length === 0) break;
      pages += 1;
      for (const row of r.rows) seen.push(row.id);
      const last: PageRow = r.rows[r.rows.length - 1]!;
      cursor = { t: last.created_at, id: last.id };
      if (pages === 2) {
        // Chèn giữa chừng với timestamp muộn hơn mọi dòng gốc: không được làm
        // trùng/sót các dòng gốc (dòng mới có thể xuất hiện ở trang sau).
        for (let i = 0; i < 3; i += 1) {
          await pg.query(
            `insert into event_log (event_type, created_at, payload) values ($1, $2, '{}'::jsonb)`,
            [`${run}.page`, new Date(base + 3_600_000 + i)],
          );
        }
      }
      if (pages > 10) throw new Error('pagination did not terminate');
    }
    expect(pages).toBe(5); // 33 dòng / 7 mỗi trang
    expect(new Set(seen).size).toBe(seen.length); // không trùng
    for (const id of originalIds) expect(seen.filter((s) => s === id)).toHaveLength(1); // không sót dòng gốc
    await pg.query(`delete from event_log where event_type = $1`, [`${run}.page`]);
  });

  it('(6) FK filters use the explicit FK indexes (planner + pg_indexes presence)', async () => {
    const expectedIndexes = [
      'course_category_idx',
      'course_modules_course_idx',
      'course_modules_section_idx',
      'grade_grades_user_id_idx',
      'user_enrolments_user_id_idx',
    ];
    const present = await pg.query(
      `select indexname from pg_indexes where schemaname = 'public' and indexname = any($1)`,
      [expectedIndexes],
    );
    expect(present.rows.map((r) => r.indexname as string).sort()).toEqual([...expectedIndexes].sort());

    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    await pg.query('begin');
    try {
      // Tắt seqscan trong transaction kiểm chứng để khẳng định index dùng được
      // cho predicate FK (bảng kiểm chứng nhỏ nên planner mặc định chọn seqscan).
      await pg.query('set local enable_seqscan = off');
      const plan = await pg.query(`explain (format json) select * from course where category = $1`, [course.category]);
      const planText = JSON.stringify(plan.rows[0]['QUERY PLAN']);
      expect(planText).toContain('Index');
      expect(planText).toContain('course_category_idx');
    } finally {
      await pg.query('rollback');
    }
  });

  it('(6b) every single-column foreign key in the schema is covered by a leading index column', async () => {
    const missing = await pg.query<{ col: string }>(
      `SELECT conrelid::regclass || '.' || a.attname AS col
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1
          AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = a.attnum)`,
    );
    expect(missing.rows.map((r) => r.col)).toEqual([]);
  });

  it('(7) IDOR: a valid UUID of another course resource is still denied (404/403) after the key change', async () => {
    const cat = await createCategory(app, admin);
    const courseA = await createCourse(app, admin, cat.id);
    const courseB = await createCourse(app, admin, cat.id);
    const student = await createUserViaApi(app, admin);
    const instance = await createEnrolInstance(app, admin, courseA.id);
    await enrolUser(app, admin, courseA.id, instance.id, student.id);
    const token = (await login(app, student.username, STRONG_PASSWORD)).accessToken;

    const own = await http(app).get(`/api/v1/courses/${courseA.id}/content`).set('Authorization', `Bearer ${token}`);
    expect(own.status).toBe(200);
    const foreign = await http(app).get(`/api/v1/courses/${courseB.id}/content`).set('Authorization', `Bearer ${token}`);
    expect([403, 404]).toContain(foreign.status);
  });

  it('(8) API contract: ids serialize as UUIDv7 strings; malformed id → 400; unknown well-formed id → 404', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    expect(typeof course.id).toBe('string');
    expect(course.id).toMatch(UUID_RE);

    const malformed = await http(app).get('/api/v1/courses/not-a-uuid').set('Authorization', `Bearer ${admin}`);
    expect(malformed.status).toBe(400);

    const missing = await http(app).get(`/api/v1/courses/${uuidv7()}`).set('Authorization', `Bearer ${admin}`);
    expect(missing.status).toBe(404);
  });

  it('(8b) user ids follow the same contract — and a malformed user id is a 400, never a 500 from the capability guard', async () => {
    // CapabilityGuard chạy trước pipe validate và tra context theo :id thô:
    // id không phải UUID từng làm guard ném lỗi DB (500). Regression test
    // cho hành vi đúng của hợp đồng: 400 ở biên validate.
    const created = await createUserViaApi(app, admin);
    expect(created.id).toMatch(UUID_RE);

    const malformed = await http(app).get('/api/v1/users/not-a-uuid').set('Authorization', `Bearer ${admin}`);
    expect(malformed.status).toBe(400);

    const missing = await http(app).get(`/api/v1/users/${uuidv7()}`).set('Authorization', `Bearer ${admin}`);
    expect(missing.status).toBe(404);
  });
});

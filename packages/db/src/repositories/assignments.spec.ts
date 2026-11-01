import { describe, expect, it } from 'vitest';
import { createRecordingDb } from '../test-support/recording-db';
import { AssignmentsRepository } from './assignments';
import { GuardiansRepository } from './guardians';

/**
 * Ca đơn vị của repository bài tập và repository liên kết giám hộ
 * (issue #649): khoá hình dạng SQL biên dịch — không cần database,
 * handle ghi lại câu SQL + tham số mà Kysely biên dịch. Ngữ nghĩa
 * chạy thật trên database được khoá ở các spec tích hợp đi kèm.
 *
 * Bất biến được khoá ở đây:
 * - Cột jsonb `points` của dấu chấm được ghi bằng chuỗi JSON đã
 *   serialize tường minh (tham số là chuỗi JSON), không đưa mảng
 *   thô cho driver — driver `pg` hiểu mảng cấp cao nhất là mảng
 *   PostgreSQL và cột jsonb sẽ lỗi (khuôn đã đo ở pilot).
 * - Bộ lọc động của `listLinks` (khuôn T-13): không bộ lọc thì
 *   không có mệnh đề WHERE; có bộ lọc thì các điều kiện nối bằng
 *   AND trong WHERE và không điều kiện nào mang giá trị `undefined`
 *   (T-4: `undefined` trong WHERE gắn NULL và lặng lẽ trả 0 dòng).
 */
const SUBMISSION_ID = '01a19887-6b35-7760-8e64-a5960bfd0875';
const FILE_ID = '01a19887-6b35-7760-8e64-a5960bfd0876';
const AUTHOR_ID = '01a19887-6b35-7760-8e64-a5960bfd0877';
const GUARDIAN_ID = '01a19887-6b35-7760-8e64-a5960bfd0878';

describe('AssignmentsRepository — hình dạng SQL biên dịch', () => {
  it('insertAnnotation serialize mảng points thành chuỗi JSON tường minh khi ghi vào cột jsonb', async () => {
    const { db, driver } = createRecordingDb();
    const repo = new AssignmentsRepository(db);

    await repo.insertAnnotation({
      submissionId: SUBMISSION_ID,
      fileId: FILE_ID,
      page: 1,
      x: 0.25,
      y: 0.5,
      kind: 'draw',
      color: null,
      text: null,
      points: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
      authorId: AUTHOR_ID,
    });

    expect(driver.queries).toHaveLength(1);
    const compiled = driver.queries[0]!;
    expect(compiled.sql).toContain('insert into "assign_annotations"');
    expect(compiled.sql).toContain('::jsonb');
    expect(compiled.parameters).toContain('[{"x":1,"y":2},{"x":3,"y":4}]');
    expect(compiled.parameters).not.toContainEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
  });

  it('upsertGrade biên dịch đúng khoá trùng (assignment_id, user_id) cho nhánh ghi/đè gói chấm', async () => {
    const { db, driver } = createRecordingDb();
    const repo = new AssignmentsRepository(db);

    await repo.upsertGrade({
      assignmentId: SUBMISSION_ID,
      userId: AUTHOR_ID,
      graderId: AUTHOR_ID,
      attemptNumber: 1,
      grade: 8.5,
    });

    expect(driver.queries).toHaveLength(1);
    const sqlText = driver.queries[0]!.sql;
    expect(sqlText).toContain('insert into "assign_grades"');
    expect(sqlText).toContain('on conflict ("assignment_id", "user_id") do update set');
  });
});

describe('GuardiansRepository — bộ lọc động của listLinks (T-13)', () => {
  it('không bộ lọc thì câu truy vấn không có mệnh đề WHERE', async () => {
    const { db, driver } = createRecordingDb();
    const repo = new GuardiansRepository(db);

    await repo.listLinks({});

    expect(driver.queries).toHaveLength(1);
    expect(driver.queries[0]!.sql).not.toContain(' where ');
    expect(driver.queries[0]!.parameters).toEqual([]);
  });

  it('có bộ lọc thì các điều kiện nối bằng AND và tham số không chứa undefined', async () => {
    const { db, driver } = createRecordingDb();
    const repo = new GuardiansRepository(db);

    await repo.listLinks({ guardianUserId: GUARDIAN_ID, status: 'active' });

    expect(driver.queries).toHaveLength(1);
    const compiled = driver.queries[0]!;
    expect(compiled.sql).toContain(' where ');
    expect(compiled.sql).toContain(' and ');
    expect(compiled.parameters).toEqual([GUARDIAN_ID, 'active']);
    expect(compiled.parameters).not.toContain(undefined);
  });
});

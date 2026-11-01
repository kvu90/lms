import { describe, expect, it } from 'vitest';
import { createRecordingDb } from '../test-support/recording-db';
import { GuardianViewRepository } from './guardian-view';

/**
 * Ca đơn vị của repository bề mặt phụ huynh chỉ-xem (issue #649):
 * khoá HÌNH DẠNG SQL biên dịch của các truy vấn đọc — không cần
 * database, handle ghi lại câu SQL + tham số mà Kysely biên dịch.
 *
 * Bất biến được khoá ở đây (hành vi chạy thật trên database được
 * khoá tiếp ở spec tích hợp đi kèm):
 * - Điều kiện trên bảng được nối bằng LEFT JOIN nằm trong mệnh đề
 *   ON, không rơi xuống WHERE: `completion_state <> 0` của tiến độ
 *   theo khoá và `preview = false` của attempt quiz. Dời xuống WHERE
 *   sẽ đổi ngữ nghĩa phép nối ngoài (module/quiz bị lọc mất thay vì
 *   chỉ không đóng góp vào số đếm/trạng thái) — đây là điểm nóng đã
 *   được nêu đích danh của nhóm G9.
 * - Tập khoá rỗng được chặn ở đầu phương thức: không câu truy vấn
 *   nào được biên dịch hay thực thi.
 */
const COURSE_ID = '01a19887-6b35-7760-8e64-a5960bfd0875';
const STUDENT_ID = '01a19887-6b35-7760-8e64-a5960bfd0876';
const UNTIL = new Date('2026-11-06T00:00:00.000Z');

describe('GuardianViewRepository — hình dạng SQL biên dịch', () => {
  it('courseProgressRows giữ điều kiện completion_state <> 0 trong ON của left join, không nằm trong WHERE', async () => {
    const { db, driver } = createRecordingDb();
    const repo = new GuardianViewRepository(db);

    await repo.courseProgressRows([COURSE_ID], STUDENT_ID);

    expect(driver.queries).toHaveLength(1);
    const sqlText = driver.queries[0]!.sql;
    const whereAt = sqlText.indexOf(' where ');
    expect(whereAt).toBeGreaterThan(-1);
    const joinPart = sqlText.slice(0, whereAt);
    const wherePart = sqlText.slice(whereAt);
    expect(joinPart).toContain('left join "course_modules_completion"');
    expect(joinPart).toContain('"course_modules_completion"."completion_state" <>');
    expect(wherePart).not.toContain('completion_state');
    expect(wherePart).toContain('"course_modules"."completion" <>');
  });

  it('quizDueRows giữ điều kiện preview = false trong ON của left join attempt, không nằm trong WHERE', async () => {
    const { db, driver } = createRecordingDb();
    const repo = new GuardianViewRepository(db);

    await repo.quizDueRows([COURSE_ID], STUDENT_ID, UNTIL);

    expect(driver.queries).toHaveLength(1);
    const compiled = driver.queries[0]!;
    const whereAt = compiled.sql.indexOf(' where ');
    expect(whereAt).toBeGreaterThan(-1);
    const joinPart = compiled.sql.slice(0, whereAt);
    const wherePart = compiled.sql.slice(whereAt);
    expect(joinPart).toContain('left join "exam_attempts"');
    expect(joinPart).toContain('"exam_attempts"."preview" =');
    expect(wherePart).not.toContain('"exam_attempts"');
    expect(compiled.parameters).toContain(false);
    expect(compiled.parameters).toContain(STUDENT_ID);
  });

  it('tập khoá rỗng: cả ba truy vấn gom theo khoá trả mảng rỗng mà không thực thi câu truy vấn nào', async () => {
    const { db, driver } = createRecordingDb();
    const repo = new GuardianViewRepository(db);

    await expect(repo.quizDueRows([], STUDENT_ID, UNTIL)).resolves.toEqual([]);
    await expect(repo.assignmentDueRows([], STUDENT_ID, UNTIL)).resolves.toEqual([]);
    await expect(repo.courseProgressRows([], STUDENT_ID)).resolves.toEqual([]);
    expect(driver.queries).toHaveLength(0);
  });
});

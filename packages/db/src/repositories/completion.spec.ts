import { describe, expect, it } from 'vitest';
import { createRecordingDb } from '../test-support/recording-db';
import { CompletionRepository } from './completion';

/**
 * Ca đơn vị của repository hoàn thành (issue #649): khoá hình dạng
 * SQL biên dịch của các thao tác ghi/đè — không cần database, handle
 * ghi lại câu SQL + tham số mà Kysely biên dịch. Ngữ nghĩa chạy thật
 * trên database được khoá ở spec tích hợp đi kèm.
 *
 * Bất biến được khoá ở đây:
 * - Quy tắc T-4 (đã đo ở pilot): trường mang `undefined` trong dữ
 *   kiện ghi bị LOẠI khỏi cả values insert lẫn set của nhánh cập
 *   nhật-khi-trùng — không biên dịch thành tham số, để default của
 *   database (nhánh chèn) và giá trị đã có (nhánh cập nhật) quyết
 *   định.
 * - Đọc cấu hình của khoá chưa từng cấu hình trả mặc định
 *   `{ method: 1 }` mà không ghi gì xuống database.
 */
const CM_ID = '01a19887-6b35-7760-8e64-a5960bfd0875';
const USER_ID = '01a19887-6b35-7760-8e64-a5960bfd0876';
const COURSE_ID = '01a19887-6b35-7760-8e64-a5960bfd0877';

describe('CompletionRepository — hình dạng SQL biên dịch', () => {
  it('upsertCmCompletion loại trường undefined khỏi values và khỏi set khi trùng khoá (T-4)', async () => {
    const { db, driver } = createRecordingDb();
    const repo = new CompletionRepository(db);

    await repo.upsertCmCompletion({ courseModuleId: CM_ID, userId: USER_ID, completionState: 1 });

    expect(driver.queries).toHaveLength(1);
    const sqlText = driver.queries[0]!.sql;
    expect(sqlText).toContain('insert into "course_modules_completion"');
    expect(sqlText).toContain('on conflict ("course_module_id", "user_id") do update set');
    // Khoanh vùng khẳng định âm tính ở phần values + set (trước
    // RETURNING): danh sách cột trả về luôn chứa đủ mọi cột của dòng.
    const writePart = sqlText.slice(0, sqlText.indexOf(' returning '));
    expect(writePart).not.toContain('"viewed"');
    expect(writePart).not.toContain('"override_by"');
    expect(writePart).toContain('"completion_state"');
    expect(writePart).toContain('"updated_at"');
  });

  it('upsertCourseCompletion không đưa time_enrolled vào set khi trùng khoá — mốc ghi danh của dòng đã có được giữ nguyên', async () => {
    const { db, driver } = createRecordingDb();
    const repo = new CompletionRepository(db);

    await repo.upsertCourseCompletion({
      userId: USER_ID,
      course: COURSE_ID,
      status: 'complete',
      timeEnrolled: new Date('2026-09-01T00:00:00.000Z'),
      timeStarted: new Date('2026-09-02T00:00:00.000Z'),
      timeCompleted: new Date('2026-10-01T00:00:00.000Z'),
    });

    expect(driver.queries).toHaveLength(1);
    const sqlText = driver.queries[0]!.sql;
    const conflictAt = sqlText.indexOf('on conflict');
    expect(conflictAt).toBeGreaterThan(-1);
    const insertPart = sqlText.slice(0, conflictAt);
    // Khoanh vùng ở đúng mệnh đề SET (từ "do update set" tới trước
    // RETURNING): danh sách cột trả về luôn chứa đủ mọi cột của dòng.
    const setPart = sqlText.slice(sqlText.indexOf('do update set'), sqlText.indexOf(' returning '));
    expect(insertPart).toContain('"time_enrolled"');
    expect(setPart).not.toContain('"time_enrolled"');
    expect(setPart).toContain('"re_aggregate"');
  });

  it('getSettings trả mặc định { method: 1 } khi khoá chưa có dòng cấu hình, và không ghi gì', async () => {
    const { db, driver } = createRecordingDb();
    const repo = new CompletionRepository(db);

    await expect(repo.getSettings(COURSE_ID)).resolves.toEqual({ method: 1 });
    expect(driver.queries).toHaveLength(1);
    expect(driver.queries[0]!.sql).toContain('select');
    expect(driver.queries[0]!.sql).toContain('"course_completion_settings"');
  });
});

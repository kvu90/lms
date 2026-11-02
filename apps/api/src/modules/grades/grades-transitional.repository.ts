import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import type { GradeRow } from '@lms/db/repositories/grades';
import type { Database, DbTx } from '../../db/database';
import { gradeGrades, gradeGradesHistory } from '../../db/schema';

/**
 * Repository CHUYỂN TIẾP phía Drizzle của ba luồng ghi điểm —
 * cùng họ điểm nối C-7/C-8 của chiến dịch chuyển Kysely (xem
 * `CORRECTIONS.md` của chiến dịch).
 *
 * Toàn bộ bề mặt dữ liệu của cụm grades đã chuyển sang repository
 * Kysely ở `@lms/db/repositories/grades` (issue #644). Riêng ba
 * luồng `setGrade`, `recordActivityGrade` và `updateGrade` của
 * GradesService còn giữ 100% phía Drizzle: mỗi luồng phải giữ
 * nguyên tử trọn gói trong MỘT transaction — ghi/cập nhật dòng
 * điểm + ghi dòng lịch sử + chèn dòng outbox `grade_updated` — và
 * phía outbox của ba luồng này (`OutboxService.enqueue`) vẫn ở
 * Drizzle, thuộc đợt D1 (issue #653), trong khi repository Kysely
 * không nhận handle Drizzle. Biến thể Kysely `enqueueKysely` đã có
 * trên main (vào qua PR #672 theo điểm C-8 của chiến dịch) nhưng
 * chủ hấp thụ và lật các luồng còn lại vẫn là đợt D1 #653, nên ba
 * luồng giữ nguyên trạng thái ở đây. Kiểm kê tại issue #644 xác nhận ba luồng này là toàn
 * bộ bề mặt giao dịch của cụm grades và ba phương thức ghi dưới
 * đây chỉ được gọi bên trong chúng.
 *
 * File này CHỈ chứa đúng các lệnh ghi ba luồng đó dùng — mở
 * transaction, upsert dòng điểm, cập nhật dòng điểm, chèn dòng
 * lịch sử — không đọc, không logic thêm; thân các lệnh ghi giữ
 * nguyên văn của repository cũ. Chủ đóng: đợt D1 (issue #653) —
 * khi OutboxService chuyển sang Kysely, ba luồng lật điểm mở
 * transaction sang Kysely, dời lời gọi về `upsertGrade` /
 * `updateGrade` / `insertHistory` của repository phía Kysely và
 * XOÁ file này; issue #663 (gỡ Drizzle) đối chiếu không còn sót.
 */
@Injectable()
export class GradesTransitionalRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** Mở một transaction Drizzle cho một luồng ghi điểm. */
  async transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  /**
   * Điểm ghi CHUYỂN TIẾP: ghi/cập nhật MỘT dòng điểm trong
   * transaction Drizzle được truyền vào (nhánh xung đột theo
   * (item, user) giữ nguyên tập trường của repository cũ) — xem
   * đầu file về lý do tồn tại và điều kiện xoá.
   */
  async upsertGradeTx(v: typeof gradeGrades.$inferInsert, tx: DbTx): Promise<GradeRow> {
    const [row] = await tx.insert(gradeGrades).values(v)
      .onConflictDoUpdate({
        target: [gradeGrades.itemId, gradeGrades.userId],
        set: {
          rawGrade: v.rawGrade, finalGrade: v.finalGrade, hidden: v.hidden, locked: v.locked,
          overridden: v.overridden, excluded: v.excluded, frozen: v.frozen, feedback: v.feedback,
          aggregationStatus: v.aggregationStatus, aggregationWeight: v.aggregationWeight,
          lockTime: v.lockTime, updatedAt: new Date(),
        },
      }).returning();
    return row! as GradeRow;
  }

  /**
   * Điểm ghi CHUYỂN TIẾP: cập nhật MỘT dòng điểm trong transaction
   * Drizzle được truyền vào — chỉ UPDATE theo patch, không đọc,
   * không logic thêm. (Xem đầu file về điều kiện xoá.)
   */
  async updateGradeTx(id: string, patch: Partial<GradeRow>, tx: DbTx): Promise<void> {
    await tx.update(gradeGrades).set({ ...patch, updatedAt: new Date() }).where(eq(gradeGrades.id, id));
  }

  /**
   * Điểm ghi CHUYỂN TIẾP: chèn MỘT dòng lịch sử điểm trong
   * transaction Drizzle được truyền vào — chỉ INSERT, không đọc,
   * không logic thêm. (Xem đầu file về điều kiện xoá.)
   */
  async insertHistoryTx(v: typeof gradeGradesHistory.$inferInsert, tx: DbTx): Promise<void> {
    await tx.insert(gradeGradesHistory).values(v);
  }
}

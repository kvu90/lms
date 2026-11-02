import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import type { ClassRow, CohortRow } from '@lms/db/repositories/classes';
import type { Database, DbTx } from '../../db/database';
import { classes, cohort } from '../../db/schema';

/**
 * Repository CHUYỂN TIẾP phía Drizzle của giao dịch tạo lớp — điểm
 * nối C-8/B của chiến dịch chuyển Kysely (xem `CORRECTIONS.md` của
 * chiến dịch, mục C-8).
 *
 * Toàn bộ bề mặt dữ liệu của cụm classes đã chuyển sang repository
 * Kysely ở `@lms/db/repositories/classes`. Riêng giao dịch tạo lớp
 * (`ClassesService.createClass`) còn giữ 100% phía Drizzle: bên
 * trong giao dịch đó, service gọi `contexts.createContext`,
 * `roles.setCapabilityOverride` và `roles.assignRole` kèm
 * transaction của tầng access. Phán quyết C-8 cho phép thêm biến
 * thể Kysely cho ba phương thức access đó NHƯNG kèm điều kiện
 * dừng từng điểm — và `roles.assignRole` thực chất làm nhiều hơn
 * ghi giới hạn (cổng giới hạn gói của tenant, kiểm tra phân tách
 * vai, đánh dấu bẩn bộ nhớ đệm quyền, phát sự kiện `role_assigned`
 * qua outbox) nên điểm đó đã DỪNG theo đúng điều kiện; vì tạo lớp
 * là điểm gọi transaction duy nhất của cả ba phương thức, giao
 * dịch tạo lớp không thể lật sang Kysely trong PR này mà không
 * phá nguyên tử trọn gói của nó.
 *
 * File này CHỈ chứa đúng các lệnh ghi giao dịch tạo lớp dùng —
 * mở transaction, chèn cohort nền, chèn dòng lớp, nối context cho
 * cohort — không đọc, không logic thêm. Chủ đóng: đợt access
 * (#651) khi chuyển tầng access sang Kysely (kèm phán quyết bổ
 * sung của điều phối): lật điểm mở transaction của `createClass`
 * sang Kysely và XOÁ file này; issue #663 đối chiếu không còn sót.
 */
@Injectable()
export class ClassesTransitionalRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** Mở một transaction Drizzle cho giao dịch tạo lớp. */
  async transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  /** Chèn backing cohort của lớp trong transaction tạo lớp. */
  async insertBackingCohort(v: typeof cohort.$inferInsert, tx: DbTx): Promise<CohortRow> {
    const [row] = await tx.insert(cohort).values(v).returning();
    return row! as CohortRow;
  }

  /** Chèn dòng lớp trong transaction tạo lớp. */
  async insertClass(v: typeof classes.$inferInsert, tx: DbTx): Promise<ClassRow> {
    const [row] = await tx.insert(classes).values(v).returning();
    return row! as ClassRow;
  }

  /** Nối context lớp vừa tạo cho backing cohort, trong transaction tạo lớp. */
  async updateCohortContext(cohortId: string, contextId: string, tx: DbTx): Promise<void> {
    await tx.update(cohort).set({ contextId, updatedAt: new Date() }).where(eq(cohort.id, cohortId));
  }
}

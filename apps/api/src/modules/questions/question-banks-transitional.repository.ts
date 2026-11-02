import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { BankCategoryRow, QuestionBankRow } from '@lms/db/repositories/question-banks';
import type { Database, DbTx } from '../../db/database';
import { questionBanks, questionCategories } from '../../db/schema';

/**
 * Repository CHUYỂN TIẾP phía Drizzle của giao dịch dựng bank —
 * điểm nối C-7 của chiến dịch chuyển Kysely (xem `CORRECTIONS.md`
 * của chiến dịch, mục C-7).
 *
 * Toàn bộ bề mặt dữ liệu của lớp bank đã chuyển sang repository
 * Kysely ở `@lms/db/repositories/question-banks` (issue #644).
 * Riêng giao dịch `buildBank` (QuestionBanksService) còn giữ 100%
 * phía Drizzle: nó phải giữ bất biến nguyên tử DL-09 (issue #490)
 * trong MỘT transaction — context + dòng bank + category mặc
 * định + override hai vai + gán vai lead + dòng outbox
 * `question_bank_created` — và các phía còn lại trong transaction
 * đó (context/roles của access, outbox) vẫn ở Drizzle, trong khi
 * các repository Kysely không nhận handle Drizzle.
 *
 * File này CHỈ chứa đúng các lệnh ghi của buildBank dùng — mở
 * transaction, chèn dòng bank, chèn category mặc định — không
 * đọc, không logic thêm. Chủ đóng KHÔNG ĐỔI: PR merge CUỐI trong
 * ba issue #644/#651/#653 chuyển điểm mở transaction của
 * buildBank sang Kysely, dời hai lời gọi về `insertBank` của
 * repository phía Kysely và `insertCategory` của
 * QuestionsRepository phía Kysely rồi XOÁ file này; issue #663
 * (gỡ Drizzle) đối chiếu không còn sót điểm chuyển tiếp nào. PR
 * #644 chạy trước #651/#653 nên KHÔNG đóng C-7.
 */
@Injectable()
export class QuestionBanksTransitionalRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** Mở một transaction Drizzle cho giao dịch dựng bank. */
  async transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  /**
   * Điểm ghi CHUYỂN TIẾP C-7: chèn MỘT dòng bank vào transaction
   * Drizzle được truyền vào — chỉ INSERT, không đọc, không logic
   * thêm. (Xem đầu file về lý do tồn tại và điều kiện xoá.)
   */
  async insertBankTx(v: typeof questionBanks.$inferInsert, tx: DbTx): Promise<QuestionBankRow> {
    const [row] = await tx.insert(questionBanks).values(v).returning();
    return row! as QuestionBankRow;
  }

  /**
   * Điểm ghi CHUYỂN TIẾP C-7 (có từ issue #642): chèn MỘT dòng
   * category vào transaction Drizzle được truyền vào — chỉ
   * INSERT, không đọc, không logic thêm. (Xem đầu file về lý do
   * tồn tại và điều kiện xoá.)
   */
  async insertCategoryTx(v: typeof questionCategories.$inferInsert, tx: DbTx): Promise<BankCategoryRow> {
    const [row] = await tx.insert(questionCategories).values(v).returning();
    return row! as BankCategoryRow;
  }
}

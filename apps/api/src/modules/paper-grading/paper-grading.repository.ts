/**
 * Kho dữ liệu của chấm bài giấy (CAM-0, issue #112): lô phiếu in
 * (layout + roster đã chụp) và từng phiếu đã quét kèm vòng đời hàng
 * chờ. Mọi truy vấn nghiệp vụ nằm ở PaperGradingService; kho này chỉ
 * làm CRUD mỏng trên hai bảng `quiz_paper_batches`/`quiz_paper_scans`.
 */
import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { quizPaperBatches, quizPaperScans } from '../../db/schema';

export type PaperBatchRow = typeof quizPaperBatches.$inferSelect;
export type PaperScanRow = typeof quizPaperScans.$inferSelect;

@Injectable()
export class PaperGradingRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  async insertBatch(v: typeof quizPaperBatches.$inferInsert): Promise<PaperBatchRow> {
    const [row] = await this.db.insert(quizPaperBatches).values(v).returning();
    return row!;
  }

  async getBatch(id: string): Promise<PaperBatchRow | undefined> {
    const [row] = await this.db.select().from(quizPaperBatches).where(eq(quizPaperBatches.id, id));
    return row;
  }

  async listBatchesForQuiz(quizId: string): Promise<PaperBatchRow[]> {
    return this.db.select().from(quizPaperBatches)
      .where(eq(quizPaperBatches.quizId, quizId))
      .orderBy(asc(quizPaperBatches.createdAt));
  }

  async insertScan(v: typeof quizPaperScans.$inferInsert): Promise<PaperScanRow> {
    const [row] = await this.db.insert(quizPaperScans).values(v).returning();
    return row!;
  }

  async getScan(id: string): Promise<PaperScanRow | undefined> {
    const [row] = await this.db.select().from(quizPaperScans).where(eq(quizPaperScans.id, id));
    return row;
  }

  async listScansForQuiz(quizId: string, status?: string): Promise<PaperScanRow[]> {
    const where = status
      ? and(eq(quizPaperScans.quizId, quizId), eq(quizPaperScans.status, status))
      : eq(quizPaperScans.quizId, quizId);
    return this.db.select().from(quizPaperScans).where(where).orderBy(asc(quizPaperScans.createdAt));
  }

  async updateScan(id: string, patch: Partial<typeof quizPaperScans.$inferInsert>): Promise<PaperScanRow> {
    const [row] = await this.db.update(quizPaperScans)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(quizPaperScans.id, id))
      .returning();
    return row!;
  }

  async deleteScan(id: string): Promise<void> {
    await this.db.delete(quizPaperScans).where(eq(quizPaperScans.id, id));
  }

  /** Phiếu mới nhất của quiz (dùng cho kiểm tra nhanh ở tầng service khi cần). */
  async latestScanForQuiz(quizId: string): Promise<PaperScanRow | undefined> {
    const [row] = await this.db.select().from(quizPaperScans)
      .where(eq(quizPaperScans.quizId, quizId))
      .orderBy(desc(quizPaperScans.createdAt))
      .limit(1);
    return row;
  }
}

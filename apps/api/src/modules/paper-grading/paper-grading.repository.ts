/**
 * Kho dữ liệu của chấm bài giấy (CAM-0, issue #112): lô phiếu in
 * (layout + roster đã chụp) và từng phiếu đã quét kèm vòng đời hàng
 * chờ. Mọi truy vấn nghiệp vụ nằm ở PaperGradingService; kho này chỉ
 * làm CRUD mỏng trên hai bảng `exam_batches`/`exam_scans`.
 */
import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { examBatches, examScans } from '../../db/schema';

export type PaperBatchRow = typeof examBatches.$inferSelect;
export type PaperScanRow = typeof examScans.$inferSelect;

@Injectable()
export class PaperGradingRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  async insertBatch(v: typeof examBatches.$inferInsert): Promise<PaperBatchRow> {
    const [row] = await this.db.insert(examBatches).values(v).returning();
    return row!;
  }

  async getBatch(id: string): Promise<PaperBatchRow | undefined> {
    const [row] = await this.db.select().from(examBatches).where(eq(examBatches.id, id));
    return row;
  }

  async listBatchesForPin(pinId: string): Promise<PaperBatchRow[]> {
    return this.db.select().from(examBatches)
      .where(eq(examBatches.examPinId, pinId))
      .orderBy(asc(examBatches.createdAt));
  }

  async insertScan(v: typeof examScans.$inferInsert): Promise<PaperScanRow> {
    const [row] = await this.db.insert(examScans).values(v).returning();
    return row!;
  }

  async getScan(id: string): Promise<PaperScanRow | undefined> {
    const [row] = await this.db.select().from(examScans).where(eq(examScans.id, id));
    return row;
  }

  async listScansForPin(pinId: string, status?: string): Promise<PaperScanRow[]> {
    const where = status
      ? and(eq(examScans.examPinId, pinId), eq(examScans.status, status))
      : eq(examScans.examPinId, pinId);
    return this.db.select().from(examScans).where(where).orderBy(asc(examScans.createdAt));
  }

  async updateScan(id: string, patch: Partial<typeof examScans.$inferInsert>): Promise<PaperScanRow> {
    const [row] = await this.db.update(examScans)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(examScans.id, id))
      .returning();
    return row!;
  }

  async deleteScan(id: string): Promise<void> {
    await this.db.delete(examScans).where(eq(examScans.id, id));
  }

  /** Phiếu mới nhất của quiz (dùng cho kiểm tra nhanh ở tầng service khi cần). */
  async latestScanForQuiz(pinId: string): Promise<PaperScanRow | undefined> {
    const [row] = await this.db.select().from(examScans)
      .where(eq(examScans.examPinId, pinId))
      .orderBy(desc(examScans.createdAt))
      .limit(1);
    return row;
  }
}

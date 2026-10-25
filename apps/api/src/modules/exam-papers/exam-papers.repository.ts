import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { examPaperContributions, examPapers, examPaperSlots, examPaperVersions, question, questionBankEntries, questionVersions } from '../../db/schema';

export type ExamPaperRow = typeof examPapers.$inferSelect;
export type ExamPaperVersionRow = typeof examPaperVersions.$inferSelect;
export type ExamPaperSlotRow = typeof examPaperSlots.$inferSelect;
export type ExamPaperContributionRow = typeof examPaperContributions.$inferSelect;
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Kho dữ liệu của lớp Ngân hàng đề (EB-1): danh tính đề
 * (exam_papers) + version nội dung bất biến (exam_paper_versions) +
 * slots ghim version câu (exam_paper_slots) + đề xuất đóng góp
 * (exam_paper_contributions). Mọi truy vấn là truy vấn thuần; cổng
 * quyền và vòng đời nằm ở ExamPapersService.
 */
@Injectable()
export class ExamPapersRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  get dbHandle(): Database { return this.db; }

  async insertPaper(v: typeof examPapers.$inferInsert, tx?: DbTx): Promise<ExamPaperRow> {
    const [row] = await (tx ?? this.db).insert(examPapers).values(v).returning();
    return row!;
  }

  async getPaper(id: string): Promise<ExamPaperRow | undefined> {
    const [row] = await this.db.select().from(examPapers).where(eq(examPapers.id, id));
    return row;
  }

  async listPapersInBank(bankId: string): Promise<ExamPaperRow[]> {
    return this.db.select().from(examPapers)
      .where(eq(examPapers.bankId, bankId))
      .orderBy(desc(examPapers.updatedAt), asc(examPapers.id));
  }

  async updatePaper(id: string, patch: Partial<ExamPaperRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(examPapers).set({ ...patch, updatedAt: new Date() }).where(eq(examPapers.id, id));
  }

  async deletePaper(id: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(examPapers).where(eq(examPapers.id, id));
  }

  async insertVersion(v: typeof examPaperVersions.$inferInsert, tx?: DbTx): Promise<ExamPaperVersionRow> {
    const [row] = await (tx ?? this.db).insert(examPaperVersions).values(v).returning();
    return row!;
  }

  async getVersion(id: string): Promise<ExamPaperVersionRow | undefined> {
    const [row] = await this.db.select().from(examPaperVersions).where(eq(examPaperVersions.id, id));
    return row;
  }

  async getVersionByNumber(paperId: string, version: number): Promise<ExamPaperVersionRow | undefined> {
    const [row] = await this.db.select().from(examPaperVersions)
      .where(and(eq(examPaperVersions.paperId, paperId), eq(examPaperVersions.version, version)));
    return row;
  }

  async listVersions(paperId: string): Promise<ExamPaperVersionRow[]> {
    return this.db.select().from(examPaperVersions)
      .where(eq(examPaperVersions.paperId, paperId))
      .orderBy(desc(examPaperVersions.version));
  }

  async insertSlots(rows: (typeof examPaperSlots.$inferInsert)[], tx?: DbTx): Promise<void> {
    if (rows.length === 0) return;
    await (tx ?? this.db).insert(examPaperSlots).values(rows);
  }

  async listSlots(paperVersionId: string): Promise<ExamPaperSlotRow[]> {
    return this.db.select().from(examPaperSlots)
      .where(eq(examPaperSlots.paperVersionId, paperVersionId))
      .orderBy(asc(examPaperSlots.position));
  }

  /** Thông tin hiển thị của các câu trong slots: tên + qtype + trạng thái entry trong bank câu hỏi của chúng. */
  async listSlotQuestionInfo(questionIds: string[]): Promise<{ questionId: string; name: string; qtype: string }[]> {
    if (questionIds.length === 0) return [];
    return this.db.select({ questionId: question.id, name: question.name, qtype: question.qtype })
      .from(question).where(inArray(question.id, questionIds));
  }

  /**
   * Bản mới nhất của một câu ở trạng thái ready (điểm phân giải ghim
   * khi soạn đề — cùng kỷ luật ghim của quiz.addSlot QB-3). Trả
   * undefined khi câu không có entry nào ở trạng thái ready
   * (draft/hidden đều không được đưa vào đề).
   */
  async resolveReadyVersion(questionId: string): Promise<{ versionId: string; versionNumber: number } | undefined> {
    const entries = await this.db.select({
      latestVersion: questionBankEntries.latestVersion,
      status: questionBankEntries.status,
    }).from(questionBankEntries).where(eq(questionBankEntries.questionId, questionId));
    const entry = entries.find((e) => e.status === 'ready');
    if (!entry) return undefined;
    const [ver] = await this.db.select({ id: questionVersions.id, version: questionVersions.version })
      .from(questionVersions)
      .where(and(eq(questionVersions.questionId, questionId), eq(questionVersions.version, entry.latestVersion)));
    if (!ver) return undefined;
    return { versionId: ver.id, versionNumber: ver.version };
  }

  /** Trạng thái entry của các câu (để hiển thị trong chi tiết đề: câu đã rút khỏi ngân hàng vẫn đọc được trong version đã chụp). */
  async listQuestionEntryStatuses(questionIds: string[]): Promise<{ questionId: string; status: string }[]> {
    if (questionIds.length === 0) return [];
    return this.db.select({ questionId: questionBankEntries.questionId, status: questionBankEntries.status })
      .from(questionBankEntries).where(inArray(questionBankEntries.questionId, questionIds));
  }

  /** Câu có tồn tại hay không (phân biệt 404 câu với 400 câu-chưa-ready). */
  async questionExists(questionId: string): Promise<boolean> {
    const [row] = await this.db.select({ id: question.id }).from(question).where(eq(question.id, questionId));
    return !!row;
  }

  async insertContribution(v: typeof examPaperContributions.$inferInsert, tx?: DbTx): Promise<ExamPaperContributionRow> {
    const [row] = await (tx ?? this.db).insert(examPaperContributions).values(v).returning();
    return row!;
  }

  async getContribution(id: string): Promise<ExamPaperContributionRow | undefined> {
    const [row] = await this.db.select().from(examPaperContributions).where(eq(examPaperContributions.id, id));
    return row;
  }

  async listContributionsForBank(targetBankId: string): Promise<ExamPaperContributionRow[]> {
    return this.db.select().from(examPaperContributions)
      .where(eq(examPaperContributions.targetBankId, targetBankId))
      .orderBy(desc(examPaperContributions.createdAt));
  }

  async findPendingContribution(paperId: string, targetBankId: string): Promise<ExamPaperContributionRow | undefined> {
    const [row] = await this.db.select().from(examPaperContributions)
      .where(and(
        eq(examPaperContributions.paperId, paperId),
        eq(examPaperContributions.targetBankId, targetBankId),
        eq(examPaperContributions.status, 'pending'),
      ));
    return row;
  }

  async updateContribution(id: string, patch: Partial<ExamPaperContributionRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(examPaperContributions).set({ ...patch, updatedAt: new Date() })
      .where(eq(examPaperContributions.id, id));
  }

  /** Tăng copy_count của đề nguồn sau một lần copy thành công. */
  async bumpCopyCount(paperId: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(examPapers)
      .set({ copyCount: sql`${examPapers.copyCount} + 1` })
      .where(eq(examPapers.id, paperId));
  }
}

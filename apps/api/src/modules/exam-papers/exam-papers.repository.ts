import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import {
  context, course, examDeployments, examDossierReviews, examDossiers, examMatrices,
  examPaperContributions, examPapers, examPaperSlots, examPaperVersions, question,
  questionBankEntries, questionVersions, role, roleAssignments,
} from '../../db/schema';

export type ExamPaperRow = typeof examPapers.$inferSelect;
export type ExamPaperVersionRow = typeof examPaperVersions.$inferSelect;
export type ExamPaperSlotRow = typeof examPaperSlots.$inferSelect;
export type ExamPaperContributionRow = typeof examPaperContributions.$inferSelect;
export type ExamDeploymentRow = typeof examDeployments.$inferSelect;
export type ExamDossierRow = typeof examDossiers.$inferSelect;
export type ExamDossierReviewRow = typeof examDossierReviews.$inferSelect;
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

  // --- triển khai + mã đề (EB-2) ------------------------------------------------

  async insertDeployment(v: typeof examDeployments.$inferInsert, tx?: DbTx): Promise<ExamDeploymentRow> {
    const [row] = await (tx ?? this.db).insert(examDeployments).values(v).returning();
    return row!;
  }

  async getDeployment(id: string): Promise<ExamDeploymentRow | undefined> {
    const [row] = await this.db.select().from(examDeployments).where(eq(examDeployments.id, id));
    return row;
  }

  async listDeploymentsForPaper(paperId: string): Promise<ExamDeploymentRow[]> {
    return this.db.select().from(examDeployments)
      .where(eq(examDeployments.paperId, paperId))
      .orderBy(desc(examDeployments.createdAt));
  }

  // --- bộ hồ sơ duyệt đề (EB-3) --------------------------------------------------

  /** Tên + số version hiện tại của một ma trận (ghim vào bộ hồ sơ lúc nộp khi paper version không mang sẵn matrixVersion). */
  async getMatrixInfo(matrixId: string): Promise<{ name: string; version: number } | undefined> {
    const [row] = await this.db.select({ name: examMatrices.name, version: examMatrices.version })
      .from(examMatrices).where(eq(examMatrices.id, matrixId));
    return row;
  }

  async insertDossier(v: typeof examDossiers.$inferInsert, tx?: DbTx): Promise<ExamDossierRow> {
    const [row] = await (tx ?? this.db).insert(examDossiers).values(v).returning();
    return row!;
  }

  async getDossier(id: string): Promise<ExamDossierRow | undefined> {
    const [row] = await this.db.select().from(examDossiers).where(eq(examDossiers.id, id));
    return row;
  }

  async updateDossier(id: string, patch: Partial<ExamDossierRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(examDossiers).set({ ...patch, updatedAt: new Date() })
      .where(eq(examDossiers.id, id));
  }

  async deleteDossier(id: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(examDossiers).where(eq(examDossiers.id, id));
  }

  /** Hàng chờ của một bank đích (mới nhất trước) — lọc theo quyền ở tầng service. */
  async listDossiersForBank(targetBankId: string): Promise<ExamDossierRow[]> {
    return this.db.select().from(examDossiers)
      .where(eq(examDossiers.targetBankId, targetBankId))
      .orderBy(desc(examDossiers.createdAt));
  }

  /** Mọi bộ hồ sơ của một người đóng góp (xem kết quả duyệt + lý do từ chối xuyên bank). */
  async listDossiersByProposer(proposerId: string): Promise<ExamDossierRow[]> {
    return this.db.select().from(examDossiers)
      .where(eq(examDossiers.proposerId, proposerId))
      .orderBy(desc(examDossiers.createdAt));
  }

  /** Bộ hồ sơ ĐANG HIỆU LỰC chờ duyệt (pending/pending_board) của cùng một đề vào cùng bank đích — nộp trùng bị chặn 409. */
  async findActiveDossier(paperId: string, targetBankId: string, excludeId?: string): Promise<ExamDossierRow | undefined> {
    const conds = [
      eq(examDossiers.paperId, paperId),
      eq(examDossiers.targetBankId, targetBankId),
      inArray(examDossiers.status, ['pending', 'pending_board']),
    ];
    if (excludeId) conds.push(ne(examDossiers.id, excludeId));
    const [row] = await this.db.select().from(examDossiers).where(and(...conds));
    return row;
  }

  async insertDossierReview(v: typeof examDossierReviews.$inferInsert, tx?: DbTx): Promise<ExamDossierReviewRow> {
    const [row] = await (tx ?? this.db).insert(examDossierReviews).values(v).returning();
    return row!;
  }

  /** Vết duyệt của một bộ hồ sơ theo thứ tự thời gian (cấp 1 trước, cấp 2 sau). */
  async listDossierReviews(dossierId: string): Promise<ExamDossierReviewRow[]> {
    return this.db.select().from(examDossierReviews)
      .where(eq(examDossierReviews.dossierId, dossierId))
      .orderBy(asc(examDossierReviews.createdAt), asc(examDossierReviews.id));
  }

  /**
   * Người dùng có đang DẠY khối `grade` hay không (lớp bảo mật đề
   * định kỳ A.3.4): tồn tại một gán vai archetype giáo viên
   * (teacher/editingteacher) tại context của một khoá có grade khớp.
   */
  async userTeachesGrade(userId: string, grade: number): Promise<boolean> {
    const rows = await this.db.select({ id: roleAssignments.id })
      .from(roleAssignments)
      .innerJoin(role, eq(roleAssignments.roleId, role.id))
      .innerJoin(context, eq(roleAssignments.contextId, context.id))
      .innerJoin(course, eq(context.instanceId, course.id))
      .where(and(
        eq(roleAssignments.userId, userId),
        eq(context.contextLevel, 50),
        eq(course.grade, grade),
        inArray(role.archetype, ['teacher', 'editingteacher']),
      ))
      .limit(1);
    return rows.length > 0;
  }
}

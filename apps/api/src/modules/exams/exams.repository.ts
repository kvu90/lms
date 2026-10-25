import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import {
  context, course, examDossierReviews, examDossiers, examMatrices, examPins,
  examContributions, exams, examSlots, examVersions, question,
  questionBankEntries, questionVersions, role, roleAssignments,
} from '../../db/schema';

export type ExamRow = typeof exams.$inferSelect;
export type ExamVersionRow = typeof examVersions.$inferSelect;
export type ExamSlotRow = typeof examSlots.$inferSelect;
export type ExamContributionRow = typeof examContributions.$inferSelect;
export type ExamDossierRow = typeof examDossiers.$inferSelect;
export type ExamDossierReviewRow = typeof examDossierReviews.$inferSelect;
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Kho dữ liệu của lớp Ngân hàng đề (EB-1): danh tính đề
 * (exam_papers) + version nội dung bất biến (exam_paper_versions) +
 * slots ghim version câu (exam_paper_slots) + đề xuất đóng góp
 * (exam_paper_contributions). Mọi truy vấn là truy vấn thuần; cổng
 * quyền và vòng đời nằm ở ExamsService.
 */
@Injectable()
export class ExamsRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  get dbHandle(): Database { return this.db; }

  async insertPaper(v: typeof exams.$inferInsert, tx?: DbTx): Promise<ExamRow> {
    const [row] = await (tx ?? this.db).insert(exams).values(v).returning();
    return row!;
  }

  /** Các lần ghim của một đề (kèm tên khoá + số version đã ghim) — bề mặt thay cho danh sách deployments cũ. */
  async listPinsOfExam(examId: string): Promise<{ id: string; courseId: string; courseName: string; examVersionId: string; versionNumber: number; name: string | null; variantCount: number; variants: { code: string }[]; targetGroupId: string | null; createdAt: Date }[]> {
    return this.db.select({
      id: examPins.id, courseId: examPins.courseId, courseName: course.fullName,
      examVersionId: examPins.examVersionId, versionNumber: examVersions.version,
      name: examPins.name, variantCount: examPins.variantCount, variants: examPins.variants,
      targetGroupId: examPins.targetGroupId, createdAt: examPins.createdAt,
    }).from(examPins)
      .innerJoin(course, eq(course.id, examPins.courseId))
      .innerJoin(examVersions, eq(examVersions.id, examPins.examVersionId))
      .where(eq(examPins.examId, examId))
      .orderBy(desc(examPins.createdAt));
  }

  async getPaper(id: string): Promise<ExamRow | undefined> {
    const [row] = await this.db.select().from(exams).where(eq(exams.id, id));
    return row;
  }

  async listPapersInBank(bankId: string): Promise<ExamRow[]> {
    return this.db.select().from(exams)
      .where(eq(exams.bankId, bankId))
      .orderBy(desc(exams.updatedAt), asc(exams.id));
  }

  async updatePaper(id: string, patch: Partial<ExamRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(exams).set({ ...patch, updatedAt: new Date() }).where(eq(exams.id, id));
  }

  async deletePaper(id: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(exams).where(eq(exams.id, id));
  }

  async insertVersion(v: typeof examVersions.$inferInsert, tx?: DbTx): Promise<ExamVersionRow> {
    const [row] = await (tx ?? this.db).insert(examVersions).values(v).returning();
    return row!;
  }

  async getVersion(id: string): Promise<ExamVersionRow | undefined> {
    const [row] = await this.db.select().from(examVersions).where(eq(examVersions.id, id));
    return row;
  }

  async getVersionByNumber(paperId: string, version: number): Promise<ExamVersionRow | undefined> {
    const [row] = await this.db.select().from(examVersions)
      .where(and(eq(examVersions.examId, paperId), eq(examVersions.version, version)));
    return row;
  }

  async listVersions(paperId: string): Promise<ExamVersionRow[]> {
    return this.db.select().from(examVersions)
      .where(eq(examVersions.examId, paperId))
      .orderBy(desc(examVersions.version));
  }

  async insertSlots(rows: (typeof examSlots.$inferInsert)[], tx?: DbTx): Promise<void> {
    if (rows.length === 0) return;
    await (tx ?? this.db).insert(examSlots).values(rows);
  }

  async listSlots(examVersionId: string): Promise<ExamSlotRow[]> {
    return this.db.select().from(examSlots)
      .where(eq(examSlots.examVersionId, examVersionId))
      .orderBy(asc(examSlots.position));
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
  async resolveReadyVersion(questionId: string): Promise<{ versionId: string; versionNumber: number; defaultMark: number } | undefined> {
    const entries = await this.db.select({
      latestVersion: questionBankEntries.latestVersion,
      status: questionBankEntries.status,
    }).from(questionBankEntries).where(eq(questionBankEntries.questionId, questionId));
    const entry = entries.find((e) => e.status === 'ready');
    if (!entry) return undefined;
    const [ver] = await this.db.select({ id: questionVersions.id, version: questionVersions.version, defaultMark: questionVersions.defaultMark })
      .from(questionVersions)
      .where(and(eq(questionVersions.questionId, questionId), eq(questionVersions.version, entry.latestVersion)));
    if (!ver) return undefined;
    return { versionId: ver.id, versionNumber: ver.version, defaultMark: ver.defaultMark };
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

  async insertContribution(v: typeof examContributions.$inferInsert, tx?: DbTx): Promise<ExamContributionRow> {
    const [row] = await (tx ?? this.db).insert(examContributions).values(v).returning();
    return row!;
  }

  async getContribution(id: string): Promise<ExamContributionRow | undefined> {
    const [row] = await this.db.select().from(examContributions).where(eq(examContributions.id, id));
    return row;
  }

  async listContributionsForBank(targetBankId: string): Promise<ExamContributionRow[]> {
    return this.db.select().from(examContributions)
      .where(eq(examContributions.targetBankId, targetBankId))
      .orderBy(desc(examContributions.createdAt));
  }

  async findPendingContribution(paperId: string, targetBankId: string): Promise<ExamContributionRow | undefined> {
    const [row] = await this.db.select().from(examContributions)
      .where(and(
        eq(examContributions.examId, paperId),
        eq(examContributions.targetBankId, targetBankId),
        eq(examContributions.status, 'pending'),
      ));
    return row;
  }

  async updateContribution(id: string, patch: Partial<ExamContributionRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(examContributions).set({ ...patch, updatedAt: new Date() })
      .where(eq(examContributions.id, id));
  }

  /** Tăng copy_count của đề nguồn sau một lần copy thành công. */
  async bumpCopyCount(paperId: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(exams)
      .set({ copyCount: sql`${exams.copyCount} + 1` })
      .where(eq(exams.id, paperId));
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
      eq(examDossiers.examId, paperId),
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

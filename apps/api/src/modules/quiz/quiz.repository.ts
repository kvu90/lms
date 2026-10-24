import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { examMatrices, examMatrixCells, examMatrixContributions, quizAttemptEvents, quizAttempts, quizFeedbacks, quizOverrides, quizSlotVersionEvents, quizSlots, quizzes } from '../../db/schema';

export type QuizRow = typeof quizzes.$inferSelect;
export type QuizSlotRow = typeof quizSlots.$inferSelect;
export type QuizAttemptRow = typeof quizAttempts.$inferSelect;
export type QuizSlotVersionEventRow = typeof quizSlotVersionEvents.$inferSelect;
export type QuizOverrideRow = typeof quizOverrides.$inferSelect;
export type ExamMatrixRow = typeof examMatrices.$inferSelect;
export type ExamMatrixCellRow = typeof examMatrixCells.$inferSelect;
export type ExamMatrixContributionRow = typeof examMatrixContributions.$inferSelect;
export type QuizFeedbackRow = typeof quizFeedbacks.$inferSelect;
export type QuizAttemptEventRow = typeof quizAttemptEvents.$inferSelect;
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
/**
 * Kho dữ liệu của hoạt động Quiz: bản ghi quiz (instance của course
 * module), các slot của đề và các lượt làm. Điểm của câu trong lượt làm
 * sống ở question engine (question_attempts) — kho này chỉ giữ tầng hoạt
 * động: slot nào mang câu nào với max_mark bao nhiêu, lượt làm nào gắn
 * usage nào và tổng điểm đã chốt của lượt.
 */
export class QuizRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  /**
   * Chèn bản ghi quiz.
   */
  async insertQuiz(v: typeof quizzes.$inferInsert, tx?: DbTx): Promise<QuizRow> {
    const [row] = await (tx ?? this.db).insert(quizzes).values(v).returning(); return row!;
  }
  /**
   * Lấy quiz theo id.
   */
  async getQuiz(id: string): Promise<QuizRow | undefined> {
    const [row] = await this.db.select().from(quizzes).where(eq(quizzes.id, id)); return row;
  }
  /**
   * Các quiz trong một khoá học.
   */
  async listQuizzesInCourse(courseId: string): Promise<QuizRow[]> {
    return this.db.select().from(quizzes).where(eq(quizzes.course, courseId)).orderBy(asc(quizzes.createdAt), asc(quizzes.id));
  }
  /**
   * Cập nhật quiz.
   */
  async updateQuiz(id: string, patch: Partial<QuizRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(quizzes).set({ ...patch, updatedAt: new Date() }).where(eq(quizzes.id, id));
  }
  /**
   * Xoá quiz (slots và attempts cascade theo khoá ngoại).
   */
  async deleteQuiz(id: string): Promise<void> {
    await this.db.delete(quizzes).where(eq(quizzes.id, id));
  }

  /**
   * Chèn một slot vào đề.
   */
  async insertSlot(v: typeof quizSlots.$inferInsert, tx?: DbTx): Promise<QuizSlotRow> {
    const [row] = await (tx ?? this.db).insert(quizSlots).values(v).returning(); return row!;
  }
  /**
   * Lấy một slot.
   */
  async getSlot(id: string): Promise<QuizSlotRow | undefined> {
    const [row] = await this.db.select().from(quizSlots).where(eq(quizSlots.id, id)); return row;
  }
  /**
   * Các slot của đề theo thứ tự hiển thị.
   */
  async listSlots(quizId: string): Promise<QuizSlotRow[]> {
    return this.db.select().from(quizSlots).where(eq(quizSlots.quizId, quizId)).orderBy(asc(quizSlots.slot));
  }
  /**
   * Cập nhật một slot.
   */
  async updateSlot(id: string, patch: Partial<QuizSlotRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(quizSlots).set({ ...patch, updatedAt: new Date() }).where(eq(quizSlots.id, id));
  }
  /**
   * Xoá một slot.
   */
  async deleteSlot(id: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(quizSlots).where(eq(quizSlots.id, id));
  }
  /**
   * Ghi nhật ký nâng version đã ghim của slot (QB-3).
   */
  async insertSlotVersionEvent(v: typeof quizSlotVersionEvents.$inferInsert): Promise<QuizSlotVersionEventRow> {
    const [row] = await this.db.insert(quizSlotVersionEvents).values(v).returning(); return row!;
  }
  /**
   * Nhật ký nâng version của một slot theo thời gian.
   */
  async listSlotVersionEvents(slotId: string): Promise<QuizSlotVersionEventRow[]> {
    return this.db.select().from(quizSlotVersionEvents)
      .where(eq(quizSlotVersionEvents.slotId, slotId)).orderBy(asc(quizSlotVersionEvents.createdAt));
  }

  /**
   * Chèn một lượt làm.
   */
  async insertAttempt(v: typeof quizAttempts.$inferInsert, tx?: DbTx): Promise<QuizAttemptRow> {
    const [row] = await (tx ?? this.db).insert(quizAttempts).values(v).returning(); return row!;
  }
  /**
   * Lấy một lượt làm.
   */
  async getAttempt(id: string): Promise<QuizAttemptRow | undefined> {
    const [row] = await this.db.select().from(quizAttempts).where(eq(quizAttempts.id, id)); return row;
  }
  /**
   * Các lượt làm của một quiz (mọi học sinh), mới nhất theo số lượt.
   */
  async listAttempts(quizId: string): Promise<QuizAttemptRow[]> {
    return this.db.select().from(quizAttempts).where(eq(quizAttempts.quizId, quizId)).orderBy(asc(quizAttempts.userId), asc(quizAttempts.attemptNumber));
  }
  /**
   * Các lượt làm của một học sinh trong một quiz (kể cả preview khi `includePreview`).
   */
  async listAttemptsForUser(quizId: string, userId: string, includePreview = false): Promise<QuizAttemptRow[]> {
    const conds = includePreview
      ? and(eq(quizAttempts.quizId, quizId), eq(quizAttempts.userId, userId))
      : and(eq(quizAttempts.quizId, quizId), eq(quizAttempts.userId, userId), eq(quizAttempts.preview, false));
    return this.db.select().from(quizAttempts).where(conds).orderBy(asc(quizAttempts.attemptNumber));
  }
  /**
   * Cập nhật một lượt làm.
   */
  async updateAttempt(id: string, patch: Partial<QuizAttemptRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(quizAttempts).set({ ...patch, updatedAt: new Date() }).where(eq(quizAttempts.id, id));
  }

  // --- overrides (Chặng 2) ------------------------------------------------------

  /**
   * Chèn một ghi đè cài đặt thi.
   */
  async insertOverride(v: typeof quizOverrides.$inferInsert, tx?: DbTx): Promise<QuizOverrideRow> {
    const [row] = await (tx ?? this.db).insert(quizOverrides).values(v).returning(); return row!;
  }
  /**
   * Lấy một ghi đè.
   */
  async getOverride(id: string): Promise<QuizOverrideRow | undefined> {
    const [row] = await this.db.select().from(quizOverrides).where(eq(quizOverrides.id, id)); return row;
  }
  /**
   * Mọi ghi đè của một quiz (theo nhóm và theo người dùng).
   */
  async listOverrides(quizId: string): Promise<QuizOverrideRow[]> {
    return this.db.select().from(quizOverrides).where(eq(quizOverrides.quizId, quizId)).orderBy(asc(quizOverrides.createdAt), asc(quizOverrides.id));
  }
  /**
   * Mốc đóng MUỘN NHẤT của cả đợt thi: max giữa time_close của quiz và
   * time_close của MỌI override đang tồn tại (null = có ít nhất một
   * tầng không đặt mốc đóng → đợt chưa đóng hẳn). Dùng cho cửa sổ
   * review "sau khi đóng" khi các ca thi lệch nhau vì override —
   * chống lộ đáp án cho ca sau (hồ sơ thi trực tuyến VN, điểm 5.1.4).
   */
  async sessionLatestClose(quizId: string): Promise<{ hasUnbounded: boolean; latest: Date | null }> {
    const quizRows = await this.db.select({ timeClose: quizzes.timeClose }).from(quizzes).where(eq(quizzes.id, quizId));
    const base = quizRows[0]?.timeClose ?? null;
    const overrides = await this.listOverrides(quizId);
    // Override có time_close null = kế thừa mốc của quiz (đã tính);
    // đợt chỉ "chưa đóng hẳn" khi chính quiz không có mốc đóng.
    const hasUnbounded = base === null;
    let latest = base;
    for (const o of overrides) {
      if (o.timeClose === null) continue;
      if (latest === null || o.timeClose > latest) latest = o.timeClose;
    }
    return { hasUnbounded, latest };
  }

  /**
   * Cập nhật một ghi đè.
   */
  async updateOverride(id: string, patch: Partial<QuizOverrideRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(quizOverrides).set({ ...patch, updatedAt: new Date() }).where(eq(quizOverrides.id, id));
  }
  /**
   * Xoá một ghi đè.
   */
  async deleteOverride(id: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(quizOverrides).where(eq(quizOverrides.id, id));
  }

  // --- ma trận đề (Chặng 3) -------------------------------------------------------

  /**
   * Chèn một ma trận.
   */
  async insertMatrix(v: typeof examMatrices.$inferInsert, tx?: DbTx): Promise<ExamMatrixRow> {
    const [row] = await (tx ?? this.db).insert(examMatrices).values(v).returning(); return row!;
  }
  /**
   * Lấy một ma trận.
   */
  async getMatrix(id: string): Promise<ExamMatrixRow | undefined> {
    const [row] = await this.db.select().from(examMatrices).where(eq(examMatrices.id, id)); return row;
  }
  /**
   * Các ma trận của một môn (mới nhất trước).
   */
  async listMatricesBySubject(subjectId: string): Promise<ExamMatrixRow[]> {
    return this.db.select().from(examMatrices).where(eq(examMatrices.subjectId, subjectId)).orderBy(asc(examMatrices.name));
  }
  /**
   * Cập nhật một ma trận.
   */
  async updateMatrix(id: string, patch: Partial<ExamMatrixRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(examMatrices).set({ ...patch, updatedAt: new Date() }).where(eq(examMatrices.id, id));
  }
  /**
   * Xoá một ma trận (ô cascade theo FK; quiz đã sinh giữ matrix_id = null theo FK set null).
   */
  async deleteMatrix(id: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(examMatrices).where(eq(examMatrices.id, id));
  }
  /**
   * Chèn một ô ma trận.
   */
  async insertMatrixCell(v: typeof examMatrixCells.$inferInsert, tx?: DbTx): Promise<ExamMatrixCellRow> {
    const [row] = await (tx ?? this.db).insert(examMatrixCells).values(v).returning(); return row!;
  }
  /**
   * Lấy một ô ma trận.
   */
  async getMatrixCell(id: string): Promise<ExamMatrixCellRow | undefined> {
    const [row] = await this.db.select().from(examMatrixCells).where(eq(examMatrixCells.id, id)); return row;
  }
  /**
   * Các ô của một ma trận theo thứ tự hiển thị.
   */
  async listMatrixCells(matrixId: string): Promise<ExamMatrixCellRow[]> {
    return this.db.select().from(examMatrixCells).where(eq(examMatrixCells.matrixId, matrixId)).orderBy(asc(examMatrixCells.position), asc(examMatrixCells.id));
  }
  /**
   * Cập nhật một ô ma trận.
   */
  async updateMatrixCell(id: string, patch: Partial<ExamMatrixCellRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(examMatrixCells).set({ ...patch, updatedAt: new Date() }).where(eq(examMatrixCells.id, id));
  }
  /**
   * Xoá một ô ma trận.
   */
  async deleteMatrixCell(id: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(examMatrixCells).where(eq(examMatrixCells.id, id));
  }

  // --- ngân hàng ma trận (MB-1, issue #111) ----------------------------------------

  /**
   * Các ma trận trong một bank ma trận (theo tên).
   */
  async listMatricesByBank(bankId: string): Promise<ExamMatrixRow[]> {
    return this.db.select().from(examMatrices).where(eq(examMatrices.bankId, bankId)).orderBy(asc(examMatrices.name), asc(examMatrices.id));
  }
  /**
   * Chèn một đề xuất đóng góp ma trận (hàng chờ duyệt).
   */
  async insertMatrixContribution(v: typeof examMatrixContributions.$inferInsert, tx?: DbTx): Promise<ExamMatrixContributionRow> {
    const [row] = await (tx ?? this.db).insert(examMatrixContributions).values(v).returning(); return row!;
  }
  /**
   * Lấy một đề xuất đóng góp ma trận.
   */
  async getMatrixContribution(id: string): Promise<ExamMatrixContributionRow | undefined> {
    const [row] = await this.db.select().from(examMatrixContributions).where(eq(examMatrixContributions.id, id)); return row;
  }
  /**
   * Hàng chờ đóng góp của một bank (lọc theo trạng thái nếu có; cũ nhất trước để duyệt theo thứ tự đến).
   */
  async listMatrixContributions(targetBankId: string, status?: string): Promise<ExamMatrixContributionRow[]> {
    const where = status
      ? and(eq(examMatrixContributions.targetBankId, targetBankId), eq(examMatrixContributions.status, status))
      : eq(examMatrixContributions.targetBankId, targetBankId);
    return this.db.select().from(examMatrixContributions).where(where).orderBy(asc(examMatrixContributions.createdAt), asc(examMatrixContributions.id));
  }
  /**
   * Hàng chờ đóng góp do một người gửi (mọi bank) — người gửi xem lại kết quả duyệt/lý do từ chối.
   */
  async listMatrixContributionsByProposer(proposerId: string): Promise<ExamMatrixContributionRow[]> {
    return this.db.select().from(examMatrixContributions).where(eq(examMatrixContributions.proposerId, proposerId)).orderBy(asc(examMatrixContributions.createdAt), asc(examMatrixContributions.id));
  }
  /**
   * Đề xuất đang chờ của cùng một ma trận vào cùng một bank (chống gửi trùng hàng chờ).
   */
  async findPendingMatrixContribution(matrixId: string, targetBankId: string, proposerId: string): Promise<ExamMatrixContributionRow | undefined> {
    const [row] = await this.db.select().from(examMatrixContributions).where(and(
      eq(examMatrixContributions.matrixId, matrixId),
      eq(examMatrixContributions.targetBankId, targetBankId),
      eq(examMatrixContributions.proposerId, proposerId),
      eq(examMatrixContributions.status, 'pending'),
    )); return row;
  }
  /**
   * Cập nhật một đề xuất đóng góp (kết quả duyệt).
   */
  async updateMatrixContribution(id: string, patch: Partial<ExamMatrixContributionRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(examMatrixContributions).set({ ...patch, updatedAt: new Date() }).where(eq(examMatrixContributions.id, id));
  }

  // --- dải nhận xét tổng quát + nhật ký sự kiện lượt làm -------------------------

  /** Các dải nhận xét tổng quát của một quiz theo mốc % tăng dần. */
  async listFeedbacks(quizId: string): Promise<QuizFeedbackRow[]> {
    return this.db.select().from(quizFeedbacks).where(eq(quizFeedbacks.quizId, quizId)).orderBy(asc(quizFeedbacks.minPercent), asc(quizFeedbacks.id));
  }

  /** Chèn một dải nhận xét tổng quát. */
  async insertFeedback(v: typeof quizFeedbacks.$inferInsert, tx?: DbTx): Promise<QuizFeedbackRow> {
    const [row] = await (tx ?? this.db).insert(quizFeedbacks).values(v).returning(); return row!;
  }

  /** Xoá một dải nhận xét tổng quát. */
  async deleteFeedback(id: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(quizFeedbacks).where(eq(quizFeedbacks.id, id));
  }

  /** Ghi một sự kiện giám sát của lượt làm (chỉ ghi nhận). */
  async insertAttemptEvent(v: typeof quizAttemptEvents.$inferInsert, tx?: DbTx): Promise<QuizAttemptEventRow> {
    const [row] = await (tx ?? this.db).insert(quizAttemptEvents).values(v).returning(); return row!;
  }

  /** Nhật ký sự kiện của một lượt làm theo thời gian ghi. */
  async listAttemptEvents(attemptId: string): Promise<QuizAttemptEventRow[]> {
    return this.db.select().from(quizAttemptEvents).where(eq(quizAttemptEvents.attemptId, attemptId)).orderBy(asc(quizAttemptEvents.createdAt), asc(quizAttemptEvents.id));
  }
}

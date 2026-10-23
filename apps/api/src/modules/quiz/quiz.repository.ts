import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { quizAttempts, quizSlots, quizzes } from '../../db/schema';

export type QuizRow = typeof quizzes.$inferSelect;
export type QuizSlotRow = typeof quizSlots.$inferSelect;
export type QuizAttemptRow = typeof quizAttempts.$inferSelect;
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
}

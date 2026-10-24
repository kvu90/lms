import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { question, questionBankEntries } from '../questions/schema';
import { curricula, curriculumNodes, learningOutcomes, questionLearningOutcomes, subjects } from './schema';

export type SubjectRow = typeof subjects.$inferSelect;
export type CurriculumRow = typeof curricula.$inferSelect;
export type CurriculumNodeRow = typeof curriculumNodes.$inferSelect;
export type LearningOutcomeRow = typeof learningOutcomes.$inferSelect;

@Injectable()
/**
 * Kho dữ liệu Curriculum: subjects → curricula → curriculum_nodes (cây) →
 * learning_outcomes. Thứ tự hiển thị luôn là position tăng dần, rồi thời
 * gian tạo để ổn định khi trùng position.
 */
export class CurriculumRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  // --- subjects -------------------------------------------------------------

  /** Chèn môn học. */
  async insertSubject(v: typeof subjects.$inferInsert): Promise<SubjectRow> {
    const [row] = await this.db.insert(subjects).values(v).returning(); return row!;
  }
  /** Lấy môn học theo id. */
  async getSubject(id: string): Promise<SubjectRow | undefined> {
    const [row] = await this.db.select().from(subjects).where(eq(subjects.id, id)); return row;
  }
  /** Liệt kê môn học trong một context. */
  async listSubjects(contextId: string): Promise<SubjectRow[]> {
    return this.db.select().from(subjects).where(eq(subjects.contextId, contextId))
      .orderBy(asc(subjects.position), asc(subjects.createdAt));
  }
  /** Sửa môn học (đã lọc trường ở tầng service). */
  async updateSubject(id: string, v: Partial<typeof subjects.$inferInsert>): Promise<void> {
    await this.db.update(subjects).set({ ...v, updatedAt: new Date() }).where(eq(subjects.id, id));
  }
  /** Xoá môn học; curricula/nodes/outcomes con bị xoá theo cascade. */
  async deleteSubject(id: string): Promise<void> {
    await this.db.delete(subjects).where(eq(subjects.id, id));
  }

  // --- curricula --------------------------------------------------------------

  /** Chèn chương trình (môn + khối). */
  async insertCurriculum(v: typeof curricula.$inferInsert): Promise<CurriculumRow> {
    const [row] = await this.db.insert(curricula).values(v).returning(); return row!;
  }
  /** Lấy chương trình theo id. */
  async getCurriculum(id: string): Promise<CurriculumRow | undefined> {
    const [row] = await this.db.select().from(curricula).where(eq(curricula.id, id)); return row;
  }
  /** Liệt kê chương trình của một môn, theo khối tăng dần. */
  async listCurricula(subjectId: string): Promise<CurriculumRow[]> {
    return this.db.select().from(curricula).where(eq(curricula.subjectId, subjectId))
      .orderBy(asc(curricula.grade));
  }
  /** Sửa chương trình. */
  async updateCurriculum(id: string, v: Partial<typeof curricula.$inferInsert>): Promise<void> {
    await this.db.update(curricula).set({ ...v, updatedAt: new Date() }).where(eq(curricula.id, id));
  }
  /** Xoá chương trình; cây node và outcomes bị xoá theo cascade. */
  async deleteCurriculum(id: string): Promise<void> {
    await this.db.delete(curricula).where(eq(curricula.id, id));
  }

  // --- nodes ------------------------------------------------------------------

  /** Chèn node nội dung. */
  async insertNode(v: typeof curriculumNodes.$inferInsert): Promise<CurriculumNodeRow> {
    const [row] = await this.db.insert(curriculumNodes).values(v).returning(); return row!;
  }
  /** Lấy node theo id. */
  async getNode(id: string): Promise<CurriculumNodeRow | undefined> {
    const [row] = await this.db.select().from(curriculumNodes).where(eq(curriculumNodes.id, id)); return row;
  }
  /** Toàn bộ node của một chương trình, phẳng, theo position. */
  async listNodes(curriculumId: string): Promise<CurriculumNodeRow[]> {
    return this.db.select().from(curriculumNodes).where(eq(curriculumNodes.curriculumId, curriculumId))
      .orderBy(asc(curriculumNodes.position), asc(curriculumNodes.createdAt));
  }
  /** Sửa node. */
  async updateNode(id: string, v: Partial<typeof curriculumNodes.$inferInsert>): Promise<void> {
    await this.db.update(curriculumNodes).set({ ...v, updatedAt: new Date() }).where(eq(curriculumNodes.id, id));
  }
  /** Xoá node; node con và outcomes bị xoá theo cascade. */
  async deleteNode(id: string): Promise<void> {
    await this.db.delete(curriculumNodes).where(eq(curriculumNodes.id, id));
  }

  // --- outcomes -----------------------------------------------------------------

  /** Chèn yêu cầu cần đạt. */
  async insertOutcome(v: typeof learningOutcomes.$inferInsert): Promise<LearningOutcomeRow> {
    const [row] = await this.db.insert(learningOutcomes).values(v).returning(); return row!;
  }
  /** Lấy yêu cầu cần đạt theo id. */
  async getOutcome(id: string): Promise<LearningOutcomeRow | undefined> {
    const [row] = await this.db.select().from(learningOutcomes).where(eq(learningOutcomes.id, id)); return row;
  }
  /** Liệt kê yêu cầu cần đạt của một node. */
  async listOutcomes(nodeId: string): Promise<LearningOutcomeRow[]> {
    return this.db.select().from(learningOutcomes).where(eq(learningOutcomes.nodeId, nodeId))
      .orderBy(asc(learningOutcomes.position), asc(learningOutcomes.createdAt));
  }
  /** Toàn bộ outcomes của nhiều node (dùng khi dựng cây của một chương trình). */
  async listOutcomesForNodes(nodeIds: string[]): Promise<LearningOutcomeRow[]> {
    if (nodeIds.length === 0) return [];
    return this.db.select().from(learningOutcomes).where(inArray(learningOutcomes.nodeId, nodeIds))
      .orderBy(asc(learningOutcomes.position), asc(learningOutcomes.createdAt));
  }
  /** Sửa yêu cầu cần đạt. */
  async updateOutcome(id: string, v: Partial<typeof learningOutcomes.$inferInsert>): Promise<void> {
    await this.db.update(learningOutcomes).set({ ...v, updatedAt: new Date() }).where(eq(learningOutcomes.id, id));
  }
  /**
   * Đếm câu hỏi sẵn sàng đã gắn vào một YCCĐ, nhóm theo (mức × dạng câu).
   * "Sẵn sàng" = trạng thái ready ở cấp danh tính câu hỏi
   * (question_bank_entries.status) — nền cho đếm ứng viên ma trận (A.6).
   */
  async countReadyQuestionsForOutcome(outcomeId: string): Promise<{ cognitiveLevel: string; qtype: string; count: number }[]> {
    const rows = await this.db
      .select({
        cognitiveLevel: questionLearningOutcomes.cognitiveLevel,
        qtype: question.qtype,
        count: sql<number>`count(distinct ${questionLearningOutcomes.questionId})::int`,
      })
      .from(questionLearningOutcomes)
      .innerJoin(question, eq(question.id, questionLearningOutcomes.questionId))
      .innerJoin(questionBankEntries, eq(questionBankEntries.questionId, question.id))
      .where(sql`${questionLearningOutcomes.learningOutcomeId} = ${outcomeId} and ${questionBankEntries.status} = 'ready'`)
      .groupBy(questionLearningOutcomes.cognitiveLevel, question.qtype)
      .orderBy(asc(questionLearningOutcomes.cognitiveLevel), asc(question.qtype));
    return rows;
  }
  /** Xoá yêu cầu cần đạt. */
  async deleteOutcome(id: string): Promise<void> {
    await this.db.delete(learningOutcomes).where(eq(learningOutcomes.id, id));
  }
}

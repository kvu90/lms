import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { question, questionBankEntries } from '../../db/schema';
import { curricula, curriculumNodes, curriculumProgramRecords, learningOutcomes, questionLearningOutcomes, subjects } from '../../db/schema';

export type SubjectRow = typeof subjects.$inferSelect;
export type CurriculumRow = typeof curricula.$inferSelect;
export type CurriculumNodeRow = typeof curriculumNodes.$inferSelect;
export type LearningOutcomeRow = typeof learningOutcomes.$inferSelect;
export type ProgramRecordRow = typeof curriculumProgramRecords.$inferSelect;

/** Transaction Drizzle đang mở (mẫu của CoursesRepository). */
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
/**
 * Kho dữ liệu Curriculum: subjects → curricula → curriculum_nodes (cây) →
 * learning_outcomes. Thứ tự hiển thị luôn là position tăng dần, rồi thời
 * gian tạo để ổn định khi trùng position.
 */
export class CurriculumRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** Handle DB gốc — tầng service mở transaction khi cần ghi nguyên tử nhiều bảng (nạp dataset). */
  get dbHandle(): Database { return this.db; }

  // --- subjects -------------------------------------------------------------

  /** Chèn môn học. */
  async insertSubject(v: typeof subjects.$inferInsert, tx?: DbTx): Promise<SubjectRow> {
    const [row] = await (tx ?? this.db).insert(subjects).values(v).returning(); return row!;
  }
  /** Lấy môn học theo slug (định danh đường dẫn duy nhất toàn hệ). */
  async getSubjectBySlug(slug: string): Promise<SubjectRow | undefined> {
    const [row] = await this.db.select().from(subjects).where(eq(subjects.slug, slug)); return row;
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
  async insertCurriculum(v: typeof curricula.$inferInsert, tx?: DbTx): Promise<CurriculumRow> {
    const [row] = await (tx ?? this.db).insert(curricula).values(v).returning(); return row!;
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
  async insertNode(v: typeof curriculumNodes.$inferInsert, tx?: DbTx): Promise<CurriculumNodeRow> {
    const [row] = await (tx ?? this.db).insert(curriculumNodes).values(v).returning(); return row!;
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
  async updateNode(id: string, v: Partial<typeof curriculumNodes.$inferInsert>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(curriculumNodes).set({ ...v, updatedAt: new Date() }).where(eq(curriculumNodes.id, id));
  }
  /** Xoá node; node con và outcomes bị xoá theo cascade. */
  async deleteNode(id: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(curriculumNodes).where(eq(curriculumNodes.id, id));
  }

  // --- outcomes -----------------------------------------------------------------

  /** Chèn yêu cầu cần đạt. */
  async insertOutcome(v: typeof learningOutcomes.$inferInsert, tx?: DbTx): Promise<LearningOutcomeRow> {
    const [row] = await (tx ?? this.db).insert(learningOutcomes).values(v).returning(); return row!;
  }
  /** Xoá toàn bộ yêu cầu cần đạt của một node (dùng khi nạp lại một bản ghi đã đính chính: thay cả bộ YCCĐ). */
  async deleteOutcomesForNode(nodeId: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(learningOutcomes).where(eq(learningOutcomes.nodeId, nodeId));
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

  // --- sổ đăng ký nạp dữ liệu chuẩn (K0a) --------------------------------

  /** Tra một bản ghi đã nạp theo định danh ổn định (dataset, mã bản ghi). */
  async getProgramRecord(datasetKey: string, recordId: string): Promise<ProgramRecordRow | undefined> {
    const [row] = await this.db.select().from(curriculumProgramRecords)
      .where(and(eq(curriculumProgramRecords.datasetKey, datasetKey), eq(curriculumProgramRecords.recordId, recordId)));
    return row;
  }
  /** Toàn bộ dòng sổ của một dataset (phục vụ trạng thái nạp + đối chiếu). */
  async listProgramRecords(datasetKey: string): Promise<ProgramRecordRow[]> {
    return this.db.select().from(curriculumProgramRecords)
      .where(eq(curriculumProgramRecords.datasetKey, datasetKey))
      .orderBy(asc(curriculumProgramRecords.recordId));
  }
  /** Ghi một dòng sổ khi nạp mới một bản ghi. */
  async insertProgramRecord(v: typeof curriculumProgramRecords.$inferInsert, tx?: DbTx): Promise<ProgramRecordRow> {
    const [row] = await (tx ?? this.db).insert(curriculumProgramRecords).values(v).returning(); return row!;
  }
  /** Cập nhật một dòng sổ khi bản ghi được nạp lại sau đính chính nguồn. */
  async updateProgramRecord(id: string, v: Partial<typeof curriculumProgramRecords.$inferInsert>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(curriculumProgramRecords).set({ ...v, updatedAt: new Date() })
      .where(eq(curriculumProgramRecords.id, id));
  }
  /** Toàn bộ dòng sổ của một môn (mọi dataset) — tầng SGK (K0b) truy vết mã bản ghi theo node đích của ánh xạ. */
  async listProgramRecordsBySubject(subjectId: string): Promise<ProgramRecordRow[]> {
    return this.db.select().from(curriculumProgramRecords)
      .where(eq(curriculumProgramRecords.subjectId, subjectId))
      .orderBy(asc(curriculumProgramRecords.recordId));
  }
}

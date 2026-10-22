import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import {
  question, questionAttemptStepData, questionAttemptSteps, questionAttempts,
  questionBankEntries, questionCategories, questionUsages, questionVersions,
} from '../../db/schema';

export type QCategoryRow = typeof questionCategories.$inferSelect;
export type QuestionRow = typeof question.$inferSelect;
export type EntryRow = typeof questionBankEntries.$inferSelect;
export type VersionRow = typeof questionVersions.$inferSelect;
export type UsageRow = typeof questionUsages.$inferSelect;
export type AttemptRow = typeof questionAttempts.$inferSelect;
export type StepRow = typeof questionAttemptSteps.$inferSelect;
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
/**
 * Kho dữ liệu ngân hàng câu hỏi và question engine: category, question, entry, version, usage, attempt, step và step data.
 * Mô hình version: mỗi lần sửa tạo version mới; attempt luôn gắn (pin) vào version tại thời điểm bắt đầu.
 */
export class QuestionsRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  /**
   * Chèn category câu hỏi.
   */
  async insertCategory(v: typeof questionCategories.$inferInsert): Promise<QCategoryRow> {
    const [row] = await this.db.insert(questionCategories).values(v).returning(); return row!;
  }
  /**
   * Lấy category theo id.
   */
  async getCategory(id: string): Promise<QCategoryRow | undefined> {
    const [row] = await this.db.select().from(questionCategories).where(eq(questionCategories.id, id)); return row;
  }
  /**
   * Liệt kê category trong context.
   */
  async listCategories(contextId?: string): Promise<QCategoryRow[]> {
    const rows = contextId !== undefined
      ? await this.db.select().from(questionCategories).where(eq(questionCategories.contextid, contextId))
      : await this.db.select().from(questionCategories);
    return rows.sort((a, b) => a.timecreated.getTime() - b.timecreated.getTime() || a.id.localeCompare(b.id));
  }

  /**
   * Chèn bản ghi question (định danh ổn định qua các version).
   */
  async insertQuestion(v: typeof question.$inferInsert): Promise<QuestionRow> {
    const [row] = await this.db.insert(question).values(v).returning(); return row!;
  }
  /**
   * Lấy question theo id.
   */
  async getQuestion(id: string): Promise<QuestionRow | undefined> {
    const [row] = await this.db.select().from(question).where(eq(question.id, id)); return row;
  }
  /**
   * Cập nhật question.
   */
  async updateQuestion(id: string, patch: Partial<QuestionRow>): Promise<void> {
    await this.db.update(question).set({ ...patch, timemodified: new Date() }).where(eq(question.id, id));
  }
  /**
   * Câu hỏi trong category.
   */
  async listQuestionsInCategory(categoryId: string): Promise<QuestionRow[]> {
    return this.db.select().from(question).where(eq(question.category, categoryId)).orderBy(asc(question.id));
  }

  /**
   * Chèn question entry (liên kết category ↔ question, giữ latestversion).
   */
  async insertEntry(v: typeof questionBankEntries.$inferInsert): Promise<EntryRow> {
    const [row] = await this.db.insert(questionBankEntries).values(v).returning(); return row!;
  }
  /**
   * Entry của một question.
   */
  async getEntryByQuestion(questionId: string): Promise<EntryRow | undefined> {
    const [row] = await this.db.select().from(questionBankEntries).where(eq(questionBankEntries.questionid, questionId)); return row;
  }
  /**
   * Cập nhật entry (latestversion).
   */
  async updateEntry(id: string, patch: Partial<EntryRow>): Promise<void> {
    await this.db.update(questionBankEntries).set({ ...patch, timemodified: new Date() }).where(eq(questionBankEntries.id, id));
  }

  /**
   * Chèn một version nội dung câu hỏi.
   */
  async insertVersion(v: typeof questionVersions.$inferInsert): Promise<VersionRow> {
    const [row] = await this.db.insert(questionVersions).values(v).returning(); return row!;
  }
  /**
   * Lấy version theo id.
   */
  async getVersion(id: string): Promise<VersionRow | undefined> {
    const [row] = await this.db.select().from(questionVersions).where(eq(questionVersions.id, id)); return row;
  }
  /**
   * Lấy version theo số thứ tự của question.
   */
  async getVersionByNumber(entryId: string, version: number): Promise<VersionRow | undefined> {
    const [row] = await this.db.select().from(questionVersions)
      .where(and(eq(questionVersions.questionbankentryid, entryId), eq(questionVersions.version, version)));
    return row;
  }
  /**
   * Mọi version của question (lịch sử).
   */
  async listVersions(entryId: string): Promise<VersionRow[]> {
    return this.db.select().from(questionVersions).where(eq(questionVersions.questionbankentryid, entryId)).orderBy(asc(questionVersions.version));
  }

  /**
   * Chèn question usage (một lượt sử dụng bộ câu hỏi, vd một lần làm bài quiz).
   */
  async insertUsage(v: typeof questionUsages.$inferInsert): Promise<UsageRow> {
    const [row] = await this.db.insert(questionUsages).values(v).returning(); return row!;
  }
  /**
   * Lấy usage theo id.
   */
  async getUsage(id: string): Promise<UsageRow | undefined> {
    const [row] = await this.db.select().from(questionUsages).where(eq(questionUsages.id, id)); return row;
  }
  /**
   * Chèn question attempt (một câu trong một usage).
   */
  async insertAttempt(v: typeof questionAttempts.$inferInsert): Promise<AttemptRow> {
    const [row] = await this.db.insert(questionAttempts).values(v).returning(); return row!;
  }
  /**
   * Lấy attempt theo id.
   */
  async getAttempt(id: string): Promise<AttemptRow | undefined> {
    const [row] = await this.db.select().from(questionAttempts).where(eq(questionAttempts.id, id)); return row;
  }
  /**
   * Attempt của usage.
   */
  async listAttempts(usageId: string): Promise<AttemptRow[]> {
    return this.db.select().from(questionAttempts).where(eq(questionAttempts.questionusageid, usageId)).orderBy(asc(questionAttempts.slot));
  }
  /**
   * Cập nhật attempt (trạng thái, fraction, version đã pin).
   */
  async updateAttempt(id: string, patch: Partial<AttemptRow>): Promise<void> {
    await this.db.update(questionAttempts).set({ ...patch, timemodified: new Date() }).where(eq(questionAttempts.id, id));
  }

  /**
   * Ghi một bước tương tác (step) của attempt.
   */
  async insertStep(v: typeof questionAttemptSteps.$inferInsert, tx?: DbTx): Promise<StepRow> {
    const [row] = await (tx ?? this.db).insert(questionAttemptSteps).values(v).returning(); return row!;
  }
  /**
   * Các bước của attempt theo thứ tự.
   */
  async listSteps(attemptId: string): Promise<StepRow[]> {
    return this.db.select().from(questionAttemptSteps).where(eq(questionAttemptSteps.questionattemptid, attemptId)).orderBy(asc(questionAttemptSteps.sequencenumber));
  }
  /**
   * Ghi dữ liệu của một bước (câu trả lời đã nộp).
   */
  async insertStepData(v: typeof questionAttemptStepData.$inferInsert, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).insert(questionAttemptStepData).values(v);
  }
  /**
   * Dữ liệu các bước của attempt.
   */
  async listStepData(stepId: string): Promise<(typeof questionAttemptStepData.$inferSelect)[]> {
    return this.db.select().from(questionAttemptStepData).where(eq(questionAttemptStepData.attemptstepid, stepId));
  }
}

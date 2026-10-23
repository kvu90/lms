import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import {
  question, questionAnswers, questionAttemptStepData, questionAttemptSteps, questionAttempts,
  questionBankEntries, questionCategories, questionTruefalse, questionUsages, questionVersions,
  qtypeEssayOptions, qtypeMultichoiceOptions, qtypeShortanswerOptions, stimuli,
} from '../../db/schema';

export type QCategoryRow = typeof questionCategories.$inferSelect;
export type QuestionRow = typeof question.$inferSelect;
export type EntryRow = typeof questionBankEntries.$inferSelect;
export type VersionRow = typeof questionVersions.$inferSelect;
export type StimulusRow = typeof stimuli.$inferSelect;
export type AnswerRow = typeof questionAnswers.$inferSelect;
export type MultichoiceOptionsRow = typeof qtypeMultichoiceOptions.$inferSelect;
export type TruefalseOptionsRow = typeof questionTruefalse.$inferSelect;
export type ShortanswerOptionsRow = typeof qtypeShortanswerOptions.$inferSelect;
export type EssayOptionsRow = typeof qtypeEssayOptions.$inferSelect;
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
  async insertQuestion(v: typeof question.$inferInsert, tx?: DbTx): Promise<QuestionRow> {
    const [row] = await (tx ?? this.db).insert(question).values(v).returning(); return row!;
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
  async insertEntry(v: typeof questionBankEntries.$inferInsert, tx?: DbTx): Promise<EntryRow> {
    const [row] = await (tx ?? this.db).insert(questionBankEntries).values(v).returning(); return row!;
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
  async insertVersion(v: typeof questionVersions.$inferInsert, tx?: DbTx): Promise<VersionRow> {
    const [row] = await (tx ?? this.db).insert(questionVersions).values(v).returning(); return row!;
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

  // --- stimuli -----------------------------------------------------------------

  /**
   * Chèn ngữ liệu (stimulus) mới.
   */
  async insertStimulus(v: typeof stimuli.$inferInsert, tx?: DbTx): Promise<StimulusRow> {
    const [row] = await (tx ?? this.db).insert(stimuli).values(v).returning(); return row!;
  }
  /**
   * Lấy ngữ liệu theo id.
   */
  async getStimulus(id: string): Promise<StimulusRow | undefined> {
    const [row] = await this.db.select().from(stimuli).where(eq(stimuli.id, id)); return row;
  }
  /**
   * Ngữ liệu thuộc một category (phạm vi chia sẻ của stimulus).
   */
  async listStimuliInCategory(categoryId: string): Promise<StimulusRow[]> {
    return this.db.select().from(stimuli).where(eq(stimuli.categoryid, categoryId)).orderBy(asc(stimuli.id));
  }
  /**
   * Cập nhật nội dung ngữ liệu — chỉ hợp lệ khi chưa có version nào tham
   * chiếu (bất biến do service bảo đảm trước khi gọi).
   */
  async updateStimulus(id: string, patch: Partial<StimulusRow>): Promise<void> {
    await this.db.update(stimuli).set({ ...patch, timemodified: new Date() }).where(eq(stimuli.id, id));
  }
  /**
   * Xoá ngữ liệu — chỉ hợp lệ khi chưa có version nào tham chiếu.
   */
  async deleteStimulus(id: string): Promise<void> {
    await this.db.delete(stimuli).where(eq(stimuli.id, id));
  }
  /**
   * Số version đang tham chiếu một ngữ liệu (> 0 ⇒ stimulus bất biến).
   */
  async countVersionsReferencingStimulus(stimulusId: string): Promise<number> {
    const rows = await this.db.select({ id: questionVersions.id }).from(questionVersions)
      .where(eq(questionVersions.stimulusid, stimulusId));
    return rows.length;
  }

  // --- answers & options ---------------------------------------------------------

  /**
   * Chèn một đáp án của version (question_answers).
   */
  async insertAnswer(v: typeof questionAnswers.$inferInsert, tx?: DbTx): Promise<AnswerRow> {
    const [row] = await (tx ?? this.db).insert(questionAnswers).values(v).returning(); return row!;
  }
  /**
   * Mọi đáp án của một version theo sortorder (thứ tự chấm của shortanswer).
   */
  async listAnswers(versionId: string): Promise<AnswerRow[]> {
    return this.db.select().from(questionAnswers)
      .where(eq(questionAnswers.questionversionid, versionId))
      .orderBy(asc(questionAnswers.sortorder), asc(questionAnswers.id));
  }

  /**
   * Chèn options multichoice của version.
   */
  async insertMultichoiceOptions(v: typeof qtypeMultichoiceOptions.$inferInsert, tx?: DbTx): Promise<MultichoiceOptionsRow> {
    const [row] = await (tx ?? this.db).insert(qtypeMultichoiceOptions).values(v).returning(); return row!;
  }
  /**
   * Options multichoice của version.
   */
  async getMultichoiceOptions(versionId: string): Promise<MultichoiceOptionsRow | undefined> {
    const [row] = await this.db.select().from(qtypeMultichoiceOptions).where(eq(qtypeMultichoiceOptions.questionversionid, versionId)); return row;
  }
  /**
   * Chèn options truefalse của version (trỏ vào 2 dòng đáp án đúng/sai).
   */
  async insertTruefalseOptions(v: typeof questionTruefalse.$inferInsert, tx?: DbTx): Promise<TruefalseOptionsRow> {
    const [row] = await (tx ?? this.db).insert(questionTruefalse).values(v).returning(); return row!;
  }
  /**
   * Options truefalse của version.
   */
  async getTruefalseOptions(versionId: string): Promise<TruefalseOptionsRow | undefined> {
    const [row] = await this.db.select().from(questionTruefalse).where(eq(questionTruefalse.questionversionid, versionId)); return row;
  }
  /**
   * Chèn options shortanswer của version.
   */
  async insertShortanswerOptions(v: typeof qtypeShortanswerOptions.$inferInsert, tx?: DbTx): Promise<ShortanswerOptionsRow> {
    const [row] = await (tx ?? this.db).insert(qtypeShortanswerOptions).values(v).returning(); return row!;
  }
  /**
   * Options shortanswer của version.
   */
  async getShortanswerOptions(versionId: string): Promise<ShortanswerOptionsRow | undefined> {
    const [row] = await this.db.select().from(qtypeShortanswerOptions).where(eq(qtypeShortanswerOptions.questionversionid, versionId)); return row;
  }
  /**
   * Chèn options essay của version.
   */
  async insertEssayOptions(v: typeof qtypeEssayOptions.$inferInsert, tx?: DbTx): Promise<EssayOptionsRow> {
    const [row] = await (tx ?? this.db).insert(qtypeEssayOptions).values(v).returning(); return row!;
  }
  /**
   * Options essay của version.
   */
  async getEssayOptions(versionId: string): Promise<EssayOptionsRow | undefined> {
    const [row] = await this.db.select().from(qtypeEssayOptions).where(eq(qtypeEssayOptions.questionversionid, versionId)); return row;
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

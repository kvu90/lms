import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database, DbTx } from '../../db/database';
import {
  curricula, curriculumNodes, learningOutcomes,
  question, questionAnswerKeys, questionAnswers, questionAttemptStepData, questionAttemptSteps, questionAttempts,
  questionBankEntries, questionBanks, questionCategories, questionLearningOutcomes, questionSubjects, questionTruefalse,
  questionUsages, questionVersions,
  qtypeEssayOptions, qtypeMultichoiceOptions, qtypeShortanswerOptions, examAttempts, stimuli, subjects,
} from '../../db/schema';

export type QCategoryRow = typeof questionCategories.$inferSelect;
export type QuestionRow = typeof question.$inferSelect;
export type EntryRow = typeof questionBankEntries.$inferSelect;
export type VersionRow = typeof questionVersions.$inferSelect;
export type StimulusRow = typeof stimuli.$inferSelect;
export type AnswerRow = typeof questionAnswers.$inferSelect;
export type AnswerKeyRow = typeof questionAnswerKeys.$inferSelect;
export type MultichoiceOptionsRow = typeof qtypeMultichoiceOptions.$inferSelect;
export type TruefalseOptionsRow = typeof questionTruefalse.$inferSelect;
export type ShortanswerOptionsRow = typeof qtypeShortanswerOptions.$inferSelect;
export type EssayOptionsRow = typeof qtypeEssayOptions.$inferSelect;
export type UsageRow = typeof questionUsages.$inferSelect;
export type QuizAttemptLinkRow = typeof examAttempts.$inferSelect;
export type AttemptRow = typeof questionAttempts.$inferSelect;
export type StepRow = typeof questionAttemptSteps.$inferSelect;
export type QuestionSubjectLinkRow = typeof questionSubjects.$inferSelect;
export type QuestionOutcomeLinkRow = typeof questionLearningOutcomes.$inferSelect;

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
   * Lấy nhiều category theo tập id trong một truy vấn (DL-05, issue
   * #489): bản theo lô của `getCategory` cho phép suy bank của nhiều
   * câu hỏi; caller tự tra theo id.
   */
  async getCategoriesByIds(ids: string[]): Promise<QCategoryRow[]> {
    if (!ids.length) return [];
    return this.db.select().from(questionCategories).where(inArray(questionCategories.id, ids));
  }
  /**
   * Lấy bank câu hỏi theo id (feat Ngân hàng câu hỏi chung, QB-1) — tra
   * cứu nhẹ phục vụ các cổng chung của module (vd tạo category gắn bank).
   */
  async getBankById(id: string): Promise<(typeof questionBanks.$inferSelect) | undefined> {
    const [row] = await this.db.select().from(questionBanks).where(eq(questionBanks.id, id)); return row;
  }
  /**
   * Bank sở hữu một context (context của bank trỏ thẳng về bank) — phục
   * vụ cổng riêng tư bank personal (issue #123): category sống trong
   * context của bank thì thuộc bank đó.
   */
  async getBankByContextId(contextId: string): Promise<(typeof questionBanks.$inferSelect) | undefined> {
    const [row] = await this.db.select().from(questionBanks).where(eq(questionBanks.contextId, contextId)); return row;
  }
  /**
   * Liệt kê category trong context.
   */
  async listCategories(contextId?: string): Promise<QCategoryRow[]> {
    const rows = contextId !== undefined
      ? await this.db.select().from(questionCategories).where(eq(questionCategories.contextId, contextId))
      : await this.db.select().from(questionCategories);
    return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
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
   * Lấy nhiều question theo tập id trong một truy vấn (DL-05, issue
   * #489): bản theo lô của `getQuestion`; caller tự tra theo id.
   */
  async getQuestionsByIds(ids: string[]): Promise<QuestionRow[]> {
    if (!ids.length) return [];
    return this.db.select().from(question).where(inArray(question.id, ids));
  }
  /**
   * Cập nhật question.
   */
  async updateQuestion(id: string, patch: Partial<QuestionRow>): Promise<void> {
    await this.db.update(question).set({ ...patch, updatedAt: new Date() }).where(eq(question.id, id));
  }
  /**
   * Câu hỏi trong category.
   */
  async listQuestionsInCategory(categoryId: string): Promise<QuestionRow[]> {
    return this.db.select().from(question).where(eq(question.category, categoryId)).orderBy(asc(question.id));
  }

  /**
   * Chèn question entry (liên kết category ↔ question, giữ latestVersion).
   */
  async insertEntry(v: typeof questionBankEntries.$inferInsert, tx?: DbTx): Promise<EntryRow> {
    const [row] = await (tx ?? this.db).insert(questionBankEntries).values(v).returning(); return row!;
  }
  /**
   * Entry của một question.
   */
  async getEntryByQuestion(questionId: string): Promise<EntryRow | undefined> {
    const [row] = await this.db.select().from(questionBankEntries).where(eq(questionBankEntries.questionId, questionId)); return row;
  }
  /**
   * Entry của NHIỀU question trong một truy vấn (DL-05, issue #489):
   * bản theo lô của `getEntryByQuestion`; caller tự tra theo
   * questionId (mỗi question tối đa một entry như đường đọc lẻ).
   */
  async getEntriesByQuestionIds(questionIds: string[]): Promise<EntryRow[]> {
    if (!questionIds.length) return [];
    return this.db.select().from(questionBankEntries).where(inArray(questionBankEntries.questionId, questionIds));
  }
  /**
   * Cập nhật entry (latestVersion).
   */
  async updateEntry(id: string, patch: Partial<EntryRow>): Promise<void> {
    await this.db.update(questionBankEntries).set({ ...patch, updatedAt: new Date() }).where(eq(questionBankEntries.id, id));
  }

  /**
   * Cập nhật một version (trạng thái draft/ready — đường nạp MCP đặt
   * version vừa tạo về `draft`, xem QuestionBanksService.setQuestionStatus).
   */
  async updateVersion(id: string, patch: Partial<VersionRow>): Promise<void> {
    await this.db.update(questionVersions).set({ ...patch }).where(eq(questionVersions.id, id));
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
      .where(and(eq(questionVersions.questionBankEntryId, entryId), eq(questionVersions.version, version)));
    return row;
  }
  /**
   * Mọi version của question (lịch sử).
   */
  async listVersions(entryId: string): Promise<VersionRow[]> {
    return this.db.select().from(questionVersions).where(eq(questionVersions.questionBankEntryId, entryId)).orderBy(asc(questionVersions.version));
  }
  /**
   * Mọi version của NHIỀU entry trong một truy vấn (DL-04/DL-05,
   * issue #489): bản theo lô của `listVersions`; sắp theo entry rồi
   * theo số version để khi caller gom theo entry, thứ tự version vẫn
   * tăng dần như đường đọc lẻ.
   */
  async listVersionsForEntries(entryIds: string[]): Promise<VersionRow[]> {
    if (!entryIds.length) return [];
    return this.db.select().from(questionVersions).where(inArray(questionVersions.questionBankEntryId, entryIds))
      .orderBy(asc(questionVersions.questionBankEntryId), asc(questionVersions.version));
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
    return this.db.select().from(stimuli).where(eq(stimuli.categoryId, categoryId)).orderBy(asc(stimuli.id));
  }
  /**
   * Cập nhật nội dung ngữ liệu — chỉ hợp lệ khi chưa có version nào tham
   * chiếu (bất biến do service bảo đảm trước khi gọi).
   */
  async updateStimulus(id: string, patch: Partial<StimulusRow>): Promise<void> {
    await this.db.update(stimuli).set({ ...patch, updatedAt: new Date() }).where(eq(stimuli.id, id));
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
      .where(eq(questionVersions.stimulusId, stimulusId));
    return rows.length;
  }

  // --- đáp án & tuỳ chọn ---------------------------------------------------------

  /**
   * Chèn một đáp án của version (question_answers).
   */
  async insertAnswer(v: typeof questionAnswers.$inferInsert, tx?: DbTx): Promise<AnswerRow> {
    const [row] = await (tx ?? this.db).insert(questionAnswers).values(v).returning(); return row!;
  }
  /**
   * Mọi đáp án của một version theo sortOrder (thứ tự hiển thị và thứ tự
   * suy đáp án đúng hiển thị của shortanswer).
   */
  async listAnswers(versionId: string): Promise<AnswerRow[]> {
    return this.db.select().from(questionAnswers)
      .where(eq(questionAnswers.questionVersionId, versionId))
      .orderBy(asc(questionAnswers.sortOrder), asc(questionAnswers.id));
  }

  /**
   * Chèn bản ghi phía đáp án của một version (`question_answer_keys`:
   * guidance + solution, quan hệ 1-1 với version — quyết 12:12 ngày
   * 26/10/2026). Chỉ gọi khi version có ít nhất một trong hai nội dung;
   * version không có dòng nào thì phía đọc hiểu là cả hai đều null.
   *
   * @param v - guidance/solution dạng tài liệu Tiptap/JSON đã chuẩn hoá.
   * @param tx - giao dịch đang mở của đường ghi version (bắt buộc đi
   *   cùng giao dịch với version + answers để không có version nào
   *   thiếu phía đáp án của nó).
   * @returns Dòng vừa chèn.
   */
  async insertAnswerKey(v: typeof questionAnswerKeys.$inferInsert, tx?: DbTx): Promise<AnswerKeyRow> {
    const [row] = await (tx ?? this.db).insert(questionAnswerKeys).values(v).returning(); return row!;
  }

  /**
   * Bản ghi phía đáp án của một version; `undefined` khi version không
   * mang guidance lẫn solution (phía đọc quy về cả hai null).
   */
  async getAnswerKey(versionId: string): Promise<AnswerKeyRow | undefined> {
    const [row] = await this.db.select().from(questionAnswerKeys).where(eq(questionAnswerKeys.questionVersionId, versionId)); return row;
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
    const [row] = await this.db.select().from(qtypeMultichoiceOptions).where(eq(qtypeMultichoiceOptions.questionVersionId, versionId)); return row;
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
    const [row] = await this.db.select().from(questionTruefalse).where(eq(questionTruefalse.questionVersionId, versionId)); return row;
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
    const [row] = await this.db.select().from(qtypeShortanswerOptions).where(eq(qtypeShortanswerOptions.questionVersionId, versionId)); return row;
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
    const [row] = await this.db.select().from(qtypeEssayOptions).where(eq(qtypeEssayOptions.questionVersionId, versionId)); return row;
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
   * Lấy nhiều usage theo tập id trong một truy vấn (DL-03, issue
   * #489): bản theo lô của `getUsage` cho các đường đọc phải nạp usage
   * của nhiều lượt cùng lúc; thứ tự trả về không cam kết, caller tự
   * tra theo id.
   */
  async getUsagesByIds(ids: string[]): Promise<UsageRow[]> {
    if (!ids.length) return [];
    return this.db.select().from(questionUsages).where(inArray(questionUsages.id, ids));
  }
  /**
   * Xoá usage (attempts/steps cascade theo khoá ngoại) — dùng khi hoạt
   * động sở hữu usage bị xoá (vd quiz bị xoá kéo theo các lượt làm).
   */
  async deleteUsage(id: string): Promise<void> {
    await this.db.delete(questionUsages).where(eq(questionUsages.id, id));
  }
  /**
   * Lượt quiz (quiz_attempts) đang gắn với một usage, nếu có — usage_id
   * là unique trong quiz_attempts nên tối đa một dòng. Dùng để cổng kênh
   * HTTP biết usage này thuộc về một lượt quiz (issue #60).
   */
  async findQuizAttemptByUsageId(usageId: string): Promise<QuizAttemptLinkRow | undefined> {
    const [row] = await this.db.select().from(examAttempts).where(eq(examAttempts.usageId, usageId));
    return row;
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
    return this.db.select().from(questionAttempts).where(eq(questionAttempts.questionUsageId, usageId)).orderBy(asc(questionAttempts.slot));
  }
  /**
   * Attempt của NHIỀU usage trong một truy vấn (DL-03, issue #489):
   * bản theo lô của `listAttempts`; sắp theo usage rồi theo slot để
   * khi caller gom theo usage, thứ tự attempt trong từng usage vẫn là
   * slot tăng dần như đường đọc lẻ.
   */
  async listAttemptsForUsages(usageIds: string[]): Promise<AttemptRow[]> {
    if (!usageIds.length) return [];
    return this.db.select().from(questionAttempts).where(inArray(questionAttempts.questionUsageId, usageIds))
      .orderBy(asc(questionAttempts.questionUsageId), asc(questionAttempts.slot));
  }
  /**
   * Cập nhật attempt (trạng thái, fraction, version đã pin).
   */
  async updateAttempt(id: string, patch: Partial<AttemptRow>): Promise<void> {
    await this.db.update(questionAttempts).set({ ...patch, updatedAt: new Date() }).where(eq(questionAttempts.id, id));
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
    return this.db.select().from(questionAttemptSteps).where(eq(questionAttemptSteps.questionAttemptId, attemptId)).orderBy(asc(questionAttemptSteps.sequenceNumber));
  }
  /**
   * Các bước của NHIỀU attempt trong một truy vấn (DL-03, issue
   * #489): bản theo lô của `listSteps`; sắp theo attempt rồi theo số
   * thứ tự bước để thứ tự bước trong từng attempt giữ nguyên như
   * đường đọc lẻ khi caller gom lại.
   */
  async listStepsForAttempts(attemptIds: string[]): Promise<StepRow[]> {
    if (!attemptIds.length) return [];
    return this.db.select().from(questionAttemptSteps).where(inArray(questionAttemptSteps.questionAttemptId, attemptIds))
      .orderBy(asc(questionAttemptSteps.questionAttemptId), asc(questionAttemptSteps.sequenceNumber));
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
    return this.db.select().from(questionAttemptStepData).where(eq(questionAttemptStepData.attemptStepId, stepId));
  }
  /**
   * Dữ liệu của NHIỀU bước trong một truy vấn (DL-03, issue #489):
   * bản theo lô của `listStepData`; đường đọc lẻ không sắp xếp nên
   * bản theo lô cũng không sắp — dữ liệu của mỗi bước được gom vào
   * object theo tên ở tầng service, thứ tự dòng không mang nghĩa.
   */
  async listStepDataForSteps(stepIds: string[]): Promise<(typeof questionAttemptStepData.$inferSelect)[]> {
    if (!stepIds.length) return [];
    return this.db.select().from(questionAttemptStepData).where(inArray(questionAttemptStepData.attemptStepId, stepIds));
  }

  // --- curriculum links (issue #20 Chặng 2) -----------------------------------
  // Hai bảng nối thuộc module curriculum (question_subjects,
  // question_learning_outcomes) nhưng API gắn kết đặt ở module questions —
  // nơi sở hữu danh tính câu hỏi (mục A.6) — nên repository này truy vấn
  // thẳng các bảng đó cùng chuỗi outcome → node → curriculum → subject.

  /** Môn học theo id (đích gắn kết mức môn). */
  async getSubjectRow(id: string): Promise<(typeof subjects.$inferSelect) | undefined> {
    const [row] = await this.db.select().from(subjects).where(eq(subjects.id, id)); return row;
  }
  /** Chuỗi đầy đủ của một YCCĐ để suy ra môn học sở hữu nó. */
  async getOutcomeChain(id: string): Promise<{
    outcome: typeof learningOutcomes.$inferSelect;
    node: typeof curriculumNodes.$inferSelect;
    curriculum: typeof curricula.$inferSelect;
    subject: typeof subjects.$inferSelect;
  } | undefined> {
    const [outcome] = await this.db.select().from(learningOutcomes).where(eq(learningOutcomes.id, id));
    if (!outcome) return undefined;
    const [node] = await this.db.select().from(curriculumNodes).where(eq(curriculumNodes.id, outcome.nodeId));
    if (!node) return undefined;
    const [curriculum] = await this.db.select().from(curricula).where(eq(curricula.id, node.curriculumId));
    if (!curriculum) return undefined;
    const subject = await this.getSubjectRow(curriculum.subjectId);
    if (!subject) return undefined;
    return { outcome, node, curriculum, subject };
  }
  /** Các dòng gắn môn của một câu hỏi. */
  async listQuestionSubjectLinks(questionId: string): Promise<QuestionSubjectLinkRow[]> {
    return this.db.select().from(questionSubjects).where(eq(questionSubjects.questionId, questionId))
      .orderBy(asc(questionSubjects.createdAt));
  }
  /**
   * Các dòng gắn môn của NHIỀU câu hỏi trong một truy vấn (DL-04,
   * issue #489): bản theo lô của `listQuestionSubjectLinks`; sắp
   * theo câu hỏi rồi theo thời điểm tạo để thứ tự dòng gắn trong
   * từng câu hỏi giữ nguyên như đường đọc lẻ khi caller gom lại.
   */
  async listQuestionSubjectLinksForQuestions(questionIds: string[]): Promise<QuestionSubjectLinkRow[]> {
    if (!questionIds.length) return [];
    return this.db.select().from(questionSubjects).where(inArray(questionSubjects.questionId, questionIds))
      .orderBy(asc(questionSubjects.questionId), asc(questionSubjects.createdAt));
  }
  /** Một dòng gắn môn theo cặp (câu hỏi, môn). */
  async getQuestionSubjectLink(questionId: string, subjectId: string): Promise<QuestionSubjectLinkRow | undefined> {
    const [row] = await this.db.select().from(questionSubjects)
      .where(and(eq(questionSubjects.questionId, questionId), eq(questionSubjects.subjectId, subjectId)));
    return row;
  }
  /** Chèn dòng gắn môn. */
  async insertQuestionSubjectLink(v: typeof questionSubjects.$inferInsert, tx?: DbTx): Promise<QuestionSubjectLinkRow> {
    const [row] = await (tx ?? this.db).insert(questionSubjects).values(v).returning(); return row!;
  }
  /** Xoá dòng gắn môn; trả true khi có dòng bị xoá. */
  async deleteQuestionSubjectLink(questionId: string, subjectId: string): Promise<boolean> {
    const rows = await this.db.delete(questionSubjects)
      .where(and(eq(questionSubjects.questionId, questionId), eq(questionSubjects.subjectId, subjectId)))
      .returning();
    return rows.length > 0;
  }
  /** Các dòng gắn YCCĐ của một câu hỏi. */
  async listQuestionOutcomeLinks(questionId: string): Promise<QuestionOutcomeLinkRow[]> {
    return this.db.select().from(questionLearningOutcomes).where(eq(questionLearningOutcomes.questionId, questionId))
      .orderBy(asc(questionLearningOutcomes.createdAt));
  }
  /**
   * Các dòng gắn YCCĐ của NHIỀU câu hỏi trong một truy vấn (DL-04,
   * issue #489): bản theo lô của `listQuestionOutcomeLinks`; sắp
   * theo câu hỏi rồi theo thời điểm tạo để thứ tự dòng gắn trong
   * từng câu hỏi giữ nguyên như đường đọc lẻ khi caller gom lại.
   */
  async listQuestionOutcomeLinksForQuestions(questionIds: string[]): Promise<QuestionOutcomeLinkRow[]> {
    if (!questionIds.length) return [];
    return this.db.select().from(questionLearningOutcomes).where(inArray(questionLearningOutcomes.questionId, questionIds))
      .orderBy(asc(questionLearningOutcomes.questionId), asc(questionLearningOutcomes.createdAt));
  }
  /** Một dòng gắn YCCĐ theo cặp (câu hỏi, YCCĐ). */
  async getQuestionOutcomeLink(questionId: string, outcomeId: string): Promise<QuestionOutcomeLinkRow | undefined> {
    const [row] = await this.db.select().from(questionLearningOutcomes)
      .where(and(eq(questionLearningOutcomes.questionId, questionId), eq(questionLearningOutcomes.learningOutcomeId, outcomeId)));
    return row;
  }
  /** Chèn dòng gắn YCCĐ kèm mức độ nhận thức của cặp. */
  async insertQuestionOutcomeLink(v: typeof questionLearningOutcomes.$inferInsert, tx?: DbTx): Promise<QuestionOutcomeLinkRow> {
    const [row] = await (tx ?? this.db).insert(questionLearningOutcomes).values(v).returning(); return row!;
  }
  /** Đổi mức độ nhận thức của một dòng gắn YCCĐ. */
  async updateQuestionOutcomeLink(questionId: string, outcomeId: string, cognitiveLevel: string): Promise<void> {
    await this.db.update(questionLearningOutcomes).set({ cognitiveLevel })
      .where(and(eq(questionLearningOutcomes.questionId, questionId), eq(questionLearningOutcomes.learningOutcomeId, outcomeId)));
  }
  /** Xoá dòng gắn YCCĐ; trả true khi có dòng bị xoá. */
  async deleteQuestionOutcomeLink(questionId: string, outcomeId: string): Promise<boolean> {
    const rows = await this.db.delete(questionLearningOutcomes)
      .where(and(eq(questionLearningOutcomes.questionId, questionId), eq(questionLearningOutcomes.learningOutcomeId, outcomeId)))
      .returning();
    return rows.length > 0;
  }

  /**
   * Lọc ngân hàng câu hỏi theo gắn kết chương trình (mục A.6): subjectId
   * khớp cả gắn mức môn lẫn YCCĐ thuộc môn đó (môn suy ngược từ YCCĐ);
   * outcomeId + cognitiveLevel phải khớp trên **cùng một dòng nối** khi
   * đi cùng nhau; qtype là dạng của danh tính câu; status là trạng thái
   * của bank entry. Các điều kiện gắn kết giao nhau (AND).
   */
  async filterQuestionsByCurriculumLinks(filter: {
    subjectId?: string; outcomeId?: string; nodeId?: string; cognitiveLevel?: string; qtype?: string; status?: string;
  }): Promise<QuestionRow[]> {
    // Điều kiện HIỆN HÀNH của dòng YCCĐ trên các nhánh có join
    // outcome (đợt neo lại định danh, issue #161): dòng đã rút
    // (retired_at khác NULL) không còn đưa câu vào diện lọc; dòng
    // derived chỉ hiện hành khi dòng GỐC của nó hiện hành. Cùng một
    // định nghĩa "hiện hành" với bản đặc tả. Nhánh chỉ tra đích danh
    // theo outcomeId (không join outcome) KHÔNG áp điều kiện này —
    // tra theo id phải luôn tìm thấy dòng nối của nó.
    const outcomeRoot = alias(learningOutcomes, 'learning_outcome_root');
    const activeOutcomeConditions = [
      isNull(learningOutcomes.retiredAt),
      or(isNull(learningOutcomes.derivedFromId), isNull(outcomeRoot.retiredAt)),
    ];
    const idSets: Set<string>[] = [];
    if (filter.subjectId !== undefined) {
      const viaSubjects = await this.db.select({ questionId: questionSubjects.questionId })
        .from(questionSubjects).where(eq(questionSubjects.subjectId, filter.subjectId));
      const viaOutcomes = await this.db.select({ questionId: questionLearningOutcomes.questionId })
        .from(questionLearningOutcomes)
        .innerJoin(learningOutcomes, eq(learningOutcomes.id, questionLearningOutcomes.learningOutcomeId))
        .leftJoin(outcomeRoot, eq(outcomeRoot.id, learningOutcomes.derivedFromId))
        .innerJoin(curriculumNodes, eq(curriculumNodes.id, learningOutcomes.nodeId))
        .innerJoin(curricula, eq(curricula.id, curriculumNodes.curriculumId))
        .where(and(eq(curricula.subjectId, filter.subjectId), ...activeOutcomeConditions));
      idSets.push(new Set([...viaSubjects.map((r) => r.questionId), ...viaOutcomes.map((r) => r.questionId)]));
    }
    if (filter.outcomeId !== undefined || filter.nodeId !== undefined || filter.cognitiveLevel !== undefined) {
      const conditions = [];
      if (filter.outcomeId !== undefined) conditions.push(eq(questionLearningOutcomes.learningOutcomeId, filter.outcomeId));
      if (filter.nodeId !== undefined) conditions.push(eq(learningOutcomes.nodeId, filter.nodeId));
      if (filter.cognitiveLevel !== undefined) conditions.push(eq(questionLearningOutcomes.cognitiveLevel, filter.cognitiveLevel));
      const rows = filter.nodeId !== undefined
        ? await this.db.select({ questionId: questionLearningOutcomes.questionId })
          .from(questionLearningOutcomes)
          .innerJoin(learningOutcomes, eq(learningOutcomes.id, questionLearningOutcomes.learningOutcomeId))
          .leftJoin(outcomeRoot, eq(outcomeRoot.id, learningOutcomes.derivedFromId))
          .where(and(...conditions, ...activeOutcomeConditions))
        : await this.db.select({ questionId: questionLearningOutcomes.questionId })
          .from(questionLearningOutcomes).where(and(...conditions));
      idSets.push(new Set(rows.map((r) => r.questionId)));
    }
    let candidateIds: Set<string> | null = null;
    for (const set of idSets) {
      if (candidateIds === null) { candidateIds = set; continue; }
      const current: Set<string> = candidateIds;
      candidateIds = new Set([...current].filter((id) => set.has(id)));
    }
    if (candidateIds !== null && candidateIds.size === 0) return [];
    const conditions = [];
    if (candidateIds !== null) conditions.push(inArray(question.id, [...candidateIds]));
    if (filter.qtype !== undefined) conditions.push(eq(question.qtype, filter.qtype));
    if (filter.status !== undefined) conditions.push(eq(questionBankEntries.status, filter.status));
    const rows = await this.db.select({ q: question }).from(question)
      .innerJoin(questionBankEntries, eq(questionBankEntries.questionId, question.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(question.createdAt));
    return rows.map((r) => r.q);
  }
}

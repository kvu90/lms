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
export class QuestionsRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  async insertCategory(v: typeof questionCategories.$inferInsert): Promise<QCategoryRow> {
    const [row] = await this.db.insert(questionCategories).values(v).returning(); return row!;
  }
  async getCategory(id: number): Promise<QCategoryRow | undefined> {
    const [row] = await this.db.select().from(questionCategories).where(eq(questionCategories.id, id)); return row;
  }
  async listCategories(contextId?: number): Promise<QCategoryRow[]> {
    const rows = contextId !== undefined
      ? await this.db.select().from(questionCategories).where(eq(questionCategories.contextid, contextId))
      : await this.db.select().from(questionCategories);
    return rows.sort((a, b) => a.id - b.id);
  }

  async insertQuestion(v: typeof question.$inferInsert): Promise<QuestionRow> {
    const [row] = await this.db.insert(question).values(v).returning(); return row!;
  }
  async getQuestion(id: number): Promise<QuestionRow | undefined> {
    const [row] = await this.db.select().from(question).where(eq(question.id, id)); return row;
  }
  async updateQuestion(id: number, patch: Partial<QuestionRow>): Promise<void> {
    await this.db.update(question).set({ ...patch, timemodified: new Date() }).where(eq(question.id, id));
  }
  async listQuestionsInCategory(categoryId: number): Promise<QuestionRow[]> {
    return this.db.select().from(question).where(eq(question.category, categoryId)).orderBy(asc(question.id));
  }

  async insertEntry(v: typeof questionBankEntries.$inferInsert): Promise<EntryRow> {
    const [row] = await this.db.insert(questionBankEntries).values(v).returning(); return row!;
  }
  async getEntryByQuestion(questionId: number): Promise<EntryRow | undefined> {
    const [row] = await this.db.select().from(questionBankEntries).where(eq(questionBankEntries.questionid, questionId)); return row;
  }
  async updateEntry(id: number, patch: Partial<EntryRow>): Promise<void> {
    await this.db.update(questionBankEntries).set({ ...patch, timemodified: new Date() }).where(eq(questionBankEntries.id, id));
  }

  async insertVersion(v: typeof questionVersions.$inferInsert): Promise<VersionRow> {
    const [row] = await this.db.insert(questionVersions).values(v).returning(); return row!;
  }
  async getVersion(id: number): Promise<VersionRow | undefined> {
    const [row] = await this.db.select().from(questionVersions).where(eq(questionVersions.id, id)); return row;
  }
  async getVersionByNumber(entryId: number, version: number): Promise<VersionRow | undefined> {
    const [row] = await this.db.select().from(questionVersions)
      .where(and(eq(questionVersions.questionbankentryid, entryId), eq(questionVersions.version, version)));
    return row;
  }
  async listVersions(entryId: number): Promise<VersionRow[]> {
    return this.db.select().from(questionVersions).where(eq(questionVersions.questionbankentryid, entryId)).orderBy(asc(questionVersions.version));
  }

  async insertUsage(v: typeof questionUsages.$inferInsert): Promise<UsageRow> {
    const [row] = await this.db.insert(questionUsages).values(v).returning(); return row!;
  }
  async getUsage(id: number): Promise<UsageRow | undefined> {
    const [row] = await this.db.select().from(questionUsages).where(eq(questionUsages.id, id)); return row;
  }
  async insertAttempt(v: typeof questionAttempts.$inferInsert): Promise<AttemptRow> {
    const [row] = await this.db.insert(questionAttempts).values(v).returning(); return row!;
  }
  async getAttempt(id: number): Promise<AttemptRow | undefined> {
    const [row] = await this.db.select().from(questionAttempts).where(eq(questionAttempts.id, id)); return row;
  }
  async listAttempts(usageId: number): Promise<AttemptRow[]> {
    return this.db.select().from(questionAttempts).where(eq(questionAttempts.questionusageid, usageId)).orderBy(asc(questionAttempts.slot));
  }
  async updateAttempt(id: number, patch: Partial<AttemptRow>): Promise<void> {
    await this.db.update(questionAttempts).set({ ...patch, timemodified: new Date() }).where(eq(questionAttempts.id, id));
  }

  async insertStep(v: typeof questionAttemptSteps.$inferInsert, tx?: DbTx): Promise<StepRow> {
    const [row] = await (tx ?? this.db).insert(questionAttemptSteps).values(v).returning(); return row!;
  }
  async listSteps(attemptId: number): Promise<StepRow[]> {
    return this.db.select().from(questionAttemptSteps).where(eq(questionAttemptSteps.questionattemptid, attemptId)).orderBy(asc(questionAttemptSteps.sequencenumber));
  }
  async insertStepData(v: typeof questionAttemptStepData.$inferInsert, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).insert(questionAttemptStepData).values(v);
  }
  async listStepData(stepId: number): Promise<(typeof questionAttemptStepData.$inferSelect)[]> {
    return this.db.select().from(questionAttemptStepData).where(eq(questionAttemptStepData.attemptstepid, stepId));
  }
}

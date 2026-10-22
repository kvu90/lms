import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { analyticsModels, analyticsPredictions, insights } from '../../db/schema';

export type ModelRow = typeof analyticsModels.$inferSelect;
export type PredictionRow = typeof analyticsPredictions.$inferSelect;
export type InsightRow = typeof insights.$inferSelect;

/** Kho dữ liệu analytics_models / analytics_predictions / insights. */
@Injectable()
export class AnalyticsRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }
  async upsertModel(v: typeof analyticsModels.$inferInsert): Promise<ModelRow> {
    const [row] = await this.db.insert(analyticsModels).values(v)
      .onConflictDoUpdate({ target: analyticsModels.name, set: { target: v.target, indicators: v.indicators, enabled: v.enabled ?? true } })
      .returning();
    return row!;
  }
  async getModelByName(name: string): Promise<ModelRow | undefined> {
    const [row] = await this.db.select().from(analyticsModels).where(eq(analyticsModels.name, name)); return row;
  }
  async getModel(id: string): Promise<ModelRow | undefined> {
    const [row] = await this.db.select().from(analyticsModels).where(eq(analyticsModels.id, id)); return row;
  }
  async listModels(): Promise<ModelRow[]> { return this.db.select().from(analyticsModels); }
  async insertPrediction(v: typeof analyticsPredictions.$inferInsert): Promise<PredictionRow> {
    const [row] = await this.db.insert(analyticsPredictions).values(v).returning(); return row!;
  }
  async listPredictions(): Promise<PredictionRow[]> { return this.db.select().from(analyticsPredictions); }
  async insertInsight(v: typeof insights.$inferInsert): Promise<InsightRow> {
    const [row] = await this.db.insert(insights).values(v).returning(); return row!;
  }
  async listInsights(): Promise<InsightRow[]> { return this.db.select().from(insights); }
  async listInsightsForRecipient(recipientid: string): Promise<InsightRow[]> {
    return this.db.select().from(insights).where(eq(insights.recipientid, recipientid));
  }
}

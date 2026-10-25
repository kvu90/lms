import { Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CoursesService } from '../courses/courses.service';
import { EnrolService } from '../enrol/enrol.service';
import { AnalyticsRepository, type InsightRow, type ModelRow } from './analytics.repository';
import { gradeGrades, gradeItems, users } from '../../db/schema';

/** Một indicator đăng ký trong code: tính một tín hiệu cho (user, course). */
export interface AnalyticsIndicator {
  name: string;
  calculate(userId: string, courseId: string): Promise<number>;
}
/** Một model đăng ký: target + danh sách indicator. */
export interface AnalyticsModelProvider {
  name: string;
  target: string;
  indicators: string[];
}

/**
 * AnalyticsModule facade (Moodle core_analytics, §2#23).
 * Model/indicator là provider đăng ký trong code. Insight là SUY LUẬN —
 * chỉ hiển thị cho user có capability ở context liên quan, và dự đoán
 * KHÔNG BAO GIỜ tự thay đổi điểm/ghi danh.
 * Model thật tối giản: "students at risk" = không truy cập gần đây + điểm thấp.
 */
@Injectable()
export class AnalyticsService {
  private readonly indicators = new Map<string, AnalyticsIndicator>();
  private readonly modelProviders: AnalyticsModelProvider[] = [
    { name: 'students_at_risk', target: 'at_risk', indicators: ['no_recent_access', 'low_grade'] },
  ];

  constructor(
    private readonly repo: AnalyticsRepository,
    private readonly evaluator: PermissionEvaluator,
    private readonly courses: CoursesService,
    private readonly enrol: EnrolService,
  ) {
    this.registerBuiltinIndicators();
  }

  /** Đăng ký indicator — extension point của model. */
  registerIndicator(ind: AnalyticsIndicator): void { this.indicators.set(ind.name, ind); }
  listIndicators(): string[] { return [...this.indicators.keys()]; }
  listModelProviders(): AnalyticsModelProvider[] { return this.modelProviders; }

  private registerBuiltinIndicators(): void {
    const db = this.repo.dbHandle;
    // Indicator: không truy cập gần đây — 1 nếu lastLogin cũ hơn 14 ngày hoặc chưa từng đăng nhập.
    this.registerIndicator({
      name: 'no_recent_access',
      calculate: async (userId) => {
        const [u] = await db.select().from(users).where(eq(users.id, userId));
        if (!u || !u.lastLogin) return 1;
        return Date.now() - u.lastLogin.getTime() > 14 * 24 * 3600 * 1000 ? 1 : 0;
      },
    });
    // Indicator: điểm thấp — tỉ lệ (1 - trung bình phần trăm điểm) của user trong khoá.
    this.registerIndicator({
      name: 'low_grade',
      calculate: async (userId, courseId) => {
        const items = await db.select().from(gradeItems).where(eq(gradeItems.courseId, courseId));
        if (!items.length) return 0;
        const grades = await db.select().from(gradeGrades);
        const mine = grades.filter((g) => g.userId === userId && items.some((i) => i.id === g.itemId) && g.finalGrade !== null);
        if (!mine.length) return 0.5; // chưa có điểm: tín hiệu trung bình
        const pct = mine.reduce((sum, g) => {
          const item = items.find((i) => i.id === g.itemId)!;
          return sum + (item.gradeMax > 0 ? (g.finalGrade ?? 0) / item.gradeMax : 0);
        }, 0) / mine.length;
        return pct < 0.5 ? 1 - pct : 0;
      },
    });
  }

  /** Đồng bộ model providers từ code vào bảng analytics_models (idempotent). */
  async syncModels(): Promise<ModelRow[]> {
    const out: ModelRow[] = [];
    for (const p of this.modelProviders) out.push(await this.repo.upsertModel({ name: p.name, target: p.target, indicators: p.indicators, enabled: true }));
    return out;
  }
  async listModels(): Promise<ModelRow[]> { await this.syncModels(); return this.repo.listModels(); }
  async getModelByName(name: string): Promise<ModelRow> {
    await this.syncModels();
    const row = await this.repo.getModelByName(name);
    if (!row) throw new NotFoundException({ message: `Model ${name} not found`, code: 'analytics.model_not_found' });
    return row;
  }

  /**
   * Chạy model cho một khoá: với mỗi học viên active, tính score từ các
   * indicator; score ≥ 0.6 ⇒ tạo prediction + insight cho các teacher của khoá.
   * Hàm này CHỈ ghi analytics_predictions/insights — không chạm grades/enrol.
   */
  async runModel(actorId: string, modelName: string, courseId: string): Promise<{ predictions: number; insights: number }> {
    // H6 (#134): chạy mô hình là thao tác vận hành — đòi analytics:manage tại
    // context khoá cho NGƯỜI GỌI (evaluator duyệt cây context: holder tại
    // system qua được). Trước đây hàm không uỷ quyền người gọi chút nào.
    const ctxId = await this.courses.courseContextId(courseId);
    await this.evaluator.requireCapability(actorId, 'analytics:manage', ctxId);
    const model = await this.getModelByName(modelName);
    const providerDef = this.modelProviders.find((p) => p.name === modelName);
    if (!providerDef) throw new NotFoundException({ message: `Model provider ${modelName} not registered`, code: 'analytics.provider_not_found' });
    const db = this.repo.dbHandle;
    const enrolments = await this.enrol.listEnrolmentsForCourse(courseId);
    const activeUserIds = [...new Set(enrolments.filter((e) => e.status === 0).map((e) => e.userId))];
    // Recipients: mọi user (không suspended/deleted) có analytics:viewinsights ở course context.
    const recipients: string[] = [];
    const allUsers = await db.select().from(users);
    for (const u of allUsers) {
      if (u.suspended || u.deleted || u.isGuest) continue;
      if (await this.evaluator.hasCapability(u.id, 'analytics:viewinsights', ctxId)) recipients.push(u.id);
    }
    let predictions = 0; let insightCount = 0;
    for (const userId of activeUserIds) {
      // Học viên là người chỉ có vai trò student (viewinsights=false) — vẫn là subject.
      const values: Record<string, number> = {};
      let score = 0;
      for (const indName of providerDef.indicators) {
        const ind = this.indicators.get(indName);
        if (!ind) continue;
        const v = await ind.calculate(userId, courseId);
        values[indName] = v;
        score += v;
      }
      score = providerDef.indicators.length ? score / providerDef.indicators.length : 0;
      if (score < 0.6) continue;
      const prediction = await this.repo.insertPrediction({
        modelId: model.id, userId: userId, contextId: ctxId, courseId: courseId, score, data: values,
      });
      predictions++;
      for (const recipientId of recipients) {
        await this.repo.insertInsight({
          modelId: model.id, predictionId: prediction.id, userId: userId, recipientId,
          contextId: ctxId, courseId: courseId, heading: 'Student at risk', data: { score, indicators: values },
        });
        insightCount++;
      }
    }
    return { predictions, insights: insightCount };
  }

  /** Insight chỉ hiển thị cho recipient có capability viewinsights tại context của insight. */
  async listInsightsFor(userId: string): Promise<InsightRow[]> {
    const rows = await this.repo.listInsightsForRecipient(userId);
    const out: InsightRow[] = [];
    for (const row of rows) {
      if (await this.evaluator.hasCapability(userId, 'analytics:viewinsights', row.contextId)) out.push(row);
    }
    return out;
  }
  /**
   * Danh sách insight toàn cục (H4, #134): lọc theo ĐÚNG vị từ của
   * listInsightsFor — chỉ trả dòng mà người gọi có analytics:viewinsights tại
   * context của dòng (không kèm điều kiện recipient). User không có
   * viewinsights ở context nào (học viên thường) nhận danh sách rỗng, không
   * còn thấy insight dự báo của người khác.
   */
  async listAllInsights(actorId: string): Promise<InsightRow[]> {
    const rows = await this.repo.listInsights();
    const out: InsightRow[] = [];
    for (const row of rows) {
      if (await this.evaluator.hasCapability(actorId, 'analytics:viewinsights', row.contextId)) out.push(row);
    }
    return out;
  }
}

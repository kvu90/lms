/**
 * Repository của cụm ANALYTICS trên Kysely — chuyển đổi Drizzle →
 * Kysely thuộc nhóm G8 của chiến dịch chuyển tầng dữ liệu (issue
 * #648).
 *
 * Vai trò: mọi truy cập tới ba bảng analytics_models,
 * analytics_predictions và insights của kho trung tâm tập trung ở
 * đây. Repository không chứa luật nghiệp vụ — đồng bộ model
 * provider, tính điểm và gác quyền nằm ở tầng service phía ứng
 * dụng; repository chỉ nhận handle do tầng ứng dụng truyền vào.
 *
 * Khuôn hình dạng dữ liệu ở biên repository (theo khuôn pilot kho
 * control plane):
 * - Bên trong repository, truy vấn viết trên interface schema sinh
 *   bằng codegen: tên bảng/cột giữ nguyên snake_case của database.
 * - Bên ngoài, repository nhận/trả các hình dạng dòng camelCase như
 *   phía tiêu thụ đang dùng: cột được chọn bằng danh sách tường
 *   minh có bí danh (`model_id as modelId`), giá trị ghi được ánh
 *   xạ từng trường từ camelCase sang snake_case ở các hàm
 *   `*InsertValues` trong file này.
 * - Giá trị `undefined` bị LOẠI khỏi values trước khi gọi builder
 *   (luật T-4 của chiến dịch); mọi giá trị where là tham số bắt
 *   buộc, không bao giờ `undefined`.
 * - Cột jsonb (`indicators`, `data`) khi ghi đi qua `jsonbValue`:
 *   serialize tường minh + ép kiểu `::jsonb`, vì một MẢNG ở cấp cao
 *   nhất bị driver `pg` hiểu là mảng PostgreSQL thay vì JSON.
 * - Repository không import từ `apps/*`, không đọc ALS/ngữ cảnh
 *   ứng dụng, không tự mở pool, không đọc biến môi trường.
 */
import { sql, type InsertObject, type RawBuilder, type UpdateObject } from 'kysely';
import type { CentreDb, CentreTx, CentreDB } from '../client';
import type { JsonValue } from '../types/centre-db';

/** Handle đọc/ghi mà repository nhận: transaction đang mở hoặc chính instance gốc. */
export type AnalyticsDb = CentreDb | CentreTx;

/** Một dòng mô hình phân tích (target + indicators là provider đăng ký trong code). */
export interface ModelRow {
  id: string;
  name: string;
  target: string;
  /** Danh sách tên indicator của model (jsonb). */
  indicators: unknown;
  enabled: boolean;
  createdAt: Date;
}

/** Một dòng dự đoán của model cho một user trong một context — suy luận, không phải dữ kiện. */
export interface PredictionRow {
  id: string;
  modelId: string;
  userId: string;
  contextId: string;
  courseId: string | null;
  score: number;
  /** Hình dạng dữ kiện phụ của dự đoán (jsonb). */
  data: unknown | null;
  createdAt: Date;
}

/** Một dòng insight sinh cho user có capability ở context liên quan. */
export interface InsightRow {
  id: string;
  modelId: string;
  predictionId: string | null;
  userId: string;
  recipientId: string;
  contextId: string;
  courseId: string | null;
  heading: string;
  /** Hình dạng dữ kiện phụ của insight (jsonb). */
  data: unknown | null;
  createdAt: Date;
}

/** Dữ kiện ghi một dòng mô hình mới (hình dạng insert của bảng analytics_models). */
export interface NewModel {
  id?: string;
  name: string;
  target: string;
  indicators?: unknown;
  enabled?: boolean;
  createdAt?: Date;
}

/** Dữ kiện ghi một dòng dự đoán mới (hình dạng insert của bảng analytics_predictions). */
export interface NewPrediction {
  id?: string;
  modelId: string;
  userId: string;
  contextId: string;
  courseId?: string | null;
  score?: number;
  data?: unknown | null;
  createdAt?: Date;
}

/** Dữ kiện ghi một dòng insight mới (hình dạng insert của bảng insights). */
export interface NewInsight {
  id?: string;
  modelId: string;
  predictionId?: string | null;
  userId: string;
  recipientId: string;
  contextId: string;
  courseId?: string | null;
  heading?: string;
  data?: unknown | null;
  createdAt?: Date;
}

/**
 * Bọc một giá trị jsonb thành biểu thức tham số JSON tường minh
 * (serialize + `::jsonb`) — xem lý do ở phần đầu file.
 *
 * @param value - Giá trị nghiệp vụ sẽ nằm trong cột jsonb (hình
 *   dạng do phía gọi chịu trách nhiệm — các cột jsonb của cụm này
 *   không khai kiểu nghiệp vụ riêng ở schema).
 * @returns Biểu thức Kysely mang chuỗi JSON đã serialize.
 */
function jsonbValue(value: unknown): RawBuilder<JsonValue> {
  return sql<JsonValue>`${JSON.stringify(value)}::jsonb`;
}

/** Danh sách cột tường minh có bí danh camelCase cho bảng analytics_models (dùng cho cả select lẫn returning). */
const MODEL_COLUMNS = [
  'id',
  'name',
  'target',
  'indicators',
  'enabled',
  'created_at as createdAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng analytics_predictions. */
const PREDICTION_COLUMNS = [
  'id',
  'model_id as modelId',
  'user_id as userId',
  'context_id as contextId',
  'course_id as courseId',
  'score',
  'data',
  'created_at as createdAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng insights. */
const INSIGHT_COLUMNS = [
  'id',
  'model_id as modelId',
  'prediction_id as predictionId',
  'user_id as userId',
  'recipient_id as recipientId',
  'context_id as contextId',
  'course_id as courseId',
  'heading',
  'data',
  'created_at as createdAt',
] as const;

/** Ánh xạ dữ kiện ghi mô hình từ camelCase sang snake_case, loại `undefined` từng trường. */
function modelInsertValues(values: NewModel): InsertObject<CentreDB, 'analytics_models'> {
  const row: InsertObject<CentreDB, 'analytics_models'> = {
    name: values.name,
    target: values.target,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.indicators !== undefined) row.indicators = jsonbValue(values.indicators);
  if (values.enabled !== undefined) row.enabled = values.enabled;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  return row;
}

/** Ánh xạ dữ kiện ghi dự đoán từ camelCase sang snake_case, loại `undefined` từng trường. */
function predictionInsertValues(values: NewPrediction): InsertObject<CentreDB, 'analytics_predictions'> {
  const row: InsertObject<CentreDB, 'analytics_predictions'> = {
    model_id: values.modelId,
    user_id: values.userId,
    context_id: values.contextId,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.courseId !== undefined) row.course_id = values.courseId;
  if (values.score !== undefined) row.score = values.score;
  if (values.data !== undefined) row.data = jsonbValue(values.data);
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  return row;
}

/** Ánh xạ dữ kiện ghi insight từ camelCase sang snake_case, loại `undefined` từng trường. */
function insightInsertValues(values: NewInsight): InsertObject<CentreDB, 'insights'> {
  const row: InsertObject<CentreDB, 'insights'> = {
    model_id: values.modelId,
    user_id: values.userId,
    recipient_id: values.recipientId,
    context_id: values.contextId,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.predictionId !== undefined) row.prediction_id = values.predictionId;
  if (values.courseId !== undefined) row.course_id = values.courseId;
  if (values.heading !== undefined) row.heading = values.heading;
  if (values.data !== undefined) row.data = jsonbValue(values.data);
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  return row;
}

/** Kho dữ liệu analytics_models / analytics_predictions / insights. */
export class AnalyticsRepository {
  constructor(private readonly handle: CentreDb) {}

  /** Handle Kysely của kho trung tâm mà repository đang giữ (tầng service dùng cho các truy vấn đọc phụ trợ của module). */
  get dbHandle(): CentreDb {
    return this.handle;
  }

  /**
   * Ghi một mô hình, trùng tên thì cập nhật target/indicators/enabled
   * theo dữ kiện mới (upsert theo cột unique `name`).
   */
  async upsertModel(v: NewModel, db: AnalyticsDb = this.handle): Promise<ModelRow> {
    // Nhánh cập nhật khi trùng tên: target luôn lấy theo dữ kiện mới,
    // enabled mặc định true khi dữ kiện không nêu, indicators chỉ ghi
    // khi dữ kiện có mang (loại `undefined` tường minh theo luật T-4).
    const conflictSet: UpdateObject<CentreDB, 'analytics_models'> = {
      target: v.target,
      enabled: v.enabled ?? true,
    };
    if (v.indicators !== undefined) conflictSet.indicators = jsonbValue(v.indicators);
    const rows = await db
      .insertInto('analytics_models')
      .values(modelInsertValues(v))
      .onConflict((oc) => oc.column('name').doUpdateSet(conflictSet))
      .returning(MODEL_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Lấy mô hình theo tên duy nhất. */
  async getModelByName(name: string, db: AnalyticsDb = this.handle): Promise<ModelRow | undefined> {
    return db
      .selectFrom('analytics_models')
      .select(MODEL_COLUMNS)
      .where('name', '=', name)
      .executeTakeFirst();
  }

  /** Lấy mô hình theo id. */
  async getModel(id: string, db: AnalyticsDb = this.handle): Promise<ModelRow | undefined> {
    return db
      .selectFrom('analytics_models')
      .select(MODEL_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** Liệt kê mọi mô hình. */
  async listModels(db: AnalyticsDb = this.handle): Promise<ModelRow[]> {
    return db.selectFrom('analytics_models').select(MODEL_COLUMNS).execute();
  }

  /** Ghi một dự đoán mới, trả dòng vừa ghi. */
  async insertPrediction(v: NewPrediction, db: AnalyticsDb = this.handle): Promise<PredictionRow> {
    const rows = await db
      .insertInto('analytics_predictions')
      .values(predictionInsertValues(v))
      .returning(PREDICTION_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Liệt kê mọi dự đoán. */
  async listPredictions(db: AnalyticsDb = this.handle): Promise<PredictionRow[]> {
    return db.selectFrom('analytics_predictions').select(PREDICTION_COLUMNS).execute();
  }

  /** Ghi một insight mới, trả dòng vừa ghi. */
  async insertInsight(v: NewInsight, db: AnalyticsDb = this.handle): Promise<InsightRow> {
    const rows = await db
      .insertInto('insights')
      .values(insightInsertValues(v))
      .returning(INSIGHT_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Liệt kê mọi insight. */
  async listInsights(db: AnalyticsDb = this.handle): Promise<InsightRow[]> {
    return db.selectFrom('insights').select(INSIGHT_COLUMNS).execute();
  }

  /** Liệt kê insight theo người nhận. */
  async listInsightsForRecipient(recipientId: string, db: AnalyticsDb = this.handle): Promise<InsightRow[]> {
    return db
      .selectFrom('insights')
      .select(INSIGHT_COLUMNS)
      .where('recipient_id', '=', recipientId)
      .execute();
  }
}

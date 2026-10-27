import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { question, questionBankEntries } from '../../db/schema';
import { curricula, curriculumNodes, curriculumProgramRecords, learningOutcomes, questionLearningOutcomes, subjects } from '../../db/schema';
import { bookMappings, examMatrixCells } from '../../db/schema';

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
  /** Lấy yêu cầu cần đạt theo id. */
  async getOutcome(id: string): Promise<LearningOutcomeRow | undefined> {
    const [row] = await this.db.select().from(learningOutcomes).where(eq(learningOutcomes.id, id)); return row;
  }
  /**
   * Liệt kê yêu cầu cần đạt HIỆN HÀNH của một node — ĐIỂM LỌC DUY
   * NHẤT của trạng thái rút (đợt neo lại định danh, issue #161): mặc
   * định loại các dòng đã rút (`retired_at` khác NULL); mọi bề mặt
   * "chương trình hiện hành" (cây quản trị, bản đặc tả qua tầng
   * service, khung nạp vào khoá) đều kế thừa mặc định này. Chỉ đường
   * nội bộ cần thấy cả dòng đã rút (gác xoá node, importer) mới
   * truyền `includeRetired: true`. Tra cứu đích danh theo id
   * (getOutcome) KHÔNG lọc — id là địa chỉ lịch sử hợp lệ.
   */
  async listOutcomes(nodeId: string, opts?: { includeRetired?: boolean }): Promise<LearningOutcomeRow[]> {
    const conditions = [eq(learningOutcomes.nodeId, nodeId)];
    if (!opts?.includeRetired) conditions.push(isNull(learningOutcomes.retiredAt));
    return this.db.select().from(learningOutcomes).where(and(...conditions))
      .orderBy(asc(learningOutcomes.position), asc(learningOutcomes.createdAt));
  }
  /** Toàn bộ outcomes hiện hành của nhiều node (dựng cây của một chương trình); `includeRetired` như listOutcomes. */
  async listOutcomesForNodes(nodeIds: string[], opts?: { includeRetired?: boolean }): Promise<LearningOutcomeRow[]> {
    if (nodeIds.length === 0) return [];
    const conditions = [inArray(learningOutcomes.nodeId, nodeIds)];
    if (!opts?.includeRetired) conditions.push(isNull(learningOutcomes.retiredAt));
    return this.db.select().from(learningOutcomes).where(and(...conditions))
      .orderBy(asc(learningOutcomes.position), asc(learningOutcomes.createdAt));
  }
  /**
   * Toàn bộ dòng YCCĐ thuộc DIỆN DATASET QUẢN của một node — đường
   * đọc riêng của importer: `source_kind = 'program'` VÀ `source_ref`
   * khác NULL (dòng dataset luôn ghi kèm source_ref của bản ghi; dòng
   * program do admin tạo tay có source_ref NULL nên không thuộc diện
   * quản, importer không bao giờ đụng), GỒM CẢ dòng đã rút để thuật
   * toán diff ghép cặp phân hai tập hiện hành / đã rút. Dòng `derived`
   * không nằm trong diện này.
   */
  async listDatasetManagedOutcomes(nodeId: string): Promise<LearningOutcomeRow[]> {
    return this.db.select().from(learningOutcomes)
      .where(and(
        eq(learningOutcomes.nodeId, nodeId),
        eq(learningOutcomes.sourceKind, 'program'),
        sql`${learningOutcomes.sourceRef} is not null`,
      ))
      .orderBy(asc(learningOutcomes.position), asc(learningOutcomes.createdAt));
  }
  /**
   * Đếm liên kết đang trỏ vào từng YCCĐ trong một tập (gắn câu hỏi +
   * ánh xạ sách theo outcome) — số liệu importer ghi vào báo cáo thay
   * đổi cho các ca rút dòng/sửa chữ để người duyệt thấy ảnh hưởng.
   * Trả Map theo outcomeId; id không có liên kết nào thì vắng khỏi Map.
   */
  async countOutcomeLinks(outcomeIds: string[]): Promise<Map<string, { questions: number; bookMappings: number }>> {
    const out = new Map<string, { questions: number; bookMappings: number }>();
    if (outcomeIds.length === 0) return out;
    const linkRows = await this.db.select({
      outcomeId: questionLearningOutcomes.learningOutcomeId, n: sql<number>`count(*)::int`,
    }).from(questionLearningOutcomes)
      .where(inArray(questionLearningOutcomes.learningOutcomeId, outcomeIds))
      .groupBy(questionLearningOutcomes.learningOutcomeId);
    for (const row of linkRows) {
      out.set(row.outcomeId, { questions: row.n, bookMappings: 0 });
    }
    const mappingRows = await this.db.select({
      outcomeId: bookMappings.learningOutcomeId, n: sql<number>`count(*)::int`,
    }).from(bookMappings)
      .where(inArray(bookMappings.learningOutcomeId, outcomeIds))
      .groupBy(bookMappings.learningOutcomeId);
    for (const row of mappingRows) {
      if (row.outcomeId === null) continue;
      const entry = out.get(row.outcomeId) ?? { questions: 0, bookMappings: 0 };
      entry.bookMappings = row.n;
      out.set(row.outcomeId, entry);
    }
    return out;
  }
  /** Tổng số dòng YCCĐ đang ở trạng thái đã rút của một dataset (đọc từ sổ: node của các bản ghi thuộc dataset). */
  async countRetiredOutcomesForDataset(datasetKey: string): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(learningOutcomes)
      .innerJoin(curriculumProgramRecords, eq(curriculumProgramRecords.nodeId, learningOutcomes.nodeId))
      .where(and(
        eq(curriculumProgramRecords.datasetKey, datasetKey),
        eq(learningOutcomes.sourceKind, 'program'),
        sql`${learningOutcomes.sourceRef} is not null`,
        sql`${learningOutcomes.retiredAt} is not null`,
      ));
    return row?.n ?? 0;
  }
  /** Sửa yêu cầu cần đạt (đường nạp truyền tx để diff commit nguyên tử cùng node + dòng sổ). */
  async updateOutcome(id: string, v: Partial<typeof learningOutcomes.$inferInsert>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(learningOutcomes).set({ ...v, updatedAt: new Date() }).where(eq(learningOutcomes.id, id));
  }
  /**
   * Đếm các tham chiếu "cứng" đang trỏ vào một tập node + YCCĐ từ các
   * bề mặt khác (ánh xạ sách, ô ma trận đề, gắn câu hỏi): đây là các
   * FK đã đổi từ cascade sang restrict (GDPT-SEED) — bề mặt quản trị
   * xoá phải hỏi hàm này trước và từ chối bằng lỗi nghiệp vụ rõ ràng
   * thay vì để lỗi FK thô của Postgres lộ ra.
   */
  async countGuardedReferences(
    nodeIds: string[],
    outcomeIds: string[],
  ): Promise<{ bookMappings: number; examMatrixCells: number; questionOutcomes: number }> {
    let bookMappingsCount = 0;
    const mappingConditions = [
      ...(nodeIds.length > 0 ? [inArray(bookMappings.curriculumNodeId, nodeIds)] : []),
      ...(outcomeIds.length > 0 ? [inArray(bookMappings.learningOutcomeId, outcomeIds)] : []),
    ];
    if (mappingConditions.length > 0) {
      const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(bookMappings)
        .where(mappingConditions.length === 1 ? mappingConditions[0] : or(...mappingConditions));
      bookMappingsCount = row?.n ?? 0;
    }
    let examMatrixCellsCount = 0;
    let questionOutcomesCount = 0;
    // Ô ma trận neo NODE (issue #249 — không còn neo YCCĐ): đếm theo
    // tập node sắp xoá, độc lập với tập YCCĐ.
    if (nodeIds.length > 0) {
      const [cells] = await this.db.select({ n: sql<number>`count(*)::int` }).from(examMatrixCells)
        .where(inArray(examMatrixCells.curriculumNodeId, nodeIds));
      examMatrixCellsCount = cells?.n ?? 0;
    }
    if (outcomeIds.length > 0) {
      const [links] = await this.db.select({ n: sql<number>`count(*)::int` }).from(questionLearningOutcomes)
        .where(inArray(questionLearningOutcomes.learningOutcomeId, outcomeIds));
      questionOutcomesCount = links?.n ?? 0;
    }
    return { bookMappings: bookMappingsCount, examMatrixCells: examMatrixCellsCount, questionOutcomes: questionOutcomesCount };
  }
  /**
   * Tìm YCCĐ theo từ khoá trong nội dung (không phân biệt hoa thường),
   * kèm ngữ cảnh hiển thị (tên node, khối, môn + context của môn để
   * tầng service gác quyền đọc). Lọc cứng theo môn/khối khi caller
   * truyền; trần `limit` chặn ở SQL — tầng service còn lọc quyền theo
   * từng môn rồi mới cắt theo hạn mức của caller.
   */
  async searchOutcomes(input: { query: string; subjectId?: string; grade?: number; limit: number }): Promise<{
    outcome: LearningOutcomeRow;
    nodeTitle: string;
    grade: number;
    subjectId: string;
    subjectName: string;
    subjectContextId: string;
  }[]> {
    // Tìm kiếm là đường đọc "chương trình hiện hành": dòng đã rút
    // (retired_at khác NULL) không được xuất hiện — cùng luật với
    // listOutcomes, áp ngay tại truy vấn này vì nó không qua listOutcomes.
    // Cột content nay là jsonb (tài liệu Tiptap) nên không ILIKE trực
    // tiếp được: ép sang text để khớp trên văn bản trong tài liệu.
    // Khớp có thể chạm cả cú pháp JSON của tài liệu, nhưng từ khoá
    // tìm kiếm là văn bản YCCĐ nên kết quả thực tế vẫn là các dòng
    // chứa từ khoá đó; tầng service vẫn trả text canonical trích
    // từ tài liệu, không trả JSON thô.
    const conditions = [sql`${learningOutcomes.content}::text ILIKE ${`%${input.query}%`}`, isNull(learningOutcomes.retiredAt)];
    if (input.subjectId) conditions.push(eq(subjects.id, input.subjectId));
    if (input.grade !== undefined) conditions.push(eq(curricula.grade, input.grade));
    const rows = await this.db
      .select({
        outcome: learningOutcomes,
        nodeTitle: curriculumNodes.title,
        grade: curricula.grade,
        subjectId: subjects.id,
        subjectName: subjects.name,
        subjectContextId: subjects.contextId,
      })
      .from(learningOutcomes)
      .innerJoin(curriculumNodes, eq(learningOutcomes.nodeId, curriculumNodes.id))
      .innerJoin(curricula, eq(curriculumNodes.curriculumId, curricula.id))
      .innerJoin(subjects, eq(curricula.subjectId, subjects.id))
      .where(and(...conditions))
      .orderBy(asc(subjects.position), asc(curricula.grade), asc(curriculumNodes.position), asc(learningOutcomes.position))
      .limit(input.limit);
    return rows;
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

  /** Tổng số dòng sổ đăng ký — căn cứ xét "DB đã có dữ liệu chương trình chưa" cho đường restore dump khi seed. */
  async countProgramRecords(): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(curriculumProgramRecords);
    return row?.n ?? 0;
  }
  /** Tra một bản ghi đã nạp theo định danh ổn định (dataset, mã bản ghi). */
  async getProgramRecord(datasetKey: string, recordId: string): Promise<ProgramRecordRow | undefined> {
    const [row] = await this.db.select().from(curriculumProgramRecords)
      .where(and(eq(curriculumProgramRecords.datasetKey, datasetKey), eq(curriculumProgramRecords.recordId, recordId)));
    return row;
  }
  /** Tra dòng sổ theo node nội dung — phục vụ suy mã bản ghi (mã YCCĐ vị trí) cho một node thuộc dataset. */
  async getProgramRecordByNodeId(nodeId: string): Promise<ProgramRecordRow | undefined> {
    const [row] = await this.db.select().from(curriculumProgramRecords)
      .where(eq(curriculumProgramRecords.nodeId, nodeId));
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

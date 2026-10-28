import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database, DbTx } from '../../db/database';
import { examAttemptEvents, examAttemptRegradeItems, examAttemptRegrades, examAttempts, examMatrices, examMatrixCells, examMatrixContributions, examMatrixVersions, examPinFeedbacks, examPinOverrides, examPinVersionUpdates, examPins, examSlots, examVersions, exams } from '../../db/schema';

export type ExamPinRow = typeof examPins.$inferSelect;
export type ExamAttemptRow = typeof examAttempts.$inferSelect;
export type ExamPinOverrideRow = typeof examPinOverrides.$inferSelect;
export type ExamMatrixRow = typeof examMatrices.$inferSelect;
export type ExamMatrixVersionRow = typeof examMatrixVersions.$inferSelect;
export type ExamMatrixCellRow = typeof examMatrixCells.$inferSelect;
export type ExamMatrixContributionRow = typeof examMatrixContributions.$inferSelect;
export type ExamPinFeedbackRow = typeof examPinFeedbacks.$inferSelect;
export type ExamAttemptEventRow = typeof examAttemptEvents.$inferSelect;
export type ExamPinVersionUpdateRow = typeof examPinVersionUpdates.$inferSelect;
export type ExamAttemptRegradeRow = typeof examAttemptRegrades.$inferSelect;
export type ExamAttemptRegradeItemRow = typeof examAttemptRegradeItems.$inferSelect;

@Injectable()
/**
 * Kho dữ liệu của lần ghim đề (exam_pins) và các lượt làm: bản ghi pin
 * (instance của course module), các override/feedback của pin và các
 * lượt làm neo vào pin. Nội dung đề của lượt làm đọc thẳng từ
 * exam_slots của exam version đã ghim — kho này không giữ bản chụp
 * slots nào (feat #226). Điểm của câu trong lượt làm sống ở question
 * engine (question_attempts) — kho này chỉ giữ tầng tổ chức: pin nào
 * ghim đề nào, lượt làm nào gắn usage nào và tổng điểm đã chốt.
 */
export class QuizRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  /**
   * Chèn bản ghi lần ghim.
   */
  async insertPin(v: typeof examPins.$inferInsert, tx?: DbTx): Promise<ExamPinRow> {
    const [row] = await (tx ?? this.db).insert(examPins).values(v).returning(); return row!;
  }
  /**
   * Lấy lần ghim theo id.
   */
  async getPin(id: string): Promise<ExamPinRow | undefined> {
    const [row] = await this.db.select().from(examPins).where(eq(examPins.id, id)); return row;
  }
  /**
   * Các lần ghim trong một khoá học.
   */
  async listPinsInCourse(courseId: string): Promise<ExamPinRow[]> {
    return this.db.select().from(examPins).where(eq(examPins.courseId, courseId)).orderBy(asc(examPins.createdAt), asc(examPins.id));
  }
  /**
   * Cập nhật lần ghim.
   */
  async updatePin(id: string, patch: Partial<ExamPinRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(examPins).set({ ...patch, updatedAt: new Date() }).where(eq(examPins.id, id));
  }
  /**
   * Xoá lần ghim (attempts/overrides/feedbacks cascade theo khoá ngoại).
   */
  async deletePin(id: string): Promise<void> {
    await this.db.delete(examPins).where(eq(examPins.id, id));
  }

  /**
   * Chèn một lượt làm.
   */
  // --- tham chieu de da ghim (chi doc: dinh danh/noi dung de song o module exams) ---

  async getExam(id: string) {
    const [row] = await this.db.select().from(exams).where(eq(exams.id, id)).limit(1);
    return row;
  }

  async getExamVersion(id: string) {
    const [row] = await this.db.select().from(examVersions).where(eq(examVersions.id, id)).limit(1);
    return row;
  }

  /** Slots cua mot exam version theo thu tu position (nguon cau cua pin snapshot). */
  async listExamSlots(examVersionId: string) {
    return this.db.select().from(examSlots).where(eq(examSlots.examVersionId, examVersionId)).orderBy(asc(examSlots.position));
  }

  /** Mọi exam version của một đề theo số version tăng dần (nguồn xác định "bản mới nhất" của đề cho luồng cập nhật pin). */
  async listExamVersions(examId: string) {
    return this.db.select().from(examVersions).where(eq(examVersions.examId, examId)).orderBy(asc(examVersions.version));
  }

  async insertAttempt(v: typeof examAttempts.$inferInsert, tx?: DbTx): Promise<ExamAttemptRow> {
    const [row] = await (tx ?? this.db).insert(examAttempts).values(v).returning(); return row!;
  }
  /**
   * Lấy một lượt làm.
   */
  async getAttempt(id: string): Promise<ExamAttemptRow | undefined> {
    const [row] = await this.db.select().from(examAttempts).where(eq(examAttempts.id, id)); return row;
  }
  /**
   * Các lượt làm của một lần ghim (mọi học sinh), mới nhất theo số lượt.
   */
  async listAttempts(pinId: string): Promise<ExamAttemptRow[]> {
    return this.db.select().from(examAttempts).where(eq(examAttempts.pinId, pinId)).orderBy(asc(examAttempts.userId), asc(examAttempts.attemptNumber));
  }
  /**
   * Các lượt làm của một học sinh trong một lần ghim (kể cả preview khi `includePreview`).
   */
  async listAttemptsForUser(pinId: string, userId: string, includePreview = false): Promise<ExamAttemptRow[]> {
    const conds = includePreview
      ? and(eq(examAttempts.pinId, pinId), eq(examAttempts.userId, userId))
      : and(eq(examAttempts.pinId, pinId), eq(examAttempts.userId, userId), eq(examAttempts.preview, false));
    return this.db.select().from(examAttempts).where(conds).orderBy(asc(examAttempts.attemptNumber));
  }
  /**
   * Cập nhật một lượt làm.
   */
  async updateAttempt(id: string, patch: Partial<ExamAttemptRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(examAttempts).set({ ...patch, updatedAt: new Date() }).where(eq(examAttempts.id, id));
  }

  // --- overrides ---------------------------------------------------------------

  /**
   * Chèn một ghi đè cài đặt thi.
   */
  async insertOverride(v: typeof examPinOverrides.$inferInsert, tx?: DbTx): Promise<ExamPinOverrideRow> {
    const [row] = await (tx ?? this.db).insert(examPinOverrides).values(v).returning(); return row!;
  }
  /**
   * Lấy một ghi đè.
   */
  async getOverride(id: string): Promise<ExamPinOverrideRow | undefined> {
    const [row] = await this.db.select().from(examPinOverrides).where(eq(examPinOverrides.id, id)); return row;
  }
  /**
   * Mọi ghi đè của một lần ghim (theo nhóm và theo người dùng).
   */
  async listOverrides(pinId: string): Promise<ExamPinOverrideRow[]> {
    return this.db.select().from(examPinOverrides).where(eq(examPinOverrides.pinId, pinId)).orderBy(asc(examPinOverrides.createdAt), asc(examPinOverrides.id));
  }
  /**
   * Mốc đóng MUỘN NHẤT của cả đợt thi: max giữa time_close của lần
   * ghim và time_close của MỌI override đang tồn tại (null = có ít
   * nhất một tầng không đặt mốc đóng → đợt chưa đóng hẳn). Dùng cho
   * cửa sổ review "sau khi đóng" khi các ca thi lệch nhau vì
   * override — chống lộ đáp án cho ca sau (hồ sơ thi trực tuyến VN,
   * điểm 5.1.4).
   */
  async sessionLatestClose(pinId: string): Promise<{ hasUnbounded: boolean; latest: Date | null }> {
    const pinRows = await this.db.select({ timeClose: examPins.timeClose }).from(examPins).where(eq(examPins.id, pinId));
    const base = pinRows[0]?.timeClose ?? null;
    const overrides = await this.listOverrides(pinId);
    // Override có time_close null = kế thừa mốc của lần ghim (đã tính);
    // đợt chỉ "chưa đóng hẳn" khi chính lần ghim không có mốc đóng.
    const hasUnbounded = base === null;
    let latest = base;
    for (const o of overrides) {
      if (o.timeClose === null) continue;
      if (latest === null || o.timeClose > latest) latest = o.timeClose;
    }
    return { hasUnbounded, latest };
  }

  /**
   * Cập nhật một ghi đè.
   */
  async updateOverride(id: string, patch: Partial<ExamPinOverrideRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(examPinOverrides).set({ ...patch, updatedAt: new Date() }).where(eq(examPinOverrides.id, id));
  }
  /**
   * Xoá một ghi đè.
   */
  async deleteOverride(id: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(examPinOverrides).where(eq(examPinOverrides.id, id));
  }

  // --- ma trận đề (Chặng 3) -------------------------------------------------------

  /**
   * Chèn một ma trận.
   */
  async insertMatrix(v: typeof examMatrices.$inferInsert, tx?: DbTx): Promise<ExamMatrixRow> {
    const [row] = await (tx ?? this.db).insert(examMatrices).values(v).returning(); return row!;
  }
  /**
   * Lấy một ma trận.
   */
  async getMatrix(id: string, tx?: DbTx): Promise<ExamMatrixRow | undefined> {
    const [row] = await (tx ?? this.db).select().from(examMatrices).where(eq(examMatrices.id, id)); return row;
  }
  /**
   * Ma trận trong một bank theo chữ ký nội dung đã ghi (lát chống
   * trùng của issue #233): đường ghi dùng hàm này sau khi transaction
   * của mình chạm ràng buộc duy nhất (bank, chữ ký) để đọc lại bản
   * thắng cuộc và trả về thay vì lỗi.
   */
  async findMatrixByBankAndSignature(bankId: string, contentSignature: string): Promise<ExamMatrixRow | undefined> {
    const [row] = await this.db.select().from(examMatrices).where(and(
      eq(examMatrices.bankId, bankId),
      eq(examMatrices.contentSignature, contentSignature),
    )); return row;
  }
  /**
   * Các ma trận của một môn (mới nhất trước).
   */
  async listMatricesBySubject(subjectId: string): Promise<ExamMatrixRow[]> {
    return this.db.select().from(examMatrices).where(eq(examMatrices.subjectId, subjectId)).orderBy(asc(examMatrices.name));
  }
  /**
   * Cập nhật một ma trận.
   */
  async updateMatrix(id: string, patch: Partial<ExamMatrixRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(examMatrices).set({ ...patch, updatedAt: new Date() }).where(eq(examMatrices.id, id));
  }
  /**
   * Tăng bộ đếm số lượt một ma trận đã được copy đi (tín hiệu truy
   * vết copy — tăng nguyên tử ở tầng SQL như exams.copy_count).
   */
  async bumpMatrixCopyCount(id: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(examMatrices)
      .set({ copyCount: sql`${examMatrices.copyCount} + 1` })
      .where(eq(examMatrices.id, id));
  }
  /**
   * Các version đề đã sinh từ một ma trận (truy nguồn chiều ngược
   * ma trận → đề): mỗi hàng là một exam version mang matrix_id của
   * ma trận này, kèm định danh đề cha để hiển thị.
   */
  async listExamVersionsByMatrix(matrixId: string): Promise<{ examId: string; examVersionId: string; version: number; name: string; matrixVersion: number | null }[]> {
    const rows = await this.db.select({
      examId: examVersions.examId, examVersionId: examVersions.id,
      version: examVersions.version, name: examVersions.name, matrixVersion: examVersions.matrixVersion,
    }).from(examVersions).where(eq(examVersions.matrixId, matrixId))
      .orderBy(asc(examVersions.createdAt), asc(examVersions.id));
    return rows;
  }
  /**
   * Xoá một ma trận (ô cascade theo FK; quiz đã sinh giữ matrix_id = null theo FK set null).
   */
  async deleteMatrix(id: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(examMatrices).where(eq(examMatrices.id, id));
  }
  /**
   * Chèn một version bất biến của ma trận (hàng chụp cấu hình của
   * đúng một số version; ô của version gắn qua matrix_version_id).
   */
  async insertMatrixVersion(v: typeof examMatrixVersions.$inferInsert, tx?: DbTx): Promise<ExamMatrixVersionRow> {
    const [row] = await (tx ?? this.db).insert(examMatrixVersions).values(v).returning(); return row!;
  }
  /**
   * Hàng version bất biến theo (ma trận, số version) — căn cứ đọc lại
   * nội dung một version quá khứ nguyên vẹn.
   */
  async getMatrixVersionRow(matrixId: string, version: number, tx?: DbTx): Promise<ExamMatrixVersionRow | undefined> {
    const [row] = await (tx ?? this.db).select().from(examMatrixVersions)
      .where(and(eq(examMatrixVersions.matrixId, matrixId), eq(examMatrixVersions.version, version))); return row;
  }
  /**
   * Hàng version bất biến theo id (điểm neo từ exam_versions /
   * exam_dossiers.matrix_version_id).
   */
  async getMatrixVersionById(id: string): Promise<ExamMatrixVersionRow | undefined> {
    const [row] = await this.db.select().from(examMatrixVersions).where(eq(examMatrixVersions.id, id)); return row;
  }
  /**
   * Chèn một ô ma trận.
   */
  async insertMatrixCell(v: typeof examMatrixCells.$inferInsert, tx?: DbTx): Promise<ExamMatrixCellRow> {
    const [row] = await (tx ?? this.db).insert(examMatrixCells).values(v).returning(); return row!;
  }
  /**
   * Lấy một ô ma trận.
   */
  async getMatrixCell(id: string): Promise<ExamMatrixCellRow | undefined> {
    const [row] = await this.db.select().from(examMatrixCells).where(eq(examMatrixCells.id, id)); return row;
  }
  /**
   * Các ô của VERSION HIỆN HÀNH của một ma trận theo thứ tự hiển
   * thị: version hiện hành là hàng exam_matrix_versions có số version
   * bằng exam_matrices.version; ô đọc theo matrix_version_id của
   * hàng đó nên sửa version cũ không bao giờ lọt vào bề mặt hiện
   * hành. Ma trận chưa có hàng version (chỉ gặp ở dữ liệu dựng tay
   * ngoài các đường tạo của service) thì đọc theo matrix_id như
   * trước để không mất ô.
   */
  async listMatrixCells(matrixId: string, tx?: DbTx): Promise<ExamMatrixCellRow[]> {
    const db = tx ?? this.db;
    const [matrix] = await db.select().from(examMatrices).where(eq(examMatrices.id, matrixId));
    const versionRow = matrix ? await this.getMatrixVersionRow(matrixId, matrix.version, tx) : undefined;
    const where = versionRow
      ? eq(examMatrixCells.matrixVersionId, versionRow.id)
      : eq(examMatrixCells.matrixId, matrixId);
    return db.select().from(examMatrixCells).where(where).orderBy(asc(examMatrixCells.position), asc(examMatrixCells.id));
  }
  /**
   * Các ô của ĐÚNG một version bất biến (đọc lịch sử / dựng bản đặc
   * tả theo version đã neo) theo thứ tự hiển thị.
   */
  async listMatrixCellsByVersionId(matrixVersionId: string, tx?: DbTx): Promise<ExamMatrixCellRow[]> {
    return (tx ?? this.db).select().from(examMatrixCells)
      .where(eq(examMatrixCells.matrixVersionId, matrixVersionId))
      .orderBy(asc(examMatrixCells.position), asc(examMatrixCells.id));
  }
  /**
   * Cập nhật một ô ma trận.
   */
  async updateMatrixCell(id: string, patch: Partial<ExamMatrixCellRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(examMatrixCells).set({ ...patch, updatedAt: new Date() }).where(eq(examMatrixCells.id, id));
  }
  /**
   * Xoá một ô ma trận.
   */
  async deleteMatrixCell(id: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(examMatrixCells).where(eq(examMatrixCells.id, id));
  }

  // --- ngân hàng ma trận (MB-1, issue #111) ----------------------------------------

  /**
   * Các ma trận trong một bank ma trận (theo tên).
   */
  async listMatricesByBank(bankId: string): Promise<ExamMatrixRow[]> {
    return this.db.select().from(examMatrices).where(eq(examMatrices.bankId, bankId)).orderBy(asc(examMatrices.name), asc(examMatrices.id));
  }
  /**
   * Chèn một đề xuất đóng góp ma trận (hàng chờ duyệt).
   */
  async insertMatrixContribution(v: typeof examMatrixContributions.$inferInsert, tx?: DbTx): Promise<ExamMatrixContributionRow> {
    const [row] = await (tx ?? this.db).insert(examMatrixContributions).values(v).returning(); return row!;
  }
  /**
   * Lấy một đề xuất đóng góp ma trận.
   */
  async getMatrixContribution(id: string): Promise<ExamMatrixContributionRow | undefined> {
    const [row] = await this.db.select().from(examMatrixContributions).where(eq(examMatrixContributions.id, id)); return row;
  }
  /**
   * Hàng chờ đóng góp của một bank (lọc theo trạng thái nếu có; cũ nhất trước để duyệt theo thứ tự đến).
   */
  async listMatrixContributions(targetBankId: string, status?: string): Promise<ExamMatrixContributionRow[]> {
    const where = status
      ? and(eq(examMatrixContributions.targetBankId, targetBankId), eq(examMatrixContributions.status, status))
      : eq(examMatrixContributions.targetBankId, targetBankId);
    return this.db.select().from(examMatrixContributions).where(where).orderBy(asc(examMatrixContributions.createdAt), asc(examMatrixContributions.id));
  }
  /**
   * Hàng chờ đóng góp do một người gửi (mọi bank) — người gửi xem lại kết quả duyệt/lý do từ chối.
   */
  async listMatrixContributionsByProposer(proposerId: string): Promise<ExamMatrixContributionRow[]> {
    return this.db.select().from(examMatrixContributions).where(eq(examMatrixContributions.proposerId, proposerId)).orderBy(asc(examMatrixContributions.createdAt), asc(examMatrixContributions.id));
  }
  /**
   * Đề xuất đang chờ của cùng một ma trận vào cùng một bank (chống gửi trùng hàng chờ).
   */
  async findPendingMatrixContribution(matrixId: string, targetBankId: string, proposerId: string): Promise<ExamMatrixContributionRow | undefined> {
    const [row] = await this.db.select().from(examMatrixContributions).where(and(
      eq(examMatrixContributions.matrixId, matrixId),
      eq(examMatrixContributions.targetBankId, targetBankId),
      eq(examMatrixContributions.proposerId, proposerId),
      eq(examMatrixContributions.status, 'pending'),
    )); return row;
  }
  /**
   * Cập nhật một đề xuất đóng góp (kết quả duyệt).
   */
  async updateMatrixContribution(id: string, patch: Partial<ExamMatrixContributionRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(examMatrixContributions).set({ ...patch, updatedAt: new Date() }).where(eq(examMatrixContributions.id, id));
  }

  // --- dải nhận xét tổng quát + nhật ký sự kiện lượt làm -------------------------

  /** Các dải nhận xét tổng quát của một lần ghim theo mốc % tăng dần. */
  async listFeedbacks(pinId: string): Promise<ExamPinFeedbackRow[]> {
    return this.db.select().from(examPinFeedbacks).where(eq(examPinFeedbacks.pinId, pinId)).orderBy(asc(examPinFeedbacks.minPercent), asc(examPinFeedbacks.id));
  }

  /** Chèn một dải nhận xét tổng quát. */
  async insertFeedback(v: typeof examPinFeedbacks.$inferInsert, tx?: DbTx): Promise<ExamPinFeedbackRow> {
    const [row] = await (tx ?? this.db).insert(examPinFeedbacks).values(v).returning(); return row!;
  }

  /** Xoá một dải nhận xét tổng quát. */
  async deleteFeedback(id: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(examPinFeedbacks).where(eq(examPinFeedbacks.id, id));
  }

  /** Ghi một sự kiện giám sát của lượt làm (chỉ ghi nhận). */
  async getFeedback(id: string): Promise<ExamPinFeedbackRow | undefined> {
    const [row] = await this.db.select().from(examPinFeedbacks).where(eq(examPinFeedbacks.id, id)).limit(1);
    return row;
  }

  async insertAttemptEvent(v: typeof examAttemptEvents.$inferInsert, tx?: DbTx): Promise<ExamAttemptEventRow> {
    const [row] = await (tx ?? this.db).insert(examAttemptEvents).values(v).returning(); return row!;
  }

  /** Nhật ký sự kiện của một lượt làm theo thời gian ghi. */
  async listAttemptEvents(attemptId: string): Promise<ExamAttemptEventRow[]> {
    return this.db.select().from(examAttemptEvents).where(eq(examAttemptEvents.attemptId, attemptId)).orderBy(asc(examAttemptEvents.createdAt), asc(examAttemptEvents.id));
  }

  // --- cập nhật version của pin + chấm lại theo đáp án (issue #254) --------------

  /** Ghi vết một lần áp cập nhật exam version đã ghim (ai, khi nào, từ version nào lên version nào). */
  async insertPinVersionUpdate(v: typeof examPinVersionUpdates.$inferInsert, tx?: DbTx): Promise<ExamPinVersionUpdateRow> {
    const [row] = await (tx ?? this.db).insert(examPinVersionUpdates).values(v).returning(); return row!;
  }

  /** Các lần cập nhật exam version của một pin theo thời gian (vết truy vết cho giáo viên/quản trị). */
  async listPinVersionUpdates(pinId: string): Promise<ExamPinVersionUpdateRow[]> {
    return this.db.select().from(examPinVersionUpdates).where(eq(examPinVersionUpdates.pinId, pinId)).orderBy(asc(examPinVersionUpdates.createdAt), asc(examPinVersionUpdates.id));
  }

  /** Ghi một lần chấm lại theo đáp án đã áp thật (dry-run không ghi). */
  async insertRegrade(v: typeof examAttemptRegrades.$inferInsert, tx?: DbTx): Promise<ExamAttemptRegradeRow> {
    const [row] = await (tx ?? this.db).insert(examAttemptRegrades).values(v).returning(); return row!;
  }

  /** Ghi điểm đổi của một lượt trong một lần chấm lại. */
  async insertRegradeItem(v: typeof examAttemptRegradeItems.$inferInsert, tx?: DbTx): Promise<ExamAttemptRegradeItemRow> {
    const [row] = await (tx ?? this.db).insert(examAttemptRegradeItems).values(v).returning(); return row!;
  }

  /** Nhật ký chấm lại theo đáp án của một pin theo thời gian (cũ nhất trước). */
  async listRegrades(pinId: string): Promise<ExamAttemptRegradeRow[]> {
    return this.db.select().from(examAttemptRegrades).where(eq(examAttemptRegrades.pinId, pinId)).orderBy(asc(examAttemptRegrades.createdAt), asc(examAttemptRegrades.id));
  }

  /** Các mục điểm đổi của một lần chấm lại. */
  async listRegradeItems(regradeId: string): Promise<ExamAttemptRegradeItemRow[]> {
    return this.db.select().from(examAttemptRegradeItems).where(eq(examAttemptRegradeItems.regradeId, regradeId)).orderBy(asc(examAttemptRegradeItems.createdAt), asc(examAttemptRegradeItems.id));
  }

  /** Các mục điểm đổi của chính một học sinh trong một pin (nguồn cho bề mặt lịch sử sửa điểm của học sinh). */
  async listRegradeItemsForUser(pinId: string, userId: string): Promise<{ regrade: ExamAttemptRegradeRow; item: ExamAttemptRegradeItemRow }[]> {
    const rows = await this.db.select({ regrade: examAttemptRegrades, item: examAttemptRegradeItems })
      .from(examAttemptRegradeItems)
      .innerJoin(examAttemptRegrades, eq(examAttemptRegradeItems.regradeId, examAttemptRegrades.id))
      .where(and(eq(examAttemptRegrades.pinId, pinId), eq(examAttemptRegradeItems.userId, userId)))
      .orderBy(asc(examAttemptRegrades.createdAt), asc(examAttemptRegradeItems.id));
    return rows;
  }
}

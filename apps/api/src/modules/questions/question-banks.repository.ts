import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database, DbTx } from '../../db/database';
import {
  course, learningOutcomes, question, questionAttempts, questionBankContributions, questionBankEntries, questionBanks, questionCategories,
  examPins, examSlots, examVersions, role, roleAssignments, users,
} from '../../db/schema';

export type QuestionBankRow = typeof questionBanks.$inferSelect;
export type ContributionRow = typeof questionBankContributions.$inferSelect;
export type BankCategoryRow = typeof questionCategories.$inferSelect;

/** Loại món của bank (bank_kind) — 'question' là mặc định của mọi luồng QB hiện hữu. */
export const BANK_KINDS = ['question', 'exam', 'matrix'] as const;
export type BankKind = typeof BANK_KINDS[number];

@Injectable()
/**
 * Kho dữ liệu lớp BANK của feat Ngân hàng câu hỏi chung (issue #70):
 * bank, category thuộc bank, đề xuất đóng góp, và các tra cứu tín hiệu
 * (use_count từ quiz_slots, đội ngũ giáo viên cho bank trường, tên hiển
 * thị người dùng cho dòng ghi công).
 */
export class QuestionBanksRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  // --- banks -------------------------------------------------------------------

  /** Chèn bank mới (id do service cấp trước để dựng context trỏ về bank). */
  async insertBank(v: typeof questionBanks.$inferInsert, tx?: DbTx): Promise<QuestionBankRow> {
    const db = tx ?? this.db;
    const [row] = await db.insert(questionBanks).values(v).returning(); return row!;
  }
  /** Bank theo id. */
  async getBank(id: string): Promise<QuestionBankRow | undefined> {
    const [row] = await this.db.select().from(questionBanks).where(eq(questionBanks.id, id)); return row;
  }
  /** Mọi bank (danh sách nhỏ — tầng service lọc theo quyền của từng actor). */
  async listBanks(): Promise<QuestionBankRow[]> {
    return this.db.select().from(questionBanks).orderBy(asc(questionBanks.createdAt), asc(questionBanks.id));
  }
  /** Bank cá nhân của một chủ sở hữu cho một loại món (duy nhất theo ràng buộc partial unique (owner, kind)). */
  async getPersonalBank(ownerId: string, kind: BankKind = 'question'): Promise<QuestionBankRow | undefined> {
    const [row] = await this.db.select().from(questionBanks)
      .where(and(eq(questionBanks.scope, 'personal'), eq(questionBanks.ownerId, ownerId), eq(questionBanks.bankKind, kind)));
    return row;
  }
  /** Bank trường duy nhất của MỘT tenant cho một loại món (TENANT-0, #168). */
  async getSchoolBank(tenantId: string, kind: BankKind = 'question'): Promise<QuestionBankRow | undefined> {
    const [row] = await this.db.select().from(questionBanks)
      .where(and(eq(questionBanks.scope, 'school'), eq(questionBanks.tenantId, tenantId), eq(questionBanks.bankKind, kind)));
    return row;
  }
  /** Bank platform (Ngân hàng hệ thống) duy nhất cho một loại món — tenant_id NULL. */
  async getPlatformBank(kind: BankKind = 'question'): Promise<QuestionBankRow | undefined> {
    const [row] = await this.db.select().from(questionBanks)
      .where(and(eq(questionBanks.scope, 'platform'), eq(questionBanks.bankKind, kind)));
    return row;
  }
  /** Tenant sở hữu một khoá học (điểm neo tenant cho bank khoá / đề / ma trận). */
  async getCourseTenantId(courseId: string): Promise<string | undefined> {
    const [row] = await this.db.select({ tenantId: course.tenantId }).from(course).where(eq(course.id, courseId));
    return row?.tenantId;
  }
  /** Bank theo (scope, scope_ref_id, kind) — bank tổ theo cohort, bank khoá theo course. */
  async getBankByScopeRef(scope: string, scopeRefId: string, kind: BankKind = 'question'): Promise<QuestionBankRow | undefined> {
    const [row] = await this.db.select().from(questionBanks)
      .where(and(eq(questionBanks.scope, scope), eq(questionBanks.scopeRefId, scopeRefId), eq(questionBanks.bankKind, kind)));
    return row;
  }

  // --- danh mục & câu hỏi của một bank -----------------------------------------

  /** Category thuộc bank (bank_id tường minh), thứ tự tạo. */
  async listCategoriesOfBank(bankId: string): Promise<BankCategoryRow[]> {
    const rows = await this.db.select().from(questionCategories).where(eq(questionCategories.bankId, bankId));
    return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  }
  /** Mọi câu hỏi nằm trong các category cho trước, kèm entry (trạng thái + latestVersion). */
  async listQuestionsWithEntryInCategories(categoryIds: string[]): Promise<{ q: typeof question.$inferSelect; entry: typeof questionBankEntries.$inferSelect }[]> {
    if (categoryIds.length === 0) return [];
    const rows = await this.db.select({ q: question, entry: questionBankEntries }).from(question)
      .innerJoin(questionBankEntries, eq(questionBankEntries.questionId, question.id))
      .where(inArray(question.category, categoryIds))
      .orderBy(asc(question.createdAt), asc(question.id));
    return rows;
  }

  // --- signals -------------------------------------------------------------------

  /** Số slot đề đang tham chiếu từng câu hỏi (use_count — tín hiệu QB-4; slot nay nằm trên exam version). */
  async countSlotsByQuestionIds(questionIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (questionIds.length === 0) return out;
    const rows = await this.db.select({ questionId: examSlots.questionId, n: sql<number>`count(*)::int` })
      .from(examSlots)
      .where(inArray(examSlots.questionId, questionIds))
      .groupBy(examSlots.questionId);
    for (const r of rows) if (r.questionId) out.set(r.questionId, Number(r.n));
    return out;
  }
  /**
   * Các version đề ĐANG CHỨA một câu hỏi (truy nguồn chiều ngược
   * câu → đề): mỗi hàng là một exam version có slot trỏ tới câu —
   * một đề có nhiều version chứa câu thì có nhiều hàng, để người
   * soạn thấy đúng các bản đề bị ảnh hưởng khi sửa/rút câu.
   */
  async listContainingExams(questionId: string): Promise<{ examId: string; examVersionId: string; version: number; name: string }[]> {
    return this.db.select({
      examId: examVersions.examId, examVersionId: examVersions.id,
      version: examVersions.version, name: examVersions.name,
    }).from(examSlots)
      .innerJoin(examVersions, eq(examSlots.examVersionId, examVersions.id))
      .where(eq(examSlots.questionId, questionId))
      .orderBy(asc(examVersions.createdAt), asc(examVersions.id));
  }
  /** Các LẦN GHIM đang dùng một câu hỏi (distinct, qua exam version của pin) — phục vụ rút câu + cấm xoá vật lý. */
  async listPinIdsUsingQuestion(questionId: string): Promise<string[]> {
    const rows = await this.db.selectDistinct({ pinId: examPins.id }).from(examSlots)
      .innerJoin(examVersions, eq(examVersions.id, examSlots.examVersionId))
      .innerJoin(examPins, eq(examPins.examVersionId, examVersions.id))
      .where(eq(examSlots.questionId, questionId));
    return rows.map((r) => r.pinId);
  }
  /** Số question attempt đã tồn tại cho một câu hỏi (cấm xoá vật lý khi > 0). */
  async countAttemptsOfQuestion(questionId: string): Promise<number> {
    const rows = await this.db.select({ n: sql<number>`count(*)::int` })
      .from(questionAttempts)
      .where(eq(questionAttempts.questionId, questionId));
    return Number(rows[0]?.n ?? 0);
  }

  // --- people ----------------------------------------------------------------------

  /** Tên hiển thị của người dùng (cho dòng ghi công + bộ lọc tác giả). */
  async getUserDisplayNames(userIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ids = [...new Set(userIds.filter(Boolean))];
    if (ids.length === 0) return out;
    const rows = await this.db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, username: users.username })
      .from(users).where(inArray(users.id, ids));
    for (const r of rows) {
      const name = `${r.firstName} ${r.lastName}`.trim();
      out.set(r.id, name || r.username);
    }
    return out;
  }
  /**
   * Id mọi người dùng đang giữ ít nhất một role thuộc nhóm archetype cho
   * trước ở bất kỳ context nào — đội ngũ giáo viên cho bank trường.
   */
  async listUserIdsWithArchetypes(archetypes: string[]): Promise<string[]> {
    const rows = await this.db.selectDistinct({ userId: roleAssignments.userId })
      .from(roleAssignments)
      .innerJoin(role, eq(role.id, roleAssignments.roleId))
      .where(inArray(role.archetype, archetypes));
    return rows.map((r) => r.userId);
  }

  /** Mọi YCCĐ thuộc một node chương trình và các node con cháu của nó (CTE đệ quy trên cây node) — phục vụ lọc khám phá theo node (QB-4). */
  async listOutcomeIdsForNode(nodeId: string): Promise<string[]> {
    const result = await this.db.execute(sql`
      WITH RECURSIVE tree AS (
        SELECT id FROM curriculum_nodes WHERE id = ${nodeId}
        UNION ALL
        SELECT n.id FROM curriculum_nodes n JOIN tree t ON n.parent_id = t.id
      )
      SELECT id FROM learning_outcomes WHERE node_id IN (SELECT id FROM tree)
    `);
    return (result as unknown as { rows: { id: string }[] }).rows.map((r) => r.id);
  }
  /** Kiểm chứng nhanh một node chương trình có tồn tại (lọc khám phá theo node). */
  async outcomeIdsOfNode(nodeId: string): Promise<string[]> {
    const rows = await this.db.select({ id: learningOutcomes.id }).from(learningOutcomes)
      .where(eq(learningOutcomes.nodeId, nodeId));
    return rows.map((r) => r.id);
  }

  // --- contributions -----------------------------------------------------------------

  /** Chèn đề xuất đóng góp. */
  async insertContribution(v: typeof questionBankContributions.$inferInsert): Promise<ContributionRow> {
    const [row] = await this.db.insert(questionBankContributions).values(v).returning(); return row!;
  }
  /** Đề xuất theo id. */
  async getContribution(id: string): Promise<ContributionRow | undefined> {
    const [row] = await this.db.select().from(questionBankContributions).where(eq(questionBankContributions.id, id)); return row;
  }
  /** Đề xuất thuộc một bank đích, lọc tuỳ chọn theo trạng thái/người đề xuất. */
  async listContributions(filter: { targetBankId: string; status?: string; proposerId?: string }): Promise<ContributionRow[]> {
    const conditions = [eq(questionBankContributions.targetBankId, filter.targetBankId)];
    if (filter.status !== undefined) conditions.push(eq(questionBankContributions.status, filter.status));
    if (filter.proposerId !== undefined) conditions.push(eq(questionBankContributions.proposerId, filter.proposerId));
    return this.db.select().from(questionBankContributions)
      .where(and(...conditions))
      .orderBy(asc(questionBankContributions.createdAt), asc(questionBankContributions.id));
  }
  /** Cập nhật đề xuất (duyệt/từ chối). */
  async updateContribution(id: string, patch: Partial<ContributionRow>): Promise<void> {
    await this.db.update(questionBankContributions).set({ ...patch, updatedAt: new Date() })
      .where(eq(questionBankContributions.id, id));
  }

  // --- misc ---------------------------------------------------------------------------

  /** Xoá vật lý một câu hỏi — FK cascade dọn entry/version/answers/options/links (chỉ gọi sau khi qua guard slot/attempt). */
  async deleteQuestionRow(questionId: string): Promise<void> {
    await this.db.delete(question).where(eq(question.id, questionId));
  }
  /** Cập nhật entry (trạng thái rút câu QB-3). */
  async updateEntry(id: string, patch: Partial<typeof questionBankEntries.$inferSelect>): Promise<void> {
    await this.db.update(questionBankEntries).set({ ...patch, updatedAt: new Date() })
      .where(eq(questionBankEntries.id, id));
  }
}

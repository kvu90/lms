/**
 * Repository phía trung tâm của kho ngân hàng hệ thống (issue #585):
 * các bảng vệ tinh nằm trong kho nghiệp vụ của trung tâm — bản ghi
 * nhập bản chụp, vết nhận sự kiện, bản cài gói YCCĐ — cộng các tra
 * cứu cần cho đường nhập (slug trung tâm, sự tồn tại của YCCĐ).
 *
 * Mọi truy vấn chạy qua handle nghiệp vụ đã định tuyến
 * (`@InjectDrizzle()` = `SpaceDatabaseService.routedDatabase`): trong
 * ngữ cảnh request của trung tâm, handle này trỏ đúng kho của trung
 * tâm đó (kho chung hoặc kho riêng sau di trú), nên service nhập
 * không tự chọn kho.
 */
import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, desc, eq } from 'drizzle-orm';
import {
  curricula,
  curriculumNodes,
  learningOutcomes,
  outcomePackageInstalls,
  subjects,
  systemBankEventReceipts,
  systemQuestionImports,
  tenants,
  type OutcomePackageInstallRow,
  type SystemBankEventReceiptRow,
  type SystemQuestionImportRow,
} from '@lms/db';
import type { Database, DbTx } from '../../db/database';

@Injectable()
export class SystemBankCentreRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** Slug của tenant theo id (null khi không có) — dùng suy slug trung tâm cho dòng importer khi request không mang slug kho riêng. */
  async resolveTenantSlug(tenantId: string): Promise<string | null> {
    const rows = await this.db.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    return rows[0]?.slug ?? null;
  }

  /** YCCĐ có tồn tại trong bản cài cục bộ của trung tâm không (theo id đã giữ nguyên qua bản cài gói). */
  async outcomeExists(outcomeId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: learningOutcomes.id })
      .from(learningOutcomes)
      .where(eq(learningOutcomes.id, outcomeId))
      .limit(1);
    return rows.length > 0;
  }

  /** Ghi dòng nhập bản chụp (một dòng cho mỗi câu trung tâm — PK chính là id câu trung tâm). */
  async insertImportRow(
    input: {
      questionId: string;
      sourceQuestionId: string;
      sourceVersionId: string;
      sourceVersionNumber: number;
      packageChecksum: string;
      importedVersionNumber: number;
      importedBy: string | null;
      kind: 'pristine' | 'derived';
    },
    tx?: DbTx,
  ): Promise<SystemQuestionImportRow> {
    const handle = (tx ?? this.db) as Database;
    const [row] = await handle
      .insert(systemQuestionImports)
      .values({
        questionId: input.questionId,
        sourceQuestionId: input.sourceQuestionId,
        sourceVersionId: input.sourceVersionId,
        sourceVersionNumber: input.sourceVersionNumber,
        packageChecksum: input.packageChecksum,
        importedVersionNumber: input.importedVersionNumber,
        importedBy: input.importedBy,
        kind: input.kind,
      })
      .returning();
    if (!row) throw new Error('system bank: failed to insert question import row');
    return row;
  }

  /** Đọc dòng nhập bản chụp của một câu trung tâm (null khi câu không phải bản nhập). */
  async getImportRow(questionId: string, tx?: DbTx): Promise<SystemQuestionImportRow | null> {
    const handle = (tx ?? this.db) as Database;
    const rows = await handle
      .select()
      .from(systemQuestionImports)
      .where(eq(systemQuestionImports.questionId, questionId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Chuyển một bản nhập nguyên trạng thành bản phái sinh (khi câu
   * trung tâm bị sửa): chỉ đổi cờ `kind`, không chạm các trường truy
   * vết khác — phiên bản nguyên trạng vẫn đọc lại được theo
   * `importedVersionNumber`.
   */
  async flipImportToDerived(questionId: string, tx?: DbTx): Promise<void> {
    const handle = (tx ?? this.db) as Database;
    await handle
      .update(systemQuestionImports)
      .set({ kind: 'derived' })
      .where(
        and(
          eq(systemQuestionImports.questionId, questionId),
          eq(systemQuestionImports.kind, 'pristine'),
        ),
      );
  }

  /** Ghi vết đã nhận một sự kiện kho ngân hàng (idempotent theo cặp sự kiện + slug trung tâm). */
  async insertEventReceipt(input: {
    eventId: string;
    centreSlug: string;
  }): Promise<SystemBankEventReceiptRow> {
    const [row] = await this.db
      .insert(systemBankEventReceipts)
      .values({ eventId: input.eventId, centreSlug: input.centreSlug })
      .onConflictDoNothing({
        target: [systemBankEventReceipts.eventId, systemBankEventReceipts.centreSlug],
      })
      .returning();
    if (row) return row;
    const existing = await this.db
      .select()
      .from(systemBankEventReceipts)
      .where(
        and(
          eq(systemBankEventReceipts.eventId, input.eventId),
          eq(systemBankEventReceipts.centreSlug, input.centreSlug),
        ),
      )
      .limit(1);
    if (!existing[0]) throw new Error('system bank: failed to record event receipt');
    return existing[0];
  }

  /** Đọc bản cài gói YCCĐ mới nhất của trung tâm (null khi chưa cài gói nào) — dùng suy phiên bản trước khi ghi vết cài mới. */
  async getOutcomePackageInstall(): Promise<OutcomePackageInstallRow | null> {
    const rows = await this.db
      .select()
      .from(outcomePackageInstalls)
      .orderBy(desc(outcomePackageInstalls.installedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Môn học của trung tâm theo slug duy nhất (null khi chưa có). */
  async findSubjectBySlug(slug: string): Promise<typeof subjects.$inferSelect | null> {
    const rows = await this.db.select().from(subjects).where(eq(subjects.slug, slug)).limit(1);
    return rows[0] ?? null;
  }

  /** Chương trình của trung tâm theo cặp (môn, khối) — dùng phát hiện xung đột id trước khi cài. */
  async findCurriculumBySubjectGrade(subjectId: string, grade: number): Promise<typeof curricula.$inferSelect | null> {
    const rows = await this.db
      .select()
      .from(curricula)
      .where(and(eq(curricula.subjectId, subjectId), eq(curricula.grade, grade)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Upsert một chương trình theo id giữ nguyên (bản cài gói). */
  async upsertCurriculum(input: { id: string; subjectId: string; grade: number }): Promise<void> {
    await this.db
      .insert(curricula)
      .values(input)
      .onConflictDoUpdate({
        target: curricula.id,
        set: { subjectId: input.subjectId, grade: input.grade },
      });
  }

  /** Upsert một node cây chương trình theo id giữ nguyên (gọi theo thứ tự cha trước). */
  async upsertCurriculumNode(input: {
    id: string;
    curriculumId: string;
    parentId: string | null;
    title: string;
    kind: string;
    position: number;
    durationPeriods: number | null;
    durationPercent: number | null;
  }): Promise<void> {
    await this.db
      .insert(curriculumNodes)
      .values(input)
      .onConflictDoUpdate({
        target: curriculumNodes.id,
        set: {
          curriculumId: input.curriculumId,
          parentId: input.parentId,
          title: input.title,
          kind: input.kind,
          position: input.position,
          durationPeriods: input.durationPeriods,
          durationPercent: input.durationPercent,
        },
      });
  }

  /**
   * Upsert một YCCĐ theo id giữ nguyên (bản cài gói): cập nhật nội dung
   * tại chỗ — các gắn chuẩn cũ trỏ theo id nên không bị sửa ngược.
   * `tenantId` không nằm trong gói và không được chạm: dòng cài luôn
   * là YCCĐ chuẩn platform (tenantId NULL); dòng derived của trung tâm
   * có id khác nên không bao giờ va vào upsert này.
   */
  async upsertLearningOutcome(input: {
    id: string;
    nodeId: string;
    position: number;
    content: unknown;
    sourceKind: string;
    sourceRef: string | null;
  }): Promise<void> {
    await this.db
      .insert(learningOutcomes)
      .values({ ...input, content: input.content as never })
      .onConflictDoUpdate({
        target: learningOutcomes.id,
        set: {
          nodeId: input.nodeId,
          position: input.position,
          content: input.content as never,
          sourceKind: input.sourceKind,
          sourceRef: input.sourceRef,
        },
      });
  }

  /** Ghi nhận một lần cài gói (upsert theo phiên bản gói — cài lại cùng phiên bản chỉ làm mới vết). */
  async recordOutcomePackageInstall(input: {
    packageVersion: string;
    previousVersion: string | null;
    scope: string;
    installedBy: string | null;
  }): Promise<OutcomePackageInstallRow> {
    const [row] = await this.db
      .insert(outcomePackageInstalls)
      .values(input)
      .onConflictDoUpdate({
        target: outcomePackageInstalls.packageVersion,
        set: {
          previousVersion: input.previousVersion,
          scope: input.scope,
          installedBy: input.installedBy,
          installedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new Error('system bank: failed to record outcome package install');
    return row;
  }
}

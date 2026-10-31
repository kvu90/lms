/**
 * Repository của kho ngân hàng hệ thống (issue #585): mọi truy vấn
 * đọc/ghi trên database kho ngân hàng, qua đúng một kết nối
 * `SystemBankConnection` của tiến trình.
 *
 * Chưa cấu hình (`SYSTEM_BANK_DATABASE_URL` vắng) thì mọi thao tác
 * ném `system_bank.not_configured` (503) — ứng dụng vẫn khởi động,
 * chỉ các đường dẫn kho ngân hàng mới báo chưa cấu hình.
 */
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  systemBankEvents,
  systemOutcomePackageCurricula,
  systemOutcomePackageMappings,
  systemOutcomePackageNodes,
  systemOutcomePackageOutcomes,
  systemOutcomePackages,
  systemQuestionImporters,
  systemQuestionVersionOutcomes,
  systemQuestionVersions,
  systemQuestions,
  type SystemBankEventRow,
  type SystemOutcomePackageCurriculumRow,
  type SystemOutcomePackageMappingRow,
  type SystemOutcomePackageNodeRow,
  type SystemOutcomePackageOutcomeRow,
  type SystemOutcomePackageRow,
  type SystemQuestionImporterRow,
  type SystemQuestionRow,
  type SystemQuestionVersionRow,
} from '@lms/db/system-bank';
import type { SystemBankPackage } from '@lms/contracts';
import { SystemBankConnection, type SystemBankDatabase } from './system-bank.connection';

@Injectable()
export class SystemBankRepository {
  constructor(private readonly connection: SystemBankConnection) {}

  /** Handle kho ngân hàng, hoặc ném lỗi chưa cấu hình chuẩn. */
  private db(): SystemBankDatabase {
    const db = this.connection.db;
    if (!db) {
      throw new ServiceUnavailableException({
        message: 'System bank is not configured (SYSTEM_BANK_DATABASE_URL is not set)',
        code: 'system_bank.not_configured',
      });
    }
    return db;
  }

  /**
   * Tạo câu hỏi hệ thống kèm phiên bản đầu tiên trong MỘT transaction
   * kho ngân hàng: câu + version 1 + các liên kết YCCĐ của gói.
   * `id` vắng thì database sinh uuidv7; đường di trú truyền id gốc để
   * giữ truy vết nguồn.
   */
  async createQuestionWithFirstVersion(input: {
    id?: string;
    qtype: string;
    createdBy: string | null;
    package: SystemBankPackage;
    checksum: string;
  }): Promise<{ question: SystemQuestionRow; version: SystemQuestionVersionRow }> {
    const db = this.db();
    return db.transaction(async (tx) => {
      const [question] = await tx
        .insert(systemQuestions)
        .values({
          ...(input.id ? { id: input.id } : {}),
          qtype: input.qtype,
          status: 'published',
          createdBy: input.createdBy,
        })
        .returning();
      if (!question) throw new Error('system bank: failed to insert system question');
      const [version] = await tx
        .insert(systemQuestionVersions)
        .values({ questionId: question.id, version: 1, checksum: input.checksum, package: input.package })
        .returning();
      if (!version) throw new Error('system bank: failed to insert system question version');
      if (input.package.outcomes.length > 0) {
        await tx.insert(systemQuestionVersionOutcomes).values(
          input.package.outcomes.map((outcome) => ({
            versionId: version.id,
            outcomeId: outcome.outcomeId,
            cognitiveLevel: outcome.cognitiveLevel,
          })),
        );
      }
      return { question, version };
    });
  }

  /**
   * Tạo phiên bản mới cho câu đã có trong MỘT transaction: số phiên
   * bản = max hiện tại + 1 (unique theo cặp câu + số), kèm các liên
   * kết YCCĐ của gói mới. Nội dung phiên bản cũ không bị chạm tới.
   */
  async createVersion(
    questionId: string,
    pkg: SystemBankPackage,
    checksum: string,
  ): Promise<SystemQuestionVersionRow> {
    const db = this.db();
    return db.transaction(async (tx) => {
      const latest = await tx
        .select({ version: systemQuestionVersions.version })
        .from(systemQuestionVersions)
        .where(eq(systemQuestionVersions.questionId, questionId))
        .orderBy(desc(systemQuestionVersions.version))
        .limit(1);
      const nextVersion = (latest[0]?.version ?? 0) + 1;
      const [version] = await tx
        .insert(systemQuestionVersions)
        .values({ questionId, version: nextVersion, checksum, package: pkg })
        .returning();
      if (!version) throw new Error('system bank: failed to insert system question version');
      if (pkg.outcomes.length > 0) {
        await tx.insert(systemQuestionVersionOutcomes).values(
          pkg.outcomes.map((outcome) => ({
            versionId: version.id,
            outcomeId: outcome.outcomeId,
            cognitiveLevel: outcome.cognitiveLevel,
          })),
        );
      }
      return version;
    });
  }

  /** Đọc một câu hỏi hệ thống theo id (null khi không có). */
  async getQuestion(id: string): Promise<SystemQuestionRow | null> {
    const rows = await this.db()
      .select()
      .from(systemQuestions)
      .where(eq(systemQuestions.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Đọc một phiên bản theo số phiên bản của câu (null khi không có). */
  async getVersionByNumber(questionId: string, version: number): Promise<SystemQuestionVersionRow | null> {
    const rows = await this.db()
      .select()
      .from(systemQuestionVersions)
      .where(
        and(
          eq(systemQuestionVersions.questionId, questionId),
          eq(systemQuestionVersions.version, version),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Liệt kê mọi phiên bản của một câu theo thứ tự số tăng dần. */
  async listVersions(questionId: string): Promise<SystemQuestionVersionRow[]> {
    return this.db()
      .select()
      .from(systemQuestionVersions)
      .where(eq(systemQuestionVersions.questionId, questionId))
      .orderBy(systemQuestionVersions.version);
  }

  /** Liệt kê các phiên bản mới nhất của một câu (mới nhất trước). */
  async getLatestVersion(questionId: string): Promise<SystemQuestionVersionRow | null> {
    const rows = await this.db()
      .select()
      .from(systemQuestionVersions)
      .where(eq(systemQuestionVersions.questionId, questionId))
      .orderBy(desc(systemQuestionVersions.version))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Đánh dấu câu đã rút (metadata trạng thái, tách khỏi nội dung các
   * phiên bản — các phiên bản cũ vẫn đọc lại nguyên vẹn).
   */
  async markWithdrawn(
    id: string,
    input: { reason: string; by: string | null },
  ): Promise<SystemQuestionRow | null> {
    const rows = await this.db()
      .update(systemQuestions)
      .set({
        status: 'withdrawn',
        withdrawnReason: input.reason,
        withdrawnBy: input.by,
        withdrawnAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(systemQuestions.id, id))
      .returning();
    return rows[0] ?? null;
  }

  /** Ghi một dòng sự kiện append-only vào nhật ký kho ngân hàng. */
  async recordEvent(input: {
    type: string;
    sourceQuestionId: string;
    payload: Record<string, unknown>;
  }): Promise<SystemBankEventRow> {
    const [event] = await this.db()
      .insert(systemBankEvents)
      .values({ type: input.type, sourceQuestionId: input.sourceQuestionId, payload: input.payload })
      .returning();
    if (!event) throw new Error('system bank: failed to insert bank event');
    return event;
  }

  /**
   * Liệt kê các câu hỏi đang phát hành (kèm mọi phiên bản của mỗi câu)
   * phục vụ khám phá: lọc theo dạng câu ở SQL; lọc theo YCCĐ/mức độ
   * thực hiện trên tập id (kho ngân hàng ở quy mô trăm–nghìn câu nên
   * lọc trong bộ nhớ trên id rồi mới phân trang là đủ và giữ phân
   * trang đúng — không lọc sau phân trang).
   */
  async listPublishedQuestionsWithVersions(filters: {
    qtype?: string;
    outcomeId?: string;
    cognitiveLevel?: string;
  }): Promise<
    Array<{
      question: SystemQuestionRow;
      versions: SystemQuestionVersionRow[];
      outcomeLinks: Array<{ versionId: string; outcomeId: string; cognitiveLevel: string }>;
    }>
  > {
    const db = this.db();
    const questions = await db
      .select()
      .from(systemQuestions)
      .where(
        filters.qtype
          ? and(eq(systemQuestions.status, 'published'), eq(systemQuestions.qtype, filters.qtype))
          : eq(systemQuestions.status, 'published'),
      );
    if (questions.length === 0) return [];
    const questionIds = questions.map((question) => question.id);
    const versions = await db
      .select()
      .from(systemQuestionVersions)
      .where(inArray(systemQuestionVersions.questionId, questionIds));
    const versionIds = versions.map((version) => version.id);
    const outcomeLinks =
      versionIds.length === 0
        ? []
        : await db
            .select()
            .from(systemQuestionVersionOutcomes)
            .where(inArray(systemQuestionVersionOutcomes.versionId, versionIds));
    const versionsByQuestion = new Map<string, SystemQuestionVersionRow[]>();
    for (const version of versions) {
      const list = versionsByQuestion.get(version.questionId) ?? [];
      list.push(version);
      versionsByQuestion.set(version.questionId, list);
    }
    const result = questions
      .map((question) => ({
        question,
        versions: (versionsByQuestion.get(question.id) ?? []).sort((a, b) => a.version - b.version),
        outcomeLinks: outcomeLinks.filter((link) =>
          (versionsByQuestion.get(question.id) ?? []).some((version) => version.id === link.versionId),
        ),
      }))
      .filter((entry) => {
        if (!filters.outcomeId && !filters.cognitiveLevel) return true;
        return entry.outcomeLinks.some(
          (link) =>
            (!filters.outcomeId || link.outcomeId === filters.outcomeId) &&
            (!filters.cognitiveLevel || link.cognitiveLevel === filters.cognitiveLevel),
        );
      });
    return result;
  }

  /** Liệt kê slug các trung tâm đã nhập một câu (căn cứ phát thông báo khi rút câu). */
  async listImporterSlugs(sourceQuestionId: string): Promise<string[]> {
    const rows = await this.db()
      .select({ centreSlug: systemQuestionImporters.centreSlug })
      .from(systemQuestionImporters)
      .where(eq(systemQuestionImporters.sourceQuestionId, sourceQuestionId));
    return rows.map((row) => row.centreSlug);
  }

  /** Ghi nhận một trung tâm đã nhập (upsert idempotent theo cặp câu + slug) — dùng ở lát nhập bản chụp. */
  async recordImporter(input: {
    sourceQuestionId: string;
    centreSlug: string;
    importedBy: string | null;
  }): Promise<SystemQuestionImporterRow> {
    const [row] = await this.db()
      .insert(systemQuestionImporters)
      .values({
        sourceQuestionId: input.sourceQuestionId,
        centreSlug: input.centreSlug,
        importedBy: input.importedBy,
      })
      .onConflictDoNothing({
        target: [systemQuestionImporters.sourceQuestionId, systemQuestionImporters.centreSlug],
      })
      .returning();
    if (row) return row;
    const existing = await this.db()
      .select()
      .from(systemQuestionImporters)
      .where(
        and(
          eq(systemQuestionImporters.sourceQuestionId, input.sourceQuestionId),
          eq(systemQuestionImporters.centreSlug, input.centreSlug),
        ),
      )
      .limit(1);
    if (!existing[0]) throw new Error('system bank: failed to record importer');
    return existing[0];
  }

  /** Tạo một gói YCCĐ kèm toàn bộ items trong MỘT transaction kho ngân hàng. */
  async createPackageWithItems(input: {
    version: string;
    scope: string;
    checksum: string;
    outcomeCount: number;
    createdBy: string | null;
    curricula: Array<{ curriculumId: string; subjectSlug: string; grade: number }>;
    nodes: Array<{
      nodeId: string;
      curriculumId: string;
      parentId: string | null;
      title: string;
      kind: string;
      position: number;
      durationPeriods: number | null;
      durationPercent: number | null;
    }>;
    outcomes: Array<{
      outcomeId: string;
      nodeId: string;
      position: number;
      content: unknown;
      sourceKind: string;
      sourceRef: string | null;
    }>;
    mappings: Array<{ fromOutcomeId: string; toOutcomeId: string; note: string }>;
  }): Promise<SystemOutcomePackageRow> {
    return this.db().transaction(async (tx) => {
      const [pkg] = await tx
        .insert(systemOutcomePackages)
        .values({
          version: input.version,
          scope: input.scope,
          checksum: input.checksum,
          outcomeCount: input.outcomeCount,
          createdBy: input.createdBy,
        })
        .returning();
      if (!pkg) throw new Error('system bank: failed to create outcome package');
      if (input.curricula.length > 0) {
        await tx.insert(systemOutcomePackageCurricula).values(
          input.curricula.map((curriculum) => ({ packageId: pkg.id, ...curriculum })),
        );
      }
      if (input.nodes.length > 0) {
        await tx.insert(systemOutcomePackageNodes).values(
          input.nodes.map((node) => ({ packageId: pkg.id, ...node })),
        );
      }
      if (input.outcomes.length > 0) {
        await tx.insert(systemOutcomePackageOutcomes).values(
          input.outcomes.map((outcome) => ({
            packageId: pkg.id,
            ...outcome,
            content: outcome.content as never,
          })),
        );
      }
      if (input.mappings.length > 0) {
        await tx.insert(systemOutcomePackageMappings).values(
          input.mappings.map((mapping) => ({ packageId: pkg.id, ...mapping })),
        );
      }
      return pkg;
    });
  }

  /** Đọc một gói theo định danh phiên bản (null khi chưa có). */
  async getPackageByVersion(version: string): Promise<SystemOutcomePackageRow | null> {
    const rows = await this.db()
      .select()
      .from(systemOutcomePackages)
      .where(eq(systemOutcomePackages.version, version))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Liệt kê các gói YCCĐ (mới nhất trước). */
  async listPackages(): Promise<SystemOutcomePackageRow[]> {
    return this.db()
      .select()
      .from(systemOutcomePackages)
      .orderBy(desc(systemOutcomePackages.createdAt));
  }

  /** Đọc toàn bộ items của một gói (để trung tâm cài đặt). */
  async getPackageItems(packageId: string): Promise<{
    curricula: SystemOutcomePackageCurriculumRow[];
    nodes: SystemOutcomePackageNodeRow[];
    outcomes: SystemOutcomePackageOutcomeRow[];
    mappings: SystemOutcomePackageMappingRow[];
  }> {
    const db = this.db();
    const [curricula, nodes, outcomes, mappings] = await Promise.all([
      db.select().from(systemOutcomePackageCurricula).where(eq(systemOutcomePackageCurricula.packageId, packageId)),
      db.select().from(systemOutcomePackageNodes).where(eq(systemOutcomePackageNodes.packageId, packageId)),
      db.select().from(systemOutcomePackageOutcomes).where(eq(systemOutcomePackageOutcomes.packageId, packageId)),
      db.select().from(systemOutcomePackageMappings).where(eq(systemOutcomePackageMappings.packageId, packageId)),
    ]);
    return { curricula, nodes, outcomes, mappings };
  }
}

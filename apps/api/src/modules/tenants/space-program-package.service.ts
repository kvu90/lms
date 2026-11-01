import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import {
  curricula,
  curriculumNodes,
  curriculumProgramRecords,
  learningOutcomes,
  programPackageInstalls,
  subjects,
} from '../../db/schema';
import { ContextsService } from '../access/contexts.service';
import { CENTRE_PROGRAM_PACKAGE_KEY } from './centre-provision';
import {
  loadProgramDumpSql,
  PROGRAM_DUMP_VERSION,
  restoreProgramDumpSql,
} from '../curriculum/program-dump';
import { tenantAls } from './tenant-als';

/**
 * Một dòng trong sổ ghi nhận cài đặt gói chương trình
 * (`program_package_installs`): phiên bản gói nào đã cài, băm của
 * artifact đã cài và thời điểm ghi nhận. Bảng này KHÔNG có cột
 * người cài — danh tính người vận hành thuộc về nhật ký của lượt
 * di trú gọi bước này, không nằm trong sổ (xem ghi chú ở
 * `installIntoSpace`).
 */
export interface ProgramPackageInstallRecord {
  packageKey: string;
  version: string;
  checksum: string;
  installedAt: Date;
}

/** Kết quả một lượt chạy bước cài gói chương trình vào kho đích. */
export interface SpaceProgramPackageInstallReport {
  /** Slug của trung tâm đích (đăng ký control plane). */
  slug: string;
  /** Id tenant của trung tâm (dòng tenant đã sao sang kho đích). */
  tenantId: string;
  /** Sổ cài đặt đọc được từ kho nguồn (kho chung) cho tenant này. */
  sourceInstalls: ProgramPackageInstallRecord[];
  /** Bản cài gói trung tâm đã có trong kho đích trước lượt này (null khi chưa có). */
  targetInstallBefore: ProgramPackageInstallRecord | null;
  /** Lượt này có restore artifact dump vào kho đích hay không. */
  restored: boolean;
  /** Lượt này có ghi dòng bản cài gói trung tâm vào kho đích hay không. */
  installRecorded: boolean;
  /** Các khoá trong sổ nguồn đã được chuyển sang kho đích trong lượt này. */
  transferredKeys: string[];
  /** Bản cài gói trung tâm trong kho đích sau lượt này. */
  targetInstallAfter: ProgramPackageInstallRecord;
  /** Số dòng chương trình đếm được trong kho đích sau lượt này. */
  outcomeCounts: {
    subjects: number;
    curricula: number;
    nodes: number;
    outcomes: number;
    programRecords: number;
  };
}

/**
 * Bước cài gói YCCĐ vào kho đích của một trung tâm (Phần A, issue
 * #587 — A5; bước này thuộc quy trình di trú Phần B nhưng được
 * viết và kiểm chứng ngay ở Phần A, trước mọi đợt chuyển dữ kiện
 * thật).
 *
 * Flow tổng thể (trước khi đổi định tuyến của trung tâm sang kho
 * riêng):
 * 1. Trung tâm đích PHẢI ở chế độ kho riêng — trung tâm còn ở kho
 *    chung thì không có "kho đích" để cài, bước này từ chối
 *    fail-closed thay vì cài chồng lên kho chung.
 * 2. Đọc sổ ghi nhận cài đặt của tenant từ KHO NGUỒN (kho chung,
 *    ngữ cảnh platform không mang slug) — đây là sổ mà Phần B
 *    chuyển sang kho đích.
 * 3. Trong kho đích (ngữ cảnh platform + slug của trung tâm, đúng
 *    khuôn kết nối seed của pipeline cấp phát — ghi seed cần
 *    `app.platform = 'on'` mới qua được RLS FORCE của kho mới):
 *    - Chưa có bản cài gói trung tâm mà dữ kiện chương trình cũng
 *      chưa có → restore artifact dump hiện hành của repo bằng
 *      đúng cơ chế cài gói đã có (`restoreProgramDumpSql`, neo
 *      lại context hệ thống của kho đích), rồi ghi dòng bản cài
 *      (phiên bản + checksum của artifact vừa cài).
 *    - Chưa có bản cài mà dữ kiện đã có (cửa sổ hỏng giữa lúc
 *      restore và lúc ghi bản cài) → chỉ ghi dòng bản cài, không
 *      restore chồng (đúng khuôn pipeline cấp phát).
 *    - Đã có bản cài lệch phiên bản/checksum so với artifact hiện
 *      hành → từ chối rõ thay vì ghi đè lặng lẽ: nâng cấp gói là
 *      việc của đợt migration gói, không phải của bước di trú.
 *    - Bản cài đã khớp → bỏ qua (chạy lại an toàn).
 * 4. Chuyển sổ ghi nhận cài đặt: mỗi khoá trong sổ nguồn mà kho
 *    đích chưa có thì sao nguyên văn (phiên bản, checksum, thời
 *    điểm ghi nhận) sang kho đích. Riêng khoá gói trung tâm thì
 *    dòng của kho đích là căn cứ (vừa được cài/xác nhận ở bước 3)
 *    nên không bị dòng nguồn ghi đè — sổ nguồn của khoá này chỉ
 *    còn giá trị đối chiếu, thể hiện trong `sourceInstalls` của
 *    báo cáo.
 *
 * Giới hạn đã biết, ghi rõ để Phần B không suy diễn sai: bảng sổ
 * không có cột người cài, nên "ai cài" không nằm trong dữ kiện
 * chuyển — lượt di trú gọi bước này phải ghi danh tính người vận
 * hành vào báo cáo đợt của chính nó. Gắn chuẩn đã có của trung tâm
 * giữ nguyên định danh YCCĐ đã gắn vì cơ chế cài ghi theo định
 * danh giữ nguyên (id trong artifact là hằng số literal) — bước
 * này không viết lại bất kỳ gắn chuẩn nào.
 *
 * @param slug - Slug của trung tâm đích trong sổ đăng ký.
 * @param tenantId - Id tenant của trung tâm (dòng tenant đã có
 *   trong kho đích — bước này không tạo tenant).
 * @returns Báo cáo lượt chạy (xem `SpaceProgramPackageInstallReport`).
 * @throws Error khi trung tâm đích không ở chế độ kho riêng, hoặc
 *   khi bản cài đã có trong kho đích lệch phiên bản/checksum.
 */
@Injectable()
export class SpaceProgramPackageService {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly spaceDb: SpaceDatabaseService,
    private readonly contexts: ContextsService,
  ) {}

  async installIntoSpace(slug: string, tenantId: string): Promise<SpaceProgramPackageInstallReport> {
    const target = await this.spaceDb.resolveTarget(slug);
    if (target.mode !== 'dedicated') {
      throw new Error(
        `Cannot install the program package for centre ${slug}: its store mode is ${target.mode}, not dedicated — there is no destination store to install into`,
      );
    }

    // Sổ nguồn đọc từ kho chung: ngữ cảnh platform KHÔNG mang slug
    // nên handle định tuyến uỷ thác về kho chung.
    const sourceRows = await tenantAls.run({ platform: true }, () =>
      this.db
        .select()
        .from(programPackageInstalls)
        .where(eq(programPackageInstalls.tenantId, tenantId)),
    );
    const sourceInstalls: ProgramPackageInstallRecord[] = sourceRows.map((row) => ({
      packageKey: row.packageKey,
      version: row.version,
      checksum: row.checksum,
      installedAt: row.installedAt,
    }));

    const dumpSql = loadProgramDumpSql();
    const dumpChecksum = createHash('sha256').update(dumpSql).digest('hex');

    // Toàn bộ việc trong kho đích chạy trong ngữ cảnh platform +
    // slug (khuôn kết nối seed của pipeline cấp phát): platform
    // để qua RLS FORCE của các bảng sổ, slug để handle định tuyến
    // chọn đúng kho đích. `withSpaceDatabase` giữ nguyên trường
    // platform của ngữ cảnh cha khi không truyền `tenantId`.
    const result = await tenantAls.run({ platform: true }, () =>
      this.spaceDb.withSpaceDatabase(slug, async () => {
        const system = await this.contexts.ensureSystemContext();
        const [before] = await this.db
          .select()
          .from(programPackageInstalls)
          .where(
            and(
              eq(programPackageInstalls.tenantId, tenantId),
              eq(programPackageInstalls.packageKey, CENTRE_PROGRAM_PACKAGE_KEY),
            ),
          )
          .limit(1);
        const targetInstallBefore: ProgramPackageInstallRecord | null = before
          ? {
              packageKey: before.packageKey,
              version: before.version,
              checksum: before.checksum,
              installedAt: before.installedAt,
            }
          : null;

        let restored = false;
        let installRecorded = false;
        if (!before) {
          const [subjectCount] = await this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(subjects);
          const programPresent = Number(subjectCount?.count ?? 0) > 0;
          if (!programPresent) {
            await restoreProgramDumpSql(this.db, dumpSql, { anchorContextId: system.id });
            restored = true;
          }
          await this.db.insert(programPackageInstalls).values({
            tenantId,
            packageKey: CENTRE_PROGRAM_PACKAGE_KEY,
            version: PROGRAM_DUMP_VERSION,
            checksum: dumpChecksum,
          });
          installRecorded = true;
        } else if (before.version !== PROGRAM_DUMP_VERSION || before.checksum !== dumpChecksum) {
          throw new Error(
            `Centre store already has program package ${CENTRE_PROGRAM_PACKAGE_KEY} at version ${before.version} (expected ${PROGRAM_DUMP_VERSION}) — refusing to overwrite; upgrade the package instead`,
          );
        }

        // Chuyển sổ nguồn: sao nguyên văn mọi khoá còn thiếu, trừ
        // khoá gói trung tâm (dòng đích là căn cứ, xem lời dẫn).
        const transferredKeys: string[] = [];
        for (const source of sourceInstalls) {
          if (source.packageKey === CENTRE_PROGRAM_PACKAGE_KEY) continue;
          const [existing] = await this.db
            .select({ id: programPackageInstalls.id })
            .from(programPackageInstalls)
            .where(
              and(
                eq(programPackageInstalls.tenantId, tenantId),
                eq(programPackageInstalls.packageKey, source.packageKey),
              ),
            )
            .limit(1);
          if (!existing) {
            await this.db.insert(programPackageInstalls).values({
              tenantId,
              packageKey: source.packageKey,
              version: source.version,
              checksum: source.checksum,
              installedAt: source.installedAt,
            });
            transferredKeys.push(source.packageKey);
          }
        }

        const [after] = await this.db
          .select()
          .from(programPackageInstalls)
          .where(
            and(
              eq(programPackageInstalls.tenantId, tenantId),
              eq(programPackageInstalls.packageKey, CENTRE_PROGRAM_PACKAGE_KEY),
            ),
          )
          .limit(1);
        if (!after) {
          throw new Error(
            `Program package ${CENTRE_PROGRAM_PACKAGE_KEY} has no install record in the destination store after installation`,
          );
        }
        const targetInstallAfter: ProgramPackageInstallRecord = {
          packageKey: after.packageKey,
          version: after.version,
          checksum: after.checksum,
          installedAt: after.installedAt,
        };

        const countSubjects = async () => {
          const [row] = await this.db.select({ count: sql<number>`count(*)::int` }).from(subjects);
          return Number(row?.count ?? 0);
        };
        const countCurricula = async () => {
          const [row] = await this.db.select({ count: sql<number>`count(*)::int` }).from(curricula);
          return Number(row?.count ?? 0);
        };
        const countNodes = async () => {
          const [row] = await this.db.select({ count: sql<number>`count(*)::int` }).from(curriculumNodes);
          return Number(row?.count ?? 0);
        };
        const countOutcomes = async () => {
          const [row] = await this.db.select({ count: sql<number>`count(*)::int` }).from(learningOutcomes);
          return Number(row?.count ?? 0);
        };
        const countProgramRecords = async () => {
          const [row] = await this.db.select({ count: sql<number>`count(*)::int` }).from(curriculumProgramRecords);
          return Number(row?.count ?? 0);
        };
        const outcomeCounts = {
          subjects: await countSubjects(),
          curricula: await countCurricula(),
          nodes: await countNodes(),
          outcomes: await countOutcomes(),
          programRecords: await countProgramRecords(),
        };

        return {
          slug,
          tenantId,
          sourceInstalls,
          targetInstallBefore,
          restored,
          installRecorded,
          transferredKeys,
          targetInstallAfter,
          outcomeCounts,
        };
      }),
    );
    return result;
  }
}

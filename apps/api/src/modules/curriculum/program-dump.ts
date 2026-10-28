import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, inArray, ne, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import {
  curricula, curriculumNodes, curriculumProgramRecords, learningOutcomes, subjects,
} from '../../db/schema';

/**
 * DUMP ĐÔNG CỨNG dữ liệu chương trình GDPT 2018 — mô hình phân phối
 * thay cho cơ chế hội tụ UUIDv5 trước đó.
 *
 * Flow tổng thể:
 * 1. SẢN XUẤT (chỉ ở trung tâm, một lần cho mỗi đợt đính chính của
 *    Bộ): nạp/patch dataset vào MỘT DB chuẩn bằng ProgramImportService
 *    (ghép dòng theo bản ghi + vị trí + nguyên văn trên chính DB đó,
 *    sinh báo cáo thay đổi cho người duyệt) → chạy CLI
 *    `export-program-dump` để xuất toàn bộ các bảng chương trình của
 *    DB chuẩn thành artifact SQL này → commit artifact kèm tăng
 *    {@link PROGRAM_DUMP_VERSION}.
 * 2. PHÂN PHỐI (mọi môi trường — local/CI/production): seed RESTORE
 *    nguyên văn artifact qua ProgramDumpService.restoreIfEmpty,
 *    KHÔNG chạy importer. Mọi id trong artifact là HẰNG SỐ LITERAL
 *    (kể cả uuidv7 của YCCĐ do DB chuẩn cấp) nên tập id khớp 100%
 *    giữa các môi trường bất kể lịch sử nạp của từng nơi.
 *
 * Ngoại lệ neo duy nhất của bước restore: cột `subjects.context_id`
 * trong artifact mang context hệ thống của môi trường SINH dump —
 * một context không tồn tại ở môi trường đích. Restore vì thế neo
 * lại cột này về context hệ thống của chính môi trường đích ngay
 * trong cùng transaction (xem {@link restoreProgramDumpSql}); thiếu
 * bước neo, toàn bộ cây chương trình ở đích neo vào hư không và mọi
 * bề mặt đọc chương trình đều trả 404 dù dữ liệu đầy đủ (lỗi đã gặp
 * trên production ở nghiệm thu D-3 của issue #233, phải sửa dữ liệu
 * bằng tay). Mọi id và mọi cột còn lại giữ nguyên literal của
 * artifact.
 *
 * Bất biến: artifact là dữ liệu ĐÃ ĐÔNG CỨNG — không sửa tay; muốn
 * đổi nội dung chương trình thì quay lại bước 1. Restore chỉ chạy
 * khi DB chưa có dữ liệu chương trình (sổ đăng ký trống), đúng luật
 * seed hiện hành.
 */

/**
 * Version của artifact dump hiện hành trong repo. Tăng theo định
 * dạng `<ngày>.<số đợt trong ngày>` mỗi lần sản xuất lại dump từ DB
 * chuẩn đã patch; version được ghi vào đầu file SQL và vào log seed
 * để mọi môi trường đối chiếu được mình đang chạy bản dump nào.
 */
export const PROGRAM_DUMP_VERSION = '2026-10-28.3';

/** Tên file artifact trong repo (cạnh module này), được copy sang dist khi build. */
export const PROGRAM_DUMP_FILE_NAME = 'program-dump.sql';

/**
 * Render một giá trị dòng thành literal SQL an toàn cho artifact:
 * chuỗi thoát bằng gấp đôi dấu nháy đơn (standard_conforming_strings),
 * JSONB ép kiểu tường minh, thời gian về ISO 8601. Mọi giá trị đi qua
 * hàm này — artifact không chứa tham số, restore là chạy nguyên văn.
 */
function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (typeof value === 'object') return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Một câu INSERT hoàn chỉnh cho một dòng, theo đúng thứ tự cột đã khai. */
function insertStatement(table: string, columns: string[], values: unknown[]): string {
  return `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${values.map(sqlLiteral).join(', ')});`;
}

/**
 * Sắp các node cây theo độ sâu tăng dần (cha trước con) để restore
 * không vi phạm FK parent khi chèn tuần tự; cùng độ sâu giữ thứ tự
 * position. Node có parent không nằm trong tập (không xảy ra với DB
 * chuẩn nguyên vẹn) được coi như gốc.
 */
function orderNodesTopologically<T extends { id: string; parentId: string | null; position: number }>(rows: T[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const depthOf = (row: T): number => {
    let depth = 0;
    let cursor: T | undefined = row;
    const guard = new Set<string>();
    while (cursor?.parentId && byId.has(cursor.parentId) && !guard.has(cursor.id)) {
      guard.add(cursor.id);
      depth += 1;
      cursor = byId.get(cursor.parentId);
    }
    return depth;
  };
  return [...rows].sort((a, b) => depthOf(a) - depthOf(b) || a.position - b.position);
}

/**
 * Sắp các YCCĐ sao cho dòng gốc đứng trước dòng derived trỏ vào nó
 * (FK derived_from_id) — cùng thuật toán độ sâu như cây node.
 */
function orderOutcomesTopologically<T extends { id: string; derivedFromId: string | null; position: number }>(rows: T[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const depthOf = (row: T): number => {
    let depth = 0;
    let cursor: T | undefined = row;
    const guard = new Set<string>();
    while (cursor?.derivedFromId && byId.has(cursor.derivedFromId) && !guard.has(cursor.id)) {
      guard.add(cursor.id);
      depth += 1;
      cursor = byId.get(cursor.derivedFromId);
    }
    return depth;
  };
  return [...rows].sort((a, b) => depthOf(a) - depthOf(b) || a.position - b.position);
}

/**
 * Xuất các bảng chương trình của DB hiện tại thành artifact SQL
 * đông cứng. Thứ tự bảng tôn trọng FK: subjects → curricula →
 * curriculum_nodes (cha trước con) → learning_outcomes (gốc trước
 * derived) → curriculum_program_records.
 *
 * Phạm vi xuất:
 * - Mặc định (đường sản xuất ở trung tâm): TOÀN BỘ các bảng — DB
 *   nguồn PHẢI là DB chuẩn chỉ chứa dữ liệu chương trình do
 *   importer sản xuất.
 * - `datasetKey` (đường kiểm chứng trong suite dùng chung DB): chỉ
 *   xuất cây của đúng dataset đó — môn/chương trình suy từ sổ đăng
 *   ký của dataset, node theo các chương trình đó, YCCĐ theo các
 *   node đó — để vòng xuất → restore không đụng dữ liệu của các
 *   suite khác đang ở chung DB.
 *
 * @param db - Kết nối DB cần xuất dump.
 * @param opts - `datasetKey` để giới hạn phạm vi theo một dataset.
 * @returns Toàn văn file SQL (kèm header version + số dòng từng bảng).
 */
export async function buildProgramDumpSql(db: Database, opts?: { datasetKey?: string }): Promise<string> {
  let subjectRows = await db.select().from(subjects);
  let curriculaRows = await db.select().from(curricula);
  let nodeRows = await db.select().from(curriculumNodes);
  let outcomeRows = await db.select().from(learningOutcomes);
  let recordRows = await db.select().from(curriculumProgramRecords);
  if (opts?.datasetKey) {
    recordRows = recordRows.filter((r) => r.datasetKey === opts.datasetKey);
    const subjectIds = new Set(recordRows.map((r) => r.subjectId));
    const curriculumIds = new Set(recordRows.map((r) => r.curriculumId));
    const nodeIds = new Set(nodeRows.filter((n) => curriculumIds.has(n.curriculumId)).map((n) => n.id));
    subjectRows = subjectRows.filter((r) => subjectIds.has(r.id));
    curriculaRows = curriculaRows.filter((r) => curriculumIds.has(r.id));
    nodeRows = nodeRows.filter((n) => nodeIds.has(n.id));
    outcomeRows = outcomeRows.filter((o) => nodeIds.has(o.nodeId));
  }
  nodeRows = orderNodesTopologically(nodeRows);
  outcomeRows = orderOutcomesTopologically(outcomeRows);

  const lines: string[] = [
    '-- =====================================================================',
    '-- DUMP ĐÔNG CỨNG DỮ LIỆU CHƯƠNG TRÌNH GDPT 2018 — KHÔNG SỬA TAY.',
    `-- Version dump: ${PROGRAM_DUMP_VERSION}`,
    `-- Sinh lúc: ${new Date().toISOString()}`,
    '-- Nguồn: DB chuẩn đã nạp/patch bằng ProgramImportService từ các dataset',
    '-- đã kiểm chứng nguyên văn với văn bản của Bộ (TT 32/2018/TT-BGDĐT).',
    `-- Số dòng: subjects=${subjectRows.length}, curricula=${curriculaRows.length}, ` +
      `curriculum_nodes=${nodeRows.length}, learning_outcomes=${outcomeRows.length}, ` +
      `curriculum_program_records=${recordRows.length}.`,
    '-- Mọi môi trường restore nguyên văn file này khi seed (ProgramDumpService),',
    '-- KHÔNG chạy importer. ID là hằng số literal nên khớp 100% giữa các môi trường.',
    '-- Cập nhật dữ liệu chuẩn: patch DB chuẩn bằng importer → chạy export-program-dump',
    '-- → commit bản mới kèm tăng PROGRAM_DUMP_VERSION.',
    '-- =====================================================================',
    '',
  ];
  for (const r of subjectRows) {
    lines.push(insertStatement('subjects',
      ['id', 'context_id', 'name', 'slug', 'position', 'created_at', 'updated_at'],
      [r.id, r.contextId, r.name, r.slug, r.position, r.createdAt, r.updatedAt]));
  }
  for (const r of curriculaRows) {
    lines.push(insertStatement('curricula',
      ['id', 'subject_id', 'grade', 'created_at', 'updated_at'],
      [r.id, r.subjectId, r.grade, r.createdAt, r.updatedAt]));
  }
  for (const r of nodeRows) {
    lines.push(insertStatement('curriculum_nodes',
      ['id', 'curriculum_id', 'parent_id', 'title', 'kind', 'position', 'duration_periods', 'duration_percent', 'created_at', 'updated_at'],
      [r.id, r.curriculumId, r.parentId, r.title, r.kind, r.position, r.durationPeriods, r.durationPercent, r.createdAt, r.updatedAt]));
  }
  for (const r of outcomeRows) {
    // Cột content nay là tài liệu Tiptap (jsonb): sqlLiteral render
    // đối tượng thành literal `'...json...'::jsonb`, restore vào cột
    // jsonb nguyên văn, giữ cấu trúc cha–con của tài liệu.
    lines.push(insertStatement('learning_outcomes',
      ['id', 'tenant_id', 'node_id', 'content', 'position', 'source_kind', 'source_ref', 'derived_from_id', 'retired_at', 'created_at', 'updated_at'],
      [r.id, r.tenantId, r.nodeId, r.content, r.position, r.sourceKind, r.sourceRef, r.derivedFromId, r.retiredAt, r.createdAt, r.updatedAt]));
  }
  for (const r of recordRows) {
    lines.push(insertStatement('curriculum_program_records',
      ['id', 'dataset_key', 'record_id', 'subject_id', 'curriculum_id', 'node_id', 'content_hash', 'source', 'created_at', 'updated_at'],
      [r.id, r.datasetKey, r.recordId, r.subjectId, r.curriculumId, r.nodeId, r.contentHash, r.source, r.createdAt, r.updatedAt]));
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Đọc artifact dump đi kèm mã nguồn (thư mục `program-data-dump/`
 * cạnh module; build copy sang dist cùng vị trí tương đối).
 *
 * @returns Toàn văn SQL của artifact hiện hành trong repo.
 * @throws Error khi artifact chưa được sản xuất (thiếu file) — seed
 *   phải dừng ồn ào thay vì âm thầm thiếu dữ liệu chương trình.
 */
export function loadProgramDumpSql(): string {
  return readFileSync(join(__dirname, 'program-data-dump', PROGRAM_DUMP_FILE_NAME), 'utf8');
}

/**
 * Restore một bản dump vào DB trong MỘT transaction (chết giữa chừng
 * thì rollback toàn bộ, chạy lại an toàn). Hàm này không tự xét DB
 * trống — điều kiện "chỉ restore khi chưa có dữ liệu chương trình"
 * do ProgramDumpService.restoreIfEmpty quyết trước khi gọi.
 *
 * Khi caller truyền `anchorContextId` (context hệ thống của môi
 * trường đích), transaction còn neo lại `subjects.context_id` của
 * các môn VỪA ĐƯỢC RESTORE về context đó NGAY TRONG CÙNG
 * transaction: giá trị literal trong artifact là context hệ thống
 * của môi trường sinh dump nên ở đích nó là một context không tồn
 * tại (cột này không có khoá ngoại tới bảng contexts nên DB nhận im
 * lặng), và toàn bộ cây chương trình — neo trực tiếp ở môn hoặc suy
 * ra qua khoá ngoại — thành không đọc được. Neo trong cùng
 * transaction để không tồn tại trạng thái "đã restore xong nhưng
 * chưa neo" nếu tiến trình chết giữa hai bước. Phạm vi neo khoá
 * đúng vào các môn mới chèn trong chính transaction này (đối chiếu
 * tập id môn trước/sau khi chạy artifact): môn có sẵn của môi
 * trường đích — kể cả môn neo ở context khác — không bị chạm, và
 * môn vốn đã neo đúng context đích thì không đổi gì.
 *
 * @param db - Kết nối DB đích.
 * @param dumpSql - Toàn văn artifact cần restore.
 * @param opts - `anchorContextId`: context hệ thống của môi trường
 *   đích để neo lại các môn vừa restore; bỏ trống thì restore
 *   nguyên văn như cũ (chỉ dành cho các đường kiểm chứng không qua
 *   ProgramDumpService).
 */
export async function restoreProgramDumpSql(
  db: Database,
  dumpSql: string,
  opts?: { anchorContextId?: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const subjectIdsBefore = opts?.anchorContextId
      ? new Set((await tx.select({ id: subjects.id }).from(subjects)).map((r) => r.id))
      : null;
    await tx.execute(sql.raw(dumpSql));
    if (opts?.anchorContextId && subjectIdsBefore) {
      const restoredIds = (await tx.select({ id: subjects.id }).from(subjects))
        .map((r) => r.id)
        .filter((id) => !subjectIdsBefore.has(id));
      if (restoredIds.length > 0) {
        await tx.update(subjects)
          .set({ contextId: opts.anchorContextId, updatedAt: new Date() })
          .where(and(
            inArray(subjects.id, restoredIds),
            ne(subjects.contextId, opts.anchorContextId),
          ));
      }
    }
  });
}

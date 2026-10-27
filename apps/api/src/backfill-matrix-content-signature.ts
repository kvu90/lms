import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { asc, eq } from 'drizzle-orm';
import { examMatrices, examMatrixCells } from './db/schema';
import { matrixContentSignature } from './modules/quiz/matrix-content-signature';

/**
 * Lấp chữ ký nội dung cho các ma trận có trước cột
 * `exam_matrices.content_signature` (lát schema chống trùng của issue
 * #233) — chạy bằng `pnpm --filter @lms/api backfill:matrix-signatures`
 * sau khi build, với `DATABASE_URL` trỏ vào DB đích.
 *
 * Bối cảnh: cột chữ ký + ràng buộc duy nhất (bank_id,
 * content_signature) đến từ baseline hợp nhất mới. Mọi ma trận tạo
 * sau đó đều có chữ ký do các đường ghi của API tính; các ma trận đã
 * tồn tại trước thay đổi schema thì cột còn NULL — chúng vẫn được
 * chống trùng ở tầng đối chiếu trong code, nhưng ràng buộc ở DB chỉ
 * có tác dụng trọn vẹn khi mọi bản ghi gắn bank đều đã có chữ ký.
 * Script này là bước lấp dữ liệu của cùng đợt thay đổi schema.
 *
 * Flow:
 * 1. Đọc toàn bộ `exam_matrices` + `exam_matrix_cells` và tính lại
 *    chữ ký của từng ma trận bằng ĐÚNG hàm dùng chung với các đường
 *    ghi (`matrixContentSignature`) — không có thuật toán thứ hai.
 * 2. Gom các ma trận CÓ bank (bank_id khác null) theo cặp (bank,
 *    chữ ký): nhóm nào có từ hai ma trận trở lên là TRÙNG SẴN CÓ do
 *    cửa sổ đua trước đây. Các nhóm này được IN RA BÁO CÁO (bank,
 *    chữ ký, từng ma trận: id/tên/người tạo/mốc tạo) — script KHÔNG
 *    tự xoá hay gộp bất kỳ ma trận nào; xử lý trùng sẵn có là quyết
 *    định riêng của vận hành.
 * 3. Chế độ mặc định (ghi): cập nhật `content_signature` cho mọi ma
 *    trận có chữ ký đã lưu khác chữ ký tính lại (gồm mọi bản ghi còn
 *    NULL), trong một transaction. Chế độ `--report-only` chỉ chạy
 *    bước 1–2 rồi kết thúc, không ghi gì.
 *
 * Thứ tự vận hành trên một DB đang sống (nếu áp schema theo từng
 * bước thay vì dựng lại từ baseline): thêm cột (chưa thêm ràng buộc)
 * → chạy script này để lấp chữ ký và nhận báo cáo trùng → xử lý các
 * cặp trùng theo báo cáo → thêm ràng buộc duy nhất. Nếu DB đã có
 * ràng buộc (dựng từ baseline mới, dữ liệu gieo sau đó) thì không
 * thể tồn tại cặp trùng và script chỉ lấp các bản ghi NULL còn sót.
 *
 * Mã thoát: 0 khi hoàn tất; ở chế độ `--report-only`, thoát 1 nếu
 * phát hiện cặp trùng sẵn có để pipeline vận hành chặn bước thêm
 * ràng buộc cho tới khi trùng được xử lý.
 */

interface MatrixReportRow {
  id: string;
  name: string;
  bankId: string | null;
  createdBy: string | null;
  createdAt: Date;
  storedSignature: string | null;
  signature: string;
}

async function main(): Promise<void> {
  const reportOnly = process.argv.includes('--report-only');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const db = drizzle({ client });
    const matrices = await db.select().from(examMatrices)
      .orderBy(asc(examMatrices.createdAt), asc(examMatrices.id));
    const cells = await db.select().from(examMatrixCells)
      .orderBy(asc(examMatrixCells.position), asc(examMatrixCells.id));
    const cellsByMatrix = new Map<string, typeof cells>();
    for (const cell of cells) {
      const list = cellsByMatrix.get(cell.matrixId) ?? [];
      list.push(cell);
      cellsByMatrix.set(cell.matrixId, list);
    }

    // Bước 1–2: tính chữ ký + gom nhóm trùng sẵn có theo (bank, chữ ký).
    const rows: MatrixReportRow[] = matrices.map((m) => ({
      id: m.id,
      name: m.name,
      bankId: m.bankId,
      createdBy: m.createdBy,
      createdAt: m.createdAt,
      storedSignature: m.contentSignature,
      signature: matrixContentSignature({ ...m, cells: cellsByMatrix.get(m.id) ?? [] }),
    }));
    const groups = new Map<string, MatrixReportRow[]>();
    for (const row of rows) {
      if (row.bankId === null) continue;
      const key = `${row.bankId}\n${row.signature}`;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    const duplicateGroups = [...groups.values()].filter((g) => g.length > 1);

    console.log(`[backfill-matrix-signatures] tổng số ma trận: ${rows.length}`);
    console.log(`[backfill-matrix-signatures] ma trận chưa có chữ ký đã lưu: ${rows.filter((r) => r.storedSignature === null).length}`);
    if (duplicateGroups.length === 0) {
      console.log('[backfill-matrix-signatures] không phát hiện cặp trùng sẵn có theo (bank, chữ ký).');
    } else {
      console.log(`[backfill-matrix-signatures] PHÁT HIỆN ${duplicateGroups.length} nhóm trùng sẵn có — KHÔNG tự xoá, cần xử lý riêng:`);
      for (const group of duplicateGroups) {
        const first = group[0]!;
        console.log(`  - bank ${first.bankId}, chữ ký ${first.signature}`);
        for (const member of group) {
          console.log(`      ma trận ${member.id} | tên "${member.name}" | created_by ${member.createdBy ?? 'null'} | created_at ${member.createdAt.toISOString()}`);
        }
      }
    }

    if (reportOnly) {
      console.log('[backfill-matrix-signatures] chế độ --report-only: không ghi gì.');
      if (duplicateGroups.length > 0) process.exitCode = 1;
      return;
    }

    // Bước 3: ghi chữ ký cho các bản ghi lệch/chưa có, một transaction.
    const stale = rows.filter((r) => r.storedSignature !== r.signature);
    await db.transaction(async (tx) => {
      for (const row of stale) {
        await tx.update(examMatrices)
          .set({ contentSignature: row.signature })
          .where(eq(examMatrices.id, row.id));
      }
    });
    console.log(`[backfill-matrix-signatures] đã cập nhật chữ ký cho ${stale.length} ma trận; ${rows.length - stale.length} ma trận đã đúng chữ ký.`);
    if (duplicateGroups.length > 0) {
      console.log('[backfill-matrix-signatures] LƯU Ý: các nhóm trùng ở trên vẫn giữ nguyên dữ liệu; ràng buộc duy nhất chỉ thêm được sau khi các cặp trùng này được xử lý.');
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error('[backfill-matrix-signatures] thất bại:', err);
  process.exitCode = 1;
});

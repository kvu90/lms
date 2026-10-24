import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Manifest + logic thuần của cơ chế nạp dữ liệu chương trình chuẩn
 * (K0a). Dataset là file bản ghi đã kiểm chứng nguyên văn với văn bản
 * ban hành kèm Thông tư 32/2018/TT-BGDĐT (xem hồ sơ kiểm chứng của dự
 * án: Toán 300/300, Ngữ văn 238/238, 0 chênh lệch chữ) và được vendor
 * nguyên văn tại thư mục `program-data/` cạnh file này — nạp dữ liệu là
 * chuyển các bản ghi đó vào cây chương trình, TUYỆT ĐỐI không sửa chữ,
 * kể cả lỗi in có thật trong PDF của Bộ.
 *
 * Thêm môn mới về sau = có dataset đã kiểm chứng của môn đó + thêm một
 * mục vào PROGRAM_DATASETS; cơ chế nạp không đổi.
 */

/** Truy vết nguồn của một bản ghi, nguyên văn theo dataset. */
export interface ProgramRecordSource {
  document: string;
  file: string;
  portal: string;
  pdf_pages: number[];
}

/** Một bản ghi chương trình trong dataset đã kiểm chứng. */
export interface ProgramRecord {
  id: string;
  subject: string;
  grade: number;
  level: string;
  stream: string;
  section: string | null;
  topic: string | null;
  content: string;
  kind: string;
  outcomes: string[];
  outcome_text: string;
  source: ProgramRecordSource;
}

/** Hình dạng file dataset vendor trong repo. */
export interface ProgramDatasetFile {
  subject: string;
  issued_with: string;
  records: ProgramRecord[];
}

/** Một dataset nạp được: khoá ổn định + môn đích + file bản ghi. */
export interface ProgramDatasetDef {
  key: string;
  subjectName: string;
  slug: string;
  fileName: string;
}

/**
 * Các dataset đã kiểm chứng hiện có. Ngữ văn bao gồm phần Tiếng Việt
 * cấp tiểu học (cùng một văn bản chương trình theo nguyên văn trang 3
 * của văn bản Ngữ văn).
 */
export const PROGRAM_DATASETS: readonly ProgramDatasetDef[] = [
  { key: 'toan', subjectName: 'Toán', slug: 'toan', fileName: 'program-toan.json' },
  { key: 'nguvan', subjectName: 'Ngữ văn', slug: 'ngu-van', fileName: 'program-nguvan.json' },
];

/** Tìm định nghĩa dataset theo khoá; undefined khi khoá không có trong manifest. */
export function programDatasetByKey(key: string): ProgramDatasetDef | undefined {
  return PROGRAM_DATASETS.find((d) => d.key === key);
}

/** Đọc + parse một file dataset đã vendor (đường dẫn theo vị trí module, chạy được cả ở src lẫn dist). */
export function loadProgramDataset(def: ProgramDatasetDef): ProgramDatasetFile {
  const raw = readFileSync(join(__dirname, 'program-data', def.fileName), 'utf8');
  return JSON.parse(raw) as ProgramDatasetFile;
}

/**
 * Hash nội dung của một bản ghi (sha256 trên JSON chuẩn hoá theo đúng
 * thứ tự trường của dataset). Đây là căn cứ idempotent của sổ đăng ký:
 * hash khớp → bản ghi trong hệ thống đã đúng nguyên văn, bỏ qua; lệch →
 * dataset đã được đính chính tại nguồn, cập nhật node + YCCĐ.
 */
export function programRecordHash(record: ProgramRecord): string {
  const canonical = JSON.stringify([
    record.id, record.subject, record.grade, record.level, record.stream,
    record.section, record.topic, record.content, record.kind,
    record.outcomes, record.outcome_text, record.source,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Các dòng YCCĐ của một bản ghi, theo thứ tự nguyên văn:
 * - Có `outcomes[]`: mỗi ý là một dòng.
 * - `outcomes[]` rỗng nhưng `outcome_text` có chữ (bản ghi hoạt động —
 *   nguyên văn viết dạng văn xuôi, không tách ý): đúng một dòng bằng
 *   toàn văn `outcome_text`.
 * - Cả hai rỗng (bản ghi Nội dung của Ngữ văn — toàn văn nằm ở trường
 *   nội dung của node): không có dòng nào.
 */
export function programRecordOutcomeTexts(record: ProgramRecord): string[] {
  if (record.outcomes.length > 0) return [...record.outcomes];
  if (record.outcome_text.trim().length > 0) return [record.outcome_text];
  return [];
}

/**
 * Trích dẫn nguồn hiển thị trên từng YCCĐ đã nạp: nguyên văn tên văn
 * bản + file PDF + trang + mã bản ghi — đủ để truy về đúng vị trí trong
 * văn bản chính chủ mà Bộ ban hành không ban hành "mã YCCĐ".
 */
export function programRecordSourceRef(record: ProgramRecord): string {
  const pages = record.source.pdf_pages.join(', ');
  return `${record.source.document} — ${record.source.file}, trang ${pages} — bản ghi ${record.id}`;
}

/**
 * Đường tổ tiên của một bản ghi trong cây của chương trình một khối:
 * mạch (stream) → section (nếu có) → topic (nếu có). Node `lesson` của
 * chính bản ghi nằm dưới phần tử cuối của đường này.
 */
export function programRecordAncestors(record: ProgramRecord): { kind: 'strand' | 'topic'; title: string }[] {
  const path: { kind: 'strand' | 'topic'; title: string }[] = [{ kind: 'strand', title: record.stream }];
  if (record.section !== null && record.section !== '') path.push({ kind: 'topic', title: record.section });
  if (record.topic !== null && record.topic !== '') path.push({ kind: 'topic', title: record.topic });
  return path;
}

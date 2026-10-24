import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Manifest + logic thuần của cơ chế nạp dữ liệu SGK (K0b, issue #67) —
 * đối ứng của `program-datasets.ts` ở tầng chương trình. Dataset là
 * file bản ghi **đã kiểm chứng nguyên văn** với mục lục in trong cuốn
 * SGK của bộ "Kết nối tri thức với cuộc sống" (NXB Giáo dục Việt Nam),
 * đối chiếu với mục lục Sách giáo viên cùng bộ, và được vendor nguyên
 * văn tại thư mục `book-data/` cạnh file này. Bước 0 của lát (ghi
 * trên issue #67) khai nguồn chính chủ cho từng môn × khối trước khi
 * số hoá; dataset mới chỉ được thêm vào manifest khi đã qua bước đó.
 *
 * Mỗi bản ghi là một BÀI học; chương (chủ đề) là tổ tiên suy từ trường
 * của bản ghi, đúng như bản ghi chương trình suy mạch/chủ đề tổ tiên.
 * `programRecords` là danh sách **mã bản ghi chương trình** (định danh
 * ổn định trong dataset chương trình của K0a, ví dụ TOAN-0001) mà bài
 * ánh xạ tới — lượt nạp phân giải mã sang node chương trình thật qua
 * sổ đăng ký chương trình và báo lỗi cứng nếu mã không tồn tại, nên
 * ánh xạ trong dataset luôn truy vết được và không bao giờ treo.
 */

/** Truy vết nguồn của một bản ghi SGK, nguyên văn theo dataset. */
export interface BookRecordSource {
  document: string;
  volume: string;
  artifact: string;
  portal: string;
}

/** Một bản ghi bài SGK trong dataset đã kiểm chứng. */
export interface BookRecord {
  id: string;
  subject: string;
  grade: number;
  volume: number;
  chapterNumber: number;
  chapter: string;
  lessonNumber: number | null;
  lesson: string;
  periods: number | null;
  programRecords: string[];
  source: BookRecordSource;
}

/** Hình dạng file dataset SGK vendor trong repo. */
export interface BookDatasetFile {
  book: string;
  series: string;
  publisher: string;
  records: BookRecord[];
}

/** Hình dạng thô của một bản ghi trong file vendor (khoá snake_case như hồ sơ dữ liệu nguồn). */
interface RawBookRecord {
  id: string;
  subject: string;
  grade: number;
  volume: number;
  chapter_number: number;
  chapter: string;
  lesson_number: number | null;
  lesson: string;
  periods: number | null;
  program_records: string[];
  source: BookRecordSource;
}

/** Một dataset SGK nạp được: khoá ổn định + môn/khối đích + dataset chương trình dùng để phân giải ánh xạ. */
export interface BookDatasetDef {
  key: string;
  subjectName: string;
  slug: string;
  bookTitle: string;
  grade: number;
  programDatasetKey: string;
  fileName: string;
  /** Cờ bản quyền theo sách: dataset này là sách của Bộ được ghi công khai nguồn → true. */
  attributionPublic: boolean;
}

/**
 * Các dataset SGK đã kiểm chứng hiện có. Thêm môn × khối mới = có
 * dataset đã kiểm chứng của sách đó (kèm Bước 0 khai nguồn trên issue)
 * + thêm một mục vào manifest; cơ chế nạp không đổi.
 */
export const BOOK_DATASETS: readonly BookDatasetDef[] = [
  { key: 'sgk-toan-1', subjectName: 'Toán', slug: 'toan', bookTitle: 'Toán 1', grade: 1, programDatasetKey: 'toan', fileName: 'book-toan-1.json', attributionPublic: true },
];

/** Tìm định nghĩa dataset SGK theo khoá; undefined khi khoá không có trong manifest. */
export function bookDatasetByKey(key: string): BookDatasetDef | undefined {
  return BOOK_DATASETS.find((d) => d.key === key);
}

/** Đọc + parse một file dataset SGK đã vendor (đường dẫn theo vị trí module, chạy được cả ở src lẫn dist); chuẩn hoá khoá snake_case của file sang hình dạng bản ghi dùng trong code. */
export function loadBookDataset(def: BookDatasetDef): BookDatasetFile {
  const raw = JSON.parse(readFileSync(join(__dirname, 'book-data', def.fileName), 'utf8')) as {
    book: string; series: string; publisher: string; records: RawBookRecord[];
  };
  return {
    book: raw.book,
    series: raw.series,
    publisher: raw.publisher,
    records: raw.records.map((r) => ({
      id: r.id,
      subject: r.subject,
      grade: r.grade,
      volume: r.volume,
      chapterNumber: r.chapter_number,
      chapter: r.chapter,
      lessonNumber: r.lesson_number,
      lesson: r.lesson,
      periods: r.periods,
      programRecords: r.program_records,
      source: r.source,
    })),
  };
}

/**
 * Hash nội dung của một bản ghi SGK (sha256 trên JSON chuẩn hoá theo
 * đúng thứ tự trường của dataset, gồm cả danh sách mã ánh xạ). Căn cứ
 * idempotent của sổ đăng ký SGK: hash khớp → bản ghi trong hệ thống đã
 * đúng nguyên văn + đúng ánh xạ, bỏ qua; lệch → dataset đã đính chính
 * tại nguồn, cập nhật node bài + thay toàn bộ ánh xạ của nó.
 */
export function bookRecordHash(record: BookRecord): string {
  const canonical = JSON.stringify([
    record.id, record.subject, record.grade, record.volume,
    record.chapterNumber, record.chapter, record.lessonNumber, record.lesson,
    record.periods, record.programRecords, record.source,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Trích dẫn nguồn hiển thị cho một bản ghi SGK đã nạp: tên văn bản +
 * tập + hiện vật đối chiếu + mã bản ghi — đủ để truy về đúng vị trí
 * trong mục lục của cuốn sách chính chủ.
 */
export function bookRecordSourceRef(record: BookRecord): string {
  return `${record.source.document} — ${record.source.volume} — bản ghi ${record.id}`;
}

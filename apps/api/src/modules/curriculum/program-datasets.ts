import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { v5 as uuidv5 } from 'uuid';

/**
 * Manifest + logic thuần của cơ chế nạp dữ liệu chương trình chuẩn
 * (K0a). Dataset là file bản ghi đã kiểm chứng nguyên văn với văn bản
 * ban hành kèm Thông tư 32/2018/TT-BGDĐT (xem hồ sơ kiểm chứng của dự
 * án: 19 môn có dữ liệu, 2.126 bản ghi, 0 chênh lệch chữ) và được vendor
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

/**
 * Một node trong doc Tiptap của một YCCĐ (hình dạng thu gọn đúng các
 * node hệ dùng cho YCCĐ: doc/paragraph/text + bulletList/listItem cho
 * ý con; marks trên node text được giữ nguyên khi lưu nhưng bị bỏ qua
 * khi trích text canonical).
 */
export interface ProgramOutcomeDocNode {
  type: string;
  text?: string;
  marks?: unknown[];
  content?: ProgramOutcomeDocNode[];
}

/** Một YCCĐ dạng Tiptap doc: phần tử của `outcomes[]` trong dataset. */
export interface ProgramOutcomeDoc {
  type: 'doc';
  content?: ProgramOutcomeDocNode[];
}

/**
 * Một bản ghi chương trình trong dataset đã kiểm chứng. Hình dạng
 * không đồng nhất giữa các đợt trích xuất (ghi nhận ở issue #161):
 * các dataset trích sau đợt Toán/Ngữ văn để `stream` trống/null (cấu
 * trúc nằm ở `section`/`topic`), bản ghi dạng `requirement` để
 * `content` rỗng, và 12 bản ghi chủ điểm của Tiếng Anh mang
 * `grade = null` (phần "Nội dung khái quát" theo CẤP, không theo lớp).
 * Các hàm thuần bên dưới là nơi duy nhất thích ứng hình dạng đó; bản
 * ghi trong dataset giữ nguyên văn tuyệt đối.
 */
export interface ProgramRecord {
  id: string;
  subject: string;
  grade: number | null;
  level: string;
  stream: string | null;
  section: string | null;
  topic: string | null;
  content: string;
  kind: string;
  /**
   * Các YCCĐ của bản ghi: dạng đích là Tiptap doc (xem
   * ProgramOutcomeDoc). Trong đợt chuyển đổi của issue #161 các
   * dataset chưa chuyển vẫn giữ phần tử dạng chuỗi thuần; importer
   * chấp nhận cả hai cho tới commit chốt hạ cổng lỗi.
   */
  outcomes: (string | ProgramOutcomeDoc)[];
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
 * Toàn bộ dataset đã kiểm chứng (19 môn có dữ liệu, 21 file, 2.126 bản
 * ghi — GDPT-SEED, issue #161; môn thứ 20 GDQP&AN chưa có dataset). Hai cặp file dùng CHUNG một môn đích (slug
 * giống nhau = resolve về đúng một môn ở tầng nạp):
 * - Tiếng Anh: văn bản "Làm quen lớp 1–2" + văn bản lớp 3–12;
 * - Lịch sử và Địa lí: văn bản Tiểu học + văn bản THCS (Lịch sử/Địa lí
 *   THPT là hai môn riêng, hai dataset riêng bên dưới).
 * Ngữ văn bao gồm phần Tiếng Việt cấp tiểu học (cùng một văn bản
 * chương trình theo nguyên văn trang 3 của văn bản Ngữ văn). `subjectName`
 * là tên môn đích trong hệ thống; với các dataset gộp nhiều tên môn theo
 * cấp (GDCD, HDTN) tên đích lấy nguyên văn trường `subject` của dataset.
 * Ngoài phạm vi theo chốt của dự án: Tiếng dân tộc thiểu số, Ngoại ngữ 2
 * (không có dataset) và GDQP&AN (chưa có PDF chính chủ — issue #74).
 */
export const PROGRAM_DATASETS: readonly ProgramDatasetDef[] = [
  { key: 'toan', subjectName: 'Toán', slug: 'toan', fileName: 'program-toan.json' },
  { key: 'nguvan', subjectName: 'Ngữ văn', slug: 'ngu-van', fileName: 'program-nguvan.json' },
  { key: 'tienganh-1-2', subjectName: 'Tiếng Anh', slug: 'tieng-anh', fileName: 'program-tienganh-1-2.json' },
  { key: 'tienganh-3-12', subjectName: 'Tiếng Anh', slug: 'tieng-anh', fileName: 'program-tienganh-3-12.json' },
  { key: 'gdcd', subjectName: 'Giáo dục công dân (Đạo đức / GDCD / GD kinh tế và pháp luật)', slug: 'giao-duc-cong-dan', fileName: 'program-gdcd.json' },
  { key: 'tnxh', subjectName: 'Tự nhiên và Xã hội', slug: 'tu-nhien-va-xa-hoi', fileName: 'program-tnxh.json' },
  { key: 'khoahoc', subjectName: 'Khoa học', slug: 'khoa-hoc', fileName: 'program-khoahoc.json' },
  { key: 'lsdl-th', subjectName: 'Lịch sử và Địa lí', slug: 'lich-su-va-dia-li', fileName: 'program-lsdl-th.json' },
  { key: 'lsdl-thcs', subjectName: 'Lịch sử và Địa lí', slug: 'lich-su-va-dia-li', fileName: 'program-lsdl-thcs.json' },
  { key: 'lichsu', subjectName: 'Lịch sử', slug: 'lich-su', fileName: 'program-lichsu.json' },
  { key: 'diali', subjectName: 'Địa lí', slug: 'dia-li', fileName: 'program-diali.json' },
  { key: 'khtn', subjectName: 'Khoa học tự nhiên', slug: 'khoa-hoc-tu-nhien', fileName: 'program-khtn.json' },
  { key: 'vatli', subjectName: 'Vật lí', slug: 'vat-li', fileName: 'program-vatli.json' },
  { key: 'hoahoc', subjectName: 'Hoá học', slug: 'hoa-hoc', fileName: 'program-hoahoc.json' },
  { key: 'sinhhoc', subjectName: 'Sinh học', slug: 'sinh-hoc', fileName: 'program-sinhhoc.json' },
  { key: 'tinhoc', subjectName: 'Tin học', slug: 'tin-hoc', fileName: 'program-tinhoc.json' },
  { key: 'congnghe', subjectName: 'Công nghệ', slug: 'cong-nghe', fileName: 'program-congnghe.json' },
  { key: 'gdtc', subjectName: 'Giáo dục thể chất', slug: 'giao-duc-the-chat', fileName: 'program-gdtc.json' },
  { key: 'amnhac', subjectName: 'Âm nhạc', slug: 'am-nhac', fileName: 'program-amnhac.json' },
  { key: 'mithuat', subjectName: 'Mĩ thuật', slug: 'mi-thuat', fileName: 'program-mithuat.json' },
  { key: 'hdtn', subjectName: 'Hoạt động trải nghiệm / Hoạt động trải nghiệm, hướng nghiệp', slug: 'hoat-dong-trai-nghiem', fileName: 'program-hdtn.json' },
];

/** Tìm định nghĩa dataset theo khoá; undefined khi khoá không có trong manifest. */
export function programDatasetByKey(key: string): ProgramDatasetDef | undefined {
  return PROGRAM_DATASETS.find((d) => d.key === key);
}

/**
 * Đọc + parse một file dataset đã vendor (đường dẫn theo vị trí
 * module, chạy được cả ở src lẫn dist). Mọi bản ghi ở dạng doc đều
 * qua kiểm chứng toàn vẹn với `outcome_text` ngay tại đây — dataset
 * lệch là lỗi nạp ở mọi đường đọc, không chờ tới lúc ghi DB.
 */
export function loadProgramDataset(def: ProgramDatasetDef): ProgramDatasetFile {
  const raw = readFileSync(join(__dirname, 'program-data', def.fileName), 'utf8');
  const file = JSON.parse(raw) as ProgramDatasetFile;
  for (const record of file.records) assertProgramRecordOutcomeIntegrity(def.key, record);
  return file;
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
 * Các dòng text của một doc YCCĐ, theo đúng thứ tự duyệt tài liệu:
 * mỗi `paragraph` cho một dòng (nối các node `text` con, bỏ qua
 * marks); `listItem` cho dòng của paragraph của nó rồi tới các dòng
 * của `bulletList` lồng bên trong (đệ quy). Đây là MỘT NỬA của hàm
 * trích canonical duy nhất của hệ — xem programOutcomeDocText.
 */
export function programOutcomeDocLines(doc: ProgramOutcomeDoc): string[] {
  const lines: string[] = [];
  const walk = (node: ProgramOutcomeDocNode): void => {
    if (node.type === 'paragraph') {
      const text = (node.content ?? [])
        .filter((child) => child.type === 'text')
        .map((child) => child.text ?? '')
        .join('');
      lines.push(text);
      return;
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return lines;
}

/**
 * Text canonical của một YCCĐ: các dòng của doc nối bằng `\n`, cắt
 * khoảng trắng hai đầu. ĐÂY LÀ HÀM TRÍCH DUY NHẤT của hệ cho YCCĐ dạng
 * doc: id/hash của dòng YCCĐ tính trên text này (xem programOutcomeId)
 * và kiểm chứng toàn vẹn với `outcome_text` cũng so trên text này —
 * đổi định dạng lưu (thứ tự khoá JSON, marks) không làm đổi id, chỉ
 * đổi NỘI DUNG chữ mới đổi id.
 */
export function programOutcomeDocText(doc: ProgramOutcomeDoc): string {
  return programOutcomeDocLines(doc).join('\n').trim();
}

/**
 * Khoá so sánh toàn vẹn giữa các dòng YCCĐ đã trích và `outcome_text`
 * nguyên văn: tách theo khoảng trắng; bỏ các token CHỈ gồm ký tự gạch
 * đầu dòng/dấu phân đoạn (`–`, `−`, `-`, `+`, `•` đứng một mình) và
 * tước một ký tự đánh dấu dính ở đầu token có chữ (extraction có chỗ
 * viết `–Trình bày` thiếu khoảng trắng) — các ký tự này là dấu trình
 * bày của văn bản gốc, không phải nội dung; gạch nằm giữa một token
 * có chữ, vd `cao – thấp` ở hai phía đều bị xử lý như nhau nên phép
 * so vẫn chặt về mặt chữ. Dấu phảy/chấm phảy ở CUỐI một token cũng là
 * dấu phân đoạn của các danh sách liệt kê (vd danh sách kiến thức
 * ngôn ngữ của Tiếng Anh ngăn bằng `, `) nên bị tước ở cả hai phía —
 * phép so vẫn chặt về mặt chữ vì dấu này không bao giờ nằm giữa một
 * từ tiếng Việt. Nối lại bằng một khoảng trắng. Hai phía áp cùng một
 * hàm nên phép so chỉ lệch khi chữ thật lệch.
 */
export function programOutcomeComparisonKey(text: string): string {
  return text
    .split(/\s+/)
    .filter((token) => token !== '' && !/^[–−+•-]$/.test(token))
    .map((token) => (/^[–−•+]/.test(token) ? token.slice(1) : token))
    .map((token) => token.replace(/[,;]+$/, ''))
    .join(' ');
}

/**
 * Kiểm chứng toàn vẹn của một bản ghi: khi `outcomes[]` đã ở dạng doc,
 * text canonical trích từ các doc (theo đúng thứ tự) PHẢI khớp
 * `outcome_text` nguyên văn theo khoá so sánh — lệch là dataset đã bị
 * sửa tay sai hoặc tách ý làm rơi/thêm chữ: ném lỗi, không nạp thầm.
 * Bản ghi còn ở dạng chuỗi (chưa chuyển đổi trong đợt #161) được bỏ
 * qua ở cổng này; bản ghi không có doc nào cũng vậy (cổng lỗi cứng
 * cho trường hợp đó nằm ở commit chốt hạ của đợt chuyển đổi).
 */
export function assertProgramRecordOutcomeIntegrity(datasetKey: string, record: ProgramRecord): void {
  if (!record.outcomes.some((outcome) => typeof outcome !== 'string')) return;
  const lines = record.outcomes.flatMap((outcome) =>
    typeof outcome === 'string' ? [outcome] : programOutcomeDocLines(outcome),
  );
  const fromOutcomes = programOutcomeComparisonKey(lines.join('\n'));
  const fromText = programOutcomeComparisonKey(record.outcome_text);
  if (fromOutcomes !== fromText) {
    throw new Error(
      `Dataset ${datasetKey}, bản ghi ${record.id}: YCCĐ dạng doc không khớp outcome_text nguyên văn ` +
        `(trích doc: "${fromOutcomes.slice(0, 120)}…" — outcome_text: "${fromText.slice(0, 120)}…"). ` +
        'Không nạp dataset lệch toàn vẹn; đối chiếu lại văn bản nguồn.',
    );
  }
}

/**
 * Các dòng YCCĐ của một bản ghi, theo thứ tự nguyên văn:
 * - Có `outcomes[]`: mỗi ý là một dòng (phần tử dạng doc cho text
 *   canonical trích bằng programOutcomeDocText; phần tử dạng chuỗi
 *   trong đợt chuyển đổi cho chính chuỗi đó).
 * - `outcomes[]` rỗng nhưng `outcome_text` có chữ (bản ghi hoạt động —
 *   nguyên văn viết dạng văn xuôi, không tách ý): đúng một dòng bằng
 *   toàn văn `outcome_text`.
 * - Cả hai rỗng (bản ghi Nội dung của Ngữ văn — toàn văn nằm ở trường
 *   nội dung của node): không có dòng nào.
 */
export function programRecordOutcomeTexts(record: ProgramRecord): string[] {
  if (record.outcomes.length > 0) {
    return record.outcomes.map((outcome) =>
      typeof outcome === 'string' ? outcome : programOutcomeDocText(outcome),
    );
  }
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
 *
 * Các dataset trích sau đợt Toán/Ngữ văn để trống một hoặc nhiều bậc
 * (stream trống thì section là bậc mang cấu trúc cao nhất, có dataset
 * cả ba bậc đều trống): bậc nào trống/null thì BỎ QUA, bậc có chữ đầu
 * tiên thành node mạch ('strand'), các bậc sau là 'topic'. Tựa giữ
 * nguyên văn, chỉ dùng bản cắt khoảng trắng để xét rỗng.
 */
export function programRecordAncestors(record: ProgramRecord): { kind: 'strand' | 'topic'; title: string }[] {
  const titles = [record.stream, record.section, record.topic]
    .filter((title): title is string => title !== null && title.trim() !== '');
  return titles.map((title, i) => ({ kind: i === 0 ? ('strand' as const) : ('topic' as const), title }));
}

/**
 * Tựa của node `lesson` cho một bản ghi: nguyên văn trường `content`.
 * Bản ghi dạng `requirement` (GDCD, TNXH, Lịch sử và Địa lí, Khoa học)
 * để `content` rỗng — toàn văn của chúng là YCCĐ, đơn vị nội dung trình
 * bày theo chủ đề — nên tựa suy xuống `topic`, rồi `section`; cả ba
 * rỗng thì dùng mã bản ghi (không xảy ra trong dataset hiện có, chỉ là
 * chốt an toàn để không bao giờ tạo node không tựa).
 */
export function programRecordTitle(record: ProgramRecord): string {
  for (const title of [record.content, record.topic, record.section]) {
    if (title !== null && title.trim() !== '') return title;
  }
  return record.id;
}

/**
 * Khối hiệu lực của một bản ghi trong cây: chính `grade` của nó. Riêng
 * 12 bản ghi chủ điểm (kind `theme`) của Tiếng Anh 3–12 mang
 * `grade = null` vì văn bản gốc trình bày phần "Nội dung khái quát"
 * theo CẤP chứ không theo lớp, trong khi cây chương trình khóa theo
 * cặp (môn, khối 1–12) — quyết định ở issue #161: neo các bản ghi đó
 * vào khối ĐẦU TIÊN của cấp của chúng trong cùng dataset (Tiểu học →
 * lớp 3, THCS → lớp 6, THPT → lớp 10 với dataset này). Các bản ghi đó
 * không mang YCCĐ nên vị trí neo không ảnh hưởng chọn YCCĐ/ma trận;
 * khi mô hình cây hỗ trợ chương trình theo cấp thì dời về đúng cấp.
 */
export function programRecordEffectiveGrade(records: readonly ProgramRecord[], record: ProgramRecord): number {
  if (record.grade !== null) return record.grade;
  const graded = records.filter((r) => r.grade !== null);
  const sameLevel = graded.filter((r) => r.level === record.level).map((r) => r.grade as number);
  const pool = sameLevel.length > 0 ? sameLevel : graded.map((r) => r.grade as number);
  return Math.min(...pool);
}

// --- Định danh xác định của dữ liệu chuẩn (phương án D, issue #161) ----------

/**
 * Namespace UUIDv5 cho TOÀN BỘ dữ liệu chuẩn do dataset sinh ra
 * (môn, chương trình, node, YCCĐ của tầng chương trình GDPT).
 *
 * ⚠️ HẰNG SỐ ĐÓNG BĂNG VĨNH VIỄN — sinh ngẫu nhiên một lần khi chuẩn
 * này được thiết lập (GDPT-SEED, 25/10/2026). Đổi giá trị này = đổi
 * mọi id của dữ liệu chuẩn ở mọi môi trường, tương đương đổi chuẩn
 * định danh; tuyệt đối không sửa, không "sinh lại cho đẹp". Căn cứ:
 * hồ sơ `gdpt-reference-data-loading-research-2026-10-25.md` mục 5.1
 * và ADR-017 (ngoại lệ dữ liệu chuẩn của ADR-013: cột vẫn giữ
 * `DEFAULT uuidv7()`, chỉ các dòng do dataset sinh ra mới mang id v5;
 * dữ liệu do người dùng tạo tay vẫn uuidv7 như mọi bảng khác).
 */
export const PROGRAM_ID_NAMESPACE = '057667e9-ad06-49ca-80ea-50756ad6c0e6';

/**
 * Id xác định của một thực thể dữ liệu chuẩn: UUIDv5 trên chuỗi
 * `<loại>|<khoá tự nhiên>` trong namespace của dự án. Cùng khoá tự
 * nhiên → cùng id ở mọi môi trường, mọi lần seed, mọi thời điểm.
 */
export function programId(kind: string, naturalKey: string): string {
  return uuidv5(`${kind}|${naturalKey}`, PROGRAM_ID_NAMESPACE);
}

/** Id xác định của môn học: khoá tự nhiên là slug (unique toàn hệ). */
export function programSubjectId(slug: string): string {
  return programId('subject', slug);
}

/** Id xác định của chương trình một khối: khoá tự nhiên là (slug môn, khối). */
export function programCurriculumId(slug: string, grade: number): string {
  return programId('curriculum', `${slug}|${grade}`);
}

/**
 * Id xác định của một node tổ tiên (mạch/chủ đề): khoá tự nhiên là
 * đường tổ tiên đầy đủ từ gốc tới chính node đó — mảng các cặp
 * [kind, title] — trong chương trình (slug, khối) của nó. Đây là cùng
 * dữ liệu mà chỉ mục cây trong bộ nhớ của tầng nạp dùng làm khoá, nay
 * nâng thành khoá định danh bền.
 */
export function programAncestorNodeId(
  slug: string,
  grade: number,
  path: readonly (readonly [kind: string, title: string])[],
): string {
  return programId('node', `${slug}|${grade}|${JSON.stringify(path)}`);
}

/** Id xác định của node nội dung (lesson) của một bản ghi: khoá tự nhiên là (dataset, mã bản ghi) — trùng khoá sổ đăng ký. */
export function programLessonNodeId(datasetKey: string, recordId: string): string {
  return programId('record', `${datasetKey}|${recordId}`);
}

/** sha256 hex của một dòng YCCĐ (đúng văn bản nguyên văn của dòng). */
export function programOutcomeTextHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Id xác định của một dòng YCCĐ của một bản ghi: khoá tự nhiên là
 * (dataset, mã bản ghi, sha256 nội dung dòng). Neo theo NỘI DUNG thay
 * vì số thứ tự: Bộ chèn một ý mới vào giữa danh sách thì các ý cũ giữ
 * nguyên id; sửa chữ một ý = id mới (ý cũ thành orphaned — xem luật
 * diff không-xoá ở ProgramImportService). Hai dòng trùng nội dung
 * hệt nhau trong cùng một bản ghi được phân biệt bằng hậu tố `#2`,
 * `#3`… theo thứ tự xuất hiện.
 */
export function programOutcomeId(datasetKey: string, recordId: string, text: string, occurrence = 1): string {
  const suffix = occurrence > 1 ? `#${occurrence}` : '';
  return programId('outcome', `${datasetKey}|${recordId}|${programOutcomeTextHash(text)}${suffix}`);
}

/**
 * Các dòng YCCĐ của một bản ghi kèm id xác định của chúng, theo đúng
 * thứ tự nguyên văn — đầu vào duy nhất của cả đường tạo mới lẫn đường
 * diff khi nạp lại. `position` là vị trí 1-based trong danh sách.
 */
export function programRecordOutcomeEntries(
  datasetKey: string,
  record: ProgramRecord,
): { id: string; text: string; position: number }[] {
  const seen = new Map<string, number>();
  return programRecordOutcomeTexts(record).map((text, i) => {
    const occurrence = (seen.get(text) ?? 0) + 1;
    seen.set(text, occurrence);
    return { id: programOutcomeId(datasetKey, record.id, text, occurrence), text, position: i + 1 };
  });
}

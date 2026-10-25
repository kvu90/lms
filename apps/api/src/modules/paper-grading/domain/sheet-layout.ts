/**
 * Hình học template phiếu trả lời CAM-0 (issue #112): MỘT nguồn sự thật
 * duy nhất cho cả ba phía — sinh PDF (vector), dựng ảnh mô phỏng (raster)
 * và engine OMR (đọc lại đúng các toạ độ này sau khi nắn phẳng). Mọi toạ
 * độ tính trong "không gian template" 1240×1754 px (A4 ở 150 dpi); phía
 * PDF đổi sang point bằng PX_PER_PT.
 *
 * Bố cục (trục y từ trên xuống):
 *  - 4 fiducial vuông đen 40×40 ở 4 góc, tâm cách biên 68px — mốc nắn
 *    phối cảnh; thiếu 1 mốc là ảnh bị cổng chất lượng từ chối.
 *  - Đầu phiếu (y 48..300): tiêu đề + tên bài bên trái; QR 240×240 ở
 *    góc phải (phiếu cá nhân hoá mang userId; phiếu dùng chung chỉ
 *    mang mã lô + mã đề).
 *  - Vùng mã (y 300..664): bên trái là lưới MÃ ĐỀ 4 cột × 10 hàng kèm
 *    hàng ô ghi chữ số phía trên (cặp ghi+tô như mẫu Bộ — học sinh ghi
 *    mã đề trên đề thi được phát rồi tô vào lưới dưới); bên phải là
 *    lưới MÃ HỌC SINH cấu hình được: 4 cột (tại lớp: 3 số thứ tự + 1
 *    số kiểm tra) hoặc 8 cột (thi thử theo phòng: 7 số thứ tự + 1 số
 *    kiểm tra, đúng độ dài SBD của Bộ). Cả hai loại phiếu giữ nguyên
 *    các vùng này để OMR dùng một template duy nhất.
 *  - Lưới đáp án (y từ 672): mỗi câu 1 hàng cao 36px, tối đa 30 hàng/cột;
 *    ≤30 câu 1 cột, 31–60 câu 2 cột, tối đa 60 câu. Bong bóng r=13,
 *    bước ngang 42px, tối đa 5 lựa chọn (A–E); câu đúng/sai in 2 bong
 *    bóng (Đ/S).
 */
export const TEMPLATE_WIDTH = 1240;
export const TEMPLATE_HEIGHT = 1754;
/** A4 = 595.28 × 841.89 pt; hệ số đổi px template → pt PDF. */
export const PX_PER_PT = TEMPLATE_WIDTH / 595.28;

export const FIDUCIAL_SIZE = 40;
export const FIDUCIAL_CENTERS: readonly { x: number; y: number }[] = [
  { x: 68, y: 68 },
  { x: TEMPLATE_WIDTH - 68, y: 68 },
  { x: 68, y: TEMPLATE_HEIGHT - 68 },
  { x: TEMPLATE_WIDTH - 68, y: TEMPLATE_HEIGHT - 68 },
];

/**
 * Vùng QR ở đầu phiếu: nằm dưới dải fiducial trên (fiducial chiếm y
 * 48..88), x từ lề phải vào. Cỡ 240px là yêu cầu đọc tin cậy: payload
 * sản xuất ~81 ký tự (hai uuid) tạo QR version 6 (41×41 module) — ở
 * 176px module chỉ ~4,3px, giải mã sau nắn phối cảnh + nhiễu rớt ngẫu
 * nhiên theo nội dung (đo thực tế 9/12); ở 240px module ~5,9px đọc ổn
 * định. Phiếu trắng giữ nguyên vùng này (khung trống) để một template
 * hình học dùng cho cả hai loại phiếu.
 */
export const QR_RECT = { x: TEMPLATE_WIDTH - 64 - 240, y: 100, size: 240 };

/** Vùng mã học sinh: lưới ô tô (chỉ dùng cho phiếu trắng/dùng chung). Số cột cấu hình theo lô: 4 (tại lớp) hoặc 8 (thi thử). */
export const CODE_DIGITS = 4;
export const SBD_DIGITS = 8;
export const CODE_ROWS = 10;
export const CODE_ORIGIN = { x: 420, y: 330 };
export const CODE_COL_STEP = 46;
export const CODE_ROW_STEP = 31;
export const CODE_BUBBLE_R = 12;

/**
 * Vùng MÃ ĐỀ trên phiếu dùng chung (giống Bộ): học sinh nhận đề mã nào
 * thì GHI chữ số vào hàng ô ghi rồi TÔ vào lưới 4 cột × 10 hàng bên
 * dưới. Lưới dịch xuống so với lưới mã học sinh để chừa hàng ô ghi
 * (y 330..358); hàng bong bóng cuối ở y 651, đáy 663 — vẫn trên lưới
 * đáp án (ANSWER_TOP 672). OMR chỉ đọc lưới tô; ô ghi là chứng cứ
 * bằng mắt cho giáo viên khi phiếu vào hàng chờ.
 */
export const VARIANT_DIGITS = 4;
export const VARIANT_ORIGIN = { x: 150, y: 372 };
export const VARIANT_WRITE_BOX = { top: 330, width: 38, height: 28 };

/** Mã học sinh: 3 số thứ tự (001–999) + 1 số kiểm tra = (d0*3 + d1*5 + d2*7) mod 10. */
export function studentCodeForIndex(index: number): string {
  if (index < 0 || index > 998) throw new Error(`student index out of range: ${index}`);
  const n = index + 1;
  const d = [Math.floor(n / 100) % 10, Math.floor(n / 10) % 10, n % 10];
  const check = (d[0]! * 3 + d[1]! * 5 + d[2]! * 7) % 10;
  return `${d[0]}${d[1]}${d[2]}${check}`;
}

export function studentCodeChecksumOk(code: string): boolean {
  if (!/^\d{4}$/.test(code)) return false;
  const d = code.split('').map((c) => Number(c));
  return (d[0]! * 3 + d[1]! * 5 + d[2]! * 7) % 10 === d[3];
}

/** Chỉ số (0-based) từ mã học sinh hợp lệ; null khi mã sai số kiểm tra/định dạng. */
export function studentIndexForCode(code: string): number | null {
  if (!studentCodeChecksumOk(code)) return null;
  const n = Number(code.slice(0, 3));
  return n >= 1 ? n - 1 : null;
}

/**
 * Mã thí sinh THI THỬ theo phòng: 8 số đúng độ dài SBD của Bộ = 7 số
 * thứ tự (0000001–9999999 theo danh sách phòng đã sắp) + 1 số kiểm
 * tra. KHÁC SBD thật của Bộ ở đúng một điểm có chủ đích: SBD Bộ là mã
 * được cấp, KHÔNG có chữ số kiểm tra (Bộ bắt sai bằng khớp danh sách
 * dự thi + đối chiếu phiếu thu bài); mã này CÓ số kiểm tra để máy bắt
 * sai ngay tại cổng đọc — định dạng bề ngoài (8 chữ số, lưới tô 8×10,
 * cặp ghi+tô) giữ y hệt Bộ cho học sinh luyện kỹ năng thi thật.
 *
 * Số kiểm tra = tổng có trọng số mod 10 trên 7 số đầu, trọng số
 * (3, 5, 7, 9, 1, 3, 5) — mọi trọng số nguyên tố cùng nhau với 10 nên
 * sai đúng một chữ số bị bắt 100%. Hoán vị hai chữ số kề bị bắt trừ
 * cặp chữ số hơn kém nhau đúng 5 (giới hạn toán học của checksum mod
 * 10 một chữ số: hiệu hai trọng số kề luôn là số chẵn); các ca đó do
 * lớp khớp roster của buổi bắt tiếp (mã phải có trong roster).
 */
export const SBD_CHECK_WEIGHTS = [3, 5, 7, 9, 1, 3, 5] as const;

export function sbdCodeForIndex(index: number): string {
  if (index < 0 || index > 9_999_998) throw new Error(`sbd index out of range: ${index}`);
  const body = String(index + 1).padStart(7, '0');
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(body[i]) * SBD_CHECK_WEIGHTS[i]!;
  return `${body}${sum % 10}`;
}

export function sbdCodeChecksumOk(code: string): boolean {
  if (!/^\d{8}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(code[i]) * SBD_CHECK_WEIGHTS[i]!;
  return sum % 10 === Number(code[7]);
}

/** Chỉ số (0-based) từ mã SBD hợp lệ; null khi mã sai số kiểm tra/định dạng. */
export function sbdIndexForCode(code: string): number | null {
  if (!sbdCodeChecksumOk(code)) return null;
  const n = Number(code.slice(0, 7));
  return n >= 1 ? n - 1 : null;
}

/** Sinh mã tô cho vị trí roster theo cấu hình số cột của lô (4 = tại lớp, 8 = thi thử SBD). */
export function codeForIndex(index: number, digits: number): string {
  return digits === SBD_DIGITS ? sbdCodeForIndex(index) : studentCodeForIndex(index);
}

/** Kiểm tra số kiểm tra của một mã đọc được theo độ dài của nó (4 hoặc 8 số). */
export function codeChecksumOk(code: string): boolean {
  if (code.length === SBD_DIGITS) return sbdCodeChecksumOk(code);
  if (code.length === CODE_DIGITS) return studentCodeChecksumOk(code);
  return false;
}

/** Chỉ số roster (0-based) từ mã hợp lệ 4 hoặc 8 số; null khi sai số kiểm tra/định dạng. */
export function indexForCode(code: string): number | null {
  if (code.length === SBD_DIGITS) return sbdIndexForCode(code);
  if (code.length === CODE_DIGITS) return studentIndexForCode(code);
  return null;
}

export const ANSWER_TOP = 672;
export const ANSWER_ROW_H = 36;
export const ANSWER_ROWS_PER_COLUMN = 30;
export const MAX_SHEET_QUESTIONS = 60;
export const BUBBLE_R = 13;
export const BUBBLE_STEP = 42;
export const MAX_OPTIONS = 5;

export interface AnswerRowGeometry {
  /** Số thứ tự câu 1-based theo thứ tự slot của đề. */
  slot: number;
  /** Tâm bong bóng theo từng lựa chọn (chiều ngang), cùng thứ tự đáp án đã in. */
  centers: { x: number; y: number }[];
  /** Vị trí nhãn số câu (góc trái hàng). */
  labelX: number;
  labelY: number;
  column: number;
}

export interface CodeCellGeometry {
  digitIndex: number;
  value: number;
  x: number;
  y: number;
}

export interface SheetGeometry {
  questionCount: number;
  columns: 1 | 2;
  rows: AnswerRowGeometry[];
  /** Số cột của lưới mã học sinh theo cấu hình lô (4 = tại lớp, 8 = thi thử SBD). */
  codeDigits: number;
  codeCells: CodeCellGeometry[];
  /** Lưới mã đề 4 cột × 10 hàng trên phiếu dùng chung (học sinh tự ghi + tô). */
  variantCodeCells: CodeCellGeometry[];
}

/**
 * Các vùng cắt trên ảnh đã nắn (toạ độ template) cho hàng chờ định
 * danh: giáo viên nhìn vùng mã đã tô + vùng họ tên viết tay để đối
 * chiếu, thay vì nhìn toàn phiếu. Web cắt các vùng này từ chính ảnh
 * warped của phiếu.
 */
export interface SheetRegion { x: number; y: number; w: number; h: number }
/** Dòng ghi họ tên + lớp viết tay ở đầu phiếu. */
export const NAME_REGION: SheetRegion = { x: 56, y: 148, w: 740, h: 104 };
/** Lưới mã học sinh (bao cả cấu hình 8 cột: x tới 742 + biên). */
export const STUDENT_CODE_REGION: SheetRegion = { x: 392, y: 296, w: 400, h: 356 };
/** Ô ghi + lưới mã đề. */
export const VARIANT_CODE_REGION: SheetRegion = { x: 100, y: 296, w: 224, h: 368 };

/** Tâm bong bóng đầu tiên của một cột: nhãn số câu chiếm 52px từ lề trái cột. */
function columnOriginX(column: number, columns: 1 | 2): number {
  if (columns === 1) return 72;
  return column === 0 ? 72 : 660;
}

/**
 * Tính hình học lưới cho một đề có các câu với số lựa chọn tương ứng.
 * optionCounts[i] = số bong bóng của câu i (2..5). Ném lỗi khi quá 60
 * câu hoặc số lựa chọn ngoài miền — sinh phiếu phải chặn ở tầng service
 * bằng mã lỗi nghiệp vụ trước khi gọi hàm này. `codeDigits` là cấu
 * hình lưới mã học sinh của lô: 4 (tại lớp) hoặc 8 (thi thử SBD).
 */
export function computeSheetGeometry(optionCounts: readonly number[], codeDigits: number = CODE_DIGITS): SheetGeometry {
  if (codeDigits !== CODE_DIGITS && codeDigits !== SBD_DIGITS) {
    throw new Error(`code digits out of range: ${codeDigits}`);
  }
  const questionCount = optionCounts.length;
  if (questionCount === 0) throw new Error('sheet needs at least one question');
  if (questionCount > MAX_SHEET_QUESTIONS) throw new Error(`sheet supports at most ${MAX_SHEET_QUESTIONS} questions`);
  for (const n of optionCounts) {
    if (n < 2 || n > MAX_OPTIONS) throw new Error(`option count out of range: ${n}`);
  }
  const columns: 1 | 2 = questionCount > ANSWER_ROWS_PER_COLUMN ? 2 : 1;
  const rows: AnswerRowGeometry[] = optionCounts.map((count, i) => {
    const column = columns === 1 ? 0 : (i < ANSWER_ROWS_PER_COLUMN ? 0 : 1);
    const rowInColumn = columns === 1 ? i : (i < ANSWER_ROWS_PER_COLUMN ? i : i - ANSWER_ROWS_PER_COLUMN);
    const y = ANSWER_TOP + rowInColumn * ANSWER_ROW_H + ANSWER_ROW_H / 2;
    const originX = columnOriginX(column, columns);
    const centers = Array.from({ length: count }, (_, k) => ({ x: originX + 52 + k * BUBBLE_STEP + BUBBLE_R, y }));
    return { slot: i + 1, centers, labelX: originX, labelY: y, column };
  });
  const codeCells: CodeCellGeometry[] = [];
  for (let digitIndex = 0; digitIndex < codeDigits; digitIndex++) {
    for (let value = 0; value < CODE_ROWS; value++) {
      codeCells.push({
        digitIndex, value,
        x: CODE_ORIGIN.x + digitIndex * CODE_COL_STEP,
        y: CODE_ORIGIN.y + value * CODE_ROW_STEP,
      });
    }
  }
  const variantCodeCells: CodeCellGeometry[] = [];
  for (let digitIndex = 0; digitIndex < VARIANT_DIGITS; digitIndex++) {
    for (let value = 0; value < CODE_ROWS; value++) {
      variantCodeCells.push({
        digitIndex, value,
        x: VARIANT_ORIGIN.x + digitIndex * CODE_COL_STEP,
        y: VARIANT_ORIGIN.y + value * CODE_ROW_STEP,
      });
    }
  }
  return { questionCount, columns, rows, codeDigits, codeCells, variantCodeCells };
}

/** Chữ cái lựa chọn theo vị trí (0=A..4=E); câu đúng/sai dùng Đ/S ở tầng trình bày PDF. */
export const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;

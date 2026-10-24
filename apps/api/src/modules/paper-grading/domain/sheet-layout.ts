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
 *  - Đầu phiếu (y 48..300): tiêu đề + tên bài bên trái; QR cá nhân hoá
 *    190×190 ở góc phải (phiếu trắng thay bằng ô trống cùng kích thước).
 *  - Vùng mã học sinh (y 320..640): phiếu cá nhân hoá in sẵn mã + tên;
 *    phiếu trắng in lưới ô tô 4 cột số (3 số thứ tự + 1 số kiểm tra) ×
 *    10 hàng. Cả hai loại phiếu giữ nguyên vùng này để OMR dùng một
 *    template duy nhất.
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
 * 48..88), x từ lề phải vào 176px. Phiếu trắng giữ nguyên vùng này
 * (khung trống) để một template hình học dùng cho cả hai loại phiếu.
 */
export const QR_RECT = { x: TEMPLATE_WIDTH - 64 - 176, y: 116, size: 176 };

/** Vùng mã học sinh: lưới ô tô 4 cột × 10 hàng (chỉ dùng cho phiếu trắng). */
export const CODE_DIGITS = 4;
export const CODE_ROWS = 10;
export const CODE_ORIGIN = { x: 420, y: 330 };
export const CODE_COL_STEP = 46;
export const CODE_ROW_STEP = 31;
export const CODE_BUBBLE_R = 12;

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
  codeCells: CodeCellGeometry[];
}

/** Tâm bong bóng đầu tiên của một cột: nhãn số câu chiếm 52px từ lề trái cột. */
function columnOriginX(column: number, columns: 1 | 2): number {
  if (columns === 1) return 72;
  return column === 0 ? 72 : 660;
}

/**
 * Tính hình học lưới cho một đề có các câu với số lựa chọn tương ứng.
 * optionCounts[i] = số bong bóng của câu i (2..5). Ném lỗi khi quá 60
 * câu hoặc số lựa chọn ngoài miền — sinh phiếu phải chặn ở tầng service
 * bằng mã lỗi nghiệp vụ trước khi gọi hàm này.
 */
export function computeSheetGeometry(optionCounts: readonly number[]): SheetGeometry {
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
  for (let digitIndex = 0; digitIndex < CODE_DIGITS; digitIndex++) {
    for (let value = 0; value < CODE_ROWS; value++) {
      codeCells.push({
        digitIndex, value,
        x: CODE_ORIGIN.x + digitIndex * CODE_COL_STEP,
        y: CODE_ORIGIN.y + value * CODE_ROW_STEP,
      });
    }
  }
  return { questionCount, columns, rows, codeCells };
}

/** Chữ cái lựa chọn theo vị trí (0=A..4=E); câu đúng/sai dùng Đ/S ở tầng trình bày PDF. */
export const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;

/**
 * Dữ liệu + quy tắc thuần của ma trận đề (Chặng 3, mục C.1/C.4 của hồ
 * sơ thiết kế). Preset là DỮ LIỆU CẤU HÌNH chụp vào ma trận lúc tạo —
 * không hard-code tỉ lệ vào logic kiểm tra: lệch tỉ lệ chỉ cảnh báo.
 */

/** Thang Đ–S mặc định theo QĐ 764: 0/1/2/3/4 ý đúng → 0/10/25/50/100% điểm chùm. */
export const TF_SCALE_QD764: number[] = [0, 10, 25, 50, 100];

/** Thang Đ–S chia đều (biến thể thực hành trường): 0/25/50/75/100%. */
export const TF_SCALE_EVEN: number[] = [0, 25, 50, 75, 100];

export interface MatrixPreset {
  targetFormPercents: Record<string, number>;
  targetLevelPercents: Record<string, number>;
}

/**
 * Tỉ lệ % ĐIỂM mục tiêu của hai preset đã chốt:
 * - CV 7991 (kiểm tra định kỳ, mẫu THPT): dạng trắc nghiệm 30 / Đ–S 20 /
 *   trả lời ngắn 20 / tự luận 30; mức Biết 40 / Hiểu 30 / Vận dụng 30.
 * - QĐ 764 (tốt nghiệp): Phần I trắc nghiệm 12 câu = 3đ (30%), Phần II
 *   Đ–S chùm = 4đ (40%), Phần III trả lời ngắn 6 câu = 3đ (30%), không
 *   tự luận; mức Biết/Hiểu/Vận dụng ≈ 40/30/30.
 */
export const MATRIX_PRESETS: Record<'cv7991_periodic' | 'qd764_graduation', MatrixPreset> = {
  cv7991_periodic: {
    targetFormPercents: { multichoice: 30, truefalse: 20, shortanswer: 20, essay: 30 },
    targetLevelPercents: { biet: 40, hieu: 30, van_dung: 30 },
  },
  qd764_graduation: {
    targetFormPercents: { multichoice: 30, truefalse: 40, shortanswer: 30, essay: 0 },
    targetLevelPercents: { biet: 40, hieu: 30, van_dung: 30 },
  },
};

/** Một thang Đ–S hợp lệ: đúng 5 phần tử 0..100, đơn điệu không giảm, phần tử cuối = 100. */
export function isValidTfScale(scale: unknown): scale is number[] {
  if (!Array.isArray(scale) || scale.length !== 5) return false;
  for (const v of scale) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) return false;
  }
  for (let i = 1; i < scale.length; i++) {
    if (scale[i]! < scale[i - 1]!) return false;
  }
  return scale[4] === 100;
}

/** Thang hiệu lực của một đề: thang riêng của đề, không có thì mặc định QĐ 764. */
export function effectiveTfScale(quizScale: number[] | null | undefined): number[] {
  return quizScale && isValidTfScale(quizScale) ? quizScale : TF_SCALE_QD764;
}

export interface MatrixCellLike {
  cognitiveLevel: string;
  qtype: string;
  questionCount: number;
  cellScore: number;
}

/**
 * Tính % điểm thực tế theo dạng và theo mức từ các ô, so với mục tiêu
 * đã chụp; trả danh sách cảnh báo (rỗng = khớp). Ngưỡng cảnh báo 0,5
 * điểm % để tránh nhiễu làm tròn. Tổng điểm các ô khác totalScore của
 * ma trận cũng là một cảnh báo (đề sinh ra sẽ quy điểm về thang của
 * quiz, nhưng ma trận lệch tổng là dấu hiệu soạn sai).
 */
export function matrixWarnings(input: {
  cells: MatrixCellLike[];
  targetFormPercents: Record<string, number> | null;
  targetLevelPercents: Record<string, number> | null;
  totalScore: number;
}): string[] {
  const warnings: string[] = [];
  const totalCellScore = input.cells.reduce((s, c) => s + c.cellScore, 0);
  if (!input.cells.length) {
    warnings.push('Ma trận chưa có ô nào.');
    return warnings;
  }
  if (Math.abs(totalCellScore - input.totalScore) > 0.001) {
    warnings.push(`Tổng điểm các ô (${round1(totalCellScore)}) khác tổng điểm đích của ma trận (${round1(input.totalScore)}).`);
  }
  const compare = (label: string, actual: Map<string, number>, target: Record<string, number> | null) => {
    if (!target) return;
    const keys = new Set([...Object.keys(target), ...actual.keys()]);
    for (const key of keys) {
      const a = actual.get(key) ?? 0;
      const t = target[key] ?? 0;
      if (Math.abs(a - t) > 0.5) {
        warnings.push(`Tỉ lệ điểm theo ${label} "${key}": thực tế ${round1(a)}% so với mục tiêu ${round1(t)}%.`);
      }
    }
  };
  const pctOf = (pick: (c: MatrixCellLike) => string) => {
    const map = new Map<string, number>();
    for (const c of input.cells) {
      const key = pick(c);
      map.set(key, (map.get(key) ?? 0) + (totalCellScore > 0 ? (c.cellScore / totalCellScore) * 100 : 0));
    }
    return map;
  };
  compare('dạng câu', pctOf((c) => c.qtype), input.targetFormPercents);
  compare('mức', pctOf((c) => c.cognitiveLevel), input.targetLevelPercents);
  return warnings;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Preset quy tắc thi theo hình thức kiểm tra (hồ sơ tổ chức thi trực
 * tuyến VN, mục 5.1 — theo TT 22 + Quy chế thi TN TT 24/2024): chọn
 * exam_kind lúc tạo quiz là ĐIỀN SẴN các trường dưới đây, giáo viên
 * vẫn sửa từng trường sau đó. Điểm theo hình thức:
 *  - thường xuyên (regular): xem điểm/đáp án/feedback NGAY SAU NỘP
 *    (bitmask = mọi cửa sổ sau nộp: 0x1110 = 4368);
 *  - định kỳ (periodic) và thi thử (mock): các khía cạnh chỉ mở ở cửa
 *    sổ SAU KHI ĐÓNG (0x10) — và mốc đóng hiệu lực cho review là
 *    max(timeClose) của cả đợt (xem reviewWindowBit);
 *  - thi thử: late_entry_minutes = 15 (Điều 21 TT 24/2024);
 *  - giám sát sự kiện (chỉ ghi nhận): định kỳ/thi thử bật, thường
 *    xuyên tắt.
 * Mật khẩu/subnet KHÔNG nằm trong preset: preset chỉ nêu kỳ vọng
 * (định kỳ/thi thử phát mật khẩu đầu buổi) — giá trị do giáo viên đặt.
 */
export type ExamKind = 'regular' | 'periodic' | 'mock';

export interface ExamKindPreset {
  attemptsAllowed: number;
  reviewMarks: number;
  reviewCorrectness: number;
  reviewSpecificFeedback: number;
  reviewGeneralFeedback: number;
  reviewRightAnswer: number;
  reviewOverallFeedback: number;
  lateEntryMinutes: number | null;
  monitorEvents: boolean;
  shuffleAnswers: boolean;
}

const REVIEW_AFTER_SUBMIT = 4368; // 0x1000 | 0x0100 | 0x0010
const REVIEW_AFTER_CLOSE_ONLY = 16; // 0x0010

export const EXAM_KIND_PRESETS: Record<ExamKind, ExamKindPreset> = {
  regular: {
    attemptsAllowed: 1,
    reviewMarks: REVIEW_AFTER_SUBMIT,
    reviewCorrectness: REVIEW_AFTER_SUBMIT,
    reviewSpecificFeedback: REVIEW_AFTER_SUBMIT,
    reviewGeneralFeedback: REVIEW_AFTER_SUBMIT,
    reviewRightAnswer: REVIEW_AFTER_SUBMIT,
    reviewOverallFeedback: REVIEW_AFTER_SUBMIT,
    lateEntryMinutes: null,
    monitorEvents: false,
    shuffleAnswers: true,
  },
  periodic: {
    attemptsAllowed: 1,
    reviewMarks: REVIEW_AFTER_CLOSE_ONLY,
    reviewCorrectness: REVIEW_AFTER_CLOSE_ONLY,
    reviewSpecificFeedback: REVIEW_AFTER_CLOSE_ONLY,
    reviewGeneralFeedback: REVIEW_AFTER_CLOSE_ONLY,
    reviewRightAnswer: REVIEW_AFTER_CLOSE_ONLY,
    reviewOverallFeedback: REVIEW_AFTER_CLOSE_ONLY,
    lateEntryMinutes: null,
    monitorEvents: true,
    shuffleAnswers: true,
  },
  mock: {
    attemptsAllowed: 1,
    reviewMarks: REVIEW_AFTER_CLOSE_ONLY,
    reviewCorrectness: REVIEW_AFTER_CLOSE_ONLY,
    reviewSpecificFeedback: REVIEW_AFTER_CLOSE_ONLY,
    reviewGeneralFeedback: REVIEW_AFTER_CLOSE_ONLY,
    reviewRightAnswer: REVIEW_AFTER_CLOSE_ONLY,
    reviewOverallFeedback: REVIEW_AFTER_CLOSE_ONLY,
    lateEntryMinutes: 15,
    monitorEvents: true,
    shuffleAnswers: true,
  },
};

/** Tên thang Đ–S để nêu BẰNG CHỮ trong trình bày review chùm (Q-a): thang mặc định gọi đúng tên văn bản, thang khác gọi là thang tuỳ chỉnh kèm các mốc %. */
export function tfScaleLabel(scale: number[]): string {
  const isQd764 = scale.length === TF_SCALE_QD764.length && scale.every((v, i) => v === TF_SCALE_QD764[i]);
  return isQd764 ? 'thang QĐ 764' : `thang tuỳ chỉnh [${scale.join('/')}]`;
}

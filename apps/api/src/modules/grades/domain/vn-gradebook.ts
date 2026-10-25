/**
 * Sổ điểm Việt Nam — domain THUẦN (không Nest, không DB), lát GB-VN-1 (issue #95).
 *
 * Oracle: Thông tư 22/2021/TT-BGDĐT (đọc nguyên văn, hồ sơ
 * `vn-gradebook-scoring-research-2026-10-24.md`):
 *  - Điều 5.3: điểm thang 10, làm tròn đến chữ số thập phân thứ nhất;
 *    một nhóm môn chỉ đánh giá bằng nhận xét (Đạt/Chưa đạt).
 *  - Điều 6.2b: số ĐĐGtx mỗi học kì suy từ số tiết/năm của môn
 *    (≤35 → 2; 35–70 → 3; >70 → 4). Môn nhận xét: 2 lần/kì (Điều 6.2a).
 *  - Điều 7.3: mỗi học kì đúng 01 ĐĐGgk + 01 ĐĐGck cho môn điểm số.
 *  - Điều 9.1b: ĐTBmhk = (TĐĐGtx + 2×ĐĐGgk + 3×ĐĐGck) / (số ĐĐGtx + 5);
 *    ĐTBmcn = (ĐTBmhkI + 2×ĐTBmhkII) / 3 — tính trên ĐTBmhk ĐÃ làm tròn.
 *  - Điều 9.2–9.3: xếp mức Tốt/Khá/Đạt/Chưa đạt trên TẤT CẢ các môn,
 *    kèm quy tắc nâng 1 mức khi mức bị hạ ≥2 mức chỉ vì duy nhất 1 môn.
 *  - TT 22 KHÔNG có khái niệm điểm liệt — không cài ngưỡng nào ngoài văn bản.
 */

/** Vai trò cột điểm TT 22 trên grade_items.vn_role (nx_* dành cho môn nhận xét, dùng đầy đủ ở GB-VN-3). */
export const VN_GRADE_ROLES = ['dgtx', 'dggk', 'dgck', 'nx_tx', 'nx_gk', 'nx_ck', 'ktdk', 'tong_hop'] as const;
export type VnGradeRole = (typeof VN_GRADE_ROLES)[number];

/** Học kì của một sổ VN. */
export const VN_TERMS = ['hk1', 'hk2'] as const;
export type VnTerm = (typeof VN_TERMS)[number];

/** Chế độ đánh giá của sổ: tt22 (trung học) | tt27 (tiểu học — GB-VN-3) | free (khoá tự do). */
export const VN_REGIMES = ['tt22', 'tt27', 'free'] as const;
export type VnRegime = (typeof VN_REGIMES)[number];

/** Môn điểm số (kết hợp nhận xét) hay môn chỉ-nhận-xét theo Điều 5.3 TT 22. */
export const VN_ASSESSMENT_MODES = ['score', 'comment'] as const;
export type VnAssessmentMode = (typeof VN_ASSESSMENT_MODES)[number];

/** Kết quả của môn chỉ-nhận-xét (Điều 5.3a). */
export const VN_COMMENT_RESULTS = ['Đạt', 'Chưa đạt'] as const;
export type VnCommentResult = (typeof VN_COMMENT_RESULTS)[number];

/**
 * Mức tổng hợp của môn/hoạt động ở tiểu học (Điều 7.1a TT 27/2020): tại mỗi
 * mốc tổng hợp, giáo viên xếp mỗi môn vào một trong ba mức này từ quá trình
 * đánh giá thường xuyên (nhận xét) + kết quả kiểm tra định kỳ. Đây là phán
 * đoán tổng hợp của giáo viên có minh chứng — hệ thống không tự tính.
 */
export const VN_TT27_LEVELS = ['Hoàn thành tốt', 'Hoàn thành', 'Chưa hoàn thành'] as const;
export type VnTt27Level = (typeof VN_TT27_LEVELS)[number];

/** Mọi giá trị kết quả nhận xét hợp lệ ở cả hai regime (cột comment_result là text; tính hợp lệ xét theo regime của sổ). */
export const VN_COMMENT_RESULT_VALUES = [...VN_COMMENT_RESULTS, ...VN_TT27_LEVELS] as const;
export type VnCommentResultValue = (typeof VN_COMMENT_RESULT_VALUES)[number];

/** Tập giá trị kết quả nhận xét hợp lệ cho một regime: tt27 dùng 3 mức Điều 7.1a; còn lại (tt22) dùng Đạt/Chưa đạt Điều 5.3a. */
export function commentResultsForRegime(regime: string): readonly string[] {
  return regime === 'tt27' ? VN_TT27_LEVELS : VN_COMMENT_RESULTS;
}

/** Giá trị kết quả nhận xét có thuộc tập hợp lệ của regime hay không. */
export function isCommentResultForRegime(regime: string, value: string): boolean {
  return commentResultsForRegime(regime).includes(value);
}

/** Bốn mức kết quả học tập (Điều 9.2), xếp từ thấp đến cao để so bậc khi áp quy tắc điều chỉnh 9.3. */
export const VN_LEVELS = ['Chưa đạt', 'Đạt', 'Khá', 'Tốt'] as const;
export type VnLevel = (typeof VN_LEVELS)[number];

/**
 * Các môn CHỈ đánh giá bằng nhận xét (Điều 5.3a TT 22), dạng tên đã chuẩn hoá
 * (thường, bỏ dấu câu thừa) để đối chiếu với tên môn trong dữ liệu chương trình.
 * Đây là dữ liệu phân biệt của GB-VN-1; luồng bề mặt đầy đủ của nhóm môn này là GB-VN-3.
 */
const COMMENT_ONLY_SUBJECT_NAMES: readonly string[] = [
  'giáo dục thể chất',
  'thể dục',
  'nghệ thuật',
  'âm nhạc',
  'mĩ thuật',
  'mỹ thuật',
  'nội dung giáo dục của địa phương',
  'nội dung giáo dục địa phương',
  'hoạt động trải nghiệm',
  'hoạt động trải nghiệm hướng nghiệp',
  'hoạt động trải nghiệm, hướng nghiệp',
];

/** Chuẩn hoá tên môn để đối chiếu: chữ thường, gộp khoảng trắng, bỏ dấu chấm cuối. */
export function normalizeSubjectName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\.+$/, '');
}

/** Môn có thuộc nhóm chỉ-nhận-xét (Điều 5.3a) hay không, theo tên môn trong chương trình GDPT. */
export function isCommentOnlySubjectName(name: string | null | undefined): boolean {
  if (!name) return false;
  const normalized = normalizeSubjectName(name);
  return COMMENT_ONLY_SUBJECT_NAMES.some(
    (candidate) => normalized === candidate || normalized.startsWith(`${candidate} `) || normalized.startsWith(`${candidate} (`),
  );
}

/**
 * Số ĐĐGtx mỗi học kì theo số tiết/năm của môn (Điều 6.2b):
 * ≤35 tiết → 2; trên 35 đến 70 → 3; trên 70 → 4.
 */
export function dgtxQuotaForPeriods(periodsPerYear: number): number {
  if (!Number.isFinite(periodsPerYear) || periodsPerYear <= 0) {
    throw new Error(`subjectPeriodsPerYear must be a positive number, got ${periodsPerYear}`);
  }
  if (periodsPerYear <= 35) return 2;
  if (periodsPerYear <= 70) return 3;
  return 4;
}

/** Số lần đánh giá ghi sổ mỗi học kì của môn chỉ-nhận-xét (Điều 6.2a): 2 lần thường xuyên + giữa kì + cuối kì (Điều 7.2). */
export const VN_COMMENT_EVALUATIONS_PER_TERM = 2;

/** Làm tròn tới 1 chữ số thập phân (Điều 5.3b) — nửa đơn vị làm tròn lên; cộng 1e-7 để chống sai số nhị phân ở biên .x5 (7,55 bị lưu thành 75,4999… khi nhân 10). */
export function round1(value: number): number {
  return Math.round(value * 10 + 1e-7) / 10;
}

/**
 * Quy đổi một điểm trên thang của hoạt động về thang 10 (Điều 5.3b: thang
 * khác phải quy đổi về thang 10) — dùng cho ứng viên điểm của GB-VN-2:
 * điểm gợi ý vào cột = (điểm − min)/(max − min) × 10, kẹp về [0, 10] rồi
 * làm tròn 1 chữ số thập phân. Ví dụ: 30/40 → 7,5; 18/20 → 9,0.
 */
export function convertGradeToScale10(value: number, gradeMin: number, gradeMax: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(gradeMin) || !Number.isFinite(gradeMax) || gradeMax <= gradeMin) {
    throw new Error(`Invalid grade range for scale-10 conversion: [${gradeMin}, ${gradeMax}]`);
  }
  const ratio = (value - gradeMin) / (gradeMax - gradeMin);
  return round1(Math.min(10, Math.max(0, ratio * 10)));
}

/** Đầu vào tính ĐTBmhk: các ĐĐGtx (mỗi điểm hệ số 1), ĐĐGgk (hệ số 2), ĐĐGck (hệ số 3). */
export interface DtbHkInput {
  dgtx: number[];
  dggk: number;
  dgck: number;
}

/**
 * ĐTBmhk = (TĐĐGtx + 2×ĐĐGgk + 3×ĐĐGck) / (số ĐĐGtx + 5) — Điều 9.1b,
 * làm tròn 1 chữ số thập phân. Ví dụ của research: ĐĐGtx 8/7/9/6, gk 7, ck 8
 * → (30 + 14 + 24)/9 = 7,555… → 7,6.
 */
export function computeDtbHk(input: DtbHkInput): number {
  if (input.dgtx.length === 0) throw new Error('ĐTBmhk requires at least one ĐĐGtx');
  const sumTx = input.dgtx.reduce((s, v) => s + v, 0);
  return round1((sumTx + 2 * input.dggk + 3 * input.dgck) / (input.dgtx.length + 5));
}

/**
 * ĐTBmcn = (ĐTBmhkI + 2×ĐTBmhkII) / 3 — Điều 9.1b. Hai đầu vào PHẢI là
 * ĐTBmhk đã làm tròn 1 chữ số thập phân (thứ tự làm tròn khoá cứng tại đây).
 */
export function computeDtbCn(dtbHk1: number, dtbHk2: number): number {
  return round1((dtbHk1 + 2 * dtbHk2) / 3);
}

/** Kết quả một môn đưa vào xếp mức chung (Điều 9.2): môn điểm số mang ĐTB (hk hoặc cn), môn nhận xét mang Đạt/Chưa đạt. */
export interface VnSubjectLevelInput {
  /** Khoá định danh môn trong lần xếp mức (để truy vết môn gây hạ mức ở quy tắc 9.3). */
  key: string;
  kind: VnAssessmentMode;
  /** ĐTB của môn điểm số (đã làm tròn); bắt buộc khi kind = 'score'. */
  dtb?: number | null;
  /** Kết quả của môn nhận xét; bắt buộc khi kind = 'comment'. */
  commentResult?: VnCommentResult | null;
}

/** Kết quả xếp mức Điều 9: mức cuối cùng, mức gốc trước điều chỉnh, và môn duy nhất gây hạ mức (nếu có điều chỉnh). */
export interface VnClassification {
  level: VnLevel;
  baseLevel: VnLevel;
  adjusted: boolean;
  adjustedDueToSubjectKey: string | null;
}

function levelIndex(level: VnLevel): number {
  return VN_LEVELS.indexOf(level);
}

/** Xếp mức gốc theo đúng điều kiện Điều 9.2, chưa áp quy tắc điều chỉnh 9.3. */
export function classifyBaseLevel(subjects: VnSubjectLevelInput[]): VnLevel {
  const score = subjects.filter((s) => s.kind === 'score');
  const comment = subjects.filter((s) => s.kind === 'comment');
  const allCommentPass = comment.every((s) => s.commentResult === 'Đạt');
  const commentFailures = comment.filter((s) => s.commentResult !== 'Đạt').length;
  const allScoreAtLeast = (threshold: number) => score.every((s) => (s.dtb ?? Number.NEGATIVE_INFINITY) >= threshold);
  const countScoreAtLeast = (threshold: number) => score.filter((s) => (s.dtb ?? Number.NEGATIVE_INFINITY) >= threshold).length;

  if (allCommentPass && allScoreAtLeast(6.5) && countScoreAtLeast(8.0) >= 6) return 'Tốt';
  if (allCommentPass && allScoreAtLeast(5.0) && countScoreAtLeast(6.5) >= 6) return 'Khá';
  if (commentFailures <= 1 && countScoreAtLeast(5.0) >= 6 && allScoreAtLeast(3.5)) return 'Đạt';
  return 'Chưa đạt';
}

/**
 * Xếp mức kết quả học tập (Điều 9.2 + 9.3): tính mức gốc; nếu bỏ đi DUY NHẤT
 * một môn mà mức tăng từ 2 mức trở lên thì mức chung được nâng lên mức liền kề
 * (chỉ nâng 1 mức, và chỉ khi đúng một môn là nguyên nhân duy nhất).
 */
export function classifyLearningLevel(subjects: VnSubjectLevelInput[]): VnClassification {
  const baseLevel = classifyBaseLevel(subjects);
  const baseIndex = levelIndex(baseLevel);
  if (baseIndex >= VN_LEVELS.length - 1 || subjects.length < 2) {
    return { level: baseLevel, baseLevel, adjusted: false, adjustedDueToSubjectKey: null };
  }
  const culprits: string[] = [];
  for (const subject of subjects) {
    const without = subjects.filter((s) => s.key !== subject.key);
    if (levelIndex(classifyBaseLevel(without)) - baseIndex >= 2) culprits.push(subject.key);
  }
  if (culprits.length === 1) {
    return {
      level: VN_LEVELS[baseIndex + 1]!,
      baseLevel,
      adjusted: true,
      adjustedDueToSubjectKey: culprits[0]!,
    };
  }
  return { level: baseLevel, baseLevel, adjusted: false, adjustedDueToSubjectKey: null };
}

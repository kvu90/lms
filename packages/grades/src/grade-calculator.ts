/**
 * GradeCalculator — domain THUẦN (không Nest, không DB), report §2.1/§3.11(2b).
 *
 * Ngữ nghĩa được port từ gradebook của Moodle (Grade aggregation, MoodleDocs):
 *  - CHUẨN HOÁ TRƯỚC: mọi điểm đều được chuyển thành một phân số theo khoảng
 *    [gradeMin, gradeMax] của item của nó TRƯỚC khi tổng hợp; kết quả của category là
 *    phân số đó được chiếu lên khoảng của chính category.
 *  - Natural (mặc định): trọng số tỉ lệ theo max của item. Max của category
 *    là TỔNG của (max-min) của các item con không phải extra-credit của nó. Khi
 *    giáo viên ghi đè một trọng số, phần trăm còn lại được phân phối lại
 *    cho các item không bị ghi đè theo tỉ lệ (max-min) của chúng, để
 *    trọng số hiệu lực luôn cộng đủ 100%.
 *  - Extra credit (chỉ Natural): điểm của item được tính vào tử số
 *    nhưng max của nó KHÔNG được tính vào mẫu số; kết quả bị chặn trên tại
 *    max của category.
 *  - Điểm trống ≠ 0: với aggregateOnlyGraded ("exclude empty grades") một
 *    item chưa có điểm rời khỏi CẢ tử số và mẫu số; không có nó, một
 *    điểm trống được tính là gradeMin ở tử số và giữ max của nó ở
 *    mẫu số.
 *  - drop-the-lowest / keep-the-highest áp dụng cho các điểm đã chuẩn hoá của
 *    các item không phải extra-credit.
 *  - multiplicator/offset điều chỉnh một điểm thô TRƯỚC khi chuẩn hoá
 *    (adjusted = raw * multiplicator + offset, được clamp vào khoảng của item).
 *  - FREEZE (đóng băng): một điểm đã bị đóng băng mang frozenFinalGrade của nó; bộ
 *    tính dùng nguyên văn giá trị đó và bỏ qua multiplicator/offset — một thay đổi
 *    công thức về sau không bao giờ viết lại được lịch sử (nhóm lỗi MDL-89497).
 *  - điểm excluded không bao giờ tham gia; điểm hidden VẪN tham gia
 *    (ẩn là một quy tắc hiển thị trong Moodle, không phải quy tắc tổng hợp).
 *  - xử lý overridden/locked nằm ở tầng service: một finalGrade đã bị ghi đè
 *    không bao giờ được tính lại, nên service đơn giản là không đưa
 *    điểm category/course đã bị ghi đè trở lại qua đây.
 */

/**
 * Chiến lược tổng hợp điểm của category: trung bình có trọng số (weightedmean), trung bình đơn giản, tự nhiên (natural — theo gradeMax), trung vị, điểm cao nhất/thấp nhất, mode, tổng.
 * Khớp aggregation của Moodle grade category (grade/classes).
 */
export type AggregationStrategy =
  | 'natural' | 'mean' | 'weightedmean' | 'simpleweightedmean'
  | 'median' | 'lowest' | 'highest' | 'mode' | 'sum';

export const AGGREGATIONS: AggregationStrategy[] = [
  'natural', 'mean', 'weightedmean', 'simpleweightedmean', 'median', 'lowest', 'highest', 'mode', 'sum',
];

/**
 * Đầu vào tính điểm của một grade item: điểm thô, gradeMin/gradeMax, hệ số (aggregationCoef), extra credit, ẩn.
 */
export interface CalcItemInput {
  itemId: string;
  gradeMin: number;
  gradeMax: number;
  /** Điểm đã lưu (điểm thô đối với item lá; điểm final đã tổng hợp đối với subcategory). Null = trống. */
  grade: number | null;
  excluded?: boolean;
  extraCredit?: boolean;
  /** Natural: trọng số do giáo viên điều chỉnh (phần trăm) — chỉ có ý nghĩa khi weightOverride là true. */
  weightOverride?: boolean;
  weight?: number;
  /** Trọng số của weighted-mean (aggregationCoef); mặc định là 1. */
  aggregationCoef?: number;
  multiplicator?: number;
  offset?: number;
  /** Khi là true, `grade` là final grade đã đóng băng và multiplicator/offset PHẢI bị bỏ qua. */
  frozen?: boolean;
}

/**
 * Đầu vào tính một category: danh sách item con (kèm kết quả category con) và chiến lược tổng hợp.
 */
export interface CategoryCalcInput {
  aggregation: AggregationStrategy;
  /** Khoảng của category đối với các chiến lược không phải natural (mặc định của Moodle là 0..100). Đối với natural, max được suy ra. */
  gradeMin: number;
  gradeMax: number;
  dropLow?: number;
  keepHigh?: number;
  aggregateOnlyGraded?: boolean;
  items: CalcItemInput[];
}

/**
 * Kết quả tính category: finalGrade đã chuẩn hoá về thang của category, kèm chi tiết từng item để hiển thị sổ điểm.
 */
export interface CategoryCalcResult {
  /** Null khi không có gì để tổng hợp (không có điểm nào dùng được). */
  finalGrade: number | null;
  gradeMin: number;
  gradeMax: number;
  /** Trọng số hiệu lực (phần trăm, cộng đủ 100 trên các item không phải extra) theo itemId — chiến lược natural. */
  weights: Record<string, number>;
  /** Phân số đã chuẩn hoá trong [0,1] trước khi chiếu thang (null khi finalGrade là null). */
  fraction: number | null;
}

const EPS = 1e-9;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Áp multiplicator/offset (trừ khi đã đóng băng) và clamp vào khoảng của item. */
/**
 * Chuẩn hoá điểm của item về thang 0..1 theo gradeMin/gradeMax; item ẩn hoặc chưa có điểm trả null (không tính vào tổng hợp).
 */
export function adjustedGrade(item: CalcItemInput): number | null {
  if (item.grade === null || item.grade === undefined) return null;
  if (item.frozen) return clamp(item.grade, item.gradeMin, item.gradeMax);
  const mult = item.multiplicator ?? 1;
  const off = item.offset ?? 0;
  return clamp(item.grade * mult + off, item.gradeMin, item.gradeMax);
}

function norm(item: CalcItemInput, adjusted: number): number {
  const range = item.gradeMax - item.gradeMin;
  if (range <= 0) return 0;
  return (adjusted - item.gradeMin) / range;
}

interface Prepared {
  item: CalcItemInput;
  adjusted: number;
  fraction: number;
  isExtra: boolean;
}

/** Trọng số hiệu lực của natural: các item bị ghi đè giữ nguyên trọng số của chúng; phần còn lại của 100% được chia theo (max-min). */
/**
 * Trọng số “tự nhiên” của Moodle: mỗi item đóng góp tỉ lệ theo (gradeMax - gradeMin) của nó sau khi chuẩn hoá, extra credit không làm tăng mẫu số.
 */
export function naturalWeights(items: CalcItemInput[]): Record<string, number> {
  const nonExtra = items.filter((i) => !i.extraCredit);
  const weights: Record<string, number> = {};
  const overridden = nonExtra.filter((i) => i.weightOverride);
  const rest = nonExtra.filter((i) => !i.weightOverride);
  const usedByOverride = overridden.reduce((s, i) => s + (i.weight ?? 0), 0);
  for (const i of overridden) weights[i.itemId] = i.weight ?? 0;
  const remaining = Math.max(0, 100 - usedByOverride);
  const restRange = rest.reduce((s, i) => s + Math.max(0, i.gradeMax - i.gradeMin), 0);
  for (const i of rest) {
    weights[i.itemId] = restRange > 0 ? (remaining * Math.max(0, i.gradeMax - i.gradeMin)) / restRange : (rest.length ? remaining / rest.length : 0);
  }
  // Các item extra-credit nhận một trọng số mang tính thông tin tỉ lệ theo khoảng của các item không phải extra (không thuộc phần 100%).
  const nonExtraRange = nonExtra.reduce((s, i) => s + Math.max(0, i.gradeMax - i.gradeMin), 0);
  for (const i of items) {
    if (i.extraCredit) {
      weights[i.itemId] = i.weightOverride ? (i.weight ?? 0)
        : nonExtraRange > 0 ? (100 * Math.max(0, i.gradeMax - i.gradeMin)) / nonExtraRange : 0;
    }
  }
  return weights;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mode(values: number[]): number {
  const counts = new Map<string, { value: number; count: number }>();
  for (const v of values) {
    const key = v.toFixed(9);
    const entry = counts.get(key) ?? { value: v, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  let best: { value: number; count: number } | undefined;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best?.value ?? 0;
}

/**
 * Tính điểm category theo chiến lược tổng hợp: chuẩn hoá từng item, áp trọng số/hệ số, xử lý extra credit (chỉ cộng tử số), drop-lowest nếu cấu hình, rồi chiếu về thang điểm của category.
 * Đối chiếu Moodle: grade/lib.php grade_category::compute và bộ test PHPUnit của gradebook.
 */
export function calculateCategory(input: CategoryCalcInput): CategoryCalcResult {
  const dropLow = Math.max(0, input.dropLow ?? 0);
  const keepHigh = Math.max(0, input.keepHigh ?? 0);

  // 1. Chuẩn bị: loại bỏ excluded; xử lý điểm trống theo chính sách; điều chỉnh + chuẩn hoá.
  const prepared: Prepared[] = [];
  for (const item of input.items) {
    if (item.excluded) continue;
    const adjusted = adjustedGrade(item);
    if (adjusted === null) {
      if (input.aggregateOnlyGraded) continue; // điểm trống rời khỏi tử số VÀ mẫu số
      // Điểm trống được tính là gradeMin (fraction 0) nhưng giữ nguyên trọng số/max của nó.
      prepared.push({ item, adjusted: item.gradeMin, fraction: 0, isExtra: !!item.extraCredit });
    } else {
      prepared.push({ item, adjusted, fraction: norm(item, adjusted), isExtra: !!item.extraCredit });
    }
  }

  const nonExtraAll = input.items.filter((i) => !i.excluded && !i.extraCredit);
  // Max cấu trúc cho natural/sum: tổng của (max-min) của mọi item không phải extra (các item bị loại vì trống vẫn xác định thang).
  const structuralRange = nonExtraAll.reduce((s, i) => s + Math.max(0, i.gradeMax - i.gradeMin), 0);

  let weights: Record<string, number> = {};
  if (input.aggregation === 'natural') {
    weights = naturalWeights(prepared.map((p) => p.item));
  }

  if (prepared.length === 0) {
    const gradeMax = input.aggregation === 'natural' || input.aggregation === 'sum'
      ? input.gradeMin + structuralRange : input.gradeMax;
    return { finalGrade: null, gradeMin: input.gradeMin, gradeMax, weights, fraction: null };
  }

  // 2. Drop lowest / keep highest trên các điểm đã chuẩn hoá không phải extra.
  let main = prepared.filter((p) => !p.isExtra);
  const extras = prepared.filter((p) => p.isExtra);
  if (keepHigh > 0 && main.length > keepHigh) {
    main = [...main].sort((a, b) => b.fraction - a.fraction).slice(0, keepHigh);
  }
  if (dropLow > 0 && main.length > dropLow) {
    main = [...main].sort((a, b) => a.fraction - b.fraction).slice(dropLow);
  }

  // 3. Tổng hợp các phân số theo chiến lược.
  let fraction: number | null = null;
  let gradeMax = input.gradeMax;
  let gradeMin = input.gradeMin;

  switch (input.aggregation) {
    case 'natural': {
      gradeMin = input.gradeMin;
      gradeMax = input.gradeMin + structuralRange;
      const anyOverride = main.some((p) => p.item.weightOverride) || extras.some((p) => p.item.weightOverride);
      if (!anyOverride) {
        const denom = main.reduce((s, p) => s + Math.max(0, p.item.gradeMax - p.item.gradeMin), 0);
        const numer = main.reduce((s, p) => s + (p.adjusted - p.item.gradeMin), 0)
          + extras.reduce((s, p) => s + (p.adjusted - p.item.gradeMin), 0);
        fraction = denom > 0 ? numer / denom : (extras.length ? 1 : null);
        // Với exclude-empty, main chỉ chứa các item đã có điểm: numer/denom là
        // phân số của phần đã có điểm, sau đó được chiếu lên structural max ở dưới.
        if (fraction === null) break;
      } else {
        const w = naturalWeights([...main, ...extras].map((p) => p.item));
        weights = w;
        const numer = main.reduce((s, p) => s + p.fraction * (w[p.item.itemId] ?? 0), 0)
          + extras.reduce((s, p) => s + p.fraction * (w[p.item.itemId] ?? 0), 0);
        fraction = numer / 100;
      }
      break;
    }
    case 'sum': {
      gradeMin = input.gradeMin;
      gradeMax = input.gradeMin + structuralRange;
      const total = main.reduce((s, p) => s + (p.adjusted - p.item.gradeMin), 0)
        + extras.reduce((s, p) => s + (p.adjusted - p.item.gradeMin), 0);
      fraction = structuralRange > 0 ? total / structuralRange : null;
      if (fraction !== null) {
        const finalGrade = clamp(input.gradeMin + total, gradeMin, gradeMax);
        return { finalGrade, gradeMin, gradeMax, weights, fraction: structuralRange > 0 ? (finalGrade - gradeMin) / structuralRange : 0 };
      }
      break;
    }
    case 'mean': {
      if (main.length) fraction = main.reduce((s, p) => s + p.fraction, 0) / main.length;
      break;
    }
    case 'weightedmean': {
      const denom = main.reduce((s, p) => s + (p.item.aggregationCoef ?? p.item.weight ?? 1), 0);
      if (main.length && denom > 0) {
        fraction = main.reduce((s, p) => s + p.fraction * (p.item.aggregationCoef ?? p.item.weight ?? 1), 0) / denom;
      }
      break;
    }
    case 'simpleweightedmean': {
      const denom = main.reduce((s, p) => s + Math.max(0, p.item.gradeMax - p.item.gradeMin), 0);
      if (main.length && denom > 0) {
        fraction = main.reduce((s, p) => s + p.fraction * Math.max(0, p.item.gradeMax - p.item.gradeMin), 0) / denom;
      }
      break;
    }
    case 'median': if (main.length) fraction = median(main.map((p) => p.fraction)); break;
    case 'lowest': if (main.length) fraction = Math.min(...main.map((p) => p.fraction)); break;
    case 'highest': if (main.length) fraction = Math.max(...main.map((p) => p.fraction)); break;
    case 'mode': if (main.length) fraction = mode(main.map((p) => p.fraction)); break;
  }

  if (fraction === null) return { finalGrade: null, gradeMin, gradeMax, weights, fraction: null };
  // Extra credit có thể đẩy vượt quá 1 — max của category là giới hạn cứng (trừ việc nó
  // không bao giờ có thể hạ một điểm đạt được hợp lệ xuống dưới khoảng).
  const capped = clamp(fraction, 0, 1);
  const finalGrade = gradeMin + capped * (gradeMax - gradeMin);
  void EPS;
  return { finalGrade, gradeMin, gradeMax, weights, fraction: capped };
}

/** Letter cho một điểm: phần trăm theo khoảng của item được đối chiếu với các biên (biên cao nhất <= pct sẽ thắng). */
/**
 * Ánh xạ điểm phần trăm sang chữ cái (letter) theo bảng grade letters của khoá học; biên dưới của mỗi khoảng là bao hàm.
 */
export function letterForGrade(
  finalGrade: number, gradeMin: number, gradeMax: number,
  letters: { letter: string; lowerBoundary: number }[],
): string | null {
  if (!letters.length || gradeMax <= gradeMin) return null;
  const pct = ((finalGrade - gradeMin) / (gradeMax - gradeMin)) * 100;
  const sorted = [...letters].sort((a, b) => b.lowerBoundary - a.lowerBoundary);
  for (const l of sorted) {
    if (pct >= l.lowerBoundary - EPS) return l.letter;
  }
  return null;
}

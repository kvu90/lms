/**
 * GradeCalculator — PURE domain (no Nest, no DB), report §2.1/§3.11(2b).
 *
 * Semantics ported from Moodle's gradebook (Grade aggregation, MoodleDocs):
 *  - NORMALISE FIRST: every grade is converted to a fraction of its item's
 *    [gradeMin, gradeMax] BEFORE aggregation; the category result is that
 *    fraction scaled onto the category's own range.
 *  - Natural (default): weights are relative to item max. The category max
 *    is the SUM of the (max-min) of its non-extra-credit children. When a
 *    teacher overrides a weight, the remaining percentage is redistributed
 *    over the non-overridden items in proportion to their (max-min), so the
 *    effective weights always sum to 100%.
 *  - Extra credit (Natural only): the item's grade counts in the numerator
 *    but its max does NOT count in the denominator; the result is capped at
 *    the category max.
 *  - Empty grade ≠ 0: with aggregateOnlyGraded ("exclude empty grades") an
 *    ungraded item leaves BOTH numerator and denominator; without it, an
 *    empty grade counts as gradeMin in the numerator and keeps its max in
 *    the denominator.
 *  - drop-the-lowest / keep-the-highest apply to the normalised grades of
 *    non-extra-credit items.
 *  - multiplicator/offset adjust a raw grade BEFORE normalisation
 *    (adjusted = raw * multiplicator + offset, clamped to the item range).
 *  - FREEZE: a grade that was frozen carries its frozenFinalGrade; the
 *    calculator uses it verbatim and ignores multiplicator/offset — a later
 *    formula change can never rewrite history (MDL-89497 class of bug).
 *  - excluded grades never participate; hidden grades DO participate
 *    (hiding is a display rule in Moodle, not an aggregation rule).
 *  - overridden/locked handling lives in the service layer: an overridden
 *    finalGrade is never recomputed, so the service simply does not feed
 *    overridden category/course grades back through here.
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
  /** The stored grade (raw for leaf items; already-aggregated final for subcategories). Null = empty. */
  grade: number | null;
  excluded?: boolean;
  extraCredit?: boolean;
  /** Natural: teacher-adjusted weight (percent) — only meaningful when weightOverride is true. */
  weightOverride?: boolean;
  weight?: number;
  /** Weighted-mean weight (aggregationCoef); defaults to 1. */
  aggregationCoef?: number;
  multiplicator?: number;
  offset?: number;
  /** When true, `grade` is the frozen final grade and multiplicator/offset MUST be ignored. */
  frozen?: boolean;
}

/**
 * Đầu vào tính một category: danh sách item con (kèm kết quả category con) và chiến lược tổng hợp.
 */
export interface CategoryCalcInput {
  aggregation: AggregationStrategy;
  /** Category range for non-natural strategies (Moodle default 0..100). For natural the max is derived. */
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
  /** Null when there is nothing to aggregate (no usable grades). */
  finalGrade: number | null;
  gradeMin: number;
  gradeMax: number;
  /** Effective weight (percent, sums to 100 over non-extra items) per itemId — natural strategy. */
  weights: Record<string, number>;
  /** Normalised fraction in [0,1] before scaling (null when finalGrade is null). */
  fraction: number | null;
}

const EPS = 1e-9;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Apply multiplicator/offset (unless frozen) and clamp into the item range. */
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

/** Natural effective weights: overridden items keep their weight; the rest of 100% is split by (max-min). */
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
  // Extra-credit items get an informational weight relative to the non-extra range (not part of the 100%).
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

  // 1. Prepare: drop excluded; resolve empties per policy; adjust + normalise.
  const prepared: Prepared[] = [];
  for (const item of input.items) {
    if (item.excluded) continue;
    const adjusted = adjustedGrade(item);
    if (adjusted === null) {
      if (input.aggregateOnlyGraded) continue; // empty leaves numerator AND denominator
      // Empty counts as gradeMin (fraction 0) but keeps its weight/max.
      prepared.push({ item, adjusted: item.gradeMin, fraction: 0, isExtra: !!item.extraCredit });
    } else {
      prepared.push({ item, adjusted, fraction: norm(item, adjusted), isExtra: !!item.extraCredit });
    }
  }

  const nonExtraAll = input.items.filter((i) => !i.excluded && !i.extraCredit);
  // Structural max for natural/sum: sum of (max-min) of every non-extra item (empty-excluded items still define the scale).
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

  // 2. Drop lowest / keep highest over non-extra normalised grades.
  let main = prepared.filter((p) => !p.isExtra);
  const extras = prepared.filter((p) => p.isExtra);
  if (keepHigh > 0 && main.length > keepHigh) {
    main = [...main].sort((a, b) => b.fraction - a.fraction).slice(0, keepHigh);
  }
  if (dropLow > 0 && main.length > dropLow) {
    main = [...main].sort((a, b) => a.fraction - b.fraction).slice(dropLow);
  }

  // 3. Aggregate fractions by strategy.
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
        // With exclude-empty, main only holds graded items: numer/denom is the
        // graded fraction, then scaled onto the structural max below.
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
  // Extra credit can push above 1 — the category max is a hard cap (except it
  // can never reduce a legitimately earned grade below the range).
  const capped = clamp(fraction, 0, 1);
  const finalGrade = gradeMin + capped * (gradeMax - gradeMin);
  void EPS;
  return { finalGrade, gradeMin, gradeMax, weights, fraction: capped };
}

/** Letter for a grade: percentage of the item range matched against boundaries (highest boundary <= pct wins). */
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

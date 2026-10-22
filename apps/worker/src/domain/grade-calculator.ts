/**
 * GradeCalculator — PURE domain (no Nest, no DB), report §2.1/§3.11(2b).
 * WORKER COPY of apps/api/src/modules/grades/domain/grade-calculator.ts —
 * the worker is a separate process with its own schema subset;
 * keep the two copies in sync. Golden arithmetic tests live in the api copy.
 *
 * Semantics ported from Moodle's gradebook (Grade aggregation, MoodleDocs):
 *  - NORMALISE FIRST: every grade is converted to a fraction of its item's
 *    [grademin, grademax] BEFORE aggregation; the category result is that
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
 *    empty grade counts as grademin in the numerator and keeps its max in
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
 *    finalgrade is never recomputed, so the service simply does not feed
 *    overridden category/course grades back through here.
 */

/**
 * Chiến lược tổng hợp điểm của category (bản worker — cùng semantics với bản ở apps/api, dùng cho tiến trình regrade nền).
 */
export type AggregationStrategy =
  | 'natural' | 'mean' | 'weightedmean' | 'simpleweightedmean'
  | 'median' | 'lowest' | 'highest' | 'mode' | 'sum';

export const AGGREGATIONS: AggregationStrategy[] = [
  'natural', 'mean', 'weightedmean', 'simpleweightedmean', 'median', 'lowest', 'highest', 'mode', 'sum',
];

export interface CalcItemInput {
  itemId: number;
  grademin: number;
  grademax: number;
  /** The stored grade (raw for leaf items; already-aggregated final for subcategories). Null = empty. */
  grade: number | null;
  excluded?: boolean;
  extracredit?: boolean;
  /** Natural: teacher-adjusted weight (percent) — only meaningful when weightOverride is true. */
  weightOverride?: boolean;
  weight?: number;
  /** Weighted-mean weight (aggregationcoef); defaults to 1. */
  aggregationcoef?: number;
  multiplicator?: number;
  offset?: number;
  /** When true, `grade` is the frozen final grade and multiplicator/offset MUST be ignored. */
  frozen?: boolean;
}

export interface CategoryCalcInput {
  aggregation: AggregationStrategy;
  /** Category range for non-natural strategies (Moodle default 0..100). For natural the max is derived. */
  grademin: number;
  grademax: number;
  droplow?: number;
  keephigh?: number;
  aggregateOnlyGraded?: boolean;
  items: CalcItemInput[];
}

export interface CategoryCalcResult {
  /** Null when there is nothing to aggregate (no usable grades). */
  finalgrade: number | null;
  grademin: number;
  grademax: number;
  /** Effective weight (percent, sums to 100 over non-extra items) per itemId — natural strategy. */
  weights: Record<number, number>;
  /** Normalised fraction in [0,1] before scaling (null when finalgrade is null). */
  fraction: number | null;
}

const EPS = 1e-9;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Apply multiplicator/offset (unless frozen) and clamp into the item range. */
/**
 * Chuẩn hoá điểm item về thang 0..1; null khi ẩn/chưa có điểm.
 */
export function adjustedGrade(item: CalcItemInput): number | null {
  if (item.grade === null || item.grade === undefined) return null;
  if (item.frozen) return clamp(item.grade, item.grademin, item.grademax);
  const mult = item.multiplicator ?? 1;
  const off = item.offset ?? 0;
  return clamp(item.grade * mult + off, item.grademin, item.grademax);
}

function norm(item: CalcItemInput, adjusted: number): number {
  const range = item.grademax - item.grademin;
  if (range <= 0) return 0;
  return (adjusted - item.grademin) / range;
}

interface Prepared {
  item: CalcItemInput;
  adjusted: number;
  fraction: number;
  isExtra: boolean;
}

/** Natural effective weights: overridden items keep their weight; the rest of 100% is split by (max-min). */
/**
 * Trọng số tự nhiên theo (grademax - grademin) đã chuẩn hoá; extra credit không tăng mẫu số.
 */
export function naturalWeights(items: CalcItemInput[]): Record<number, number> {
  const nonExtra = items.filter((i) => !i.extracredit);
  const weights: Record<number, number> = {};
  const overridden = nonExtra.filter((i) => i.weightOverride);
  const rest = nonExtra.filter((i) => !i.weightOverride);
  const usedByOverride = overridden.reduce((s, i) => s + (i.weight ?? 0), 0);
  for (const i of overridden) weights[i.itemId] = i.weight ?? 0;
  const remaining = Math.max(0, 100 - usedByOverride);
  const restRange = rest.reduce((s, i) => s + Math.max(0, i.grademax - i.grademin), 0);
  for (const i of rest) {
    weights[i.itemId] = restRange > 0 ? (remaining * Math.max(0, i.grademax - i.grademin)) / restRange : (rest.length ? remaining / rest.length : 0);
  }
  // Extra-credit items get an informational weight relative to the non-extra range (not part of the 100%).
  const nonExtraRange = nonExtra.reduce((s, i) => s + Math.max(0, i.grademax - i.grademin), 0);
  for (const i of items) {
    if (i.extracredit) {
      weights[i.itemId] = i.weightOverride ? (i.weight ?? 0)
        : nonExtraRange > 0 ? (100 * Math.max(0, i.grademax - i.grademin)) / nonExtraRange : 0;
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
 * Tính điểm category theo chiến lược tổng hợp — bản worker dùng khi tính lại điểm hàng loạt (regrade).
 */
export function calculateCategory(input: CategoryCalcInput): CategoryCalcResult {
  const droplow = Math.max(0, input.droplow ?? 0);
  const keephigh = Math.max(0, input.keephigh ?? 0);

  // 1. Prepare: drop excluded; resolve empties per policy; adjust + normalise.
  const prepared: Prepared[] = [];
  for (const item of input.items) {
    if (item.excluded) continue;
    const adjusted = adjustedGrade(item);
    if (adjusted === null) {
      if (input.aggregateOnlyGraded) continue; // empty leaves numerator AND denominator
      // Empty counts as grademin (fraction 0) but keeps its weight/max.
      prepared.push({ item, adjusted: item.grademin, fraction: 0, isExtra: !!item.extracredit });
    } else {
      prepared.push({ item, adjusted, fraction: norm(item, adjusted), isExtra: !!item.extracredit });
    }
  }

  const nonExtraAll = input.items.filter((i) => !i.excluded && !i.extracredit);
  // Structural max for natural/sum: sum of (max-min) of every non-extra item (empty-excluded items still define the scale).
  const structuralRange = nonExtraAll.reduce((s, i) => s + Math.max(0, i.grademax - i.grademin), 0);

  let weights: Record<number, number> = {};
  if (input.aggregation === 'natural') {
    weights = naturalWeights(prepared.map((p) => p.item));
  }

  if (prepared.length === 0) {
    const grademax = input.aggregation === 'natural' || input.aggregation === 'sum'
      ? input.grademin + structuralRange : input.grademax;
    return { finalgrade: null, grademin: input.grademin, grademax, weights, fraction: null };
  }

  // 2. Drop lowest / keep highest over non-extra normalised grades.
  let main = prepared.filter((p) => !p.isExtra);
  const extras = prepared.filter((p) => p.isExtra);
  if (keephigh > 0 && main.length > keephigh) {
    main = [...main].sort((a, b) => b.fraction - a.fraction).slice(0, keephigh);
  }
  if (droplow > 0 && main.length > droplow) {
    main = [...main].sort((a, b) => a.fraction - b.fraction).slice(droplow);
  }

  // 3. Aggregate fractions by strategy.
  let fraction: number | null = null;
  let grademax = input.grademax;
  let grademin = input.grademin;

  switch (input.aggregation) {
    case 'natural': {
      grademin = input.grademin;
      grademax = input.grademin + structuralRange;
      const anyOverride = main.some((p) => p.item.weightOverride) || extras.some((p) => p.item.weightOverride);
      if (!anyOverride) {
        const denom = main.reduce((s, p) => s + Math.max(0, p.item.grademax - p.item.grademin), 0);
        const numer = main.reduce((s, p) => s + (p.adjusted - p.item.grademin), 0)
          + extras.reduce((s, p) => s + (p.adjusted - p.item.grademin), 0);
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
      grademin = input.grademin;
      grademax = input.grademin + structuralRange;
      const total = main.reduce((s, p) => s + (p.adjusted - p.item.grademin), 0)
        + extras.reduce((s, p) => s + (p.adjusted - p.item.grademin), 0);
      fraction = structuralRange > 0 ? total / structuralRange : null;
      if (fraction !== null) {
        const finalgrade = clamp(input.grademin + total, grademin, grademax);
        return { finalgrade, grademin, grademax, weights, fraction: structuralRange > 0 ? (finalgrade - grademin) / structuralRange : 0 };
      }
      break;
    }
    case 'mean': {
      if (main.length) fraction = main.reduce((s, p) => s + p.fraction, 0) / main.length;
      break;
    }
    case 'weightedmean': {
      const denom = main.reduce((s, p) => s + (p.item.aggregationcoef ?? p.item.weight ?? 1), 0);
      if (main.length && denom > 0) {
        fraction = main.reduce((s, p) => s + p.fraction * (p.item.aggregationcoef ?? p.item.weight ?? 1), 0) / denom;
      }
      break;
    }
    case 'simpleweightedmean': {
      const denom = main.reduce((s, p) => s + Math.max(0, p.item.grademax - p.item.grademin), 0);
      if (main.length && denom > 0) {
        fraction = main.reduce((s, p) => s + p.fraction * Math.max(0, p.item.grademax - p.item.grademin), 0) / denom;
      }
      break;
    }
    case 'median': if (main.length) fraction = median(main.map((p) => p.fraction)); break;
    case 'lowest': if (main.length) fraction = Math.min(...main.map((p) => p.fraction)); break;
    case 'highest': if (main.length) fraction = Math.max(...main.map((p) => p.fraction)); break;
    case 'mode': if (main.length) fraction = mode(main.map((p) => p.fraction)); break;
  }

  if (fraction === null) return { finalgrade: null, grademin, grademax, weights, fraction: null };
  // Extra credit can push above 1 — the category max is a hard cap (except it
  // can never reduce a legitimately earned grade below the range).
  const capped = clamp(fraction, 0, 1);
  const finalgrade = grademin + capped * (grademax - grademin);
  void EPS;
  return { finalgrade, grademin, grademax, weights, fraction: capped };
}

/** Letter for a grade: percentage of the item range matched against boundaries (highest boundary <= pct wins). */
/**
 * Ánh xạ điểm phần trăm sang chữ cái theo bảng grade letters.
 */
export function letterForGrade(
  finalgrade: number, grademin: number, grademax: number,
  letters: { letter: string; lowerboundary: number }[],
): string | null {
  if (!letters.length || grademax <= grademin) return null;
  const pct = ((finalgrade - grademin) / (grademax - grademin)) * 100;
  const sorted = [...letters].sort((a, b) => b.lowerboundary - a.lowerboundary);
  for (const l of sorted) {
    if (pct >= l.lowerboundary - EPS) return l.letter;
  }
  return null;
}

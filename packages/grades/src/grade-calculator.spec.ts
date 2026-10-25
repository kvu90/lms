import { describe, expect, it } from 'vitest';
import { calculateCategory, letterForGrade, type CalcItemInput } from './grade-calculator.js';

/**
 * GOLDEN GRADEBOOK (§3.11b) — pure-domain arithmetic.
 *
 * Verbatim MoodleDocs "Grade aggregation" examples (docs.moodle.org,
 * Grade_aggregation; read via the MoodleDocs mirror indexed 2026-10-22):
 *  - Natural: "A1 70/100, A2 20/80, A3 10/10, without forcing weights:
 *    A: (70 + 20 + 10)/(100 + 80 + 10) --> 100/190"
 *  - Extra credit: Item 1 (0-100, extra credit) + Item 2 (0-75); grades 20
 *    and 70 ⇒ "Category 1's total will be graded 0-75 … 75/75 (20+70 = 90
 *    but … it brings the total to its maximum)".
 *  - Lowest: "A1 70/100, A2 20/80, A3 10/10, category max 100:
 *    min(0.7, 0.25, 1.0) = 0.25 --> 25/100"
 *  - Highest: same set ⇒ "max(0.7, 0.25, 1.0) = 1.0 --> 100/100"
 *  - Mode: "A1 70/100, A2 35/50, A3 20/80, A4 10/10, A5 7/10 …
 *    mode(0.7, 0.7, 0.25, 1.0, 0.7) = 0.7 --> 70/100"
 *  - Weighted mean worked example (MoodleDocs-derived teaching material):
 *    grades 90%, 70%, 85%, 89% with weights 1,2,1,2 ⇒ 493/6 = 82.167%.
 * The weight-redistribution, drop-lowest, exclude-empty and freeze cases
 * implement the rules stated in report §2.1 (redistribution to 100%, empty
 * ≠ 0 changes the denominator, freeze after penalty/multiplicator) with
 * arithmetic worked from those rules.
 */

let nextId = 1;
function item(partial: Partial<CalcItemInput> & { grade: number | null }): CalcItemInput {
  return { itemId: `item-${nextId++}`, gradeMin: 0, gradeMax: 100, ...partial };
}
function resetIds(): void { nextId = 1; }

describe('GradeCalculator — golden gradebook (MoodleDocs Grade aggregation)', () => {
  it('Natural without weight overrides is the sum over the sum of maxes: (70+20+10)/(100+80+10) = 100/190', () => {
    resetIds();
    const r = calculateCategory({
      aggregation: 'natural', gradeMin: 0, gradeMax: 100,
      items: [item({ grade: 70, gradeMax: 100 }), item({ grade: 20, gradeMax: 80 }), item({ grade: 10, gradeMax: 10 })],
    });
    expect(r.gradeMax).toBe(190);
    expect(r.finalGrade).toBeCloseTo(100, 9);
  });

  it('Natural extra credit: max is NOT added to the denominator and the total is capped at the category max (20 extra + 70/75 ⇒ 75/75)', () => {
    resetIds();
    const r = calculateCategory({
      aggregation: 'natural', gradeMin: 0, gradeMax: 100,
      items: [
        item({ grade: 20, gradeMax: 100, extraCredit: true }),
        item({ grade: 70, gradeMax: 75 }),
      ],
    });
    expect(r.gradeMax).toBe(75);
    expect(r.finalGrade).toBeCloseTo(75, 9);
  });

  it('Natural with an overridden weight redistributes the rest to exactly 100% by relative max', () => {
    resetIds();
    const a = item({ grade: 80, gradeMax: 100, weightOverride: true, weight: 25 });
    const b = item({ grade: 40, gradeMax: 100 });
    const c = item({ grade: 60, gradeMax: 100 });
    const r = calculateCategory({ aggregation: 'natural', gradeMin: 0, gradeMax: 100, items: [a, b, c] });
    // A keeps 25%; B and C share the remaining 75% equally (equal maxes) ⇒ 37.5% each.
    expect(r.weights[a.itemId]).toBeCloseTo(25, 9);
    expect(r.weights[b.itemId]).toBeCloseTo(37.5, 9);
    expect(r.weights[c.itemId]).toBeCloseTo(37.5, 9);
    expect(Object.values(r.weights).reduce((s, w) => s + w, 0)).toBeCloseTo(100, 9);
    // fraction = .8*.25 + .4*.375 + .6*.375 = .575, scaled onto category max 300.
    expect(r.gradeMax).toBe(300);
    expect(r.finalGrade).toBeCloseTo(172.5, 9);
  });

  it('drop-the-lowest removes the lowest normalised grade before aggregation', () => {
    resetIds();
    const r = calculateCategory({
      aggregation: 'mean', gradeMin: 0, gradeMax: 100, dropLow: 1,
      items: [item({ grade: 50 }), item({ grade: 80 }), item({ grade: 90 })],
    });
    expect(r.finalGrade).toBeCloseTo(85, 9); // (0.8 + 0.9) / 2
  });

  it('keep-the-highest keeps only the best N normalised grades', () => {
    resetIds();
    const r = calculateCategory({
      aggregation: 'mean', gradeMin: 0, gradeMax: 100, keepHigh: 2,
      items: [item({ grade: 50 }), item({ grade: 80 }), item({ grade: 90 })],
    });
    expect(r.finalGrade).toBeCloseTo(85, 9);
  });

  it('exclude empty grades: an empty item leaves the denominator (empty is not zero)', () => {
    resetIds();
    const items = () => [item({ grade: 50, gradeMax: 100 }), item({ grade: null, gradeMax: 100 })];
    const excluded = calculateCategory({ aggregation: 'natural', gradeMin: 0, gradeMax: 100, aggregateOnlyGraded: true, items: items() });
    resetIds();
    const included = calculateCategory({ aggregation: 'natural', gradeMin: 0, gradeMax: 100, aggregateOnlyGraded: false, items: items() });
    // Excluded: fraction is 50/100 = 0.5 of the structural max 200 ⇒ 100.
    expect(excluded.finalGrade).toBeCloseTo(100, 9);
    // Included as zero: (50 + 0)/(100 + 100) ⇒ 50.
    expect(included.finalGrade).toBeCloseTo(50, 9);
  });

  it('freeze with multiplicator: a frozen grade ignores the multiplicator; an unfrozen one applies it', () => {
    resetIds();
    const unfrozen = calculateCategory({
      aggregation: 'natural', gradeMin: 0, gradeMax: 100,
      items: [item({ grade: 50, gradeMax: 100, multiplicator: 2 })],
    });
    expect(unfrozen.finalGrade).toBeCloseTo(100, 9); // 50 * 2
    resetIds();
    const frozen = calculateCategory({
      aggregation: 'natural', gradeMin: 0, gradeMax: 100,
      items: [item({ grade: 50, gradeMax: 100, multiplicator: 2, frozen: true })],
    });
    expect(frozen.finalGrade).toBeCloseTo(50, 9); // frozen final grade used verbatim
  });

  it('multiplicator and offset adjust before normalisation and clamp to the item range', () => {
    resetIds();
    const r = calculateCategory({
      aggregation: 'mean', gradeMin: 0, gradeMax: 100,
      items: [item({ grade: 40, multiplicator: 2, offset: 10 }), item({ grade: 95, multiplicator: 2 })],
    });
    // 40*2+10 = 90; 95*2 clamps to 100 ⇒ mean(0.9, 1.0) = 0.95
    expect(r.finalGrade).toBeCloseTo(95, 9);
  });

  it('Mean of grades over the MoodleDocs set: (0.7 + 0.25 + 1.0)/3 = 65/100', () => {
    resetIds();
    const r = calculateCategory({
      aggregation: 'mean', gradeMin: 0, gradeMax: 100,
      items: [item({ grade: 70, gradeMax: 100 }), item({ grade: 20, gradeMax: 80 }), item({ grade: 10, gradeMax: 10 })],
    });
    expect(r.finalGrade).toBeCloseTo(65, 9);
  });

  it('Lowest grade (MoodleDocs): min(0.7, 0.25, 1.0) = 0.25 ⇒ 25/100', () => {
    resetIds();
    const r = calculateCategory({
      aggregation: 'lowest', gradeMin: 0, gradeMax: 100,
      items: [item({ grade: 70, gradeMax: 100 }), item({ grade: 20, gradeMax: 80 }), item({ grade: 10, gradeMax: 10 })],
    });
    expect(r.finalGrade).toBeCloseTo(25, 9);
  });

  it('Highest grade (MoodleDocs): max(0.7, 0.25, 1.0) = 1.0 ⇒ 100/100', () => {
    resetIds();
    const r = calculateCategory({
      aggregation: 'highest', gradeMin: 0, gradeMax: 100,
      items: [item({ grade: 70, gradeMax: 100 }), item({ grade: 20, gradeMax: 80 }), item({ grade: 10, gradeMax: 10 })],
    });
    expect(r.finalGrade).toBeCloseTo(100, 9);
  });

  it('Median of the MoodleDocs set is the middle normalised grade 0.7 ⇒ 70/100', () => {
    resetIds();
    const r = calculateCategory({
      aggregation: 'median', gradeMin: 0, gradeMax: 100,
      items: [item({ grade: 70, gradeMax: 100 }), item({ grade: 20, gradeMax: 80 }), item({ grade: 10, gradeMax: 10 })],
    });
    expect(r.finalGrade).toBeCloseTo(70, 9);
  });

  it('Mode (MoodleDocs verbatim): mode(0.7, 0.7, 0.25, 1.0, 0.7) = 0.7 ⇒ 70/100', () => {
    resetIds();
    const r = calculateCategory({
      aggregation: 'mode', gradeMin: 0, gradeMax: 100,
      items: [
        item({ grade: 70, gradeMax: 100 }), item({ grade: 35, gradeMax: 50 }),
        item({ grade: 20, gradeMax: 80 }), item({ grade: 10, gradeMax: 10 }),
        item({ grade: 7, gradeMax: 10 }),
      ],
    });
    expect(r.finalGrade).toBeCloseTo(70, 9);
  });

  it('Weighted mean (MoodleDocs worked example): 90,70,85,89 with weights 1,2,1,2 ⇒ 493/6 = 82.167', () => {
    resetIds();
    const r = calculateCategory({
      aggregation: 'weightedmean', gradeMin: 0, gradeMax: 100,
      items: [
        item({ grade: 90, aggregationCoef: 1 }), item({ grade: 70, aggregationCoef: 2 }),
        item({ grade: 85, aggregationCoef: 1 }), item({ grade: 89, aggregationCoef: 2 }),
      ],
    });
    expect(r.finalGrade).toBeCloseTo(493 / 6, 6);
  });

  it('Simple weighted mean weights by max like Natural but scales onto the category range', () => {
    resetIds();
    const r = calculateCategory({
      aggregation: 'simpleweightedmean', gradeMin: 0, gradeMax: 100,
      items: [item({ grade: 70, gradeMax: 100 }), item({ grade: 20, gradeMax: 80 }), item({ grade: 10, gradeMax: 10 })],
    });
    expect(r.finalGrade).toBeCloseTo((100 / 190) * 100, 6);
  });

  it('Sum (legacy) adds adjusted grades and caps at the sum of maxes', () => {
    resetIds();
    const r = calculateCategory({
      aggregation: 'sum', gradeMin: 0, gradeMax: 100,
      items: [item({ grade: 70, gradeMax: 100 }), item({ grade: 20, gradeMax: 80 }), item({ grade: 10, gradeMax: 10 })],
    });
    expect(r.gradeMax).toBe(190);
    expect(r.finalGrade).toBeCloseTo(100, 9);
  });

  it('excluded grades never participate, and an all-empty category has no grade', () => {
    resetIds();
    const r = calculateCategory({
      aggregation: 'mean', gradeMin: 0, gradeMax: 100,
      items: [item({ grade: 80 }), item({ grade: 0, excluded: true })],
    });
    expect(r.finalGrade).toBeCloseTo(80, 9);
    resetIds();
    const empty = calculateCategory({
      aggregation: 'natural', gradeMin: 0, gradeMax: 100, aggregateOnlyGraded: true,
      items: [item({ grade: null })],
    });
    expect(empty.finalGrade).toBeNull();
  });

  it('recalculation is idempotent: same inputs give the same outputs', () => {
    resetIds();
    const mk = () => calculateCategory({
      aggregation: 'natural', gradeMin: 0, gradeMax: 100,
      items: [item({ grade: 70, gradeMax: 100 }), item({ grade: 20, gradeMax: 80 }), item({ grade: 10, gradeMax: 10 })],
    });
    expect(mk().finalGrade).toBe(mk().finalGrade);
  });

  it('grade letters map by percentage boundary (highest boundary at or below the percentage)', () => {
    const letters = [
      { letter: 'A', lowerBoundary: 90 }, { letter: 'B', lowerBoundary: 80 },
      { letter: 'C', lowerBoundary: 70 }, { letter: 'F', lowerBoundary: 0 },
    ];
    expect(letterForGrade(95, 0, 100, letters)).toBe('A');
    expect(letterForGrade(85, 0, 100, letters)).toBe('B');
    expect(letterForGrade(50, 0, 200, letters)).toBe('F'); // 25%
    expect(letterForGrade(180, 0, 200, letters)).toBe('A'); // 90%
    expect(letterForGrade(50, 0, 100, [])).toBeNull();
  });
});

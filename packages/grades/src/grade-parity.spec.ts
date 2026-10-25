import { describe, expect, it } from 'vitest';
import { FORMULA_FUNCTIONS } from './grade-formula.js';
import { GRADE_FORMULA_CORPUS, runGradeCalculatorParityProbe, runGradeFormulaCorpus } from './parity-corpus.js';

/**
 * Parity của chính package @lms/grades: corpus dùng chung phải cho đúng outcome đã
 * tính tay, và tập hàm hỗ trợ phải đủ 9 hàm của bản đầy đủ (bản worker rút gọn 4 hàm
 * là gốc của vụ phân kỳ 11.1 — #134). Spec parity ở apps/api và apps/worker chạy
 * cùng corpus này qua đường import @lms/grades và đòi outcome giống hệt.
 */
describe('@lms/grades — corpus parity (nguồn sự thật duy nhất)', () => {
  it('đủ 9 hàm: sum, average, min, max, power, round, mod, pi, if', () => {
    expect([...FORMULA_FUNCTIONS]).toEqual(['sum', 'average', 'min', 'max', 'power', 'round', 'mod', 'pi', 'if']);
  });

  it('toàn bộ corpus cho outcome đúng kỳ vọng', () => {
    expect(runGradeFormulaCorpus()).toEqual(
      GRADE_FORMULA_CORPUS.map((c) => ({ name: c.name, outcome: c.expected })),
    );
  });

  it('corpus phủ đủ 9 hàm + ca arity + ca lồng nhau', () => {
    const formulas = GRADE_FORMULA_CORPUS.map((c) => c.formula).join(' ');
    for (const fn of FORMULA_FUNCTIONS) expect(formulas).toContain(`${fn}(`);
    expect(GRADE_FORMULA_CORPUS.some((c) => c.name.startsWith('arity:'))).toBe(true);
    expect(GRADE_FORMULA_CORPUS.some((c) => c.name.startsWith('lồng'))).toBe(true);
  });

  it('grade-calculator parity probe: natural với item calculated → 210/300', () => {
    expect(runGradeCalculatorParityProbe()).toBe(210);
  });
});

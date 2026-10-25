import { describe, expect, it } from 'vitest';
import {
  FORMULA_FUNCTIONS, GRADE_FORMULA_CORPUS, runGradeCalculatorParityProbe, runGradeFormulaCorpus,
} from '@lms/grades';

/**
 * Parity phía API: apps/api phải chạy đúng corpus công thức dùng chung của
 * @lms/grades với outcome giống hệt phía worker và phía package (sửa vụ phân kỳ
 * 11.1 của #134 — trước đây api giữ bản 9 hàm, worker giữ bản rút gọn 4 hàm).
 */
describe('API — parity bộ máy công thức điểm (@lms/grades)', () => {
  it('tập hàm hỗ trợ đủ 9 hàm của bản đầy đủ', () => {
    expect([...FORMULA_FUNCTIONS]).toEqual(['sum', 'average', 'min', 'max', 'power', 'round', 'mod', 'pi', 'if']);
  });

  it('corpus dùng chung cho outcome đúng kỳ vọng', () => {
    expect(runGradeFormulaCorpus()).toEqual(
      GRADE_FORMULA_CORPUS.map((c) => ({ name: c.name, outcome: c.expected })),
    );
  });

  it('grade-calculator dùng chung: ca parity cho 210/300', () => {
    expect(runGradeCalculatorParityProbe()).toBe(210);
  });
});

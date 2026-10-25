import { describe, expect, it } from 'vitest';
import {
  FORMULA_FUNCTIONS, GRADE_FORMULA_CORPUS, runGradeCalculatorParityProbe, runGradeFormulaCorpus,
} from '@lms/grades';

/**
 * Parity phía WORKER: đường grade-regrade (GradeRegradeProcessor) import bộ máy
 * điểm từ @lms/grades — cùng package với apps/api — nên corpus công thức dùng
 * chung phải cho outcome giống hệt phía api và phía package. Đây là spec khoá vụ
 * phân kỳ 11.1 của #134: bản sao rút gọn 4 hàm từng nằm ở apps/worker/src/domain
 * đã bị xoá; nếu ai dựng lại bản sao, spec này + grep một nguồn sẽ lộ ngay.
 */
describe('Worker — parity bộ máy công thức điểm (@lms/grades)', () => {
  it('tập hàm hỗ trợ đủ 9 hàm của bản đầy đủ (bản rút gọn cũ chỉ có 4)', () => {
    expect([...FORMULA_FUNCTIONS]).toEqual(['sum', 'average', 'min', 'max', 'power', 'round', 'mod', 'pi', 'if']);
  });

  it('corpus dùng chung cho outcome đúng kỳ vọng — gồm power/round/mod/pi/if và ca arity', () => {
    expect(runGradeFormulaCorpus()).toEqual(
      GRADE_FORMULA_CORPUS.map((c) => ({ name: c.name, outcome: c.expected })),
    );
  });

  it('grade-calculator dùng chung: ca parity cho 210/300', () => {
    expect(runGradeCalculatorParityProbe()).toBe(210);
  });
});

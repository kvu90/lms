import { describe, expect, it } from 'vitest';
import { calculateCategory } from './grade-calculator';
import {
  GradeFormulaError, calculateFromFormula, findFormulaCycle, formulaReferences, parseGradeFormula,
} from './grade-formula';

/**
 * GOLDEN calculated grade items — bộ đánh giá công thức an toàn (không eval).
 *
 * Nguồn oracle: MoodleDocs "Grade calculations" (docs.moodle.org/en/Grade_calculations,
 * tra cứu trực tuyến 2026-10-23): công thức bắt đầu bằng `=`, tham chiếu idnumber trong
 * ngoặc vuông kép, hàm sum/average/min/max, ví dụ của tài liệu gồm
 * `=average([[1]], [[2]], [[3]])` (trung bình đều) và
 * `=sum([[1]]*0.3, [[2]]*0.6, [[3]]*0.1)` (trọng số 30/60/10),
 * `=max([[A]], [[B]], 100)`. Các số kỳ vọng dưới đây tính tay từ chính các ví dụ đó.
 * Ngữ nghĩa riêng đã chốt và ghi trong grade-formula.ts: chia 0 → null,
 * hàm bỏ qua đối số trống, phép toán hai ngôi có toán hạng trống → null,
 * tham chiếu vòng và idnumber lạ bị từ chối lúc lưu (kiểm ở service, vòng kiểm ở đây bằng findFormulaCycle).
 */
describe('GradeFormula — golden parser/evaluator (MoodleDocs Grade calculations)', () => {
  const grades: Record<string, number | null> = { a: 80, b: 60, c: 100, empty: null };
  const resolve = (idnumber: string): number | null => grades[idnumber] ?? null;

  it('sum: =sum([[a]],[[b]]) = 140 và ví dụ trọng số của MoodleDocs =sum([[a]]*0.3,[[b]]*0.6,[[c]]*0.1) = 70', () => {
    expect(calculateFromFormula('=sum([[a]],[[b]])', resolve)).toBeCloseTo(140, 9);
    expect(calculateFromFormula('=sum([[a]]*0.3,[[b]]*0.6,[[c]]*0.1)', resolve)).toBeCloseTo(70, 9);
  });

  it('average: =average([[a]],[[b]],[[c]]) = 80 (ví dụ trung bình đều của MoodleDocs)', () => {
    expect(calculateFromFormula('=average([[a]],[[b]],[[c]])', resolve)).toBeCloseTo(80, 9);
  });

  it('min/max: =min([[a]],[[b]],[[c]]) = 60, =max([[a]],[[b]],100) = 100', () => {
    expect(calculateFromFormula('=min([[a]],[[b]],[[c]])', resolve)).toBe(60);
    expect(calculateFromFormula('=max([[a]],[[b]],100)', resolve)).toBe(100);
  });

  it('số học và ngoặc: =([[a]]+[[b]])/2 = 70; ưu tiên * trước +: =[[a]]+[[b]]*0.5 = 110; số âm đơn ngôi', () => {
    expect(calculateFromFormula('=([[a]]+[[b]])/2', resolve)).toBeCloseTo(70, 9);
    expect(calculateFromFormula('=[[a]]+[[b]]*0.5', resolve)).toBeCloseTo(110, 9);
    expect(calculateFromFormula('=-[[b]]+[[a]]', resolve)).toBeCloseTo(20, 9);
  });

  it('lồng nhau: =average(sum([[a]],[[b]]), [[c]]) = average(140, 100) = 120', () => {
    expect(calculateFromFormula('=average(sum([[a]],[[b]]), [[c]])', resolve)).toBeCloseTo(120, 9);
  });

  it('chia cho 0 → null (không lỗi, không Infinity), kể cả mẫu số tính ra 0', () => {
    expect(calculateFromFormula('=[[a]]/0', resolve)).toBeNull();
    expect(calculateFromFormula('=[[a]]/([[b]]-[[b]])', resolve)).toBeNull();
    expect(calculateFromFormula('=sum([[a]]/0, 5)', resolve)).toBe(5); // đối số null bị hàm bỏ qua
  });

  it('điểm trống: hàm bỏ qua đối số trống; phép toán hai ngôi với toán hạng trống → null; tất cả trống → null', () => {
    expect(calculateFromFormula('=sum([[empty]],[[a]])', resolve)).toBe(80);
    expect(calculateFromFormula('=average([[empty]],[[a]],[[b]])', resolve)).toBeCloseTo(70, 9);
    expect(calculateFromFormula('=[[empty]]+[[a]]', resolve)).toBeNull();
    expect(calculateFromFormula('=sum([[empty]])', resolve)).toBeNull();
  });

  it('formulaReferences liệt kê idnumber không trùng theo thứ tự xuất hiện', () => {
    expect(formulaReferences(parseGradeFormula('=sum([[b]],[[a]],[[b]])'))).toEqual(['b', 'a']);
  });

  it('tham chiếu vòng: findFormulaCycle phát hiện vòng trực tiếp và vòng qua chuỗi', () => {
    const direct = new Map([['x', ['x']]]);
    expect(findFormulaCycle(direct, 'x')).toEqual(['x', 'x']);
    const chain = new Map([['x', ['y']], ['y', ['z']], ['z', ['y']]]);
    expect(findFormulaCycle(chain, 'x')).toEqual(['y', 'z', 'y']);
    const acyclic = new Map([['x', ['y']], ['y', ['a']]]);
    expect(findFormulaCycle(acyclic, 'x')).toBeNull();
  });

  it('cú pháp sai và hàm không hỗ trợ bị từ chối bằng GradeFormulaError rõ lý do (power/round là phần CHƯA hỗ trợ)', () => {
    expect(() => parseGradeFormula('=sum([[a]],)')).toThrow(GradeFormulaError);
    expect(() => parseGradeFormula('=[[a]]+')).toThrow(/syntax|Unexpected/);
    try {
      parseGradeFormula('=power([[a]],2)');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GradeFormulaError);
      expect((e as GradeFormulaError).reason).toBe('unknown_function');
    }
    expect(() => parseGradeFormula('=[[a]]; process.exit(1)')).toThrow(GradeFormulaError); // không eval: ký tự lạ bị token hoá từ chối
  });

  it('calculator dùng điểm calculated như điểm của item trong tổng hợp category (natural)', () => {
    // Hai item thường 80/100 và 60/100; calculated = average của chúng = 70/100.
    const calcValue = calculateFromFormula('=average([[a]],[[b]])', resolve)!;
    const r = calculateCategory({
      aggregation: 'natural', grademin: 0, grademax: 100,
      items: [
        { itemId: 'a', grademin: 0, grademax: 100, grade: 80 },
        { itemId: 'b', grademin: 0, grademax: 100, grade: 60 },
        { itemId: 'calc', grademin: 0, grademax: 100, grade: calcValue },
      ],
    });
    // natural: (80 + 60 + 70) / 300 của thang cấu trúc 300 ⇒ 210.
    expect(r.grademax).toBe(300);
    expect(r.finalgrade).toBeCloseTo(210, 9);
  });
});

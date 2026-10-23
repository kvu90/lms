import { describe, expect, it } from 'vitest';
import { calculateCategory } from './grade-calculator';
import {
  GradeFormulaError, calculateFromFormula, findFormulaCycle, formulaReferences, parseGradeFormula,
} from './grade-formula';

/**
 * GOLDEN calculated grade items — bộ đánh giá công thức an toàn (không eval).
 *
 * Nguồn oracle: MoodleDocs "Grade calculations" (docs.moodle.org/en/Grade_calculations,
 * tra cứu trực tuyến 2026-10-23): công thức bắt đầu bằng `=`, tham chiếu idNumber trong
 * ngoặc vuông kép, hàm sum/average/min/max, ví dụ của tài liệu gồm
 * `=average([[1]], [[2]], [[3]])` (trung bình đều) và
 * `=sum([[1]]*0.3, [[2]]*0.6, [[3]]*0.1)` (trọng số 30/60/10),
 * `=max([[A]], [[B]], 100)`. Các số kỳ vọng dưới đây tính tay từ chính các ví dụ đó.
 * Ngữ nghĩa riêng đã chốt và ghi trong grade-formula.ts: chia 0 → null,
 * hàm bỏ qua đối số trống, phép toán hai ngôi có toán hạng trống → null,
 * tham chiếu vòng và idNumber lạ bị từ chối lúc lưu (kiểm ở service, vòng kiểm ở đây bằng findFormulaCycle).
 * Năm hàm bổ sung theo issue #24 (power/round/mod/pi/if) đối chiếu chính trang
 * MoodleDocs trên: power(base, exponent) = base^exponent; round(number, count)
 * làm tròn tới count chữ số thập phân; mod(dividend, divisor) là phần dư;
 * pi() = 3.14159265…; if(cond, then, else) trả nhánh thứ hai khi điều kiện
 * khác 0, nhánh thứ ba khi điều kiện bằng 0 — ví dụ 4 của tài liệu:
 * `=if([[midtermexam]]>=5, [[midtermexam]]+[[lab]], 0)`.
 */
describe('GradeFormula — golden parser/evaluator (MoodleDocs Grade calculations)', () => {
  const grades: Record<string, number | null> = { a: 80, b: 60, c: 100, empty: null };
  const resolve = (idNumber: string): number | null => grades[idNumber] ?? null;

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

  it('formulaReferences liệt kê idNumber không trùng theo thứ tự xuất hiện', () => {
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

  it('cú pháp sai và hàm không hỗ trợ bị từ chối bằng GradeFormulaError rõ lý do (foo không phải hàm Moodle)', () => {
    expect(() => parseGradeFormula('=sum([[a]],)')).toThrow(GradeFormulaError);
    expect(() => parseGradeFormula('=[[a]]+')).toThrow(/syntax|Unexpected/);
    try {
      parseGradeFormula('=foo([[a]],2)');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GradeFormulaError);
      expect((e as GradeFormulaError).reason).toBe('unknown_function');
    }
    expect(() => parseGradeFormula('=[[a]]; process.exit(1)')).toThrow(GradeFormulaError); // không eval: ký tự lạ bị token hoá từ chối
  });

  it('power: =power([[a]],2) = 6400; =power(2,10) = 1024; đối số trống → null; cơ số âm mũ phân số (NaN) → null', () => {
    expect(calculateFromFormula('=power([[a]],2)', resolve)).toBe(6400);
    expect(calculateFromFormula('=power(2,10)', resolve)).toBe(1024);
    expect(calculateFromFormula('=power([[empty]],2)', resolve)).toBeNull();
    expect(calculateFromFormula('=power(4,0.5)', resolve)).toBe(2);
    expect(calculateFromFormula('=power(-1,0.5)', resolve)).toBeNull();
  });

  it('round: ngữ nghĩa PHP nửa ra xa số 0 — round(2.5) = 3, round(-2.5) = -3; có chữ số thập phân; trống → null', () => {
    expect(calculateFromFormula('=round(2.5)', resolve)).toBe(3);
    expect(calculateFromFormula('=round(-2.5)', resolve)).toBe(-3);
    expect(calculateFromFormula('=round(80.44)', resolve)).toBe(80);
    expect(calculateFromFormula('=round([[a]]/3,2)', resolve)).toBeCloseTo(26.67, 9);
    expect(calculateFromFormula('=round(2.675,2)', resolve)).toBeCloseTo(2.68, 9);
    expect(calculateFromFormula('=round([[empty]])', resolve)).toBeNull();
    expect(calculateFromFormula('=round([[b]])', resolve)).toBe(60); // ví dụ 7 của MoodleDocs: round([[Quiz]])
  });

  it('mod: phần dư theo dấu số bị chia — mod(10,3) = 1, mod(10.5,3) = 1.5, mod(-7,3) = -1; chia 0 → null', () => {
    expect(calculateFromFormula('=mod(10,3)', resolve)).toBe(1);
    expect(calculateFromFormula('=mod([[a]],6)', resolve)).toBe(2);
    expect(calculateFromFormula('=mod(10.5,3)', resolve)).toBeCloseTo(1.5, 9);
    expect(calculateFromFormula('=mod(-7,3)', resolve)).toBe(-1);
    expect(calculateFromFormula('=mod([[a]],0)', resolve)).toBeNull();
    expect(calculateFromFormula('=mod([[empty]],3)', resolve)).toBeNull();
  });

  it('pi: =pi() và =pi trần đều cho π; dùng được trong biểu thức', () => {
    expect(calculateFromFormula('=pi()', resolve)).toBeCloseTo(Math.PI, 12);
    expect(calculateFromFormula('=pi', resolve)).toBeCloseTo(Math.PI, 12);
    expect(calculateFromFormula('=2*pi()', resolve)).toBeCloseTo(2 * Math.PI, 12);
    expect(calculateFromFormula('=round(pi(),2)', resolve)).toBeCloseTo(3.14, 9);
  });

  it('so sánh cho 1/0, ưu tiên thấp nhất, một vế trống → null', () => {
    expect(calculateFromFormula('=[[a]]>50', resolve)).toBe(1);
    expect(calculateFromFormula('=[[a]]<50', resolve)).toBe(0);
    expect(calculateFromFormula('=[[b]]==60', resolve)).toBe(1);
    expect(calculateFromFormula('=[[a]]!=[[b]]', resolve)).toBe(1);
    expect(calculateFromFormula('=[[a]]>=[[b]]+20', resolve)).toBe(1); // (a) >= (b + 20) — cộng trừ tính trước
    expect(calculateFromFormula('=[[empty]]>1', resolve)).toBeNull();
    expect(() => parseGradeFormula('=1<2<3')).toThrow(GradeFormulaError); // không chuỗi so sánh
  });

  it('if: ví dụ 4 của MoodleDocs — =if([[mid]]>=5, [[mid]]+[[lab]], 0) cho 10 khi đạt và 0 khi không đạt', () => {
    const midterm = (mid: number, lab: number) => calculateFromFormula('=if([[mid]]>=5, [[mid]]+[[lab]], 0)',
      (id) => (id === 'mid' ? mid : id === 'lab' ? lab : null));
    expect(midterm(7, 3)).toBe(10);
    expect(midterm(4, 3)).toBe(0);
    expect(calculateFromFormula('=if(1, [[a]], [[b]])', resolve)).toBe(80);
    expect(calculateFromFormula('=if(0, [[a]], [[b]])', resolve)).toBe(60);
    expect(calculateFromFormula('=if([[empty]], 1, 0)', resolve)).toBeNull(); // điều kiện trống → null
    expect(calculateFromFormula('=if(1, [[a]], [[empty]])', resolve)).toBe(80); // nhánh không chọn trống không ảnh hưởng
  });

  it('lồng hàm xuyên nhóm: =sum(if([[a]]>50, power(2,3), 0), round(9.6)) = 8 + 10 = 18; max của power/mod/round(pi())', () => {
    expect(calculateFromFormula('=sum(if([[a]]>50, power(2,3), 0), round(9.6))', resolve)).toBe(18);
    expect(calculateFromFormula('=max(power(2,3), mod(17,5), round(pi()))', resolve)).toBe(8);
  });

  it('sai số đối số của hàm mới bị từ chối lúc phân tích (power thiếu mũ, if thiếu nhánh, pi có đối số, round rỗng)', () => {
    for (const f of ['=power(1)', '=power(1,2,3)', '=if(1,2)', '=mod(1)', '=pi(1)', '=round()', '=sum()']) {
      try {
        parseGradeFormula(f);
        expect.unreachable(f);
      } catch (e) {
        expect(e).toBeInstanceOf(GradeFormulaError);
        expect((e as GradeFormulaError).reason).toBe('syntax');
      }
    }
  });

  it('calculator dùng điểm calculated như điểm của item trong tổng hợp category (natural)', () => {
    // Hai item thường 80/100 và 60/100; calculated = average của chúng = 70/100.
    const calcValue = calculateFromFormula('=average([[a]],[[b]])', resolve)!;
    const r = calculateCategory({
      aggregation: 'natural', gradeMin: 0, gradeMax: 100,
      items: [
        { itemId: 'a', gradeMin: 0, gradeMax: 100, grade: 80 },
        { itemId: 'b', gradeMin: 0, gradeMax: 100, grade: 60 },
        { itemId: 'calc', gradeMin: 0, gradeMax: 100, grade: calcValue },
      ],
    });
    // natural: (80 + 60 + 70) / 300 của thang cấu trúc 300 ⇒ 210.
    expect(r.gradeMax).toBe(300);
    expect(r.finalGrade).toBeCloseTo(210, 9);
  });
});

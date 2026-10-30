import { describe, expect, it } from 'vitest';
import { calculateCategory, letterForGrade, type CalcItemInput } from './grade-calculator.js';

/**
 * GOLDEN GRADEBOOK (§3.11b) — số học domain thuần.
 *
 * Các ví dụ nguyên văn của MoodleDocs "Grade aggregation" (docs.moodle.org,
 * Grade_aggregation; đọc qua bản mirror của MoodleDocs được lập chỉ mục ngày 2026-10-22):
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
 *  - Ví dụ tính sẵn của Weighted mean (tài liệu giảng dạy suy ra từ MoodleDocs):
 *    các điểm 90%, 70%, 85%, 89% với các trọng số 1,2,1,2 ⇒ 493/6 = 82.167%.
 * Các ca weight-redistribution, drop-lowest, exclude-empty và freeze
 * cài đặt các quy tắc nêu trong report §2.1 (phân phối lại đủ 100%, điểm trống
 * ≠ 0 làm thay đổi mẫu số, freeze sau penalty/multiplicator) với
 * số học được tính từ chính các quy tắc đó.
 */

let nextId = 1;
function item(partial: Partial<CalcItemInput> & { grade: number | null }): CalcItemInput {
  return { itemId: `item-${nextId++}`, gradeMin: 0, gradeMax: 100, ...partial };
}
function resetIds(): void { nextId = 1; }

describe('GradeCalculator — sổ điểm chuẩn (tổng hợp điểm MoodleDocs)', () => {
  it('Natural không ghi đè trọng số là tổng trên tổng các max: (70+20+10)/(100+80+10) = 100/190', () => {
    resetIds();
    const r = calculateCategory({
      aggregation: 'natural', gradeMin: 0, gradeMax: 100,
      items: [item({ grade: 70, gradeMax: 100 }), item({ grade: 20, gradeMax: 80 }), item({ grade: 10, gradeMax: 10 })],
    });
    expect(r.gradeMax).toBe(190);
    expect(r.finalGrade).toBeCloseTo(100, 9);
  });

  it('Natural điểm cộng thêm: max KHÔNG cộng vào mẫu số và tổng bị chặn ở max của danh mục (20 điểm cộng + 70/75 ⇒ 75/75)', () => {
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

  it('Natural có trọng số ghi đè sẽ phân bổ lại phần còn lại về đúng 100% theo max tương đối', () => {
    resetIds();
    const a = item({ grade: 80, gradeMax: 100, weightOverride: true, weight: 25 });
    const b = item({ grade: 40, gradeMax: 100 });
    const c = item({ grade: 60, gradeMax: 100 });
    const r = calculateCategory({ aggregation: 'natural', gradeMin: 0, gradeMax: 100, items: [a, b, c] });
    // A giữ 25%; B và C chia đều 75% còn lại (max bằng nhau) ⇒ mỗi item 37.5%.
    expect(r.weights[a.itemId]).toBeCloseTo(25, 9);
    expect(r.weights[b.itemId]).toBeCloseTo(37.5, 9);
    expect(r.weights[c.itemId]).toBeCloseTo(37.5, 9);
    expect(Object.values(r.weights).reduce((s, w) => s + w, 0)).toBeCloseTo(100, 9);
    // fraction = .8*.25 + .4*.375 + .6*.375 = .575, được chiếu lên category max 300.
    expect(r.gradeMax).toBe(300);
    expect(r.finalGrade).toBeCloseTo(172.5, 9);
  });

  it('drop-the-lowest loại điểm chuẩn hoá thấp nhất trước khi tổng hợp', () => {
    resetIds();
    const r = calculateCategory({
      aggregation: 'mean', gradeMin: 0, gradeMax: 100, dropLow: 1,
      items: [item({ grade: 50 }), item({ grade: 80 }), item({ grade: 90 })],
    });
    expect(r.finalGrade).toBeCloseTo(85, 9); // (0.8 + 0.9) / 2
  });

  it('keep-the-highest chỉ giữ N điểm chuẩn hoá tốt nhất', () => {
    resetIds();
    const r = calculateCategory({
      aggregation: 'mean', gradeMin: 0, gradeMax: 100, keepHigh: 2,
      items: [item({ grade: 50 }), item({ grade: 80 }), item({ grade: 90 })],
    });
    expect(r.finalGrade).toBeCloseTo(85, 9);
  });

  it('loại điểm trống: hạng mục trống rời khỏi mẫu số (trống không phải là 0)', () => {
    resetIds();
    const items = () => [item({ grade: 50, gradeMax: 100 }), item({ grade: null, gradeMax: 100 })];
    const excluded = calculateCategory({ aggregation: 'natural', gradeMin: 0, gradeMax: 100, aggregateOnlyGraded: true, items: items() });
    resetIds();
    const included = calculateCategory({ aggregation: 'natural', gradeMin: 0, gradeMax: 100, aggregateOnlyGraded: false, items: items() });
    // Bị loại: fraction là 50/100 = 0.5 của structural max 200 ⇒ 100.
    expect(excluded.finalGrade).toBeCloseTo(100, 9);
    // Được tính là 0: (50 + 0)/(100 + 100) ⇒ 50.
    expect(included.finalGrade).toBeCloseTo(50, 9);
  });

  it('đóng băng với hệ số nhân: điểm đã đóng băng bỏ qua hệ số nhân; điểm chưa đóng băng thì áp dụng nó', () => {
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
    expect(frozen.finalGrade).toBeCloseTo(50, 9); // final grade đã đóng băng được dùng nguyên văn
  });

  it('hệ số nhân và độ lệch điều chỉnh trước khi chuẩn hoá và chặn trong khoảng của hạng mục', () => {
    resetIds();
    const r = calculateCategory({
      aggregation: 'mean', gradeMin: 0, gradeMax: 100,
      items: [item({ grade: 40, multiplicator: 2, offset: 10 }), item({ grade: 95, multiplicator: 2 })],
    });
    // 40*2+10 = 90; 95*2 bị clamp thành 100 ⇒ mean(0.9, 1.0) = 0.95
    expect(r.finalGrade).toBeCloseTo(95, 9);
  });

  it('Trung bình điểm trên tập MoodleDocs: (0.7 + 0.25 + 1.0)/3 = 65/100', () => {
    resetIds();
    const r = calculateCategory({
      aggregation: 'mean', gradeMin: 0, gradeMax: 100,
      items: [item({ grade: 70, gradeMax: 100 }), item({ grade: 20, gradeMax: 80 }), item({ grade: 10, gradeMax: 10 })],
    });
    expect(r.finalGrade).toBeCloseTo(65, 9);
  });

  it('Điểm thấp nhất (MoodleDocs): min(0.7, 0.25, 1.0) = 0.25 ⇒ 25/100', () => {
    resetIds();
    const r = calculateCategory({
      aggregation: 'lowest', gradeMin: 0, gradeMax: 100,
      items: [item({ grade: 70, gradeMax: 100 }), item({ grade: 20, gradeMax: 80 }), item({ grade: 10, gradeMax: 10 })],
    });
    expect(r.finalGrade).toBeCloseTo(25, 9);
  });

  it('Điểm cao nhất (MoodleDocs): max(0.7, 0.25, 1.0) = 1.0 ⇒ 100/100', () => {
    resetIds();
    const r = calculateCategory({
      aggregation: 'highest', gradeMin: 0, gradeMax: 100,
      items: [item({ grade: 70, gradeMax: 100 }), item({ grade: 20, gradeMax: 80 }), item({ grade: 10, gradeMax: 10 })],
    });
    expect(r.finalGrade).toBeCloseTo(100, 9);
  });

  it('Trung vị của tập MoodleDocs là điểm chuẩn hoá ở giữa 0.7 ⇒ 70/100', () => {
    resetIds();
    const r = calculateCategory({
      aggregation: 'median', gradeMin: 0, gradeMax: 100,
      items: [item({ grade: 70, gradeMax: 100 }), item({ grade: 20, gradeMax: 80 }), item({ grade: 10, gradeMax: 10 })],
    });
    expect(r.finalGrade).toBeCloseTo(70, 9);
  });

  it('Mode (nguyên văn MoodleDocs): mode(0.7, 0.7, 0.25, 1.0, 0.7) = 0.7 ⇒ 70/100', () => {
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

  it('Trung bình có trọng số (ví dụ mẫu MoodleDocs): 90,70,85,89 với trọng số 1,2,1,2 ⇒ 493/6 = 82.167', () => {
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

  it('Trung bình có trọng số đơn giản cân theo max như Natural nhưng co giãn theo khoảng danh mục', () => {
    resetIds();
    const r = calculateCategory({
      aggregation: 'simpleweightedmean', gradeMin: 0, gradeMax: 100,
      items: [item({ grade: 70, gradeMax: 100 }), item({ grade: 20, gradeMax: 80 }), item({ grade: 10, gradeMax: 10 })],
    });
    expect(r.finalGrade).toBeCloseTo((100 / 190) * 100, 6);
  });

  it('Tổng (cũ) cộng điểm đã điều chỉnh và chặn ở tổng các max', () => {
    resetIds();
    const r = calculateCategory({
      aggregation: 'sum', gradeMin: 0, gradeMax: 100,
      items: [item({ grade: 70, gradeMax: 100 }), item({ grade: 20, gradeMax: 80 }), item({ grade: 10, gradeMax: 10 })],
    });
    expect(r.gradeMax).toBe(190);
    expect(r.finalGrade).toBeCloseTo(100, 9);
  });

  it('điểm bị loại không bao giờ tham gia, và danh mục toàn trống thì không có điểm', () => {
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

  it('tính lại có tính lũy đẳng: cùng đầu vào cho cùng đầu ra', () => {
    resetIds();
    const mk = () => calculateCategory({
      aggregation: 'natural', gradeMin: 0, gradeMax: 100,
      items: [item({ grade: 70, gradeMax: 100 }), item({ grade: 20, gradeMax: 80 }), item({ grade: 10, gradeMax: 10 })],
    });
    expect(mk().finalGrade).toBe(mk().finalGrade);
  });

  it('chữ điểm ánh xạ theo ngưỡng phần trăm (ngưỡng cao nhất bằng hoặc dưới phần trăm)', () => {
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

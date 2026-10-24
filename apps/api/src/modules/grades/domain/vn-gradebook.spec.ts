import { describe, expect, it } from 'vitest';
import {
  classifyLearningLevel, computeDtbCn, computeDtbHk, convertGradeToScale10, dgtxQuotaForPeriods,
  isCommentOnlySubjectName, round1, type VnSubjectLevelInput,
} from './vn-gradebook';

/**
 * Kiểm chứng domain sổ điểm VN (GB-VN-1, issue #95) bằng số tính tay từ
 * nguyên văn TT 22/2021/TT-BGDĐT — không lấy số từ chính code đang test.
 */
describe('quota ĐĐGtx theo số tiết/năm (Điều 6.2b)', () => {
  it('≤35 tiết → 2, 35–70 → 3, >70 → 4, đúng cả biên', () => {
    expect(dgtxQuotaForPeriods(17)).toBe(2);
    expect(dgtxQuotaForPeriods(35)).toBe(2);
    expect(dgtxQuotaForPeriods(36)).toBe(3);
    expect(dgtxQuotaForPeriods(70)).toBe(3);
    expect(dgtxQuotaForPeriods(71)).toBe(4);
    expect(dgtxQuotaForPeriods(140)).toBe(4);
  });
  it('số tiết không hợp lệ thì ném lỗi', () => {
    expect(() => dgtxQuotaForPeriods(0)).toThrow();
    expect(() => dgtxQuotaForPeriods(-5)).toThrow();
  });
});

describe('làm tròn 1 chữ số thập phân (Điều 5.3b)', () => {
  it('làm tròn nửa lên và giữ nguyên số đã tròn', () => {
    expect(round1(7.55)).toBe(7.6);
    expect(round1(7.54)).toBe(7.5);
    expect(round1(8)).toBe(8);
    expect(round1(6.25)).toBe(6.3);
  });
});

describe('ĐTBmhk (Điều 9.1b)', () => {
  it('ví dụ kiểm chứng của research: ĐĐGtx 8/7/9/6, gk 7, ck 8 → 7,6', () => {
    expect(computeDtbHk({ dgtx: [8, 7, 9, 6], dggk: 7, dgck: 8 })).toBe(7.6);
  });
  it('mẫu số là số ĐĐGtx + 5 với từng mức quota', () => {
    // 2 ĐĐGtx: (10 + 10 + 2×5 + 3×5)/(2+5) = 45/7 = 6,428… → 6,4
    expect(computeDtbHk({ dgtx: [10, 10], dggk: 5, dgck: 5 })).toBe(6.4);
    // 3 ĐĐGtx: (15 + 2×6 + 3×6)/(3+5) = 45/8 = 5,625 → 5,6
    expect(computeDtbHk({ dgtx: [5, 5, 5], dggk: 6, dgck: 6 })).toBe(5.6);
  });
});

describe('ĐTBmcn (Điều 9.1b) — tính trên ĐTBmhk đã làm tròn', () => {
  it('(hkI + 2×hkII)/3', () => {
    expect(computeDtbCn(7.6, 8.2)).toBe(8.0);
    expect(computeDtbCn(5.0, 5.0)).toBe(5.0);
    expect(computeDtbCn(6.4, 6.5)).toBe(6.5);
  });
});

describe('phân biệt môn chỉ-nhận-xét (Điều 5.3a)', () => {
  it('nhận diện đúng nhóm môn nhận xét và không nhận nhầm môn điểm số', () => {
    for (const name of ['Giáo dục thể chất', 'Nghệ thuật', 'Âm nhạc', 'Mĩ thuật', 'Nội dung giáo dục của địa phương', 'Hoạt động trải nghiệm, hướng nghiệp']) {
      expect(isCommentOnlySubjectName(name)).toBe(true);
    }
    for (const name of ['Toán', 'Ngữ văn', 'Tiếng Anh', 'Khoa học tự nhiên', 'Giáo dục công dân', null, undefined]) {
      expect(isCommentOnlySubjectName(name)).toBe(false);
    }
  });
});

const score = (key: string, dtb: number): VnSubjectLevelInput => ({ key, kind: 'score', dtb });
const comment = (key: string, result: 'Đạt' | 'Chưa đạt'): VnSubjectLevelInput => ({ key, kind: 'comment', commentResult: result });

describe('xếp mức Điều 9.2', () => {
  it('Tốt: mọi môn nhận xét Đạt, mọi môn điểm ≥6,5 và ít nhất 6 môn ≥8,0', () => {
    const subjects = [score('a', 9), score('b', 8.5), score('c', 8), score('d', 9.2), score('e', 8.1), score('f', 8.8), score('g', 7), comment('tc', 'Đạt')];
    expect(classifyLearningLevel(subjects).level).toBe('Tốt');
  });
  it('rớt Tốt xuống Khá khi một môn điểm chỉ 6,0 (mọi môn vẫn ≥5,0, đủ 6 môn ≥6,5)', () => {
    const subjects = [score('a', 9), score('b', 8.5), score('c', 8), score('d', 9.2), score('e', 8.1), score('f', 8.8), score('g', 6.0), comment('tc', 'Đạt')];
    const result = classifyLearningLevel(subjects);
    expect(result.level).toBe('Khá');
    expect(result.adjusted).toBe(false);
  });
  it('Đạt: tối đa 1 môn nhận xét Chưa đạt, ít nhất 6 môn ≥5,0, không môn nào <3,5', () => {
    const subjects = [score('a', 5), score('b', 5.5), score('c', 6), score('d', 7), score('e', 5.2), score('f', 5.8), score('g', 4.0), comment('tc', 'Chưa đạt')];
    expect(classifyLearningLevel(subjects).level).toBe('Đạt');
  });
  it('Chưa đạt khi có môn dưới 3,5 (không có điểm liệt — chỉ là hệ quả của điều kiện mức Đạt)', () => {
    const subjects = [score('a', 5), score('b', 5.5), score('c', 6), score('d', 7), score('e', 5.2), score('f', 5.8), score('g', 3.4)];
    expect(classifyLearningLevel(subjects).level).toBe('Chưa đạt');
  });
  it('Chưa đạt khi 2 môn nhận xét cùng Chưa đạt dù điểm số cao', () => {
    const subjects = [score('a', 9), score('b', 9), score('c', 9), score('d', 9), score('e', 9), score('f', 9), comment('tc', 'Chưa đạt'), comment('nn', 'Chưa đạt')];
    expect(classifyLearningLevel(subjects).level).toBe('Chưa đạt');
  });
});

describe('quy tắc điều chỉnh Điều 9.3 — nâng 1 mức khi bị hạ ≥2 mức chỉ vì 1 môn', () => {
  it('6 môn 9,0 + 1 môn 4,0: gốc Đạt (bỏ môn 4,0 thì Tốt — hạ 2 mức) → nâng lên Khá', () => {
    const subjects = [score('a', 9), score('b', 9), score('c', 9), score('d', 9), score('e', 9), score('f', 9), score('bad', 4.0)];
    const result = classifyLearningLevel(subjects);
    expect(result.baseLevel).toBe('Đạt');
    expect(result.adjusted).toBe(true);
    expect(result.adjustedDueToSubjectKey).toBe('bad');
    expect(result.level).toBe('Khá');
  });
  it('không nâng khi hạ chỉ 1 mức: 6 môn 9,0 + 1 môn 5,5 → gốc Khá, bỏ môn đó thì Tốt (hạ 1 mức)', () => {
    const subjects = [score('a', 9), score('b', 9), score('c', 9), score('d', 9), score('e', 9), score('f', 9), score('mid', 5.5)];
    const result = classifyLearningLevel(subjects);
    expect(result.baseLevel).toBe('Khá');
    expect(result.adjusted).toBe(false);
    expect(result.level).toBe('Khá');
  });
  it('không nâng khi có 2 môn cùng kéo xuống (không phải duy nhất 1 môn)', () => {
    const subjects = [score('a', 9), score('b', 9), score('c', 9), score('d', 9), score('e', 9), score('f', 9), score('bad1', 4.0), score('bad2', 4.2)];
    const result = classifyLearningLevel(subjects);
    expect(result.baseLevel).toBe('Đạt');
    expect(result.adjusted).toBe(false);
    expect(result.level).toBe('Đạt');
  });
  it('môn nhận xét Chưa đạt duy nhất kéo từ Tốt xuống Đạt → nâng lên Khá', () => {
    const subjects = [score('a', 9), score('b', 9), score('c', 9), score('d', 9), score('e', 9), score('f', 9), comment('tc', 'Chưa đạt')];
    const result = classifyLearningLevel(subjects);
    expect(result.baseLevel).toBe('Đạt');
    expect(result.adjusted).toBe(true);
    expect(result.adjustedDueToSubjectKey).toBe('tc');
    expect(result.level).toBe('Khá');
  });
});

describe('quy đổi điểm hoạt động về thang 10 (Điều 5.3b, GB-VN-2)', () => {
  it('quy đổi tuyến tính theo thang của hoạt động và làm tròn 1 chữ số thập phân', () => {
    // Số tính tay: 30/40 = 0,75 → 7,5; 18/20 = 0,9 → 9,0; 13/15 = 0,8666… → 8,7.
    expect(convertGradeToScale10(30, 0, 40)).toBe(7.5);
    expect(convertGradeToScale10(18, 0, 20)).toBe(9);
    expect(convertGradeToScale10(13, 0, 15)).toBe(8.7);
    expect(convertGradeToScale10(7.55, 0, 10)).toBe(7.6);
  });
  it('tôn trọng gradeMin khác 0 và kẹp về [0, 10]', () => {
    // Thang [5, 25]: (15 − 5)/(25 − 5) = 0,5 → 5,0; dưới min → 0; trên max → 10.
    expect(convertGradeToScale10(15, 5, 25)).toBe(5);
    expect(convertGradeToScale10(2, 5, 25)).toBe(0);
    expect(convertGradeToScale10(30, 5, 25)).toBe(10);
  });
  it('thang không hợp lệ thì ném lỗi', () => {
    expect(() => convertGradeToScale10(5, 10, 10)).toThrow();
    expect(() => convertGradeToScale10(5, 10, 5)).toThrow();
    expect(() => convertGradeToScale10(Number.NaN, 0, 10)).toThrow();
  });
});

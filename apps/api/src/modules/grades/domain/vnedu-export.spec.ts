import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  buildVneduGrid,
  renderVneduWorkbook,
  roundToOneDecimal,
  semesterAverage,
  toTenScale,
  VNEDU_DATA_START_ROW,
  type VneduExportModel,
} from './vnedu-export';

/**
 * VneduExport (issue #53) — oracle là Thông tư 22/2021/TT-BGDĐT:
 * Điều 5 (thang 10, làm tròn 1 chữ số thập phân), Điều 9 (ĐTBmhk =
 * (TĐĐGtx + 2×ĐĐGgk + 3×ĐĐGck) / (số ĐĐGtx + 5), chỉ tổng kết khi đủ điểm).
 */
describe('roundToOneDecimal', () => {
  it('làm tròn nửa lên tới 1 chữ số thập phân, khử nhiễu phẩy động', () => {
    expect(roundToOneDecimal(8.25)).toBe(8.3);
    expect(roundToOneDecimal(8.24)).toBe(8.2);
    expect(roundToOneDecimal(8.05)).toBe(8.1);
    expect(roundToOneDecimal(7)).toBe(7);
    expect(roundToOneDecimal(9.95)).toBe(10);
    expect(roundToOneDecimal(0)).toBe(0);
  });
});

describe('toTenScale', () => {
  it('quy đổi tuyến tính theo khoảng điểm của mục điểm rồi làm tròn', () => {
    expect(toTenScale(85, 0, 100)).toBe(8.5);
    expect(toTenScale(40, 0, 50)).toBe(8);
    expect(toTenScale(8, 0, 10)).toBe(8);
    expect(toTenScale(15, 10, 20)).toBe(5);
    expect(toTenScale(87.5, 0, 100)).toBe(8.8);
    expect(toTenScale(0, 0, 100)).toBe(0);
    expect(toTenScale(100, 0, 100)).toBe(10);
  });
});

describe('semesterAverage', () => {
  it('áp đúng công thức Điều 9: thường xuyên hệ số 1, giữa kỳ 2, cuối kỳ 3, mẫu số = số ĐĐGtx + 5', () => {
    // (8 + 7.5 + 2×7 + 3×9) / (2 + 5) = 56.5 / 7 ≈ 8.071 → 8.1
    expect(semesterAverage([8, 7.5], 7, 9)).toBe(8.1);
    // Một cột thường xuyên: (10 + 20 + 30) / 6 = 10
    expect(semesterAverage([10], 10, 10)).toBe(10);
    // Bốn cột thường xuyên: (6+7+8+9 + 2×5 + 3×5) / 9 = 55 / 9 ≈ 6.11 → 6.1
    expect(semesterAverage([6, 7, 8, 9], 5, 5)).toBe(6.1);
  });

  it('thiếu bất kỳ điểm thành phần nào thì không tổng kết (null)', () => {
    expect(semesterAverage([8, null], 7, 9)).toBeNull();
    expect(semesterAverage([8, 7.5], null, 9)).toBeNull();
    expect(semesterAverage([8, 7.5], 7, null)).toBeNull();
    expect(semesterAverage([], 7, 9)).toBeNull();
  });
});

function sampleModel(): VneduExportModel {
  return {
    className: '10A1',
    subjectName: 'Toán',
    semester: 1,
    schoolYear: '2026-2027',
    regular: [
      { id: 'tx1', name: 'Kiểm tra miệng', gradeMin: 0, gradeMax: 10 },
      { id: 'tx2', name: 'Kiểm tra 15 phút', gradeMin: 0, gradeMax: 100 },
    ],
    midterm: { id: 'gk', name: 'Giữa kỳ', gradeMin: 0, gradeMax: 10 },
    final: { id: 'ck', name: 'Cuối kỳ', gradeMin: 0, gradeMax: 10 },
    students: [
      {
        code: 'student1',
        fullName: 'Trần Minh Quân',
        grades: new Map<string, number | null>([['tx1', 8], ['tx2', 75], ['gk', 7], ['ck', 9]]),
      },
      {
        code: 'student2',
        fullName: 'Phạm Thu Hằng',
        grades: new Map<string, number | null>([['tx1', 9], ['tx2', null], ['gk', 6.5], ['ck', null]]),
      },
    ],
  };
}

describe('buildVneduGrid', () => {
  it('bố cục: tựa + thông tin + đầu bảng 2 tầng (STT/Mã/Họ tên/Thường xuyên/Định kỳ/ĐTBmhk), dữ liệu từ dòng 6', () => {
    const grid = buildVneduGrid(sampleModel());
    expect(grid.columnCount).toBe(8);
    expect(grid.rows[0]![0]).toBe('BẢNG ĐIỂM MÔN HỌC');
    expect(grid.rows[1]![0]).toContain('Lớp: 10A1');
    expect(grid.rows[1]![0]).toContain('Môn học: Toán');
    expect(grid.rows[1]![0]).toContain('Học kỳ: I');
    expect(grid.rows[1]![0]).toContain('Năm học: 2026-2027');
    expect(grid.rows[3]).toEqual([
      'STT', 'Mã học sinh', 'Họ và tên',
      'Điểm đánh giá thường xuyên', null,
      'Điểm đánh giá định kỳ', null,
      'Điểm trung bình môn học kỳ (ĐTBmhk)',
    ]);
    expect(grid.rows[4]).toEqual([
      null, null, null,
      'Kiểm tra miệng', 'Kiểm tra 15 phút',
      'ĐĐGgk (hệ số 2)', 'ĐĐGck (hệ số 3)',
      null,
    ]);
    // Các vùng gộp cốt lõi: nhóm thường xuyên (dòng 4, cột 4–5), nhóm định kỳ
    // (cột 6–7), ĐTBmhk gộp dọc 2 dòng đầu bảng, STT gộp dọc.
    expect(grid.merges).toContainEqual({ top: 4, left: 4, bottom: 4, right: 5 });
    expect(grid.merges).toContainEqual({ top: 4, left: 6, bottom: 4, right: 7 });
    expect(grid.merges).toContainEqual({ top: 4, left: 8, bottom: 5, right: 8 });
    expect(grid.merges).toContainEqual({ top: 4, left: 1, bottom: 5, right: 1 });
  });

  it('mỗi ô điểm trên lưới khớp điểm gradebook đã quy đổi thang 10; thiếu điểm thì trống và không có ĐTBmhk', () => {
    const grid = buildVneduGrid(sampleModel());
    // student1: tx1 8/10 → 8; tx2 75/100 → 7.5; gk 7; ck 9; ĐTB = 56.5/7 → 8.1
    expect(grid.rows[VNEDU_DATA_START_ROW - 1]).toEqual([1, 'student1', 'Trần Minh Quân', 8, 7.5, 7, 9, 8.1]);
    // student2: tx2 và ck chưa có → trống; ĐTB trống theo quy tắc đủ điểm mới tổng kết.
    expect(grid.rows[VNEDU_DATA_START_ROW]).toEqual([2, 'student2', 'Phạm Thu Hằng', 9, null, 6.5, null, null]);
  });
});

describe('renderVneduWorkbook', () => {
  it('sinh file .xlsx đọc lại được, giữ đúng giá trị từng ô điểm', async () => {
    const buffer = await renderVneduWorkbook(sampleModel());
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK'); // xlsx là zip
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet('Bảng điểm');
    expect(sheet).toBeDefined();
    expect(sheet!.getCell(1, 1).value).toBe('BẢNG ĐIỂM MÔN HỌC');
    expect(sheet!.getCell(4, 4).value).toBe('Điểm đánh giá thường xuyên');
    expect(sheet!.getCell(5, 6).value).toBe('ĐĐGgk (hệ số 2)');
    // Dòng dữ liệu đầu: STT 1, tx2 quy đổi 7.5, ĐTBmhk 8.1.
    expect(sheet!.getCell(VNEDU_DATA_START_ROW, 1).value).toBe(1);
    expect(sheet!.getCell(VNEDU_DATA_START_ROW, 5).value).toBe(7.5);
    expect(sheet!.getCell(VNEDU_DATA_START_ROW, 8).value).toBe(8.1);
    // Dòng hai: ô chưa có điểm để trống thật (không phải 0 hay chuỗi rỗng).
    expect(sheet!.getCell(VNEDU_DATA_START_ROW + 1, 5).value ?? null).toBeNull();
    expect(sheet!.getCell(VNEDU_DATA_START_ROW + 1, 8).value ?? null).toBeNull();
  });
});

/**
 * VneduExport — dựng bảng điểm Excel theo cấu trúc vnEdu trên nền Thông tư
 * 22/2021/TT-BGDĐT (issue #53; kết quả kiểm chứng mẫu ở comment Bước 0 của
 * issue). Thuần dữ liệu + một hàm render ExcelJS:
 *
 * - Điểm thành phần: ĐĐGtx hệ số 1 (mỗi mục điểm thường xuyên là một cột),
 *   ĐĐGgk hệ số 2, ĐĐGck hệ số 3 (Điều 6, Điều 7).
 * - Điểm xuất là finalGrade của gradebook QUY ĐỔI về thang 10 theo
 *   gradeMin/gradeMax của mục điểm, làm tròn đến chữ số thập phân thứ nhất
 *   (Điều 5 khoản 3 điểm b).
 * - ĐTBmhk = (TĐĐGtx + 2×ĐĐGgk + 3×ĐĐGck) / (số ĐĐGtx + 5) (Điều 9 khoản 1
 *   điểm b); chỉ tính khi học sinh có đủ mọi điểm thành phần — thiếu bất kỳ
 *   điểm nào thì ô ĐTBmhk để trống, đúng cách vnEdu chỉ tổng kết khi đủ điểm.
 */
import ExcelJS from 'exceljs';

/** Một mục điểm thành phần của bảng xuất: định danh, nhãn cột và khoảng điểm gốc trong gradebook. */
export interface VneduExportItem {
  id: string;
  name: string;
  gradeMin: number;
  gradeMax: number;
}

/** Một học sinh trong bảng xuất: mã (username), họ tên và finalGrade thô theo itemId (null = chưa có điểm). */
export interface VneduExportStudent {
  code: string;
  fullName: string;
  grades: ReadonlyMap<string, number | null>;
}

/** Toàn bộ dữ liệu cần để dựng một bảng điểm vnEdu cho một môn/lớp/học kỳ. */
export interface VneduExportModel {
  className: string;
  subjectName: string;
  semester: 1 | 2;
  schoolYear: string;
  regular: readonly VneduExportItem[];
  midterm: VneduExportItem;
  final: VneduExportItem;
  students: readonly VneduExportStudent[];
}

/** Một vùng gộp ô 1-based, bao hàm cả hai đầu. */
export interface VneduMerge {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** Lưới ô của sheet: giá trị từng ô (null = trống) + các vùng gộp. Dòng/cột tính từ 1 khi áp merge. */
export interface VneduGrid {
  rows: (string | number | null)[][];
  merges: VneduMerge[];
  columnCount: number;
}

/** Số dòng tiêu đề phía trên dòng dữ liệu đầu tiên (tựa, thông tin, trống, 2 dòng đầu bảng). */
export const VNEDU_DATA_START_ROW = 6;

/** Làm tròn đến chữ số thập phân thứ nhất (Điều 5 TT22), khử nhiễu dấu phẩy động ở biên ,5. */
export function roundToOneDecimal(value: number): number {
  const rounded = Math.round((value + Number.EPSILON) * 10) / 10;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Quy đổi một finalGrade về thang 10 theo khoảng [gradeMin, gradeMax] của
 * mục điểm rồi làm tròn 1 chữ số thập phân. Người gọi phải bảo đảm
 * gradeMax > gradeMin (service kiểm tra khi validate ánh xạ).
 */
export function toTenScale(finalGrade: number, gradeMin: number, gradeMax: number): number {
  return roundToOneDecimal(((finalGrade - gradeMin) / (gradeMax - gradeMin)) * 10);
}

/**
 * ĐTBmhk theo Điều 9 TT22 từ các điểm thành phần ĐÃ quy đổi thang 10.
 * Trả null khi thiếu bất kỳ điểm thành phần nào (chưa đủ điều kiện tổng kết).
 */
export function semesterAverage(
  regularValues: readonly (number | null)[],
  midterm: number | null,
  final: number | null,
): number | null {
  if (!regularValues.length || midterm === null || final === null) return null;
  if (regularValues.some((v) => v === null)) return null;
  const totalRegular = regularValues.reduce((sum: number, v) => sum + (v as number), 0);
  return roundToOneDecimal((totalRegular + 2 * midterm + 3 * final) / (regularValues.length + 5));
}

/** Điểm thang 10 của một học sinh cho một mục điểm; null khi chưa có finalGrade. */
function studentValue(student: VneduExportStudent, item: VneduExportItem): number | null {
  const raw = student.grades.get(item.id);
  if (raw === null || raw === undefined) return null;
  return toTenScale(raw, item.gradeMin, item.gradeMax);
}

/**
 * Dựng lưới ô của sheet bảng điểm:
 * dòng 1 tựa đề, dòng 2 thông tin lớp/môn/kỳ/năm, dòng 3 trống, dòng 4–5 đầu
 * bảng hai tầng (nhóm Thường xuyên / Định kỳ), từ dòng 6 là dữ liệu học sinh.
 * Cột: STT | Mã học sinh | Họ và tên | các cột ĐĐGtx | ĐĐGgk | ĐĐGck | ĐTBmhk.
 */
export function buildVneduGrid(model: VneduExportModel): VneduGrid {
  const regularCount = model.regular.length;
  const firstRegularCol = 4;
  const lastRegularCol = firstRegularCol + regularCount - 1;
  const midtermCol = lastRegularCol + 1;
  const finalCol = midtermCol + 1;
  const averageCol = finalCol + 1;
  const columnCount = averageCol;

  const blankRow = (): (string | number | null)[] => Array.from({ length: columnCount }, () => null);

  const titleRow = blankRow();
  titleRow[0] = 'BẢNG ĐIỂM MÔN HỌC';

  const infoRow = blankRow();
  infoRow[0] = `Lớp: ${model.className} · Môn học: ${model.subjectName} · Học kỳ: ${model.semester === 1 ? 'I' : 'II'} · Năm học: ${model.schoolYear}`;

  const groupRow = blankRow();
  groupRow[0] = 'STT';
  groupRow[1] = 'Mã học sinh';
  groupRow[2] = 'Họ và tên';
  groupRow[firstRegularCol - 1] = 'Điểm đánh giá thường xuyên';
  groupRow[midtermCol - 1] = 'Điểm đánh giá định kỳ';
  groupRow[averageCol - 1] = 'Điểm trung bình môn học kỳ (ĐTBmhk)';

  const labelRow = blankRow();
  model.regular.forEach((item, i) => { labelRow[firstRegularCol - 1 + i] = item.name; });
  labelRow[midtermCol - 1] = 'ĐĐGgk (hệ số 2)';
  labelRow[finalCol - 1] = 'ĐĐGck (hệ số 3)';

  const rows: (string | number | null)[][] = [titleRow, infoRow, blankRow(), groupRow, labelRow];
  model.students.forEach((student, index) => {
    const row = blankRow();
    row[0] = index + 1;
    row[1] = student.code;
    row[2] = student.fullName;
    const regularValues = model.regular.map((item, i) => {
      const value = studentValue(student, item);
      row[firstRegularCol - 1 + i] = value;
      return value;
    });
    const midtermValue = studentValue(student, model.midterm);
    const finalValue = studentValue(student, model.final);
    row[midtermCol - 1] = midtermValue;
    row[finalCol - 1] = finalValue;
    row[averageCol - 1] = semesterAverage(regularValues, midtermValue, finalValue);
    rows.push(row);
  });

  const merges: VneduMerge[] = [
    { top: 1, left: 1, bottom: 1, right: columnCount },
    { top: 2, left: 1, bottom: 2, right: columnCount },
    { top: 4, left: 1, bottom: 5, right: 1 },
    { top: 4, left: 2, bottom: 5, right: 2 },
    { top: 4, left: 3, bottom: 5, right: 3 },
    { top: 4, left: midtermCol, bottom: 4, right: finalCol },
    { top: 4, left: averageCol, bottom: 5, right: averageCol },
  ];
  // Nhóm thường xuyên chỉ gộp khi có từ 2 cột (gộp 1 ô là vô nghĩa với Excel).
  if (regularCount > 1) merges.push({ top: 4, left: firstRegularCol, bottom: 4, right: lastRegularCol });

  return { rows, merges, columnCount };
}

/** Render lưới ô thành file .xlsx (một sheet "Bảng điểm") bằng ExcelJS: đầu bảng in đậm/căn giữa, điểm định dạng 0.0, đóng băng 5 dòng đầu. */
export async function renderVneduWorkbook(model: VneduExportModel): Promise<Buffer> {
  const grid = buildVneduGrid(model);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Bảng điểm');

  grid.rows.forEach((values, rowIndex) => {
    const row = sheet.getRow(rowIndex + 1);
    values.forEach((value, colIndex) => {
      if (value !== null) row.getCell(colIndex + 1).value = value;
    });
  });
  for (const merge of grid.merges) {
    sheet.mergeCells(merge.top, merge.left, merge.bottom, merge.right);
  }

  const thin = { style: 'thin' as const };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  const headerFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDEEAF6' } };

  const titleCell = sheet.getCell(1, 1);
  titleCell.font = { bold: true, size: 14 };
  titleCell.alignment = { horizontal: 'center' };
  sheet.getCell(2, 1).alignment = { horizontal: 'center' };

  for (let r = 4; r <= 5; r += 1) {
    for (let c = 1; c <= grid.columnCount; c += 1) {
      const cell = sheet.getCell(r, c);
      cell.font = { bold: true };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.fill = headerFill;
      cell.border = border;
    }
  }
  for (let r = VNEDU_DATA_START_ROW; r < VNEDU_DATA_START_ROW + model.students.length; r += 1) {
    for (let c = 1; c <= grid.columnCount; c += 1) {
      const cell = sheet.getCell(r, c);
      cell.border = border;
      if (c === 1 || c >= 4) cell.alignment = { horizontal: 'center' };
      if (c >= 4 && typeof cell.value === 'number') cell.numFmt = '0.0';
    }
  }

  sheet.getColumn(1).width = 6;
  sheet.getColumn(2).width = 16;
  sheet.getColumn(3).width = 28;
  for (let c = 4; c <= grid.columnCount; c += 1) sheet.getColumn(c).width = 15;
  sheet.views = [{ state: 'frozen', ySplit: VNEDU_DATA_START_ROW - 1 }];

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

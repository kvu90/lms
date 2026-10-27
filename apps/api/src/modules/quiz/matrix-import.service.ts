/**
 * Nhập ma trận đề từ file .xlsx (chuỗi lát I-1 → I-2 → I-3 trên issue
 * #233, theo hồ sơ `matrix-import-research-2026-10-26.md` đã đối chiếu
 * sổ quyết định mục B).
 *
 * Flow tổng thể của lát I-1 (file này):
 * 1. Giáo viên chọn (môn, chương trình, phạm vi ĐVK, checkbox Vận dụng
 *    cao) → {@link MatrixImportService.buildTemplate} sinh workbook
 *    mẫu 3 sheet (`Hướng dẫn` / `Ma trận` / `Đặc tả`) đã điền sẵn danh
 *    sách hàng theo ĐƠN VỊ KIẾN THỨC của chương trình: cột khoá
 *    "Mã ĐVK" = id của `curriculum_nodes` (hệ không có mã vị trí cho
 *    node như YCCĐ nên id là khoá neo duy nhất — sổ chốt 05:33 ngày
 *    26/10: file nhập ma trận khoá theo ĐVK, KHÔNG dùng UUID của
 *    YCCĐ), kèm tên chủ đề/ĐVK và nguyên văn các YCCĐ thuộc ĐVK để
 *    giáo viên đối chiếu khi điền số. Giáo viên chỉ điền: tên ma trận,
 *    tổng điểm, điểm mỗi câu theo dạng và số câu/chùm vào lưới.
 * 2. Giáo viên tải file đã điền lên → {@link
 *    MatrixImportService.previewImport} parse lại workbook, kiểm lỗi
 *    hai tầng (lỗi cứng định vị theo sheet/dòng/cột + cảnh báo tỉ lệ
 *    theo tinh thần chữ "khoảng" của chú thích 5 CV 7991), tính lại
 *    tổng hai chiều từ các ô (KHÔNG tin công thức trong file), đối
 *    chiếu từng Mã ĐVK với `curriculum_nodes` thật của chương trình
 *    trong file và đính khả dụng ngân hàng theo từng ô dự thảo.
 * 3. Lát I-1 KHÔNG ghi DB: preview chỉ là kết quả kiểm. Lát I-2
 *    ({@link MatrixImportService.commitImport}) nhận lại chính file,
 *    chạy lại toàn bộ bước 2 tại thời điểm ghi rồi mới ghi nguyên tử
 *    (tạo `exam_matrices` + cells trong một transaction qua
 *    `QuizService.createMatrixFromImport`); luồng web 5 bước là lát
 *    I-3.
 *
 * Bất biến giữ ở mọi đường: ô ma trận neo ĐVK × mức × dạng (ma trận
 * KHÔNG gắn YCCĐ — đính chính #249 đã thi hành ở PR #259); với dạng
 * Đúng–Sai, số trong ô là số CHÙM (1 chùm = 4 ý, chú thích 2 CV 7991);
 * điểm của ô = số lượng × điểm-mỗi-câu của dạng khai ở khối thông tin
 * chung; bộ mức là 3 mức CV 7991, cột Vận dụng cao chỉ tồn tại khi
 * file khai "Có" ở trường checkbox và lưới cột phải khớp khai đó.
 */
import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import type {
  ExamMatrixView, MatrixImportIssue, MatrixImportPreview, MatrixImportPreviewCell,
} from '@lms/contracts';
import { CurriculumService, type CurriculumTreeView } from '../curriculum/curriculum.service';
import { MATRIX_PRESETS, matrixWarnings } from './domain/matrix';
import { QuizService } from './quiz.service';

/** Tên các sheet trong workbook mẫu — parser chỉ đọc sheet `Ma trận`; sheet `Đặc tả` là để giáo viên đối chiếu/in nộp, hệ không đọc số từ đó (một nguồn số liệu duy nhất). */
export const MATRIX_IMPORT_SHEET_MATRIX = 'Ma trận';
const SHEET_GUIDE = 'Hướng dẫn';
const SHEET_SPEC = 'Đặc tả';

/** Các dạng câu theo đúng thứ tự cột của Phụ lục 1 CV 7991 trong file mẫu. */
const FORM_DEFS = [
  { qtype: 'multichoice', label: 'Nhiều lựa chọn', scoreLabel: 'Điểm mỗi câu — Nhiều lựa chọn' },
  { qtype: 'truefalse', label: 'Đúng – Sai (số chùm, 4 ý/chùm)', scoreLabel: 'Điểm mỗi chùm — Đúng–Sai (1 chùm = 4 ý)' },
  { qtype: 'shortanswer', label: 'Trả lời ngắn', scoreLabel: 'Điểm mỗi câu — Trả lời ngắn' },
  { qtype: 'essay', label: 'Tự luận', scoreLabel: 'Điểm mỗi câu — Tự luận' },
] as const;
type MatrixFormQtype = (typeof FORM_DEFS)[number]['qtype'];

/** Các mức nhận thức theo thứ tự cột trong từng nhóm dạng; `van_dung_cao` chỉ xuất hiện khi file bật checkbox. */
const LEVEL_DEFS = [
  { level: 'biet', label: 'Biết' },
  { level: 'hieu', label: 'Hiểu' },
  { level: 'van_dung', label: 'Vận dụng' },
  { level: 'van_dung_cao', label: 'Vận dụng cao' },
] as const;
type MatrixLevel = (typeof LEVEL_DEFS)[number]['level'];

/** Nhãn các trường của khối thông tin chung ở đầu sheet `Ma trận` (nhãn ở cột A, giá trị ở cột B, riêng mã môn/chương trình ở cột D với nhãn ở cột C). */
const INFO = {
  name: 'Tên ma trận',
  subjectName: 'Môn học',
  subjectId: 'Mã môn',
  curriculumName: 'Chương trình',
  curriculumId: 'Mã chương trình',
  totalScore: 'Tổng điểm toàn bài',
  useVdc: 'Thêm mức Vận dụng cao',
  scopeNote: 'Ghi chú phạm vi',
} as const;

/** Nhãn cột khoá của lưới — parser tìm hàng tiêu đề bằng nhãn này ở cột A. */
const GRID_KEY_LABEL = 'Mã ĐVK';
/** Số hàng dữ liệu tối đa trong một file nhập (chặn file phình bất thường; một chương trình môn học không tới mức này). */
const MAX_DATA_ROWS = 500;
/** Dung sai lệch tổng điểm toàn bài (điểm) — lệch quá mức này là lỗi cứng số học, khác với lệch PHÂN BỔ tỉ lệ vốn chỉ cảnh báo theo chữ "khoảng". */
const TOTAL_SCORE_TOLERANCE = 0.05;

/** Hình dạng tối thiểu của một worksheet exceljs mà parser cần (tránh phụ thuộc namespace kiểu của exceljs — gói này được nạp động như các đường xuất/nhập file hiện hành). */
interface ImportWorksheetLike {
  rowCount: number;
  columnCount: number;
  getCell(row: number, col: number): { value: unknown };
}

/** Một ĐVK đã làm phẳng từ cây chương trình, kèm chủ đề tổ tiên và các YCCĐ thuộc ĐVK. */
interface FlatUnit {
  nodeId: string;
  topicTitle: string;
  nodeTitle: string;
  outcomes: { id: string; content: string }[];
}

/** Một cột số của lưới đã nhận diện: thuộc dạng nào, mức nào, ở cột Excel nào (1-based). */
interface GridColumn {
  columnIndex: number;
  columnLetter: string;
  qtype: MatrixFormQtype;
  level: MatrixLevel;
}

/** Giá trị đã trích từ một ô Excel: số (kèm cờ có phải số nguyên không) hoặc chuỗi đã cắt khoảng trắng; null = ô trống. */
type RawCellValue = { kind: 'number'; value: number } | { kind: 'text'; value: string } | null;

@Injectable()
/**
 * Service của chuỗi lát nhập ma trận: sinh workbook mẫu +
 * parse/preview file nhập (I-1, không ghi DB) và ghi nguyên tử khi
 * người nhập xác nhận (I-2 — parse lại từ file gốc tại thời điểm ghi,
 * không tin kết quả xem trước phía client).
 *
 * Phân quyền của cả ba đầu chốt tại BANK ĐÍCH — bank ma trận cá nhân
 * của người nhập — qua cổng dùng chung
 * `QuizService.requirePersonalMatrixBankManage` (học thuyết neo bank
 * MB-0/MB-1: ma trận nằm trong bank nào thì quyền theo bank đó,
 * context của môn chỉ là phạm vi dữ liệu). Dữ liệu tham chiếu
 * môn/chương trình/cây đọc bằng đường tham chiếu nội bộ của
 * CurriculumService sau khi đã qua cổng bank. Trước đây luồng còn
 * gác thêm `quiz:managematrix` và (qua đường đọc công khai)
 * `curriculum:view` tại context của môn: môn GDPT neo tại context hệ
 * thống trong khi giáo viên chỉ được gán vai tại context khoá/trung
 * tâm, nên hai lớp cổng đó chặn nhầm mọi giáo viên ở cả ba đầu, và
 * lỗi quyền ở bước đọc môn còn bị nuốt thành "môn không tồn tại"
 * (điểm chặn của nghiệm thu D-3 trên production, issue #233). Các
 * endpoint đọc công khai của chương trình không qua luồng này nên
 * cổng của chúng không đổi.
 */
export class MatrixImportService {
  constructor(
    private readonly curriculum: CurriculumService,
    private readonly quiz: QuizService,
  ) {}

  // --- Sinh mẫu ---------------------------------------------------------------

  /**
   * Sinh workbook mẫu cho một (môn, chương trình, phạm vi, bộ mức).
   *
   * Flow: gác cổng bank cá nhân của luồng nhập (cổng duy nhất của cả
   * ba đầu — chạy TRƯỚC mọi lần đọc để người không đủ tư cách không
   * dò được dữ liệu môn/chương trình qua đầu này) → đối chiếu chương
   * trình thuộc môn bằng đường đọc tham chiếu nội bộ → lấy cây
   * chương trình, làm phẳng thành danh sách ĐVK theo thứ tự cây (lọc
   * theo `scopeNodeIds` nếu có: giữ ĐVK nằm trong phạm vi đã chọn
   * hoặc thuộc subtree của node trong phạm vi) → dựng 3 sheet.
   *
   * @param actorId - Người gọi (giáo viên).
   * @param input - subjectId/curriculumId bắt buộc; levelSet mặc định
   *   'three'; scopeNodeIds null/rỗng = toàn bộ ĐVK của chương trình.
   * @returns Tên file + buffer .xlsx sẵn sàng trả về client.
   * @throws ForbiddenException khi người gọi không qua được cổng bank
   *   cá nhân của luồng nhập (xem
   *   `QuizService.requirePersonalMatrixBankManage`).
   * @throws NotFoundException khi môn hoặc chương trình không tồn tại.
   * @throws BadRequestException khi chương trình không thuộc môn, hoặc
   *   phạm vi không chứa ĐVK nào.
   */
  async buildTemplate(actorId: string, input: {
    subjectId: string; curriculumId: string;
    levelSet?: 'three' | 'four'; scopeNodeIds?: string[] | null;
  }): Promise<{ filename: string; contentType: string; buffer: Buffer }> {
    await this.quiz.requirePersonalMatrixBankManage(actorId);
    const subject = await this.curriculum.getSubjectReference(input.subjectId);
    const curriculum = await this.curriculum.getCurriculumReference(input.curriculumId);
    if (curriculum.subjectId !== subject.id) {
      throw new BadRequestException({ message: 'Curriculum does not belong to the subject', code: 'quiz.matrix_curriculum_mismatch' });
    }
    const levelSet = input.levelSet ?? 'three';
    const tree = await this.curriculum.getTreeReference(curriculum.id);
    const units = this.flattenUnits(tree).filter((u) => this.inScope(u.nodeId, tree, input.scopeNodeIds));
    if (!units.length) {
      throw new BadRequestException({ message: 'The selected scope contains no knowledge units', code: 'quiz.matrix_import_scope_empty' });
    }
    const buffer = await this.renderTemplateWorkbook({
      subjectName: subject.name, subjectId: subject.id,
      curriculumLabel: `Lớp ${curriculum.grade}`, curriculumId: curriculum.id,
      levelSet, units,
    });
    const slug = (subject as { slug?: string }).slug ?? 'mon-hoc';
    return {
      filename: `mau-ma-tran-${slug}-lop-${curriculum.grade}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer,
    };
  }

  /**
   * Làm phẳng cây chương trình thành danh sách ĐVK (node kind
   * 'lesson') theo đúng thứ tự cây; chủ đề của một ĐVK là node tổ tiên
   * kind 'topic' gần nhất, không có thì lấy node gốc cao nhất của
   * nhánh — cùng quy tắc dựng bản đặc tả hiện hành.
   */
  private flattenUnits(tree: CurriculumTreeView): FlatUnit[] {
    const units: FlatUnit[] = [];
    type NodeView = CurriculumTreeView['nodes'][number];
    const walk = (node: NodeView, topicTitle: string | null, rootTitle: string) => {
      const topic = node.kind === 'topic' ? node.title : topicTitle;
      if (node.kind === 'lesson') {
        units.push({
          nodeId: node.id,
          topicTitle: topic ?? rootTitle,
          nodeTitle: node.title,
          outcomes: node.outcomes.map((o) => ({ id: o.id, content: o.content })),
        });
      }
      for (const child of node.children) walk(child, topic, rootTitle);
    };
    for (const root of tree.nodes) walk(root, null, root.title);
    return units;
  }

  /** ĐVK thuộc phạm vi khi: không khai phạm vi; hoặc chính nó nằm trong phạm vi; hoặc một tổ tiên của nó nằm trong phạm vi (phạm vi chọn theo chủ đề bao cả subtree). */
  private inScope(nodeId: string, tree: CurriculumTreeView, scopeNodeIds?: string[] | null): boolean {
    if (!scopeNodeIds || scopeNodeIds.length === 0) return true;
    const scope = new Set(scopeNodeIds);
    if (scope.has(nodeId)) return true;
    type NodeView = CurriculumTreeView['nodes'][number];
    let found = false;
    const walk = (node: NodeView, ancestorInScope: boolean) => {
      const here = ancestorInScope || scope.has(node.id);
      if (node.id === nodeId) { found = here; return; }
      for (const child of node.children) walk(child, here);
    };
    for (const root of tree.nodes) walk(root, false);
    return found;
  }

  /**
   * Dựng workbook mẫu 3 sheet bằng exceljs (cùng hạ tầng với xuất bản
   * đặc tả và xuất vnEdu). Sheet `Ma trận` mang khối thông tin chung ở
   * các dòng cố định 2–11, hàng tiêu đề lưới ở dòng 13–14, dữ liệu từ
   * dòng 15 và 3 hàng tổng bằng CÔNG THỨC Excel ngay dưới dữ liệu để
   * giáo viên thấy tổng trong lúc điền (hệ không tin các công thức
   * này khi nhập — tự tính lại từ các ô). Sheet `Đặc tả` tham chiếu
   * sang sheet `Ma trận` bằng công thức, chỉ để đối chiếu/in.
   */
  private async renderTemplateWorkbook(input: {
    subjectName: string; subjectId: string;
    curriculumLabel: string; curriculumId: string;
    levelSet: 'three' | 'four'; units: FlatUnit[];
  }): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const levels = LEVEL_DEFS.filter((l) => input.levelSet === 'four' || l.level !== 'van_dung_cao');
    // Cột số bắt đầu ở F (6); mỗi dạng chiếm đúng số cột bằng số mức.
    const firstDataCol = 6;
    const colsPerForm = levels.length;
    const lastDataCol = firstDataCol + FORM_DEFS.length * colsPerForm - 1;
    const letter = (idx: number) => this.columnLetter(idx);

    // --- Sheet Hướng dẫn ---
    const guide = wb.addWorksheet(SHEET_GUIDE);
    guide.columns = [{ width: 110 }];
    const guideLines = [
      'HƯỚNG DẪN ĐIỀN MA TRẬN ĐỀ KIỂM TRA ĐỊNH KÌ (theo Công văn 7991/BGDĐT-GDTrH)',
      '',
      '1. Chỉ điền trên sheet "Ma trận". Sheet "Đặc tả" tự tham chiếu số từ sheet "Ma trận" để đối chiếu/in nộp — hệ thống KHÔNG đọc số từ sheet "Đặc tả".',
      '2. KHÔNG sửa cột "Mã ĐVK" (cột A): đây là khoá để hệ thống khớp hàng với đơn vị kiến thức thật của chương trình. Xoá hàng không dùng thì để trống các ô số của hàng đó.',
      '3. Điền khối thông tin chung: Tên ma trận, Tổng điểm toàn bài, điểm mỗi câu của từng dạng câu được dùng, và giữ nguyên trường "Thêm mức Vận dụng cao" đúng như lúc tải mẫu (muốn đổi thì tải lại mẫu mới).',
      '4. Điền số câu vào lưới theo từng đơn vị kiến thức: cột "Đúng – Sai" điền SỐ CHÙM (1 chùm = 4 ý). Ô để trống hoặc 0 nghĩa là không có câu ở ô đó.',
      '5. Tổng điểm tính lại từ các ô (số câu × điểm mỗi câu) phải bằng Tổng điểm toàn bài đã khai — lệch tổng là lỗi, hệ thống sẽ chặn nhập và báo vị trí cần sửa.',
      '6. Tỉ lệ điểm theo dạng/mức lệch mốc tham chiếu của CV 7991 (dạng 30/20/20/30, mức 40/30/30) chỉ là CẢNH BÁO, không chặn nhập — tỉ lệ từng ô do giáo viên quyết theo đối tượng học sinh.',
      '7. Cột "Yêu cầu cần đạt" trong sheet "Ma trận" chỉ để đối chiếu khi điền số; ma trận không gắn yêu cầu cần đạt — yêu cầu cần đạt thuộc bản đặc tả do hệ thống suy ra.',
    ];
    for (const line of guideLines) guide.addRow([line]);

    // --- Sheet Ma trận ---
    const ws = wb.addWorksheet(MATRIX_IMPORT_SHEET_MATRIX);
    ws.columns = [
      { width: 38 }, { width: 6 }, { width: 24 }, { width: 30 }, { width: 52 },
      ...Array.from({ length: FORM_DEFS.length * colsPerForm }, () => ({ width: 11 })),
    ];
    const headerFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDEEAF6' } };
    ws.mergeCells(1, 1, 1, lastDataCol);
    ws.getCell(1, 1).value = `MA TRẬN ĐỀ KIỂM TRA ĐỊNH KÌ — ${input.subjectName.toUpperCase()} (${input.curriculumLabel.toUpperCase()})`;
    ws.getCell(1, 1).font = { bold: true, size: 13 };
    const infoRows: [string, string | number, string?, string?][] = [
      [INFO.name, ''],
      [INFO.subjectName, input.subjectName, INFO.subjectId, input.subjectId],
      [INFO.curriculumName, input.curriculumLabel, INFO.curriculumId, input.curriculumId],
      [INFO.totalScore, 10],
      [INFO.useVdc, input.levelSet === 'four' ? 'Có' : 'Không'],
      [FORM_DEFS[0].scoreLabel, ''],
      [FORM_DEFS[1].scoreLabel, ''],
      [FORM_DEFS[2].scoreLabel, ''],
      [FORM_DEFS[3].scoreLabel, ''],
      [INFO.scopeNote, ''],
    ];
    infoRows.forEach(([label, value, keyLabel, keyValue], i) => {
      const row = i + 2;
      ws.getCell(row, 1).value = label;
      ws.getCell(row, 1).font = { bold: true };
      ws.getCell(row, 2).value = value;
      if (keyLabel) {
        ws.getCell(row, 3).value = keyLabel;
        ws.getCell(row, 3).font = { bold: true };
        ws.getCell(row, 4).value = keyValue ?? '';
      }
    });
    // Hàng tiêu đề lưới: dòng 13 = nhóm (khoá/STT/chủ đề/ĐVK/YCCĐ + nhóm dạng), dòng 14 = mức.
    const groupRow = 13;
    const levelRow = 14;
    const dataStart = 15;
    const fixedHeaders = [GRID_KEY_LABEL, 'STT', 'Chủ đề/Chương', 'Nội dung/Đơn vị kiến thức', 'Yêu cầu cần đạt (đối chiếu)'];
    fixedHeaders.forEach((h, i) => {
      ws.mergeCells(groupRow, i + 1, levelRow, i + 1);
      const cell = ws.getCell(groupRow, i + 1);
      cell.value = h;
      cell.font = { bold: true };
      cell.fill = headerFill;
    });
    FORM_DEFS.forEach((form, fi) => {
      const start = firstDataCol + fi * colsPerForm;
      ws.mergeCells(groupRow, start, groupRow, start + colsPerForm - 1);
      const head = ws.getCell(groupRow, start);
      head.value = form.label;
      head.font = { bold: true };
      head.fill = headerFill;
      head.alignment = { horizontal: 'center' };
      levels.forEach((lv, li) => {
        const cell = ws.getCell(levelRow, start + li);
        cell.value = lv.label;
        cell.font = { bold: true };
        cell.fill = headerFill;
        cell.alignment = { horizontal: 'center' };
      });
    });
    input.units.forEach((unit, i) => {
      const row = dataStart + i;
      ws.getCell(row, 1).value = unit.nodeId;
      ws.getCell(row, 2).value = i + 1;
      ws.getCell(row, 3).value = unit.topicTitle;
      ws.getCell(row, 4).value = unit.nodeTitle;
      const outcomeCell = ws.getCell(row, 5);
      outcomeCell.value = unit.outcomes.map((o) => o.content).join('\n');
      outcomeCell.alignment = { wrapText: true, vertical: 'top' };
    });
    // Ba hàng tổng bằng công thức (chỉ để giáo viên đối chiếu khi điền).
    const dataEnd = dataStart + input.units.length - 1;
    const totalsStart = dataEnd + 1;
    const totalLabels = ['Tổng số câu', 'Tổng số điểm', 'Tỉ lệ % điểm'];
    totalLabels.forEach((label, i) => {
      const row = totalsStart + i;
      ws.getCell(row, 4).value = label;
      ws.getCell(row, 4).font = { bold: true };
    });
    const scoreRowByForm: Record<string, number> = {
      multichoice: 7, truefalse: 8, shortanswer: 9, essay: 10,
    };
    for (let c = firstDataCol; c <= lastDataCol; c++) {
      const formIdx = Math.floor((c - firstDataCol) / colsPerForm);
      const form = FORM_DEFS[formIdx]!;
      const L = letter(c);
      ws.getCell(totalsStart, c).value = { formula: `SUM(${L}${dataStart}:${L}${dataEnd})` };
      ws.getCell(totalsStart + 1, c).value = { formula: `SUM(${L}${dataStart}:${L}${dataEnd})*$B$${scoreRowByForm[form.qtype]}` };
      ws.getCell(totalsStart + 2, c).value = {
        formula: `IF(SUM($${letter(firstDataCol)}$${totalsStart + 1}:$${letter(lastDataCol)}$${totalsStart + 1})=0,0,${L}${totalsStart + 1}/SUM($${letter(firstDataCol)}$${totalsStart + 1}:$${letter(lastDataCol)}$${totalsStart + 1})*100)`,
      };
      ws.getCell(totalsStart + 2, c).numFmt = '0.0';
    }
    ws.views = [{ state: 'frozen', ySplit: levelRow }];

    // --- Sheet Đặc tả (tham chiếu — hệ không đọc) ---
    const spec = wb.addWorksheet(SHEET_SPEC);
    spec.columns = ws.columns.map((c) => ({ width: c.width }));
    spec.mergeCells(1, 1, 1, lastDataCol);
    spec.getCell(1, 1).value = 'BẢN ĐẶC TẢ ĐỀ KIỂM TRA ĐỊNH KÌ (tham chiếu — số tự lấy từ sheet "Ma trận")';
    spec.getCell(1, 1).font = { bold: true, size: 13 };
    fixedHeaders.forEach((h, i) => {
      const cell = spec.getCell(groupRow, i + 1);
      cell.value = h;
      cell.font = { bold: true };
      cell.fill = headerFill;
    });
    FORM_DEFS.forEach((form, fi) => {
      const start = firstDataCol + fi * colsPerForm;
      const head = spec.getCell(groupRow, start);
      head.value = form.label;
      head.font = { bold: true };
      head.fill = headerFill;
    });
    const nlCol = lastDataCol + 1;
    spec.getCell(groupRow, nlCol).value = 'Ghi chú năng lực (NL)';
    spec.getCell(groupRow, nlCol).font = { bold: true };
    input.units.forEach((unit, i) => {
      const row = dataStart + i;
      spec.getCell(row, 1).value = unit.nodeId;
      spec.getCell(row, 2).value = i + 1;
      spec.getCell(row, 3).value = unit.topicTitle;
      spec.getCell(row, 4).value = unit.nodeTitle;
      spec.getCell(row, 5).value = unit.outcomes.map((o) => o.content).join('\n');
      for (let c = firstDataCol; c <= lastDataCol; c++) {
        spec.getCell(row, c).value = { formula: `'${MATRIX_IMPORT_SHEET_MATRIX}'!${letter(c)}${row}` };
      }
    });

    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /** Ký tự cột Excel từ chỉ số 1-based (6 → 'F', 27 → 'AA'). */
  private columnLetter(index: number): string {
    let out = '';
    let n = index;
    while (n > 0) {
      const rem = (n - 1) % 26;
      out = String.fromCharCode(65 + rem) + out;
      n = Math.floor((n - 1) / 26);
    }
    return out;
  }

  // --- Parse + xem trước -------------------------------------------------------

  /**
   * Parse một file .xlsx đã điền và trả kết quả XEM TRƯỚC — không ghi
   * DB. Luồng:
   * 1. Đọc workbook bằng exceljs; lỗi đọc/thiếu sheet `Ma trận`/thiếu
   *    hàng tiêu đề lưới → lỗi cứng cấp file, dừng sớm.
   * 2. Trích khối thông tin chung theo nhãn cố định; kiểm các trường
   *    bắt buộc và tính khớp giữa trường checkbox Vận dụng cao với
   *    lưới cột thực tế (khai "Có" mà không có cột VDC — hoặc ngược
   *    lại — là lỗi cứng yêu cầu sinh lại mẫu, không tự suy diễn).
   * 3. Gác cổng bank cá nhân của luồng nhập (ném 403 thẳng ra ngoài
   *    như mọi cổng quyền — người không đủ tư cách không đi tiếp
   *    được và không nhận được tín hiệu nào về dữ liệu môn), rồi đối
   *    chiếu môn/chương trình trong file với dữ liệu thật bằng đường
   *    đọc tham chiếu nội bộ: phải tồn tại và đi đúng cặp; "không
   *    tồn tại thật" dịch thành lỗi định vị trong payload như cũ,
   *    mọi lỗi khác truyền thẳng — không còn nuốt lỗi thành "môn
   *    không tồn tại" như khi đọc qua đường công khai bị gác quyền.
   * 4. Đối chiếu từng Mã ĐVK với `curriculum_nodes` của đúng chương
   *    trình đó (không tồn tại/không phải đơn vị kiến thức/trùng hàng
   *    → lỗi cứng tại dòng); kiểm từng ô số là số nguyên ≥ 0; dạng nào
   *    có câu mà thiếu điểm-mỗi-câu → lỗi cứng; tính lại tổng điểm
   *    hai chiều từ các ô và so với tổng đã khai (lệch quá dung sai là
   *    lỗi cứng kèm bảng tổng tính lại trong thông điệp).
   * 5. Cảnh báo tỉ lệ qua `matrixWarnings` với mốc CV 7991 (điều
   *    chỉnh chú thích 3: môn không dùng Trả lời ngắn thì mốc Đúng–Sai
   *    là 40%; khi bật VDC thì chỉ cảnh báo trên tổng Vận dụng +
   *    Vận dụng cao so mốc 30% — văn bản không cho mốc riêng cho VDC)
   *    + cảnh báo hàng ĐVK không có ô nào.
   * 6. Đính khả dụng ngân hàng cho từng ô dự thảo (cần/có/thiếu —
   *    cảnh báo thuần thông tin).
   *
   * @param actorId - Người gọi.
   * @param buffer - Nội dung file .xlsx tải lên.
   * @returns Cấu trúc `MatrixImportPreview` (contracts): `valid` chỉ
   *   true khi không còn lỗi cứng nào.
   */
  async previewImport(actorId: string, buffer: Buffer): Promise<MatrixImportPreview> {
    const preview: MatrixImportPreview = {
      valid: false, errors: [], warnings: [],
      name: null, subjectId: null, curriculumId: null, levelSet: null,
      totalScore: null, scopeNote: null, perFormScores: {},
      rows: [], cells: [],
      totals: { byForm: [], byLevel: [], totalScore: 0, totalQuestions: 0 },
      availability: [],
    };
    const err = (issue: Partial<MatrixImportIssue> & { code: string; message: string }) => {
      preview.errors.push({ sheet: MATRIX_IMPORT_SHEET_MATRIX, row: null, column: null, ...issue });
    };

    // Bước 1 — đọc workbook.
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer as never);
    } catch {
      err({ sheet: null, code: 'quiz.matrix_import_file_unreadable', message: 'File không đọc được — hãy tải lên một file .xlsx hợp lệ (đúng file mẫu hệ thống sinh ra).' });
      return preview;
    }
    const ws = wb.getWorksheet(MATRIX_IMPORT_SHEET_MATRIX);
    if (!ws) {
      err({ sheet: null, code: 'quiz.matrix_import_sheet_missing', message: `File thiếu sheet "${MATRIX_IMPORT_SHEET_MATRIX}" — hãy dùng đúng file mẫu hệ thống sinh ra.` });
      return preview;
    }

    // Bước 2 — trích khối thông tin chung + nhận diện lưới.
    const info = this.extractInfoBlock(ws);
    const grid = this.locateGrid(ws);
    if (!grid) {
      err({ code: 'quiz.matrix_import_grid_header_missing', message: `Không tìm thấy hàng tiêu đề lưới có cột "${GRID_KEY_LABEL}" trong sheet "${MATRIX_IMPORT_SHEET_MATRIX}".` });
      return preview;
    }
    preview.name = info.name;
    preview.scopeNote = info.scopeNote;
    preview.perFormScores = Object.fromEntries(FORM_DEFS.map((f) => [f.qtype, info.perFormScores[f.qtype] ?? null]));
    if (!info.name) {
      err({ row: info.rows.name ?? null, column: 'B', code: 'quiz.matrix_import_name_missing', message: 'Khối thông tin chung thiếu "Tên ma trận".' });
    }
    if (info.totalScore === null || !(info.totalScore > 0)) {
      err({ row: info.rows.totalScore ?? null, column: 'B', code: 'quiz.matrix_import_total_score_invalid', message: '"Tổng điểm toàn bài" phải là một số lớn hơn 0.' });
    } else {
      preview.totalScore = info.totalScore;
    }
    const uuidOk = (v: string | null) => v !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    if (!uuidOk(info.subjectId)) {
      err({ row: info.rows.subjectId ?? null, column: 'D', code: 'quiz.matrix_import_subject_invalid', message: '"Mã môn" trong file không hợp lệ — không sửa các ô mã khoá của khối thông tin chung.' });
    } else {
      preview.subjectId = info.subjectId;
    }
    if (!uuidOk(info.curriculumId)) {
      err({ row: info.rows.curriculumId ?? null, column: 'D', code: 'quiz.matrix_import_curriculum_invalid', message: '"Mã chương trình" trong file không hợp lệ — không sửa các ô mã khoá của khối thông tin chung.' });
    } else {
      preview.curriculumId = info.curriculumId;
    }
    const hasVdcColumn = grid.columns.some((c) => c.level === 'van_dung_cao');
    if (info.useVdc === null) {
      err({ row: info.rows.useVdc ?? null, column: 'B', code: 'quiz.matrix_import_vdc_invalid', message: 'Trường "Thêm mức Vận dụng cao" phải là "Có" hoặc "Không".' });
    } else if (info.useVdc !== hasVdcColumn) {
      err({ row: info.rows.useVdc ?? null, column: 'B', code: 'quiz.matrix_import_levelset_mismatch', message: 'Trường "Thêm mức Vận dụng cao" không khớp lưới cột trong file — hãy tải lại file mẫu đúng trạng thái checkbox rồi điền lại.' });
    }
    preview.levelSet = hasVdcColumn ? 'four' : 'three';
    if (preview.subjectId === null || preview.curriculumId === null || info.useVdc === null) {
      // Thiếu định danh thì không đối chiếu tiếp được — trả lỗi đã gom.
      preview.valid = preview.errors.length === 0;
      return preview;
    }

    // Bước 3 — cổng bank của luồng + đối chiếu môn/chương trình thật.
    // Cổng bank ném 403 thẳng ra ngoài (đúng vị trí và hình dạng của
    // cổng quyền trước đây ở bước này): chỉ người phụ trách được bank
    // ma trận cá nhân của mình mới đi tiếp. Sau cổng, lần đọc tham
    // chiếu chỉ còn ném NotFoundException khi dữ liệu thật sự vắng —
    // dịch đúng lỗi đó thành lỗi định vị trong payload; mọi lỗi khác
    // truyền thẳng, không nuốt thành "không tồn tại".
    await this.quiz.requirePersonalMatrixBankManage(actorId);
    const subject = await this.curriculum.getSubjectReference(preview.subjectId).catch((e: unknown) => {
      if (e instanceof NotFoundException) return null;
      throw e;
    });
    if (!subject) {
      err({ row: info.rows.subjectId ?? null, column: 'D', code: 'quiz.matrix_import_subject_not_found', message: 'Môn học trong file không tồn tại trong hệ thống.' });
      return preview;
    }
    const curriculum = await this.curriculum.getCurriculumReference(preview.curriculumId).catch((e: unknown) => {
      if (e instanceof NotFoundException) return null;
      throw e;
    });
    if (!curriculum) {
      err({ row: info.rows.curriculumId ?? null, column: 'D', code: 'quiz.matrix_import_curriculum_not_found', message: 'Chương trình trong file không tồn tại trong hệ thống.' });
      return preview;
    }
    if (curriculum.subjectId !== subject.id) {
      err({ row: info.rows.curriculumId ?? null, column: 'D', code: 'quiz.matrix_import_curriculum_mismatch', message: 'Chương trình trong file không thuộc môn học trong file — có thể đã nhập nhầm file của môn khác.' });
      return preview;
    }

    // Bước 4 — đối chiếu từng hàng ĐVK + đọc các ô số.
    const tree = await this.curriculum.getTreeReference(curriculum.id);
    const units = this.flattenUnits(tree);
    const unitById = new Map(units.map((u) => [u.nodeId, u]));
    const seenNodes = new Map<string, number>();
    const draftCells: MatrixImportPreviewCell[] = [];
    const presentNodeIds: string[] = [];
    const countByForm = new Map<MatrixFormQtype, number>();
    for (let r = grid.dataStartRow; r <= ws.rowCount; r++) {
      const keyText = this.cellText(ws.getCell(r, 1).value);
      const rowLabel = this.cellText(ws.getCell(r, 4).value);
      if (keyText === '' && (rowLabel === 'Tổng số câu' || rowLabel === 'Tổng số điểm' || rowLabel === 'Tỉ lệ % điểm')) break;
      const hasAnyNumber = grid.columns.some((c) => this.rawCell(ws.getCell(r, c.columnIndex).value) !== null);
      if (keyText === '' && !hasAnyNumber) continue;
      if (presentNodeIds.length >= MAX_DATA_ROWS) {
        err({ row: r, code: 'quiz.matrix_import_too_many_rows', message: `File vượt quá ${MAX_DATA_ROWS} hàng đơn vị kiến thức.` });
        break;
      }
      if (keyText === '') {
        err({ row: r, column: 'A', code: 'quiz.matrix_import_row_key_missing', message: `Dòng ${r} có số câu nhưng thiếu "Mã ĐVK" — không tự khớp hàng bằng tên, hãy giữ nguyên cột khoá của file mẫu.` });
        continue;
      }
      if (!uuidOk(keyText)) {
        err({ row: r, column: 'A', code: 'quiz.matrix_import_node_key_invalid', message: `Dòng ${r}: "Mã ĐVK" không hợp lệ — không sửa cột khoá của file mẫu.` });
        continue;
      }
      const unit = unitById.get(keyText);
      if (!unit) {
        err({ row: r, column: 'A', code: 'quiz.matrix_import_node_not_found', message: `Dòng ${r}: đơn vị kiến thức không tồn tại trong chương trình của file (hoặc không phải đơn vị kiến thức) — hệ thống không tự tạo đơn vị kiến thức từ file nhập.` });
        continue;
      }
      const firstRow = seenNodes.get(keyText);
      if (firstRow !== undefined) {
        err({ row: r, column: 'A', code: 'quiz.matrix_import_node_duplicate', message: `Dòng ${r}: đơn vị kiến thức "${unit.nodeTitle}" đã có ở dòng ${firstRow} — mỗi đơn vị kiến thức chỉ một hàng.` });
        continue;
      }
      seenNodes.set(keyText, r);
      presentNodeIds.push(keyText);
      preview.rows.push({
        nodeId: unit.nodeId, topicTitle: unit.topicTitle, nodeTitle: unit.nodeTitle,
        position: presentNodeIds.length, outcomes: unit.outcomes,
      });
      for (const col of grid.columns) {
        const raw = this.rawCell(ws.getCell(r, col.columnIndex).value);
        if (raw === null) continue;
        if (raw.kind !== 'number' || !Number.isInteger(raw.value) || raw.value < 0) {
          err({
            row: r, column: col.columnLetter, code: 'quiz.matrix_import_cell_value_invalid',
            message: `Ô ${col.columnLetter}${r} (${col.qtypeLabel} — ${col.levelLabel}) phải là số nguyên ≥ 0 (số câu/số chùm), nhận được "${raw.kind === 'text' ? raw.value : raw.value}".`,
          });
          continue;
        }
        if (raw.value === 0) continue;
        countByForm.set(col.qtype, (countByForm.get(col.qtype) ?? 0) + raw.value);
        draftCells.push({
          curriculumNodeId: keyText, cognitiveLevel: col.level, qtype: col.qtype,
          questionCount: raw.value, cellScore: 0, // điểm tính ở bước sau, khi đã biết điểm-mỗi-câu hợp lệ
        });
      }
    }

    // Bước 4b — điểm mỗi câu + điểm từng ô + tổng hai chiều.
    for (const form of FORM_DEFS) {
      const total = countByForm.get(form.qtype) ?? 0;
      const per = info.perFormScores[form.qtype];
      if (total > 0 && (per === null || per === undefined || !(per > 0))) {
        err({
          row: info.rows.perFormScore[form.qtype] ?? null, column: 'B',
          code: 'quiz.matrix_import_score_per_question_missing',
          message: `Dạng "${form.label}" có ${total} câu/chùm nhưng chưa khai "${form.scoreLabel}" (phải là số lớn hơn 0).`,
        });
      }
    }
    for (const cell of draftCells) {
      const per = info.perFormScores[cell.qtype as MatrixFormQtype];
      cell.cellScore = per ? Math.round(cell.questionCount * per * 10000) / 10000 : 0;
    }
    preview.cells = draftCells;
    preview.totals = this.computeTotals(draftCells);
    if (draftCells.length === 0 && preview.errors.length === 0) {
      err({ code: 'quiz.matrix_import_matrix_empty', message: 'Toàn bộ lưới không có ô nào có số câu — ma trận rỗng không nhập được.' });
    }
    if (preview.totalScore !== null && draftCells.length > 0
      && Math.abs(preview.totals.totalScore - preview.totalScore) > TOTAL_SCORE_TOLERANCE) {
      const byFormText = preview.totals.byForm.map((f) => `${f.qtype}: ${f.score}`).join(', ');
      err({
        code: 'quiz.matrix_import_total_score_mismatch',
        message: `Tổng điểm tính lại từ các ô là ${preview.totals.totalScore} (theo dạng — ${byFormText}) nhưng file khai "Tổng điểm toàn bài" là ${preview.totalScore}. Hãy sửa số câu hoặc điểm mỗi câu cho khớp.`,
      });
    }

    // Bước 5 — cảnh báo (chỉ khi đã có ô và không lệch tổng thành lỗi cứng).
    if (draftCells.length > 0) {
      preview.warnings = this.buildWarnings(draftCells, preview.totals, preview.levelSet, preview.totalScore);
      const nodesWithCells = new Set(draftCells.map((c) => c.curriculumNodeId));
      for (const row of preview.rows) {
        if (!nodesWithCells.has(row.nodeId)) {
          preview.warnings.push(`Đơn vị kiến thức "${row.nodeTitle}" không có ô nào — đã dạy nhưng không kiểm tra ở ma trận này.`);
        }
      }
    }

    // Bước 6 — khả dụng ngân hàng theo ô dự thảo.
    if (draftCells.length > 0) {
      preview.availability = await this.quiz.importAvailability(actorId, draftCells);
    }

    preview.valid = preview.errors.length === 0;
    return preview;
  }

  // --- Ghi nguyên tử (lát I-2) --------------------------------------------------

  /**
   * GHI ma trận từ file đã điền (lát I-2) — đầu chốt của luồng nhập:
   *
   * 1. Parse lại CHÍNH file tải lên bằng đúng đường của bước xem
   *    trước ({@link previewImport}): toàn bộ luật hợp lệ chạy lại ở
   *    phía server tại thời điểm ghi — lỗi cứng hai tầng, tính lại
   *    điểm ô/tổng, khả dụng ngân hàng, và cổng bank cá nhân của
   *    luồng (ném 403 khi người gọi không phụ trách được bank ma
   *    trận cá nhân của mình). KHÔNG tin dữ liệu phía client gửi kèm
   *    (kể cả khi client nói "đã xem trước"): file là nguồn sự thật
   *    duy nhất.
   * 2. Kết quả parse không còn hợp lệ (file bị sửa tay sau xem trước
   *    mà vi phạm luật) → TỪ CHỐI ghi toàn bộ: ném
   *    `UnprocessableEntityException` 422 mang mã
   *    `quiz.matrix_import_invalid` + danh sách lỗi cứng định vị
   *    trong extension member `matrixImportIssues` của ProblemDetails
   *    (đúng hình dạng lỗi của bước xem trước để web hiển thị lại
   *    bảng lỗi). Chưa một bản ghi nào được tạo ở bước này.
   * 3. Hợp lệ → uỷ quyền ghi cho `QuizService.createMatrixFromImport`:
   *    ma trận mới + toàn bộ ô trong MỘT transaction vào bank ma trận
   *    cá nhân của người nhập (draft; chống ghi trùng theo chữ ký nội
   *    dung — xem TSDoc của hàm đó). `position` của mỗi ô = số thứ tự
   *    hàng của ĐVK trong file (hồ sơ import: position của ô là STT
   *    của hàng); phạm vi của ma trận = đúng tập ĐVK có hàng trong
   *    file theo thứ tự file.
   *
   * @param actorId - Người gọi (người nhập).
   * @param buffer - Nội dung file .xlsx tải lên (cùng file đã xem
   *   trước, hoặc bản đã sửa sau xem trước — server kiểm lại từ đầu).
   * @returns View ma trận đã ghi (hoặc bản đã có khi trùng nội dung).
   * @throws UnprocessableEntityException 422 khi file không hợp lệ
   *   tại thời điểm ghi (kèm `matrixImportIssues` định vị).
   * @throws ForbiddenException khi người gọi không qua được cổng bank
   *   cá nhân của luồng nhập (ném từ bước parse lại).
   */
  async commitImport(actorId: string, buffer: Buffer): Promise<ExamMatrixView> {
    const preview = await this.previewImport(actorId, buffer);
    if (!preview.valid) {
      throw new UnprocessableEntityException({
        message: 'File không còn hợp lệ tại thời điểm ghi — hãy sửa file theo các lỗi định vị đính kèm rồi nhập lại.',
        code: 'quiz.matrix_import_invalid',
        matrixImportIssues: preview.errors,
      });
    }
    // valid = true chỉ khi mọi trường định danh đã có (tên/môn/chương
    // trình/bộ mức/tổng điểm đều là lỗi cứng khi thiếu) và lưới có ít
    // nhất một ô — các khẳng định not-null dưới đây dựa vào bất biến đó.
    const positionByNode = new Map(preview.rows.map((r) => [r.nodeId, r.position]));
    return this.quiz.createMatrixFromImport(actorId, {
      name: preview.name!,
      subjectId: preview.subjectId!,
      curriculumId: preview.curriculumId!,
      levelSet: preview.levelSet!,
      totalScore: preview.totalScore!,
      scopeNote: preview.scopeNote,
      scopeNodeIds: preview.rows.map((r) => r.nodeId),
      cells: preview.cells.map((c) => ({
        curriculumNodeId: c.curriculumNodeId,
        cognitiveLevel: c.cognitiveLevel,
        qtype: c.qtype,
        questionCount: c.questionCount,
        cellScore: c.cellScore,
        position: positionByNode.get(c.curriculumNodeId) ?? 1,
      })),
    });
  }

  /**
   * Cảnh báo tỉ lệ cho bản xem trước: tái dùng `matrixWarnings` với
   * mốc tham chiếu CV 7991 (hằng cấu hình, không phải lựa chọn của
   * giáo viên), kèm hai điều chỉnh của hồ sơ import — chú thích 3
   * (không dùng Trả lời ngắn → mốc Đúng–Sai 40%) và luật VDC (không có
   * mốc riêng cho Vận dụng cao; cảnh báo trên tổng Vận dụng + Vận
   * dụng cao so mốc 30%). Cảnh báo tổng điểm của `matrixWarnings` bị
   * loại vì lệch tổng ở đường nhập là lỗi cứng riêng (bước 4b).
   */
  private buildWarnings(
    cells: MatrixImportPreviewCell[],
    totals: MatrixImportPreview['totals'],
    levelSet: 'three' | 'four' | null,
    declaredTotal: number | null,
  ): string[] {
    const preset = MATRIX_PRESETS.cv7991_periodic;
    const formTargets = { ...preset.targetFormPercents };
    const shortScore = totals.byForm.find((f) => f.qtype === 'shortanswer')?.score ?? 0;
    if (shortScore === 0) {
      formTargets.truefalse = 40;
      formTargets.shortanswer = 0;
    }
    const warnings = matrixWarnings({
      cells,
      targetFormPercents: formTargets,
      targetLevelPercents: levelSet === 'four' ? null : preset.targetLevelPercents,
      totalScore: declaredTotal ?? totals.totalScore,
    }).filter((w) => !w.startsWith('Tổng điểm các ô') && !w.startsWith('Ma trận chưa có ô nào'));
    if (levelSet === 'four' && totals.totalScore > 0) {
      const advScore = totals.byLevel
        .filter((l) => l.cognitiveLevel === 'van_dung' || l.cognitiveLevel === 'van_dung_cao')
        .reduce((s, l) => s + l.score, 0);
      const advPct = (advScore / totals.totalScore) * 100;
      if (Math.abs(advPct - 30) > 0.5) {
        warnings.push(`Tỉ lệ điểm theo mức "Vận dụng + Vận dụng cao": thực tế ${Math.round(advPct * 10) / 10}% so với mục tiêu 30% (CV 7991 không có mốc riêng cho Vận dụng cao).`);
      }
    }
    return warnings;
  }

  /** Tổng hai chiều của bản xem trước. Quy ước đếm: `totalQuestions` đếm số câu thật (Đúng–Sai nhân 4 ý như bản đặc tả); riêng các bảng theo dạng/mức giữ đơn vị như trong file (Đúng–Sai = số chùm) để giáo viên đối chiếu trực tiếp với file đã điền. */
  private computeTotals(cells: MatrixImportPreviewCell[]): MatrixImportPreview['totals'] {
    const totalScore = Math.round(cells.reduce((s, c) => s + c.cellScore, 0) * 10000) / 10000;
    const byFormMap = new Map<MatrixFormQtype, { questionCount: number; score: number }>();
    const byLevelMap = new Map<MatrixLevel, { questionCount: number; score: number }>();
    let totalQuestions = 0;
    for (const cell of cells) {
      const f = byFormMap.get(cell.qtype as MatrixFormQtype) ?? { questionCount: 0, score: 0 };
      f.questionCount += cell.questionCount;
      f.score += cell.cellScore;
      byFormMap.set(cell.qtype as MatrixFormQtype, f);
      const l = byLevelMap.get(cell.cognitiveLevel as MatrixLevel) ?? { questionCount: 0, score: 0 };
      l.questionCount += cell.questionCount;
      l.score += cell.cellScore;
      byLevelMap.set(cell.cognitiveLevel as MatrixLevel, l);
      totalQuestions += cell.qtype === 'truefalse' ? cell.questionCount * 4 : cell.questionCount;
    }
    const pct = (score: number) => (totalScore > 0 ? Math.round((score / totalScore) * 1000) / 10 : 0);
    return {
      byForm: FORM_DEFS.filter((f) => byFormMap.has(f.qtype)).map((f) => ({
        qtype: f.qtype, questionCount: byFormMap.get(f.qtype)!.questionCount,
        score: Math.round(byFormMap.get(f.qtype)!.score * 10000) / 10000, percent: pct(byFormMap.get(f.qtype)!.score),
      })),
      byLevel: LEVEL_DEFS.filter((l) => byLevelMap.has(l.level)).map((l) => ({
        cognitiveLevel: l.level, questionCount: byLevelMap.get(l.level)!.questionCount,
        score: Math.round(byLevelMap.get(l.level)!.score * 10000) / 10000, percent: pct(byLevelMap.get(l.level)!.score),
      })),
      totalScore,
      totalQuestions,
    };
  }

  /**
   * Nhận diện lưới trong sheet `Ma trận`: quét các dòng đầu tìm hàng
   * có cột A = "Mã ĐVK" (hàng nhóm), hàng ngay dưới là hàng mức; ánh
   * xạ từng cột số sang (dạng, mức) bằng nhãn nhóm lan theo merge +
   * nhãn mức đã chuẩn hoá bỏ dấu. Trả null khi không thấy hàng tiêu đề.
   */
  private locateGrid(ws: ImportWorksheetLike): {
    dataStartRow: number;
    columns: (GridColumn & { qtypeLabel: string; levelLabel: string })[];
  } | null {
    const maxRow = Math.min(ws.rowCount, 40);
    for (let r = 1; r <= maxRow; r++) {
      if (this.cellText(ws.getCell(r, 1).value) !== GRID_KEY_LABEL) continue;
      const columns: (GridColumn & { qtypeLabel: string; levelLabel: string })[] = [];
      let currentForm: (typeof FORM_DEFS)[number] | null = null;
      for (let c = 6; c <= ws.columnCount; c++) {
        const groupText = this.cellText(ws.getCell(r, c).value);
        if (groupText) {
          currentForm = FORM_DEFS.find((f) => this.normalize(f.label) === this.normalize(groupText))
            ?? FORM_DEFS.find((f) => this.normalize(groupText).includes(this.normalize(f.label.split(' (')[0]!)))
            ?? null;
        }
        const levelText = this.cellText(ws.getCell(r + 1, c).value);
        const level = LEVEL_DEFS.find((l) => this.normalize(l.label) === this.normalize(levelText));
        if (currentForm && level) {
          columns.push({
            columnIndex: c, columnLetter: this.columnLetter(c),
            qtype: currentForm.qtype, level: level.level,
            qtypeLabel: currentForm.label, levelLabel: level.label,
          });
        }
      }
      if (columns.length === 0) return null;
      return { dataStartRow: r + 2, columns };
    }
    return null;
  }

  /**
   * Trích khối thông tin chung: quét cột A của 20 dòng đầu theo nhãn
   * cố định; giá trị lấy ở cột B (riêng mã môn/chương trình ở cột D).
   * Điểm mỗi câu đọc theo nhãn riêng của từng dạng.
   */
  private extractInfoBlock(ws: ImportWorksheetLike): {
    name: string | null; scopeNote: string | null;
    subjectId: string | null; curriculumId: string | null;
    totalScore: number | null; useVdc: boolean | null;
    perFormScores: Partial<Record<MatrixFormQtype, number | null>>;
    rows: { name?: number; subjectId?: number; curriculumId?: number; totalScore?: number; useVdc?: number; perFormScore: Partial<Record<MatrixFormQtype, number>> };
  } {
    const out: ReturnType<MatrixImportService['extractInfoBlock']> = {
      name: null, scopeNote: null, subjectId: null, curriculumId: null,
      totalScore: null, useVdc: null, perFormScores: {}, rows: { perFormScore: {} },
    };
    const maxRow = Math.min(ws.rowCount, 20);
    for (let r = 1; r <= maxRow; r++) {
      const label = this.cellText(ws.getCell(r, 1).value);
      if (!label) continue;
      const valueB = this.cellText(ws.getCell(r, 2).value);
      const valueD = this.cellText(ws.getCell(r, 4).value);
      if (label === INFO.name) { out.name = valueB || null; out.rows.name = r; }
      else if (label === INFO.totalScore) {
        const raw = this.rawCell(ws.getCell(r, 2).value);
        out.totalScore = raw?.kind === 'number' ? raw.value : null;
        out.rows.totalScore = r;
      } else if (label === INFO.useVdc) {
        const norm = this.normalize(valueB);
        out.useVdc = norm === 'co' ? true : norm === 'khong' ? false : null;
        out.rows.useVdc = r;
      } else if (label === INFO.scopeNote) {
        out.scopeNote = valueB || null;
      } else {
        const form = FORM_DEFS.find((f) => f.scoreLabel === label);
        if (form) {
          const raw = this.rawCell(ws.getCell(r, 2).value);
          out.perFormScores[form.qtype] = raw?.kind === 'number' ? raw.value : null;
          out.rows.perFormScore[form.qtype] = r;
        }
      }
      // Mã khoá KHÔNG nằm ở cột A như các trường còn lại: buildTemplate
      // ghi nhãn mã ở cột C và giá trị ở cột D (cùng dòng với tên môn /
      // tên chương trình ở cột A/B) — phải quét thêm nhãn cột C, nếu chỉ
      // quét cột A thì không bao giờ thấy "Mã môn"/"Mã chương trình".
      const keyLabel = this.cellText(ws.getCell(r, 3).value);
      if (keyLabel === INFO.subjectId) { out.subjectId = valueD || null; out.rows.subjectId = r; }
      else if (keyLabel === INFO.curriculumId) { out.curriculumId = valueD || null; out.rows.curriculumId = r; }
    }
    return out;
  }

  /** Trích giá trị thô của một ô: số trực tiếp, kết quả của công thức, hoặc chuỗi đã cắt khoảng trắng; ô trống/ngày tháng → null. */
  private rawCell(value: unknown): RawCellValue {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? { kind: 'number', value } : null;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed === '') return null;
      const asNumber = Number(trimmed.replace(',', '.'));
      return Number.isFinite(asNumber) && /^-?\d+([.,]\d+)?$/.test(trimmed)
        ? { kind: 'number', value: asNumber }
        : { kind: 'text', value: trimmed };
    }
    if (typeof value === 'object') {
      const v = value as { result?: unknown; text?: unknown };
      if (v.result !== undefined) return this.rawCell(v.result);
      if (typeof v.text === 'string') return this.rawCell(v.text);
      return null;
    }
    return null;
  }

  /** Chuỗi hiển thị của một ô (cho nhãn/khoá): số → chuỗi số, công thức → kết quả, rich text → text. */
  private cellText(value: unknown): string {
    const raw = this.rawCell(value);
    if (raw === null) return '';
    return raw.kind === 'number' ? String(raw.value) : raw.value.trim();
  }

  /** Chuẩn hoá để so nhãn: bỏ dấu tiếng Việt, thường hoá, gộp khoảng trắng (nhãn trong file có thể bị gõ lại với dấu/không dấu khác nhau). */
  private normalize(text: string): string {
    return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();
  }
}

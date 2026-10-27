import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import type { PaperSlotLayout, RichTextDocument } from '@lms/contracts';
import { getTrueFalseStatements, TRUE_FALSE_STATEMENT_COUNT } from '@lms/contracts';
import { OutboxService } from '../../infra/events/outbox.service';
import { CurriculumService } from '../curriculum/curriculum.service';
import { QuestionsService, type QuestionView } from '../questions/questions.service';
import { QuizRepository, type ExamMatrixCellRow, type ExamMatrixRow } from './quiz.repository';
import { QuizSharedService } from './quiz-shared.service';
import { QuizAttemptsService } from './quiz-attempts.service';
import { QUIZ_COMPONENT } from './quiz-shared.service';
import { QUIZ_CAPABILITIES } from './quiz-shared.service';
import type { MatrixSpecification, SpecificationSlot, PinRow } from './quiz.service';

/** Nhãn hiển thị của các dạng câu trong tài liệu đặc tả. */
export const QTYPE_LABELS: Record<string, string> = {
  multichoice: 'Trắc nghiệm',
  truefalse: 'Đúng–Sai',
  shortanswer: 'Trả lời ngắn',
  essay: 'Tự luận',
};

/** Nhãn hiển thị của các mức nhận thức trong tài liệu đặc tả. */
export const LEVEL_LABELS: Record<string, string> = {
  biet: 'Biết',
  hieu: 'Hiểu',
  van_dung: 'Vận dụng',
  van_dung_cao: 'Vận dụng cao',
};

/** Bung view model đặc tả thành các dòng phẳng cho bảng xuất file (một dòng = một ô ma trận; cột YCCĐ = mọi YCCĐ thuộc ĐVK của ô). */
export function flattenSpecification(spec: MatrixSpecification): {
  index: number; topicTitle: string; nodeTitle: string; outcomeText: string;
  levelLabel: string; qtypeLabel: string; questionCount: number; cellScore: number; slotText: string;
}[] {
  const rows: {
    index: number; topicTitle: string; nodeTitle: string; outcomeText: string;
    levelLabel: string; qtypeLabel: string; questionCount: number; cellScore: number; slotText: string;
  }[] = [];
  let index = 0;
  for (const topic of spec.topics) {
    for (const node of topic.nodes) {
      // Dòng văn của outcome program được tiền tố bằng mã YCCĐ vị
      // trí (P2, sổ mục B) khi có mã; derived trình bày nguyên văn
      // gốc (tiền tố mã của gốc) kèm bản tách mức như trước.
      const outcomeText = node.outcomes.map((outcome) => {
        const prefix = outcome.code ? `${outcome.code} ` : '';
        return outcome.derivedContent
          ? `${prefix}${outcome.programContent ?? ''}\n(Tách mức: ${outcome.derivedContent})`
          : `${prefix}${outcome.programContent ?? outcome.content}`;
      }).join('\n');
      for (const cell of node.cells) {
        index += 1;
        const slotText = cell.slotNumbers && cell.slotNumbers.length
          ? (cell.drawNote ? `${cell.drawNote} (vị trí ${cell.slotNumbers.join(', ')})` : cell.slotNumbers.join(', '))
          : (cell.drawNote ?? '');
        rows.push({
          index,
          topicTitle: topic.topicTitle,
          nodeTitle: node.nodeTitle,
          outcomeText,
          levelLabel: LEVEL_LABELS[cell.cognitiveLevel] ?? cell.cognitiveLevel,
          qtypeLabel: QTYPE_LABELS[cell.qtype] ?? cell.qtype,
          questionCount: cell.questionCount,
          cellScore: cell.cellScore,
          slotText,
        });
      }
    }
  }
  return rows;
}

/**
 * Cụm sinh đề và đặc tả của QuizService (cụm 3 của issue #295): ma
 * trận dùng cho sinh đề, rút slot cố định, đặc tả ma trận (dựng, xuất
 * file, render), và cặp lượt làm trên giấy `resolvePaperLayout` /
 * `recordPaperAttempt` (thuộc cụm này theo bản đồ đặc tả, dù nằm xen
 * trong vùng lượt làm của file gốc). `recordPaperAttempt` gọi chốt
 * lượt qua `finalizeAttempt` của cụm lượt làm; còn lại cụm chỉ gọi
 * xuống tầng thấp dùng chung.
 *
 * Ba khối top-level phục vụ đặc tả (`QTYPE_LABELS`, `LEVEL_LABELS`,
 * `flattenSpecification`) chuyển về đây cùng nơi dùng thật, facade
 * re-export lại để bề mặt import cũ không đổi.
 */

export class QuizGenerationService {
  constructor(
    private readonly repo: QuizRepository,
    private readonly questions: QuestionsService,
    private readonly curriculum: CurriculumService,
    private readonly outbox: OutboxService,
    private readonly shared: QuizSharedService,
    private readonly attempts: QuizAttemptsService,
  ) {}

  /** Trộn ngẫu nhiên một bản sao của mảng (Fisher–Yates) cho các phép rút câu. */
  private shuffled<T>(items: T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  /** Chi tiết thiếu câu theo từng ô cho lỗi cứng của generate (mục C.3 bước 1). */
  private async matrixDeficits(actorId: string, cells: ExamMatrixCellRow[]): Promise<{
    deficits: { cellId: string; curriculumNodeId: string; cognitiveLevel: string; qtype: string; required: number; available: number; deficit: number }[];
    pools: Map<string, { candidates: QuestionView[] }>;
  }> {
    const deficits: { cellId: string; curriculumNodeId: string; cognitiveLevel: string; qtype: string; required: number; available: number; deficit: number }[] = [];
    const pools = new Map<string, { candidates: QuestionView[] }>();
    for (const cell of cells) {
      const candidates = await this.shared.cellCandidatesForUser(actorId, cell);
      pools.set(cell.id, { candidates });
      const available = candidates.length;
      if (available < cell.questionCount) {
        deficits.push({
          cellId: cell.id, curriculumNodeId: cell.curriculumNodeId,
          cognitiveLevel: cell.cognitiveLevel, qtype: cell.qtype,
          required: cell.questionCount, available, deficit: cell.questionCount - available,
        });
      }
    }
    return { deficits, pools };
  }

  // --- Facade cho EB-2 (generate hai bước matrix → paper → deploy) -------------

  /**
   * Đọc ma trận cho generate (cổng matrix:edit tại context của
   * bank — E-8 qua requireMatrixCap) + các ô. EB-2: ExamsService
   * là phía điều phối generate; QuizService chỉ còn là nguồn dữ liệu
   * ma trận/pool và phía ghi slots vào quiz.
   */
  async matrixForGeneration(actorId: string, matrixId: string): Promise<{ matrix: ExamMatrixRow; cells: ExamMatrixCellRow[] }> {
    const matrix = await this.shared.getMatrixRow(matrixId);
    await this.shared.requireMatrixCap(actorId, matrix, QUIZ_CAPABILITIES.manageMatrix);
    const cells = await this.repo.listMatrixCells(matrix.id);
    if (!cells.length) {
      throw new BadRequestException({ message: 'This matrix has no cells yet', code: 'quiz.matrix_empty' });
    }
    return { matrix, cells };
  }

  /**
   * Rút MỘT bộ câu cố định cho các ô (cơ chế fixed của Chặng 3, tách
   * ra dùng chung cho generate snapshot + materialize recipe ở
   * EB-2): thiếu câu ở BẤT KỲ ô nào → 422
   * `quiz.matrix_insufficient_questions` kèm chi tiết từng ô, không
   * rút một phần. Không lặp câu trong toàn bộ; mọi ô — kể cả ô
   * truefalse — rút theo CÂU (một câu TF-A là một slot nguyên vẹn
   * mang trọn điểm của một đơn vị ô, không chia phần cho từng ý).
   * page = thứ tự của ô trong ma trận.
   */
  async drawFixedSlots(actorId: string, cells: ExamMatrixCellRow[]): Promise<{
    questionId: string; matrixCellId: string; maxMark: number; page: number;
  }[]> {
    const { deficits, pools } = await this.matrixDeficits(actorId, cells);
    if (deficits.length) {
      throw new UnprocessableEntityException({
        message: deficits.map((d) => `cell ${d.cellId} (node ${d.curriculumNodeId}, ${d.cognitiveLevel}/${d.qtype}): required ${d.required}, available ${d.available}, deficit ${d.deficit}`),
        code: 'quiz.matrix_insufficient_questions',
      });
    }
    const chosen = new Set<string>();
    const out: { questionId: string; matrixCellId: string; maxMark: number; page: number }[] = [];
    let page = 0;
    for (const cell of cells) {
      page += 1;
      const pool = pools.get(cell.id)!;
      const perUnit = cell.cellScore / cell.questionCount;
      const fresh = this.shuffled(pool.candidates.filter((v) => !chosen.has(v.question.id)));
      let picked = fresh.slice(0, cell.questionCount);
      if (picked.length < cell.questionCount) {
        const rest = this.shuffled(pool.candidates.filter((v) => !picked.some((p) => p.question.id === v.question.id)));
        picked = [...picked, ...rest.slice(0, cell.questionCount - picked.length)];
      }
      for (const member of picked) {
        out.push({ questionId: member.question.id, matrixCellId: cell.id, maxMark: perUnit, page });
        chosen.add(member.question.id);
      }
    }
    return out;
  }

  /** Câu có thuộc pool của ô hay không (pool thô theo ĐVK + mức + dạng + ready — điểm neo swap-cùng-ô của EB-2 như swapSlot đã dùng). */
  async cellPoolContains(cellId: string, questionId: string): Promise<boolean> {
    const cell = await this.repo.getMatrixCell(cellId);
    if (!cell) return false;
    const candidates = await this.shared.cellCandidates(cell);
    return candidates.some((v) => v.question.id === questionId);
  }

  /** Đề đã có lượt làm thật thì cấu trúc slots đóng băng (đúng ngữ nghĩa Chặng 1: attempt đã pin câu). */
  private async assertNoRealAttempts(quiz: PinRow): Promise<void> {
    const attempts = await this.repo.listAttempts(quiz.id);
    if (attempts.some((a) => !a.preview)) {
      throw new BadRequestException({ message: 'This quiz already has real attempts; its slots are frozen', code: 'quiz.slots_frozen' });
    }
  }

  /**
   * Dựng view model bản đặc tả theo Mẫu 2 của phụ lục CV 7991: hàng
   * Chủ đề → Nội dung/đơn vị kiến thức → YCCĐ (cột YCCĐ = mọi YCCĐ
   * thuộc ĐVK của ô: nguyên văn chương trình `source_kind='program'`
   * + bản tách mức của tổ chuyên môn `derived`), cột số câu/điểm
   * theo dạng × mức từ các ô;
   * khi đã sinh đề (pinId của đề sinh từ chính ma trận này) thì thêm
   * vị trí slot thật — đề per_student ghi rõ rút ngẫu nhiên theo ô.
   * Chân bảng: tổng theo dạng (điểm + %). Trường nhãn năng lực để dành
   * trong view model (competencyRefs) — chặng này chưa có cơ chế gắn
   * mã năng lực vào outcome nên luôn rỗng.
   */
  async getMatrixSpecification(actorId: string, matrixId: string, pinId?: string): Promise<MatrixSpecification> {
    const matrix = await this.shared.getMatrixRow(matrixId);
    await this.shared.requireMatrixCap(actorId, matrix, QUIZ_CAPABILITIES.viewMatrix);
    let quiz: PinRow | null = null;
    let slots: SpecificationSlot[] | null = null;
    if (pinId) {
      quiz = await this.shared.getPin(pinId);
      if (quiz.matrixId !== matrix.id) {
        throw new BadRequestException({ message: 'The quiz was not generated from this matrix', code: 'quiz.spec_quiz_mismatch' });
      }
      slots = (await this.shared.effectiveSlots(quiz)).map((s) => ({
        matrixCellId: s.matrixCellId, slot: s.slot, questionId: s.questionId,
      }));
    }
    return this.buildSpecification(actorId, matrix, {
      quiz: quiz ? { id: quiz.id, name: quiz.name } : null, slots,
    });
  }

  /**
   * Bản đặc tả neo theo ĐỀ (EB-3, điểm E-6 của hồ sơ ngân hàng đề):
   * cùng một builder với đặc tả theo ma trận, nhưng vị trí câu lấy từ
   * SLOTS CỦA PAPER VERSION đã ghim (đề là neo chính; quiz chỉ là một
   * lần triển khai của đề). Hàm này KHÔNG tự gác capability của ma
   * trận — cổng quyền nằm ở phía gọi (ExamPapersService gác theo đề,
   * gồm lớp bảo mật đề định kỳ A.3.4).
   */
  async buildSpecificationForPaper(actorId: string, matrixId: string, paperSlots: { matrixCellId: string | null; position: number; questionId: string | null }[]): Promise<MatrixSpecification> {
    const matrix = await this.shared.getMatrixRow(matrixId);
    return this.buildSpecification(actorId, matrix, {
      quiz: null,
      slots: paperSlots.map((s) => ({ matrixCellId: s.matrixCellId, slot: s.position, questionId: s.questionId })),
    });
  }

  /**
   * Builder dùng chung của bản đặc tả: lưới ô của ma trận + (tuỳ
   * chọn) vị trí câu của một tập slot cụ thể — slot của quiz (đặc tả
   * theo ma trận, C.6) hoặc slot của paper version (đặc tả theo đề,
   * E-6). `slots = null` nghĩa là bản đặc tả dự kiến chưa có vị trí.
   * Các lần đọc môn/chương trình/node/YCCĐ trong builder đi qua
   * đường tham chiếu nội bộ của CurriculumService (không tự đòi
   * `curriculum:view` tại context của môn), vì cổng quyền của bản
   * đặc tả đã neo ở nơi khác trước khi vào builder: wrapper theo
   * ma trận chốt quyền xem ma trận tại bank đích, còn bản đặc tả
   * theo đề thì phía gọi của đề đã gác cổng của đề. Đọc qua đường
   * công khai ở đây từng chặn nhầm giáo viên chủ bank cá nhân
   * (đã qua cổng xem ma trận) khi môn neo tại context hệ thống.
   * Tham số `actorId` giữ lại cho chữ ký chung của builder; các
   * đường tham chiếu nội bộ không dùng tới nó.
   */
  private async buildSpecification(actorId: string, matrix: ExamMatrixRow, opts: {
    quiz: { id: string; name: string } | null;
    slots: SpecificationSlot[] | null;
  }): Promise<MatrixSpecification> {
    const subject = await this.curriculum.getSubjectReference(matrix.subjectId);
    const curriculum = await this.curriculum.getCurriculumReference(matrix.curriculumId);
    const cells = await this.repo.listMatrixCells(matrix.id);
    const slots = opts.slots;
    const nodeCache = new Map<string, Awaited<ReturnType<CurriculumService['getNodeReference']>>>();
    const getNode = async (id: string) => {
      let node = nodeCache.get(id);
      if (!node) {
        node = await this.curriculum.getNodeReference(id);
        nodeCache.set(id, node);
      }
      return node;
    };
    type OutcomeAcc = MatrixSpecification['topics'][number]['nodes'][number]['outcomes'][number];
    // Mã bản ghi theo node (tra sổ đăng ký) — đệm theo node để mỗi
    // node chỉ tra một lần trong một lượt dựng đặc tả.
    const recordIdByNode = new Map<string, string | null>();
    const recordIdForNode = async (nodeId: string): Promise<string | null> => {
      let recordId = recordIdByNode.get(nodeId);
      if (recordId === undefined) {
        recordId = await this.curriculum.programRecordIdForNode(nodeId);
        recordIdByNode.set(nodeId, recordId);
      }
      return recordId;
    };
    /** Mã YCCĐ vị trí từ mã bản ghi + position; null khi node không thuộc dataset. */
    const outcomeCode = (recordId: string | null, position: number): string | null =>
      (recordId ? `${recordId}.${String(position).padStart(2, '0')}` : null);
    type NodeCells = MatrixSpecification['topics'][number]['nodes'][number]['cells'];
    const topicMap = new Map<string, { topicId: string | null; topicTitle: string; nodes: Map<string, { nodeId: string; nodeTitle: string; outcomes: Map<string, OutcomeAcc>; cells: NodeCells }> }>();
    const byForm = new Map<string, { qtype: string; questionCount: number; score: number }>();
    let totalQuestions = 0;
    for (const cell of cells) {
      // Ô neo ĐVK (issue #249): cột YCCĐ của bản đặc tả = MỌI YCCĐ
      // thuộc ĐVK của ô (program + derived tách mức như trước).
      const node = await getNode(cell.curriculumNodeId);
      // Chủ đề = node tổ tiên có kind 'topic'; không có thì lấy node gốc cao nhất của chuỗi.
      let topic = node;
      let cursor = node;
      while (cursor.parentId) {
        const parent = await getNode(cursor.parentId);
        if (parent.kind === 'topic' && topic.kind !== 'topic') topic = parent;
        cursor = parent;
      }
      if (topic.kind !== 'topic') topic = cursor;
      const topicKey = topic.id;
      let topicAcc = topicMap.get(topicKey);
      if (!topicAcc) {
        topicAcc = { topicId: topic.id, topicTitle: topic.title, nodes: new Map() };
        topicMap.set(topicKey, topicAcc);
      }
      let nodeAcc = topicAcc.nodes.get(node.id);
      if (!nodeAcc) {
        nodeAcc = { nodeId: node.id, nodeTitle: node.title, outcomes: new Map(), cells: [] };
        topicAcc.nodes.set(node.id, nodeAcc);
        // listOutcomes mặc định đã loại dòng program ĐÃ RÚT. Derived
        // mang trạng thái hiện hành của GỐC: gốc đã rút (hoặc không
        // còn tra được) thì derived cũng rời bản đặc tả — cùng một
        // định nghĩa "hiện hành" với pool sinh đề (issue #161).
        const outcomes = await this.curriculum.listOutcomesReference(node.id);
        for (const outcome of outcomes) {
          let programContent: string | null = null;
          let derivedContent: string | null = null;
          let position: number | null = outcome.position;
          let code: string | null = null;
          if (outcome.sourceKind === 'derived' && outcome.derivedFromId) {
            const parent = await this.curriculum.getOutcomeReference(outcome.derivedFromId).catch(() => undefined);
            if (!parent || parent.retiredAt !== null) continue;
            programContent = parent.content;
            derivedContent = outcome.content;
            // Derived là ý tách của gốc: position/mã là của dòng gốc.
            position = parent.position;
            code = outcomeCode(await recordIdForNode(parent.nodeId), parent.position);
          } else {
            programContent = outcome.content;
            code = outcomeCode(await recordIdForNode(node.id), outcome.position);
          }
          nodeAcc.outcomes.set(outcome.id, {
            outcomeId: outcome.id, content: outcome.content, sourceKind: outcome.sourceKind,
            sourceRef: outcome.sourceRef, programContent, derivedContent, position, code,
          });
        }
      }
      const cellSlots = slots ? slots.filter((s) => s.matrixCellId === cell.id) : [];
      const perStudent = cellSlots.length > 0 && cellSlots.every((s) => s.questionId === null);
      nodeAcc.cells.push({
        cellId: cell.id, cognitiveLevel: cell.cognitiveLevel, qtype: cell.qtype,
        questionCount: cell.questionCount, cellScore: cell.cellScore, minutes: cell.minutes,
        slotNumbers: slots ? cellSlots.map((s) => s.slot).sort((a, b) => a - b) : null,
        drawNote: slots && perStudent ? 'Rút ngẫu nhiên theo ô' : null,
        competencyRefs: [],
      });
      const formAcc = byForm.get(cell.qtype) ?? { qtype: cell.qtype, questionCount: 0, score: 0 };
      formAcc.questionCount += cell.questionCount;
      formAcc.score += cell.cellScore;
      byForm.set(cell.qtype, formAcc);
      totalQuestions += cell.questionCount;
    }
    const totalScore = cells.reduce((s, c) => s + c.cellScore, 0);
    const formTotals = [...byForm.values()].map((f) => ({
      ...f, percent: totalScore > 0 ? Math.round((f.score / totalScore) * 1000) / 10 : 0,
    }));
    const purpose = `Đề kiểm tra định kỳ môn ${subject.name} (lớp ${curriculum.grade}) xây dựng theo hướng dẫn của Công văn 7991/BGDĐT-GDTrH, bám sát yêu cầu cần đạt của Chương trình GDPT 2018.`;
    return {
      matrix: { id: matrix.id, name: matrix.name, presetKind: matrix.presetKind, totalScore: matrix.totalScore, levelSet: matrix.levelSet },
      subject: { id: subject.id, name: subject.name },
      curriculum: { id: curriculum.id, grade: curriculum.grade },
      purpose,
      structure: formTotals,
      topics: [...topicMap.values()].map((t) => ({
        topicId: t.topicId, topicTitle: t.topicTitle,
        nodes: [...t.nodes.values()].map((n) => ({
          nodeId: n.nodeId, nodeTitle: n.nodeTitle,
          outcomes: [...n.outcomes.values()],
          cells: n.cells,
        })),
      })),
      totals: { byForm: formTotals, totalScore, totalQuestions },
      quiz: opts.quiz,
    };
  }

  /**
   * Xuất bản đặc tả ra file (xlsx qua exceljs — cùng hạ tầng với xuất
   * điểm vnEdu; docx qua gói docx): cùng một view model, hai định dạng
   * nộp/lưu hồ sơ. Định dạng khác → 400 quiz.spec_export_format.
   */
  async exportMatrixSpecification(actorId: string, matrixId: string, format: string, pinId?: string): Promise<{ filename: string; contentType: string; buffer: Buffer }> {
    if (format !== 'xlsx' && format !== 'docx') {
      throw new BadRequestException({ message: 'Specification export format must be xlsx or docx', code: 'quiz.spec_export_format' });
    }
    const spec = await this.getMatrixSpecification(actorId, matrixId, pinId);
    return this.renderSpecification(spec, format);
  }

  /**
   * Render một view model đặc tả ra file (xlsx qua exceljs — cùng hạ
   * tầng với xuất điểm vnEdu; docx qua gói docx): dùng chung cho đặc
   * tả theo ma trận (C.6), đặc tả theo đề và bản chụp trong bộ hồ sơ
   * (EB-3) — cùng một view model, hai định dạng nộp/lưu hồ sơ.
   */
  async renderSpecification(spec: MatrixSpecification, format: string): Promise<{ filename: string; contentType: string; buffer: Buffer }> {
    if (format !== 'xlsx' && format !== 'docx') {
      throw new BadRequestException({ message: 'Specification export format must be xlsx or docx', code: 'quiz.spec_export_format' });
    }
    const flat = flattenSpecification(spec);
    if (format === 'xlsx') {
      const ExcelJS = await import('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Bản đặc tả');
      ws.columns = [
        { width: 6 }, { width: 24 }, { width: 28 }, { width: 46 },
        { width: 12 }, { width: 14 }, { width: 9 }, { width: 9 }, { width: 16 },
      ];
      ws.mergeCells('A1:I1');
      ws.getCell('A1').value = `BẢN ĐẶC TẢ ĐỀ KIỂM TRA — ${spec.subject.name.toUpperCase()} LỚP ${spec.curriculum.grade}`;
      ws.getCell('A1').font = { bold: true, size: 14 };
      ws.mergeCells('A2:I2');
      ws.getCell('A2').value = `Ma trận: ${spec.matrix.name}`;
      ws.mergeCells('A3:I3');
      ws.getCell('A3').value = spec.purpose;
      ws.getCell('A3').alignment = { wrapText: true, vertical: 'top' };
      ws.addRow([]);
      const header = ws.addRow(['STT', 'Chủ đề', 'Nội dung / Đơn vị kiến thức', 'Yêu cầu cần đạt', 'Mức', 'Dạng câu hỏi', 'Số câu', 'Điểm', 'Số thứ tự câu trong đề']);
      header.font = { bold: true };
      for (const row of flat) {
        ws.addRow([
          row.index, row.topicTitle, row.nodeTitle, row.outcomeText, row.levelLabel,
          row.qtypeLabel, row.questionCount, row.cellScore, row.slotText,
        ]);
      }
      ws.addRow([]);
      ws.addRow(['', '', '', 'Tổng theo dạng câu hỏi', '', '', '', '', '']);
      for (const f of spec.totals.byForm) {
        ws.addRow(['', '', '', QTYPE_LABELS[f.qtype] ?? f.qtype, '', '', f.questionCount, f.score, `${f.percent}%`]);
      }
      ws.addRow(['', '', '', 'Tổng cộng', '', '', spec.totals.totalQuestions, spec.totals.totalScore, '']);
      const buffer = Buffer.from(await wb.xlsx.writeBuffer());
      return { filename: `ban-dac-ta-${spec.matrix.id.slice(0, 8)}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer };
    }
    const docx = await import('docx');
    const cellOf = (text: string) => new docx.TableCell({ children: [new docx.Paragraph(text)] });
    const table = new docx.Table({
      rows: [
        new docx.TableRow({
          children: ['STT', 'Chủ đề', 'Nội dung / Đơn vị kiến thức', 'Yêu cầu cần đạt', 'Mức', 'Dạng câu hỏi', 'Số câu', 'Điểm', 'Số thứ tự câu trong đề'].map(cellOf),
        }),
        ...flat.map((row) => new docx.TableRow({
          children: [
            String(row.index), row.topicTitle, row.nodeTitle, row.outcomeText, row.levelLabel,
            row.qtypeLabel, String(row.questionCount), String(row.cellScore), row.slotText,
          ].map(cellOf),
        })),
      ],
    });
    const doc = new docx.Document({
      sections: [{
        children: [
          new docx.Paragraph({ children: [new docx.TextRun({ text: `BẢN ĐẶC TẢ ĐỀ KIỂM TRA — ${spec.subject.name.toUpperCase()} LỚP ${spec.curriculum.grade}`, bold: true })] }),
          new docx.Paragraph(`Ma trận: ${spec.matrix.name}`),
          new docx.Paragraph(spec.purpose),
          table,
          new docx.Paragraph(`Tổng cộng: ${spec.totals.totalQuestions} câu — ${spec.totals.totalScore} điểm.`),
          ...spec.totals.byForm.map((f) => new docx.Paragraph(`${QTYPE_LABELS[f.qtype] ?? f.qtype}: ${f.questionCount} câu, ${f.score} điểm (${f.percent}%).`)),
        ],
      }],
    });
    const buffer = await docx.Packer.toBuffer(doc);
    return { filename: `ban-dac-ta-${spec.matrix.id.slice(0, 8)}.docx`, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer };
  }

  // --- thông tin cho người xem ---------------------------------------------------

  /**
   * Phân giải layout phiếu in cho một quiz (cổng quiz:gradepaper): mọi
   * slot phải là câu CỐ ĐỊNH thuộc loại trắc nghiệm/đúng-sai — phiếu
   * giấy là một đề cố định, slot ngẫu nhiên theo category/ma trận
   * không in được. Mỗi slot được GHIM vào đúng version sẽ in (slot
   * pinned dùng version đã ghim; slot follow_latest ghim version mới
   * nhất tại thời điểm sinh phiếu) kèm đáp án của version đó theo thứ
   * tự in, để lúc ghi điểm chấm đúng bản đã phát cho học sinh.
   */
  async resolvePaperLayout(actorId: string, pinId: string): Promise<{ quiz: PinRow; layout: PaperSlotLayout[] }> {
    const quiz = await this.shared.getPin(pinId);
    await this.shared.requireCap(actorId, quiz, QUIZ_CAPABILITIES.gradePaper);
    const slots = await this.shared.effectiveSlots(quiz);
    if (!slots.length) throw new BadRequestException({ message: 'This quiz has no questions yet', code: 'quiz.no_questions' });
    if (slots.length > 60) {
      throw new UnprocessableEntityException({ message: 'A paper answer sheet supports at most 60 questions', code: 'paper.too_many_questions' });
    }
    const layout: PaperSlotLayout[] = [];
    for (const slot of slots) {
      if (!slot.questionId) {
        throw new UnprocessableEntityException({ message: 'Paper sheets need a fixed paper: every slot must pin a specific question (no random category/matrix slots)', code: 'paper.requires_fixed_slots' });
      }
      const view = await this.questions.getQuestion(slot.questionId);
      const qtype = view.question.qtype;
      if (qtype !== 'multichoice' && qtype !== 'truefalse') {
        throw new UnprocessableEntityException({ message: `Question type ${qtype} cannot be printed on an OMR answer sheet`, code: 'paper.unsupported_qtype' });
      }
      const pinnedId = slot.versionMode === 'pinned' ? slot.pinnedVersionId : null;
      const content = pinnedId && pinnedId !== view.latestVersion.id
        ? await this.questions.getVersionContent(slot.questionId, pinnedId)
        : { version: view.latestVersion, answers: view.answers, options: view.options };
      let answerIds: string[];
      let statementIds: string[] = [];
      if (qtype === 'truefalse') {
        // TF-A: một slot phiếu mang 4 ý, mỗi ý một cặp ô Đ/S theo đúng
        // thứ tự mệnh đề của version đã ghim — layout ghi statementIds
        // để lúc ghi điểm quy các cặp ô về đáp án theo từng mệnh đề.
        // Đáp án đúng KHÔNG nằm ở layout (nó ở phía đáp án của version,
        // engine tự tra khi chấm).
        const statements = getTrueFalseStatements(content.version.questionText as RichTextDocument);
        if (!statements || statements.length !== TRUE_FALSE_STATEMENT_COUNT) {
          throw new UnprocessableEntityException({ message: 'True/false question is missing its four statements', code: 'paper.bad_truefalse' });
        }
        statementIds = statements.map((s) => s.id);
        answerIds = [];
      } else {
        if (content.answers.length < 2 || content.answers.length > 5) {
          throw new UnprocessableEntityException({ message: 'A printed multichoice question needs 2–5 answers', code: 'paper.bad_option_count' });
        }
        answerIds = content.answers.map((a) => a.id);
      }
      layout.push({
        slot: slot.slot, questionId: slot.questionId, versionId: content.version.id,
        qtype, optionCount: qtype === 'truefalse' ? statementIds.length * 2 : answerIds.length,
        answerIds, statementIds, maxMark: slot.maxMark,
      });
    }
    return { quiz, layout };
  }

  /**
   * Ghi một phiếu giấy đã được giáo viên xác nhận thành attempt của
   * học sinh (cổng quiz:gradepaper, kiểm tại resolvePaperLayout của lô
   * — hàm này tin layout do module paper-grading truyền vào sau khi đã
   * kiểm quyền). Attempt là attempt THẬT của học sinh: usage dựng từ
   * đúng các version đã ghim trên phiếu, đáp án nộp qua engine như
   * attempt online, chốt bằng đúng đường finalizeAttempt (điểm chảy
   * vào sổ điểm như thường). appliedSettings mang dấu nguồn giấy
   * {source: 'paper-scan', scanId, batchId, variantCode} để báo cáo
   * phân biệt được lượt thi giấy. responses[i] là chuỗi đáp án theo
   * ngữ nghĩa engine cho slot i (multichoice: answerId đã chọn;
   * truefalse TF-A: JSON bản đồ statementId → boolean quy từ 4 cặp ô
   * Đ/S của slot; null: để trống).
   */
  async recordPaperAttempt(actorId: string, pinId: string, input: {
    studentId: string;
    layout: PaperSlotLayout[];
    responses: (string | null)[];
    scanId: string;
    batchId: string;
    variantCode: string;
  }): Promise<{ attemptId: string; state: string; sumGrades: number | null }> {
    const quiz = await this.shared.getPin(pinId);
    await this.shared.requireCap(actorId, quiz, QUIZ_CAPABILITIES.gradePaper);
    const existing = await this.repo.listAttemptsForUser(quiz.id, input.studentId, true);
    const attemptNumber = existing.length + 1;
    const now = new Date();
    const usage = await this.questions.createUsage(input.studentId, {
      component: QUIZ_COMPONENT, instanceId: quiz.id, contextId: await this.shared.cmContextId(quiz),
      slots: input.layout.map((s) => ({ questionId: s.questionId, maxMark: s.maxMark, pinnedVersionId: s.versionId })),
    });
    try {
      await this.questions.startUsage(input.studentId, usage.usage.id);
      const row = await this.repo.insertAttempt({
        pinId: quiz.id, userId: input.studentId, attemptNumber, usageId: usage.usage.id,
        state: 'inprogress', preview: false, timeStart: now, makeup: false,
        appliedSettings: { source: 'paper-scan', scanId: input.scanId, batchId: input.batchId, variantCode: input.variantCode },
      });
      await this.outbox.enqueueStandalone({
        aggregate: 'quiz', type: 'quiz_attempt_started',
        payload: { pinId: quiz.id, courseId: quiz.course, attemptId: row.id, usageId: row.usageId, userId: input.studentId, attemptNumber, preview: false, actorId },
      });
      const usageView = await this.questions.getUsage(usage.usage.id);
      for (const s of input.layout) {
        const response = input.responses[s.slot - 1] ?? null;
        if (response === null) continue;
        const qa = usageView.attempts.find((a) => a.slot === s.slot);
        if (!qa) throw new BadRequestException({ message: `Usage is missing slot ${s.slot}`, code: 'paper.slot_missing' });
        await this.questions.submitResponse(input.studentId, qa.id, response);
      }
      await this.attempts.finalizeAttempt(quiz, row, false);
      const updated = await this.shared.getAttemptRow(row.id);
      return { attemptId: updated.id, state: updated.state, sumGrades: updated.sumGrades };
    } catch (err) {
      // Cùng kỷ luật dọn dẹp với startAttempt: attempt chưa thành hình
      // thì xoá usage mồ côi (hàng attempt, nếu đã chèn, cascade theo).
      await this.questions.deleteUsage(usage.usage.id).catch(() => undefined);
      throw err;
    }
  }

  // --- báo cáo + chấm tay ---------------------------------------------------------
}

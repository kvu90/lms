import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { QuestionImportItemPayload } from '@lms/contracts';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CurriculumService } from '../curriculum/curriculum.service';
import { QuestionsService, type QuestionContentInput } from '../questions/questions.service';
import { detectImportFileKind, extractDocxLines, extractPdfLines } from './domain/document-text';
import { parseExamDocument } from './domain/exam-parser';
import { hasBlockingIssues, validateImportItem, type ImportIssue } from './domain/item-validation';
import {
  QuestionImportRepository, type ImportBatchRow, type ImportItemRow,
} from './question-import.repository';

export interface ImportBatchCounts { total: number; pending: number; approved: number; rejected: number }
export interface ImportBatchView {
  batch: ImportBatchRow;
  counts: ImportBatchCounts;
  items: ImportItemRow[];
}
export interface ImportBatchSummary {
  batch: ImportBatchRow;
  counts: ImportBatchCounts;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;

function batchNotFound(): NotFoundException {
  return new NotFoundException({ message: 'Question import batch not found', code: 'question_import.batch_not_found' });
}
function itemNotFound(): NotFoundException {
  return new NotFoundException({ message: 'Question import item not found', code: 'question_import.item_not_found' });
}

@Injectable()
/**
 * Số hoá đề từ file vào ngân hàng câu hỏi (issue #52): tải docx/pdf →
 * tách câu thuần quy tắc → HÀNG ĐỢI DUYỆT → duyệt mới thành câu hỏi
 * chính thức (kèm gắn YCCĐ + mức qua cơ chế Curriculum Chặng 2).
 *
 * Bất biến cốt lõi: mục chưa duyệt chỉ tồn tại trong hai bảng của module
 * này — không một luồng dùng câu nào (ngân hàng, quiz, ma trận) nhìn
 * thấy chúng. Duyệt là hành vi tạo câu thật qua QuestionsService nên mọi
 * kiểm chứng nội dung/quyền của ngân hàng được áp nguyên vẹn.
 */
export class QuestionImportService {
  constructor(
    private readonly repo: QuestionImportRepository,
    private readonly questions: QuestionsService,
    private readonly curriculum: CurriculumService,
    private readonly evaluator: PermissionEvaluator,
    private readonly outbox: OutboxService,
  ) {}

  // --- truy cập ---------------------------------------------------------------

  /**
   * Quyền tiếp cận một đợt: người tải lên, hoặc người có quyền thêm câu
   * hỏi tại context của category đích (đồng nghiệp cùng phụ trách ngân
   * hàng). Ngoài hai nhóm này, đợt được giấu hẳn (404) để không lộ sự
   * tồn tại — cùng chuẩn các cổng phạm vi đã chốt ở #33/#44.
   */
  private async assertAccess(actorId: string, batch: ImportBatchRow): Promise<void> {
    if (batch.uploadedBy === actorId) return;
    const category = await this.questions.getCategory(batch.categoryId);
    if (await this.evaluator.hasCapability(actorId, 'question:add', category.contextId)) return;
    throw batchNotFound();
  }

  private async batchForRead(actorId: string, batchId: string): Promise<ImportBatchRow> {
    const batch = await this.repo.getBatch(batchId);
    if (!batch) throw batchNotFound();
    await this.assertAccess(actorId, batch);
    return batch;
  }

  private async itemForMutation(actorId: string, batchId: string, itemId: string): Promise<{ batch: ImportBatchRow; item: ImportItemRow }> {
    const batch = await this.batchForRead(actorId, batchId);
    const item = await this.repo.getItem(itemId);
    if (!item || item.batchId !== batch.id) throw itemNotFound();
    return { batch, item };
  }

  private async countsFor(batch: ImportBatchRow): Promise<ImportBatchCounts> {
    const map = await this.repo.countItemsByStatus([batch.id]);
    const c = map.get(batch.id) ?? { pending: 0, approved: 0, rejected: 0 };
    return { total: batch.totalItems, ...c };
  }

  private async batchView(actorId: string, batch: ImportBatchRow): Promise<ImportBatchView> {
    void actorId;
    const items = await this.repo.listItems(batch.id);
    return { batch, counts: await this.countsFor(batch), items };
  }

  /** Cập nhật trạng thái đợt theo số mục còn chờ: hết mục chờ → completed. */
  private async refreshBatchStatus(batchId: string): Promise<void> {
    const pending = await this.repo.countPendingItems(batchId);
    await this.repo.updateBatch(batchId, { status: pending === 0 ? 'completed' : 'in_review' });
  }

  // --- tải lên + tách câu ---------------------------------------------------------

  /**
   * Tải một file đề lên một category đích và tách câu ngay (đồng bộ):
   * file không đọc được / không đúng định dạng / không tách được câu nào
   * đều bị từ chối 400 và KHÔNG tạo đợt. Quyền: question:add tại context
   * của category — cùng quyền tạo câu hỏi thường.
   */
  async upload(actorId: string, categoryId: string, file: { originalname: string; buffer: Buffer }): Promise<ImportBatchView> {
    const category = await this.questions.getCategory(categoryId);
    await this.evaluator.requireCapability(actorId, 'question:add', category.contextId);
    if (file.buffer.length === 0) {
      throw new BadRequestException({ message: 'The uploaded file is empty', code: 'question_import.file_empty' });
    }
    if (file.buffer.length > MAX_FILE_BYTES) {
      throw new BadRequestException({ message: 'The exam file must be at most 10 MB', code: 'question_import.file_too_large' });
    }
    const kind = detectImportFileKind(file.buffer, file.originalname);
    if (!kind) {
      throw new BadRequestException({ message: 'Only .docx and .pdf exam files are supported', code: 'question_import.unsupported_file' });
    }
    let lines;
    try {
      lines = kind === 'docx' ? await extractDocxLines(file.buffer) : await extractPdfLines(file.buffer);
    } catch {
      throw new BadRequestException({ message: 'The file could not be read as a valid exam document', code: 'question_import.unreadable_file' });
    }
    const parsed = parseExamDocument(lines);
    if (parsed.items.length === 0) {
      throw new BadRequestException({
        message: 'No questions could be recognised in this file with the supported marking conventions',
        code: 'question_import.no_questions_found',
      });
    }
    const contentHash = createHash('sha256').update(file.buffer).digest('hex');
    let batch!: ImportBatchRow;
    await this.repo.dbHandle.transaction(async (tx) => {
      batch = await this.repo.insertBatch({
        categoryId: category.id, uploadedBy: actorId,
        fileName: file.originalname, fileKind: kind, fileSize: file.buffer.length,
        contentHash, status: 'in_review', totalItems: parsed.items.length,
      }, tx);
      for (const item of parsed.items) {
        await this.repo.insertItem({
          batchId: batch.id, ordinal: item.ordinal, sourceNumber: item.sourceNumber,
          qtype: item.qtype, status: 'pending',
          payload: item.payload as never, issues: item.issues as never,
          rawText: item.rawText,
        }, tx);
      }
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'question_import', type: 'question_import_parsed',
      payload: { batchId: batch.id, categoryId: category.id, uploadedBy: actorId, fileKind: kind, totalItems: parsed.items.length },
    });
    return this.batchView(actorId, batch);
  }

  /** Các đợt nhập mà người dùng tiếp cận được: của chính họ; quản trị viên hệ thống thấy tất cả. */
  async listBatches(actorId: string): Promise<ImportBatchSummary[]> {
    const isAdmin = await this.evaluator.isSiteAdmin(actorId);
    const batches = isAdmin ? await this.repo.listAllBatches() : await this.repo.listBatchesByUploader(actorId);
    const counts = await this.repo.countItemsByStatus(batches.map((b) => b.id));
    return batches.map((batch) => ({
      batch,
      counts: { total: batch.totalItems, ...(counts.get(batch.id) ?? { pending: 0, approved: 0, rejected: 0 }) },
    }));
  }

  /** Chi tiết một đợt kèm toàn bộ mục chờ duyệt. */
  async getBatch(actorId: string, batchId: string): Promise<ImportBatchView> {
    const batch = await this.batchForRead(actorId, batchId);
    return this.batchView(actorId, batch);
  }

  // --- duyệt ---------------------------------------------------------------------

  /**
   * Sửa payload của một mục đang chờ (giáo viên chỉnh nội dung/đáp án và
   * chọn YCCĐ + mức ngay tại bước này). Danh sách vấn đề được tính lại
   * bằng cùng bộ quy tắc lúc tách câu. Mục đã xử lý rồi thì không sửa
   * được nữa (409) — câu chính thức sau duyệt sửa qua luồng câu hỏi.
   */
  async updateItem(actorId: string, batchId: string, itemId: string, payload: QuestionImportItemPayload): Promise<ImportItemRow> {
    const { item } = await this.itemForMutation(actorId, batchId, itemId);
    if (item.status !== 'pending') {
      throw new ConflictException({ message: 'Only a pending import item can be edited', code: 'question_import.item_not_pending' });
    }
    const issues = validateImportItem(payload);
    await this.repo.updateItem(item.id, {
      qtype: payload.qtype, payload: payload as never, issues: issues as never,
    });
    return (await this.repo.getItem(item.id))!;
  }

  /** Ánh xạ payload chờ duyệt sang đầu vào tạo câu của ngân hàng. */
  private toCreateInput(payload: QuestionImportItemPayload): QuestionContentInput {
    const base: QuestionContentInput = {
      questionText: payload.questionText,
      generalFeedback: payload.generalFeedback ?? undefined,
      defaultMark: payload.defaultMark,
    };
    if (payload.qtype === 'truefalse') {
      return { ...base, answer: { correct: payload.truefalseCorrect === true } };
    }
    if (payload.qtype === 'multichoice') {
      return {
        ...base,
        answers: payload.answers.map((a) => ({ text: a.text, fraction: a.fraction, feedback: a.feedback ?? undefined })),
        options: { single: payload.options.single ?? true, shuffleAnswers: payload.options.shuffleAnswers ?? false },
      };
    }
    if (payload.qtype === 'shortanswer') {
      return {
        ...base,
        answers: payload.answers.map((a) => ({ text: a.text, fraction: a.fraction, feedback: a.feedback ?? undefined })),
        options: { useCase: payload.options.useCase ?? false },
      };
    }
    return base; // essay: không đáp án, options mặc định của ngân hàng.
  }

  /**
   * Duyệt một mục: kiểm tra hết lỗi → tạo câu hỏi chính thức trong
   * category của đợt → gắn các YCCĐ + mức đã chọn. Mọi kiểm tra có thể
   * thất bại (quyền gắn kết, YCCĐ tồn tại) đều chạy TRƯỚC khi tạo câu để
   * không bao giờ sinh câu "duyệt dở" trong ngân hàng.
   */
  private async approveOne(actorId: string, batch: ImportBatchRow, item: ImportItemRow): Promise<{ item: ImportItemRow; questionId: string }> {
    if (item.status !== 'pending') {
      throw new ConflictException({ message: 'Import item has already been reviewed', code: 'question_import.item_not_pending' });
    }
    const payload = item.payload as unknown as QuestionImportItemPayload;
    const issues: ImportIssue[] = validateImportItem(payload);
    if (hasBlockingIssues(issues)) {
      throw new BadRequestException({
        message: 'The item still has blocking issues; fix them before approving',
        code: 'question_import.item_has_errors',
        issues,
      });
    }
    const category = await this.questions.getCategory(batch.categoryId);
    if (payload.outcomeLinks.length > 0) {
      // Gắn kết chương trình dùng quyền sửa câu (question:editall) như
      // luồng gắn kết trong trình soạn câu — kiểm tra trước khi tạo câu.
      await this.evaluator.requireCapability(actorId, 'question:editall', category.contextId);
      for (const link of payload.outcomeLinks) {
        await this.curriculum.getOutcome(actorId, link.outcomeId);
      }
    }
    const view = await this.questions.createQuestion(actorId, {
      categoryId: batch.categoryId, qtype: payload.qtype, name: payload.name,
      ...this.toCreateInput(payload),
    });
    const questionId = view.question.id;
    for (const link of payload.outcomeLinks) {
      await this.questions.attachOutcome(actorId, questionId, link.outcomeId, link.cognitiveLevel);
    }
    await this.repo.updateItem(item.id, {
      status: 'approved', questionId, reviewedBy: actorId, reviewedAt: new Date(),
    });
    return { item: (await this.repo.getItem(item.id))!, questionId };
  }

  /** Duyệt một mục chờ (xem approveOne). */
  async approveItem(actorId: string, batchId: string, itemId: string): Promise<{ item: ImportItemRow; questionId: string }> {
    const { batch, item } = await this.itemForMutation(actorId, batchId, itemId);
    const result = await this.approveOne(actorId, batch, item);
    await this.refreshBatchStatus(batch.id);
    return result;
  }

  /** Từ chối một mục chờ: mục ở lại hàng đợi làm dấu vết, không vào ngân hàng. */
  async rejectItem(actorId: string, batchId: string, itemId: string): Promise<ImportItemRow> {
    const { batch, item } = await this.itemForMutation(actorId, batchId, itemId);
    if (item.status !== 'pending') {
      throw new ConflictException({ message: 'Import item has already been reviewed', code: 'question_import.item_not_pending' });
    }
    await this.repo.updateItem(item.id, { status: 'rejected', reviewedBy: actorId, reviewedAt: new Date() });
    await this.refreshBatchStatus(batch.id);
    return (await this.repo.getItem(item.id))!;
  }

  /**
   * Duyệt hàng loạt các mục đang chờ của đợt: mục nào còn lỗi hoặc vướng
   * quyền thì bỏ qua và báo rõ trong kết quả, các mục còn lại vẫn duyệt —
   * khớp nhịp làm việc thật (giáo viên duyệt nhanh phần sạch, quay lại
   * sửa phần có vấn đề sau).
   */
  async approveAll(actorId: string, batchId: string): Promise<{
    approved: { itemId: string; questionId: string }[];
    skipped: { itemId: string; code: string; message: string }[];
  }> {
    const batch = await this.batchForRead(actorId, batchId);
    const items = await this.repo.listItems(batch.id);
    const approved: { itemId: string; questionId: string }[] = [];
    const skipped: { itemId: string; code: string; message: string }[] = [];
    for (const item of items) {
      if (item.status !== 'pending') continue;
      try {
        const result = await this.approveOne(actorId, batch, item);
        approved.push({ itemId: item.id, questionId: result.questionId });
      } catch (err) {
        const body = (err as { response?: { code?: string; message?: string } }).response;
        skipped.push({
          itemId: item.id,
          code: body?.code ?? 'question_import.approve_failed',
          message: body?.message ?? (err as Error).message,
        });
      }
    }
    await this.refreshBatchStatus(batch.id);
    return { approved, skipped };
  }
}

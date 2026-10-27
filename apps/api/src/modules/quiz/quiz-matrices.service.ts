import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type {
  ExamMatrixCellView,
  ExamMatrixView,
  MatrixCellAvailability,
  MatrixImportCellAvailability,
} from '@lms/contracts';
import { OutboxService } from '../../infra/events/outbox.service';
import { TenantContextService } from '../tenants/tenant-context.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CoursesService } from '../courses/courses.service';
import { CurriculumService } from '../curriculum/curriculum.service';
import { QuestionBanksService } from '../questions/question-banks.service';
import type { QuestionBankRow } from '../questions/question-banks.repository';
import type {
  CreateExamMatrixCellDto,
  CreateExamMatrixDto,
  UpdateExamMatrixCellDto,
  UpdateExamMatrixDto,
  WithdrawExamMatrixDto,
} from './dto/quiz.dto';
import { isValidTfScale, MATRIX_PRESETS, matrixWarnings } from './domain/matrix';
import {
  QuizRepository,
  type DbTx,
  type ExamMatrixCellRow,
  type ExamMatrixRow,
  type ExamMatrixVersionRow,
} from './quiz.repository';
import {
  isMatrixContentSignatureConflict,
  matrixContentSignature,
} from './matrix-content-signature';
import { QuizSharedService } from './quiz-shared.service';
import { QUIZ_CAPABILITIES } from './quiz-shared.service';

/**
 * Cụm ma trận đề của QuizService (cụm 2 của issue #295): CRUD ma trận
 * và ô ma trận, nhập ma trận từ file, phiên bản ma trận (fork version
 * của issue #228), độ phủ/availability, và cổng bank cá nhân
 * `requirePersonalMatrixBankManage` (neo bank đích của issue #233).
 * Cụm này chỉ gọi xuống tầng thấp dùng chung (`QuizSharedService`),
 * không phụ thuộc cụm ca sử dụng nào khác.
 */

export class QuizMatricesService {
  constructor(
    private readonly repo: QuizRepository,
    private readonly evaluator: PermissionEvaluator,
    private readonly banks: QuestionBanksService,
    private readonly curriculum: CurriculumService,
    private readonly outbox: OutboxService,
    private readonly tenantContext: TenantContextService,
    private readonly shared: QuizSharedService,
  ) {}

  /** Kiểm tra thang Đ–S khi lưu (đúng 5 mức, đơn điệu không giảm, cuối = 100) — thang sai là lỗi soạn đề, chặn ở biên. */
  private assertValidTfScale(scale: number[] | null | undefined): void {
    if (scale !== undefined && scale !== null && !isValidTfScale(scale)) {
      throw new BadRequestException({ message: 'tfScale must be 5 percentages (0..100), non-decreasing, ending at 100', code: 'quiz.tf_scale_invalid' });
    }
  }

  /**
   * Tạo một lần GHIM đề vào khoá (thực thể duy nhất thay quiz +
   * deployment): bản ghi exam_pins neo (exam, exam version) + course
   * module (component mod_quiz, completion tự động theo điểm) + grade
   * item 'mod' mang thang điểm của exam version. Cổng exam:deploy tại
   * bank của đề + trạng thái ready của đề do ExamsService kiểm trước
   * khi gọi; quyền tạo hoạt động do CoursesService kiểm
   * (course:manageactivities); các thao tác về sau kiểm quiz:manage
   * tại context của module.
   */

  /**
   * Cổng BANK của các luồng ghi ma trận vào bank cá nhân (MB-1, cùng
   * học thuyết neo bank của {@link requireMatrixCap}): bank đích của
   * các luồng này là bank ma trận CÁ NHÂN của chính người gọi — tạo
   * lười như đường copy mẫu (người không thuộc nhóm staff bị từ chối
   * ngay ở bước tạo lười, trước mọi lần đọc dữ liệu) — và quyền ghi
   * chốt bằng bộ quyền bank-local tại bank đó (chủ bank giữ vai lead
   * nên có `quiz:managematrix` bản địa).
   *
   * Đây là cổng DUY NHẤT của đường nhập ma trận từ file ở cả ba đầu
   * (sinh mẫu, xem trước, ghi — MatrixImportService gọi hàm này) và
   * là bước chốt quyền của chính thao tác ghi
   * {@link createMatrixFromImport}. Các luồng này KHÔNG gác thêm
   * `quiz:managematrix` hay `curriculum:view` tại context của môn:
   * môn chỉ là phạm vi dữ liệu tham chiếu của thao tác ghi, và giáo
   * viên thật không có vai nào tại context hệ thống của môn GDPT nên
   * cổng tại context môn chặn nhầm mọi giáo viên (điểm chặn của
   * nghiệm thu D-3 trên production, issue #233).
   *
   * @param actorId - Người gọi (chủ bank đích).
   * @returns Bank ma trận cá nhân của người gọi.
   * @throws ForbiddenException `question.personal_bank_staff_only`
   *   khi người gọi không thuộc nhóm staff và chưa có bank cá nhân;
   *   `access.capability_denied` khi bộ quyền bank-local không cho
   *   phụ trách bank.
   */
  async requirePersonalMatrixBankManage(actorId: string): Promise<QuestionBankRow> {
    const bank = await this.banks.ensurePersonalBank(actorId, 'matrix');
    await this.banks.syncBankMembership(bank);
    const caps = await this.banks.bankLocalMatrixCaps(actorId, bank);
    if (!caps.manage) {
      throw new ForbiddenException({ message: `Missing capability ${QUIZ_CAPABILITIES.manageMatrix} in matrix bank ${bank.id}`, code: 'access.capability_denied' });
    }
    return bank;
  }

  private matrixCellView(row: ExamMatrixCellRow): ExamMatrixCellView {
    return {
      id: row.id, matrixId: row.matrixId, curriculumNodeId: row.curriculumNodeId,
      cognitiveLevel: row.cognitiveLevel as ExamMatrixCellView['cognitiveLevel'],
      qtype: row.qtype as ExamMatrixCellView['qtype'],
      questionCount: row.questionCount, cellScore: row.cellScore,
      minutes: row.minutes, tfScale: row.tfScale, position: row.position,
    };
  }

  private async matrixView(row: ExamMatrixRow): Promise<ExamMatrixView> {
    const cells = await this.repo.listMatrixCells(row.id);
    return {
      id: row.id, name: row.name, subjectId: row.subjectId, curriculumId: row.curriculumId,
      contextId: row.contextId,
      presetKind: row.presetKind as ExamMatrixView['presetKind'],
      targetFormPercents: row.targetFormPercents, targetLevelPercents: row.targetLevelPercents,
      levelSet: row.levelSet as ExamMatrixView['levelSet'],
      scopeNote: row.scopeNote, scopeNodeIds: row.scopeNodeIds,
      totalScore: row.totalScore, createdBy: row.createdBy,
      bankId: row.bankId, status: row.status as ExamMatrixView['status'],
      isTemplate: row.isTemplate, derivedFromMatrixId: row.derivedFromMatrixId,
      derivedFromBankId: row.derivedFromBankId, originalAuthorId: row.originalAuthorId,
      copyCount: row.copyCount,
      withdrawnReason: row.withdrawnReason, withdrawnBy: row.withdrawnBy,
      withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
      version: row.version,
      cells: cells.map((c) => this.matrixCellView(c)),
      warnings: matrixWarnings({
        cells, targetFormPercents: row.targetFormPercents,
        targetLevelPercents: row.targetLevelPercents, totalScore: row.totalScore,
      }),
    };
  }

  /** View đầy đủ của một dòng ma trận (ô + cảnh báo) — bản công khai cho lớp bank (MB-1) dùng sau khi đã tự gác quyền. */
  async viewMatrixRow(row: ExamMatrixRow): Promise<ExamMatrixView> {
    return this.matrixView(row);
  }

  /**
   * Tạo ma trận: quyền ghi MỘT nguồn duy nhất (E-8) — khi gắn vào một
   * Tạo ma trận: quyền ghi MỘT nguồn duy nhất (E-8) — khi gắn vào một
   * bank ma trận (MB-1) thì gác matrix:add tại CONTEXT CỦA BANK
   * (bank phải tồn tại và đúng bank_kind='matrix'); không gắn bank thì
   * gác matrix:add tại context của môn. Tạo mới dùng cổng ADD
   * (khuôn S3 của #228) — matrix:edit chỉ gác sửa ma trận đã có. Tỉ
   * lệ mục tiêu không được cho thì CHỤP từ preset tại lúc tạo — về
   * sau preset có đổi thì ma trận đã tạo không đổi theo.
   *
   * Môn/chương trình ở đây chỉ là dữ liệu THAM CHIẾU của thao tác ghi
   * (đối chiếu cặp + lấy context môn cho nhánh không gắn bank) nên
   * đọc bằng đường tham chiếu nội bộ của CurriculumService, không qua
   * đường đọc công khai vốn đòi `curriculum:view` tại context của
   * môn — lớp đọc đó từng chặn nhầm giáo viên tạo ma trận GẮN BANK
   * theo môn thuộc chương trình hệ thống (cùng điểm chặn D-3 của
   * issue #233 ở đường nhập file), trong khi cổng ghi thật của nhánh
   * gắn bank là bộ quyền bank-local tại bank đích.
   */
  async createMatrix(actorId: string, input: CreateExamMatrixDto): Promise<ExamMatrixView> {
    const subject = await this.curriculum.getSubjectReference(input.subjectId);
    const curriculum = await this.curriculum.getCurriculumReference(input.curriculumId);
    if (curriculum.subjectId !== subject.id) {
      throw new BadRequestException({ message: 'Curriculum does not belong to the subject', code: 'quiz.matrix_curriculum_mismatch' });
    }
    let bankTenantId: string | null | undefined;
    if (input.bankId) {
      const bank = await this.banks.findBankById(input.bankId);
      bankTenantId = bank?.tenantId;
      if (!bank) throw new NotFoundException({ message: `Matrix bank ${input.bankId} not found`, code: 'quiz.matrix_bank_not_found' });
      if (bank.bankKind !== 'matrix') {
        throw new BadRequestException({ message: 'Target bank is not a matrix bank', code: 'quiz.matrix_bank_kind_mismatch' });
      }
      await this.banks.syncBankMembership(bank);
      // Ghi ma trận MỚI vào bank = cổng tạo bank-local (caps.add, xem requireMatrixCap).
      const caps = await this.banks.bankLocalMatrixCaps(actorId, bank);
      if (!caps.add) {
        throw new ForbiddenException({ message: `Missing capability ${QUIZ_CAPABILITIES.addMatrix} in matrix bank ${bank.id}`, code: 'access.capability_denied' });
      }
    } else {
      await this.evaluator.requireCapability(actorId, QUIZ_CAPABILITIES.addMatrix, subject.contextId);
    }
    // Khuôn ma trận duy nhất là CV 7991 (bỏ hẳn chọn preset): tỉ lệ
    // tham chiếu chụp từ hằng cấu hình khi GV không cho tỉ lệ riêng.
    const presetKind = 'cv7991_periodic';
    const preset = MATRIX_PRESETS[presetKind];
    const tenantId = bankTenantId !== undefined ? bankTenantId : await this.shared.matrixTenantId();
    // Chữ ký nội dung (lát chống trùng của issue #233): ma trận mới
    // tạo chưa có ô nên chữ ký tính trên tập ô rỗng; các thao tác ô
    // về sau tính lại trong cùng thao tác ghi. Ma trận gắn bank mà
    // trùng toàn bộ nội dung với một ma trận đã có trong bank đó thì
    // ràng buộc duy nhất ở DB chặn insert — dịch thành 409 tường
    // minh thay vì lỗi 500 thô.
    const contentSignature = matrixContentSignature({
      name: input.name, subjectId: subject.id, curriculumId: curriculum.id,
      levelSet: input.levelSet ?? 'three', totalScore: input.totalScore ?? 10,
      scopeNote: input.scopeNote ?? null, scopeNodeIds: input.scopeNodeIds ?? null,
      cells: [],
    });
    // Ma trận (kèm chữ ký nội dung) và hàng version bất biến đầu
    // tiên sinh trong MỘT transaction: không tồn tại ma trận nào
    // không có version 1 chứa cấu hình khởi tạo của nó (bất biến
    // nền của cơ chế version hoá).
    let row: ExamMatrixRow;
    try {
      row = await this.repo.dbHandle.transaction(async (tx) => {
        const created = await this.repo.insertMatrix({
          tenantId,
          name: input.name, subjectId: subject.id, curriculumId: curriculum.id,
          contextId: subject.contextId, presetKind,
          targetFormPercents: input.targetFormPercents !== undefined ? input.targetFormPercents : (preset?.targetFormPercents ?? null),
          targetLevelPercents: input.targetLevelPercents !== undefined ? input.targetLevelPercents : (preset?.targetLevelPercents ?? null),
          levelSet: input.levelSet ?? 'three',
          scopeNote: input.scopeNote ?? null,
          scopeNodeIds: input.scopeNodeIds ?? null,
          totalScore: input.totalScore ?? 10,
          contentSignature,
          createdBy: actorId,
          // Trường ngân hàng (MB-0/MB-1): bankId đã gác quyền tại context
          // bank ở trên; copy mẫu/đóng góp đi qua MatrixBanksService.
          bankId: input.bankId ?? null,
          status: input.status ?? 'draft',
          isTemplate: input.isTemplate ?? false,
          derivedFromMatrixId: input.derivedFromMatrixId ?? null,
        }, tx);
        await this.repo.insertMatrixVersion({
          matrixId: created.id, version: 1, ...this.matrixVersionConfigOf(created), createdBy: actorId,
        }, tx);
        return created;
      });
    } catch (err) {
      this.rethrowAsDuplicateContentConflict(err);
    }
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'exam_matrix_created', payload: { matrixId: row.id, subjectId: subject.id, actorId } });
    return this.matrixView(row);
  }

  /**
   * Chữ ký nội dung chuẩn hoá của một ma trận (dự thảo nhập hoặc bản
   * ghi đã lưu): tên + môn + chương trình + bộ mức + tổng điểm + ghi
   * chú phạm vi + tập ĐVK phạm vi (không thứ tự) + toàn bộ ô (không
   * thứ tự; điểm ô làm tròn 4 chữ số thập phân như đường parse của
   * lát I-1). Hai nội dung cho cùng một chữ ký là TRÙNG TOÀN BỘ theo
   * nghĩa nghiệp vụ của đường nhập file — cơ sở cho chống ghi trùng
   * của {@link createMatrixFromImport}.
   *
   * Thuật toán sống ở module dùng chung `matrix-content-signature`
   * (lát schema của issue #233): cùng một hàm tính chữ ký cho tầng
   * đối chiếu trong code, cho cột `content_signature` ghi xuống DB ở
   * mọi đường tạo/sửa ma trận, và cho script lấp dữ liệu cũ — method
   * này chỉ là lớp uỷ quyền giữ nguyên chữ ký gọi của các điểm dùng
   * trong service.
   */
  private importedMatrixSignature(input: {
    name: string; subjectId: string; curriculumId: string;
    levelSet: string; totalScore: number; scopeNote: string | null;
    scopeNodeIds: string[] | null;
    cells: { curriculumNodeId: string; cognitiveLevel: string; qtype: string; questionCount: number; cellScore: number }[];
  }): string {
    return matrixContentSignature(input);
  }

  /**
   * Tính lại và ghi chữ ký nội dung của một ma trận từ trạng thái đã
   * lưu hiện tại (phần đầu + toàn bộ ô), trong cùng transaction của
   * thao tác sửa nội dung khi người gọi truyền `tx` (lát schema của
   * issue #233).
   *
   * Mọi đường sửa làm đổi thành phần chữ ký — sửa ô (số câu/điểm ô,
   * thêm/xoá ô) — phải gọi hàm này để cột `content_signature` không
   * lệch nội dung thật: lệch chữ ký làm chống trùng ở DB so sai và
   * ràng buộc duy nhất (bank, chữ ký) mất tác dụng. Va chạm ràng buộc
   * duy nhất tại bước ghi này (nội dung sau sửa trùng toàn bộ với một
   * ma trận khác trong cùng bank) huỷ toàn bộ transaction của thao
   * tác sửa — người gọi dịch thành 409 `quiz.matrix_duplicate_content`.
   *
   * @param matrixId - Ma trận cần tính lại chữ ký.
   * @param tx - Transaction của thao tác sửa, nếu có; thiếu thì đọc
   *   và ghi trên kết nối thường.
   */
  private async refreshMatrixContentSignature(matrixId: string, tx?: DbTx): Promise<void> {
    const row = await this.repo.getMatrix(matrixId, tx);
    if (!row) return;
    const cells = await this.repo.listMatrixCells(matrixId, tx);
    await this.repo.updateMatrix(matrixId, {
      contentSignature: matrixContentSignature({ ...row, cells }),
    }, tx);
  }

  /**
   * Dịch lỗi va chạm ràng buộc duy nhất (bank, chữ ký nội dung)
   * thành 409 tường minh cho các đường ghi ma trận KHÔNG có hành vi
   * "trả bản đã có" (tạo tay, sửa, thao tác ô): trùng toàn bộ nội
   * dung trong cùng một bank là lỗi nghiệp vụ của người gọi, không
   * phải lỗi 500 thô của DB. Lỗi khác được ném lại nguyên vẹn.
   *
   * @param err - Lỗi bắt được từ thao tác ghi.
   * @throws ConflictException `quiz.matrix_duplicate_content` khi
   *   `err` là va chạm của ràng buộc chữ ký.
   */
  private rethrowAsDuplicateContentConflict(err: unknown): never {
    if (isMatrixContentSignatureConflict(err)) {
      throw new ConflictException({ message: 'A matrix with identical content already exists in the target bank', code: 'quiz.matrix_duplicate_content' });
    }
    throw err;
  }

  /**
   * Ghi NGUYÊN TỬ một ma trận từ kết quả parse HỢP LỆ của đường nhập
   * file (lát I-2, issue #233) — đầu ghi duy nhất của luồng nhập:
   *
   * 1. Đối chiếu cặp môn/chương trình như {@link createMatrix} bằng
   *    đường đọc tham chiếu nội bộ (môn/chương trình chỉ là dữ liệu
   *    tham chiếu của thao tác ghi). Cổng quyền của luồng là cổng
   *    bank cá nhân {@link requirePersonalMatrixBankManage}: đã chạy
   *    ở bước parse của chính request ghi
   *    (MatrixImportService.previewImport) và chạy lại tại đây ngay
   *    trước khi ghi — KHÔNG có cổng nào tại context của môn.
   * 2. Bank đích = bank ma trận CÁ NHÂN của người nhập (tạo lười như
   *    đường copy mẫu); quyền ghi tại bank chốt bằng bộ quyền
   *    bank-local như nhánh gắn bank của createMatrix; `tenant_id`
   *    của ma trận suy từ bank (schema đã chốt: tenant suy từ bank
   *    chủ). Ma trận vào bank ở trạng thái `draft`, không phải mẫu —
   *    cùng vị thế với ma trận tạo tay, muốn lên bank chung phải đi
   *    đường copy/đóng góp hiện có.
   * 3. CHỐNG GHI TRÙNG hai tầng (lát schema của issue #233 đóng cửa
   *    sổ đua của tầng một): tầng một đối chiếu chữ ký nội dung với
   *    các ma trận chính người nhập đã có trong bank đích — trùng
   *    toàn bộ thì trả ngay ma trận đã có, KHÔNG tạo bản thứ hai
   *    (gửi lại cùng một file do double submit/retry không nhân đôi
   *    dữ liệu). Tầng hai là ràng buộc duy nhất (bank_id,
   *    content_signature) ở DB: chữ ký được ghi xuống cột
   *    `content_signature` ngay trong transaction tạo ma trận, nên
   *    hai request trùng chạy ĐỒNG THỜI tuyệt đối cũng chỉ một
   *    transaction thắng; transaction thua chạm ràng buộc, rollback
   *    toàn bộ, rồi đọc lại ma trận thắng cuộc theo (bank, chữ ký)
   *    và trả về — người dùng không nhận lỗi, đúng hành vi "trùng
   *    toàn bộ thì trả bản đã có".
   * 4. Ghi ma trận + toàn bộ ô trong MỘT transaction: bất kỳ lỗi nào
   *    giữa chừng (khoá ngoại, ràng buộc duy nhất của ô, check của
   *    DB) đều rollback toàn bộ — không để lại ma trận mồ côi hay ô
   *    ghi dở. Sự kiện outbox `exam_matrix_created` phát SAU khi
   *    transaction đã commit, như createMatrix; riêng request thua
   *    cuộc ở bước 3 không phát sự kiện vì không tạo dữ liệu nào.
   *
   * @param actorId - Người nhập (chủ bank đích).
   * @param input - Dự thảo đã parse hợp lệ: thông tin chung + phạm vi
   *   (ĐVK theo thứ tự hàng trong file) + các ô kèm `position` = số
   *   thứ tự hàng của ĐVK trong file (hồ sơ import: position của ô là
   *   STT của hàng).
   * @returns View ma trận (mới tạo, hoặc bản đã có khi trùng nội dung).
   * @throws BadRequestException khi chương trình không thuộc môn.
   * @throws ForbiddenException khi người nhập không có quyền phụ
   *   trách bank cá nhân của mình (bộ quyền bank-local).
   */
  async createMatrixFromImport(actorId: string, input: {
    name: string; subjectId: string; curriculumId: string;
    levelSet: 'three' | 'four'; totalScore: number; scopeNote: string | null;
    scopeNodeIds: string[];
    cells: { curriculumNodeId: string; cognitiveLevel: string; qtype: string; questionCount: number; cellScore: number; position: number }[];
  }): Promise<ExamMatrixView> {
    const subject = await this.curriculum.getSubjectReference(input.subjectId);
    const curriculum = await this.curriculum.getCurriculumReference(input.curriculumId);
    if (curriculum.subjectId !== subject.id) {
      throw new BadRequestException({ message: 'Curriculum does not belong to the subject', code: 'quiz.matrix_curriculum_mismatch' });
    }
    const bank = await this.requirePersonalMatrixBankManage(actorId);
    // Bước chống ghi trùng: chỉ đối chiếu ma trận của CHÍNH người
    // nhập trong bank đích có cùng định danh thô (tên/môn/chương
    // trình) rồi mới so chữ ký đầy đủ kèm ô — tránh nạp ô của mọi ma
    // trận trong bank. Bản ghi đã có chữ ký ghi ở cột
    // `content_signature` thì so thẳng theo cột (không cần nạp ô);
    // bản ghi lịch sử chưa lấp chữ ký (cột null) mới tính lại từ ô đã
    // lưu — cùng một thuật toán nên hai cách cho cùng một kết quả.
    const signature = this.importedMatrixSignature(input);
    const candidates = (await this.repo.listMatricesByBank(bank.id))
      .filter((r) => r.createdBy === actorId && r.name === input.name
        && r.subjectId === subject.id && r.curriculumId === curriculum.id);
    for (const candidate of candidates) {
      if (candidate.contentSignature !== null) {
        if (candidate.contentSignature === signature) return this.matrixView(candidate);
        continue;
      }
      const existingCells = await this.repo.listMatrixCells(candidate.id);
      if (this.importedMatrixSignature({ ...candidate, cells: existingCells }) === signature) {
        return this.matrixView(candidate);
      }
    }
    // Khuôn ma trận duy nhất là CV 7991 như createMatrix: tỉ lệ tham
    // chiếu chụp từ hằng cấu hình của preset duy nhất còn hiệu lực.
    const preset = MATRIX_PRESETS['cv7991_periodic'];
    let row: ExamMatrixRow;
    try {
      row = await this.repo.dbHandle.transaction(async (tx) => {
        const matrix = await this.repo.insertMatrix({
          tenantId: bank.tenantId,
          name: input.name, subjectId: subject.id, curriculumId: curriculum.id,
          contextId: subject.contextId, presetKind: 'cv7991_periodic',
          targetFormPercents: preset?.targetFormPercents ?? null,
          targetLevelPercents: preset?.targetLevelPercents ?? null,
          levelSet: input.levelSet,
          scopeNote: input.scopeNote,
          scopeNodeIds: input.scopeNodeIds,
          totalScore: input.totalScore,
          contentSignature: signature,
          createdBy: actorId,
          bankId: bank.id,
          status: 'draft',
          isTemplate: false,
          derivedFromMatrixId: null,
        }, tx);
        // Version bất biến đầu tiên của ma trận nhập: cấu hình chụp
        // từ chính ma trận vừa tạo; toàn bộ ô thuộc về version này.
        const firstVersion = await this.repo.insertMatrixVersion({
          matrixId: matrix.id, version: 1, ...this.matrixVersionConfigOf(matrix), createdBy: actorId,
        }, tx);
        for (const cell of input.cells) {
          await this.repo.insertMatrixCell({
            matrixId: matrix.id, matrixVersionId: firstVersion.id, curriculumNodeId: cell.curriculumNodeId,
            cognitiveLevel: cell.cognitiveLevel, qtype: cell.qtype,
            questionCount: cell.questionCount, cellScore: cell.cellScore,
            minutes: null, tfScale: null, position: cell.position,
          }, tx);
        }
        return matrix;
      });
    } catch (err) {
      // Đua ghi đồng thời tuyệt đối: transaction của request này
      // chạm ràng buộc duy nhất (bank, chữ ký) — lỗi 23505 chỉ nổi
      // SAU khi transaction thắng cuộc đã commit, nên đọc lại theo
      // (bank, chữ ký) tại thời điểm này chắc chắn thấy bản thắng
      // cuộc. Trả bản đó như hành vi trùng tuần tự ở trên; không
      // thấy (ràng buộc khác/đua xoá) thì ném lại lỗi gốc.
      if (isMatrixContentSignatureConflict(err)) {
        const winner = await this.repo.findMatrixByBankAndSignature(bank.id, signature);
        if (winner) return this.matrixView(winner);
      }
      throw err;
    }
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'exam_matrix_created', payload: { matrixId: row.id, subjectId: subject.id, actorId } });
    return this.matrixView(row);
  }

  /** Đọc một ma trận kèm ô và cảnh báo lệch tỉ lệ (matrix:use). */
  async getMatrix(actorId: string, matrixId: string): Promise<ExamMatrixView> {
    const row = await this.shared.getMatrixRow(matrixId);
    // Ma trận thuộc tenant khác với tenant hiệu lực → 404 đồng nhất (TENANT-0, #168).
    const activeTenant = this.tenantContext.currentTenantId();
    if (activeTenant !== undefined && row.tenantId !== null && row.tenantId !== activeTenant) {
      throw new NotFoundException({ message: `Exam matrix ${matrixId} not found`, code: 'quiz.matrix_not_found' });
    }
    await this.shared.requireMatrixCap(actorId, row, QUIZ_CAPABILITIES.viewMatrix);
    return this.matrixView(row);
  }

  /**
   * Đọc nội dung của ĐÚNG một version bất biến của ma trận: cấu
   * hình lấy từ hàng version, ô lấy theo version đó — dùng để đối
   * chiếu bản đặc tả đã nộp/đề đã sinh với nội dung ma trận tại
   * thời điểm của chúng. Cổng quyền như đọc ma trận hiện hành.
   * Version không tồn tại → 404 quiz.matrix_version_not_found.
   */
  async getMatrixVersion(actorId: string, matrixId: string, version: number): Promise<ExamMatrixView> {
    const row = await this.shared.getMatrixRow(matrixId);
    const activeTenant = this.tenantContext.currentTenantId();
    if (activeTenant !== undefined && row.tenantId !== null && row.tenantId !== activeTenant) {
      throw new NotFoundException({ message: `Exam matrix ${matrixId} not found`, code: 'quiz.matrix_not_found' });
    }
    await this.shared.requireMatrixCap(actorId, row, QUIZ_CAPABILITIES.viewMatrix);
    const versionRow = await this.repo.getMatrixVersionRow(matrixId, version);
    if (!versionRow) {
      throw new NotFoundException({ message: `Exam matrix ${matrixId} has no version ${version}`, code: 'quiz.matrix_version_not_found' });
    }
    const cells = await this.repo.listMatrixCellsByVersionId(versionRow.id);
    return {
      id: row.id, name: row.name, subjectId: row.subjectId, curriculumId: row.curriculumId,
      contextId: row.contextId,
      presetKind: versionRow.presetKind as ExamMatrixView['presetKind'],
      targetFormPercents: versionRow.targetFormPercents, targetLevelPercents: versionRow.targetLevelPercents,
      levelSet: versionRow.levelSet as ExamMatrixView['levelSet'],
      scopeNote: versionRow.scopeNote, scopeNodeIds: versionRow.scopeNodeIds,
      totalScore: versionRow.totalScore, createdBy: row.createdBy,
      bankId: row.bankId, status: row.status as ExamMatrixView['status'],
      isTemplate: row.isTemplate, derivedFromMatrixId: row.derivedFromMatrixId,
      derivedFromBankId: row.derivedFromBankId, originalAuthorId: row.originalAuthorId,
      copyCount: row.copyCount,
      // Truy vết rút thuộc về THỰC THỂ ma trận (không thuộc version
      // bất biến) — đọc từ hàng ma trận hiện hành như matrixView.
      withdrawnReason: row.withdrawnReason, withdrawnBy: row.withdrawnBy,
      withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
      version: versionRow.version,
      cells: cells.map((c) => this.matrixCellView(c)),
      warnings: matrixWarnings({
        cells, targetFormPercents: versionRow.targetFormPercents,
        targetLevelPercents: versionRow.targetLevelPercents, totalScore: versionRow.totalScore,
      }),
    };
  }

  /**
   * Truy nguồn chiều ngược của ma trận: mọi version đề đã sinh từ
   * ma trận này (exam_versions.matrix_id) kèm số version ma trận đã
   * neo lúc sinh đề — để người soạn truy từ ma trận ra các đề nó đã
   * đẻ ra. Cổng quyền và cổng tenant như đọc chi tiết ma trận.
   */
  async listGeneratedExams(actorId: string, matrixId: string) {
    const row = await this.shared.getMatrixRow(matrixId);
    const activeTenant = this.tenantContext.currentTenantId();
    if (activeTenant !== undefined && row.tenantId !== null && row.tenantId !== activeTenant) {
      throw new NotFoundException({ message: `Exam matrix ${matrixId} not found`, code: 'quiz.matrix_not_found' });
    }
    await this.shared.requireMatrixCap(actorId, row, QUIZ_CAPABILITIES.viewMatrix);
    return this.repo.listExamVersionsByMatrix(matrixId);
  }

  /** Các ma trận của một môn (matrix:use tại context của môn).
   * Ma trận thuộc bank personal của người khác bị loại khỏi danh sách
   * (issue #123) — danh sách theo môn không được rò ma trận riêng. */

  async listMatrices(actorId: string, subjectId: string): Promise<ExamMatrixView[]> {
    const subject = await this.curriculum.getSubject(actorId, subjectId);
    await this.evaluator.requireCapability(actorId, QUIZ_CAPABILITIES.viewMatrix, subject.contextId);
    const rows = await this.repo.listMatricesBySubject(subject.id);
    const foreignPersonalByBank = new Map<string, boolean>();
    const out: ExamMatrixView[] = [];
    for (const r of rows) {
      if (r.bankId) {
        let foreign = foreignPersonalByBank.get(r.bankId);
        if (foreign === undefined) {
          const bank = await this.banks.findBankById(r.bankId);
          foreign = bank ? await this.banks.isForeignPersonalBank(actorId, bank) : false;
          foreignPersonalByBank.set(r.bankId, foreign);
        }
        if (foreign) continue;
      }
      out.push(await this.matrixView(r));
    }
    return out;
  }

  /** Sửa ma trận (matrix:edit); thu hẹp bộ mức khi đã có ô dùng mức bị loại thì bị từ chối. */
  async updateMatrix(actorId: string, matrixId: string, input: UpdateExamMatrixDto): Promise<ExamMatrixView> {
    const row = await this.shared.getMatrixRow(matrixId);
    await this.shared.requireMatrixCap(actorId, row, QUIZ_CAPABILITIES.manageMatrix);
    // Ma trận đã RÚT CHÍNH THỨC (có truy vết withdrawn_*) thì
    // không đổi trạng thái qua đường sửa này — phải khôi phục qua
    // đường khôi phục để truy vết được xoá đúng nghi thức (gác
    // ngang hàng `exam.status_withdrawn` của đề và
    // `question.status_withdrawn` của câu hỏi). Sửa các trường khác
    // trên ma trận đã rút vẫn cho qua — gác chỉ khoá THAY ĐỔI trạng
    // thái.
    if (row.withdrawnAt && input.status !== undefined && input.status !== row.status) {
      throw new ConflictException({
        message: 'Matrix is withdrawn; restore it before changing its status',
        code: 'quiz.matrix_status_withdrawn',
      });
    }
    // MB-1: CHUYỂN ma trận sang bank khác qua PATCH phải có thêm
    // quyền GHI VÀO bank đích (cổng tạo matrix:add tại bank đích —
    // chuyển sang là thêm một ma trận vào bank đó) — quyền ở bank
    // nguồn không tự mang sang bank lạ.
    if (input.bankId !== undefined && input.bankId !== null && input.bankId !== row.bankId) {
      const target = await this.banks.findBankById(input.bankId);
      if (!target) throw new NotFoundException({ message: `Matrix bank ${input.bankId} not found`, code: 'quiz.matrix_bank_not_found' });
      if (target.bankKind !== 'matrix') {
        throw new BadRequestException({ message: 'Target bank is not a matrix bank', code: 'quiz.matrix_bank_kind_mismatch' });
      }
      await this.banks.syncBankMembership(target);
      const targetCaps = await this.banks.bankLocalMatrixCaps(actorId, target);
      if (!targetCaps.add) {
        throw new ForbiddenException({ message: `Missing capability ${QUIZ_CAPABILITIES.addMatrix} in matrix bank ${target.id}`, code: 'access.capability_denied' });
      }
    }
    if (input.levelSet === 'three' && row.levelSet !== 'three') {
      const cells = await this.repo.listMatrixCells(row.id);
      if (cells.some((c) => c.cognitiveLevel === 'van_dung_cao')) {
        throw new BadRequestException({ message: 'Cells already use van_dung_cao; remove them before switching to the three-level set', code: 'quiz.matrix_level_in_use' });
      }
    }
    const patch: Partial<ExamMatrixRow> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.targetFormPercents !== undefined) patch.targetFormPercents = input.targetFormPercents;
    if (input.targetLevelPercents !== undefined) patch.targetLevelPercents = input.targetLevelPercents;
    if (input.levelSet !== undefined) patch.levelSet = input.levelSet;
    if (input.scopeNote !== undefined) patch.scopeNote = input.scopeNote;
    if (input.scopeNodeIds !== undefined) patch.scopeNodeIds = input.scopeNodeIds;
    if (input.totalScore !== undefined) patch.totalScore = input.totalScore;
    if (input.bankId !== undefined) patch.bankId = input.bankId;
    if (input.status !== undefined) patch.status = input.status;
    if (input.isTemplate !== undefined) patch.isTemplate = input.isTemplate;
    // Ma trận đã rời draft (đã dùng sinh đề/đem duyệt) thì sửa nội
    // dung phải sinh VERSION BẤT BIẾN MỚI — bản đặc tả đã nộp khớp
    // version tại thời điểm nộp, không khớp bản đã sửa lặng lẽ.
    // Nhóm trường tính là "sửa nội dung" giữ đúng hợp đồng trước
    // đợt version hoá (gồm cả tên): tên không được chụp VÀO hàng
    // version (ảnh chụp chỉ gồm cấu hình + ô), nhưng đổi tên trên
    // ma trận đã rời draft vẫn fork một version mới mang cấu hình
    // và ô nguyên trạng — số version giữ nguyên ý nghĩa "ma trận
    // đã bị sửa sau khi rời draft" mà các bề mặt cũ đang dựa vào.
    const contentChanged = ['name', 'targetFormPercents', 'targetLevelPercents', 'levelSet', 'scopeNote', 'scopeNodeIds', 'totalScore']
      .some((k) => (patch as Record<string, unknown>)[k] !== undefined);
    // Chữ ký nội dung (lát chống trùng của issue #233): patch chạm
    // một thành phần của chữ ký (tên, bộ mức, tổng điểm, ghi chú
    // phạm vi, phạm vi) hoặc CHUYỂN BANK (bank là một nửa của cặp
    // duy nhất) thì tính lại chữ ký từ trạng thái sau patch + ô hiện
    // tại và ghi trong CÙNG câu update — chữ ký không bao giờ lệch
    // nội dung đã lưu. Sửa chỉ đổi tỉ lệ mục tiêu/trạng thái/mẫu thì
    // chữ ký giữ nguyên vì các trường đó không thuộc chữ ký. Nội
    // dung sau sửa trùng toàn bộ với một ma trận khác trong cùng
    // bank (hoặc chuyển bank vào bank đã có nội dung này) thì ràng
    // buộc duy nhất chặn lại — dịch thành 409 tường minh ở cả hai
    // đường ghi dưới đây.
    const signatureChanged = ['name', 'levelSet', 'scopeNote', 'scopeNodeIds', 'totalScore', 'bankId']
      .some((k) => (patch as Record<string, unknown>)[k] !== undefined);
    if (signatureChanged) {
      const cells = await this.repo.listMatrixCells(row.id);
      patch.contentSignature = matrixContentSignature({
        name: patch.name ?? row.name,
        subjectId: row.subjectId,
        curriculumId: row.curriculumId,
        levelSet: patch.levelSet ?? row.levelSet,
        totalScore: patch.totalScore ?? row.totalScore,
        scopeNote: patch.scopeNote !== undefined ? patch.scopeNote : row.scopeNote,
        scopeNodeIds: patch.scopeNodeIds !== undefined ? patch.scopeNodeIds : row.scopeNodeIds,
        cells,
      });
    }
    if (contentChanged && row.status !== 'draft') {
      // Fork + áp patch trong MỘT transaction: hàng version mới
      // chụp cấu hình sau patch và mang toàn bộ ô (nội dung ô không
      // đổi ở đường sửa này); exam_matrices nhận patch làm bản hiện
      // hành đồng thời với số version mới do fork tăng (bước 3 của
      // forkMatrixVersion — không tăng tay ở đây nữa).
      const config = {
        presetKind: row.presetKind,
        targetFormPercents: patch.targetFormPercents !== undefined ? patch.targetFormPercents : row.targetFormPercents,
        targetLevelPercents: patch.targetLevelPercents !== undefined ? patch.targetLevelPercents : row.targetLevelPercents,
        levelSet: patch.levelSet !== undefined ? patch.levelSet : row.levelSet,
        scopeNote: patch.scopeNote !== undefined ? patch.scopeNote : row.scopeNote,
        scopeNodeIds: patch.scopeNodeIds !== undefined ? patch.scopeNodeIds : row.scopeNodeIds,
        totalScore: patch.totalScore !== undefined ? patch.totalScore : row.totalScore,
      };
      try {
        await this.repo.dbHandle.transaction(async (tx) => {
          await this.forkMatrixVersion(row, actorId, config, tx);
          if (Object.keys(patch).length) await this.repo.updateMatrix(row.id, patch, tx);
        });
      } catch (err) {
        this.rethrowAsDuplicateContentConflict(err);
      }
    } else if (Object.keys(patch).length) {
      try {
        await this.repo.updateMatrix(row.id, patch);
      } catch (err) {
        this.rethrowAsDuplicateContentConflict(err);
      }
    }
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'exam_matrix_updated', payload: { matrixId: row.id, actorId } });
    return this.matrixView(await this.shared.getMatrixRow(matrixId));
  }

  /**
   * Rút một ma trận khỏi ngân hàng (matrix:edit — ngang hàng
   * `withdrawPaper` của đề và `withdrawQuestion` của QB-3, issue
   * #228 lát S5): trạng thái về `hidden` KÈM truy vết bắt buộc —
   * lý do (DTO chặn rỗng), người rút, thời điểm. Hệ quả của
   * `hidden`: ma trận biến mất khỏi khám phá, không sinh đề mới /
   * đóng góp mới được; các version đề đã sinh từ ma trận và các
   * version ma trận đã ghim trong hồ sơ/đóng góp vẫn đọc lại
   * nguyên vẹn vì chúng là bản chụp bất biến. Ma trận đang `hidden`
   * rồi thì 409 — rút hai lần không có nghĩa.
   */
  async withdrawMatrix(actorId: string, matrixId: string, input: WithdrawExamMatrixDto): Promise<{ matrixId: string; status: string }> {
    const row = await this.shared.getMatrixRow(matrixId);
    await this.shared.requireMatrixCap(actorId, row, QUIZ_CAPABILITIES.manageMatrix);
    if (row.status === 'hidden') {
      throw new ConflictException({ message: 'Matrix is already withdrawn', code: 'quiz.matrix_already_withdrawn' });
    }
    await this.repo.updateMatrix(row.id, {
      status: 'hidden',
      withdrawnReason: input.reason,
      withdrawnBy: actorId,
      withdrawnAt: new Date(),
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'quiz', type: 'exam_matrix_withdrawn',
      payload: { matrixId: row.id, actorId, reason: input.reason },
    });
    return { matrixId: row.id, status: 'hidden' };
  }

  /**
   * Khôi phục một ma trận đã rút về `ready` và XOÁ truy vết lần
   * rút (ngang hàng khôi phục của đề/câu hỏi): ma trận hiện lại
   * trong khám phá và sinh đề/đóng góp được như trước. Ma trận
   * không ở trạng thái `hidden` thì 409.
   */
  async restoreMatrix(actorId: string, matrixId: string): Promise<{ matrixId: string; status: string }> {
    const row = await this.shared.getMatrixRow(matrixId);
    await this.shared.requireMatrixCap(actorId, row, QUIZ_CAPABILITIES.manageMatrix);
    if (row.status !== 'hidden') {
      throw new ConflictException({ message: 'Matrix is not withdrawn', code: 'quiz.matrix_not_withdrawn' });
    }
    await this.repo.updateMatrix(row.id, {
      status: 'ready', withdrawnReason: null, withdrawnBy: null, withdrawnAt: null,
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'quiz', type: 'exam_matrix_restored',
      payload: { matrixId: row.id, actorId },
    });
    return { matrixId: row.id, status: 'ready' };
  }

  /** Xoá ma trận (matrix:edit); đề đã sinh từ ma trận giữ nguyên, chỉ mất vết matrix_id (FK set null). */
  async deleteMatrix(actorId: string, matrixId: string): Promise<void> {
    const row = await this.shared.getMatrixRow(matrixId);
    await this.shared.requireMatrixCap(actorId, row, QUIZ_CAPABILITIES.manageMatrix);
    await this.repo.deleteMatrix(row.id);
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'exam_matrix_deleted', payload: { matrixId: row.id, actorId } });
  }

  /**
   * Phần cấu hình THUỘC VỀ NỘI DUNG của một ma trận — phần được chụp
   * vào hàng version bất biến (exam_matrix_versions). Tên/môn/chương
   * trình/bank/trạng thái là thuộc tính định danh và vòng đời của
   * chính thực thể ma trận nên KHÔNG version hoá: chúng chỉ sống trên
   * exam_matrices.
   */
  private matrixVersionConfigOf(source: {
    presetKind: string; targetFormPercents: Record<string, number> | null;
    targetLevelPercents: Record<string, number> | null; levelSet: string;
    scopeNote: string | null; scopeNodeIds: string[] | null; totalScore: number;
  }): {
    presetKind: string; targetFormPercents: Record<string, number> | null;
    targetLevelPercents: Record<string, number> | null; levelSet: string;
    scopeNote: string | null; scopeNodeIds: string[] | null; totalScore: number;
  } {
    return {
      presetKind: source.presetKind, targetFormPercents: source.targetFormPercents,
      targetLevelPercents: source.targetLevelPercents, levelSet: source.levelSet,
      scopeNote: source.scopeNote, scopeNodeIds: source.scopeNodeIds, totalScore: source.totalScore,
    };
  }

  /**
   * Hàng version bất biến của version HIỆN HÀNH của một ma trận;
   * chưa có thì tạo ngay từ cấu hình hiện tại trên exam_matrices.
   * Mọi đường tạo ma trận của service đều sinh hàng này ngay từ
   * version 1, nên nhánh tạo bù chỉ gặp ở dữ liệu dựng ngoài các
   * đường tạo đó — giữ để các đường ghi ô không bao giờ rơi vào
   * trạng thái "có ô mà không có version chứa ô".
   */
  private async ensureCurrentMatrixVersionRow(
    matrix: ExamMatrixRow, actorId: string, tx?: DbTx,
  ): Promise<ExamMatrixVersionRow> {
    const existing = await this.repo.getMatrixVersionRow(matrix.id, matrix.version, tx);
    if (existing) return existing;
    return this.repo.insertMatrixVersion({
      matrixId: matrix.id, version: matrix.version,
      ...this.matrixVersionConfigOf(matrix),
      createdBy: matrix.createdBy ?? actorId,
    }, tx);
  }

  /**
   * Sinh VERSION MỚI bất biến cho một ma trận đã rời draft khi nội
   * dung thay đổi (luật version hoá — thay cho cơ chế chỉ tăng số
   * version trước đây):
   *
   * 1. Chụp cấu hình nội dung MỚI vào hàng version (số = hiện hành
   *    + 1) — với sửa tầng ô, cấu hình mới chính là cấu hình hiện
   *    tại; với sửa tầng ma trận, là cấu hình sau patch.
   * 2. Sao TOÀN BỘ ô của version hiện hành sang version mới (danh
   *    tính ô mới, cùng khoá tự nhiên) — thao tác sửa ô sau đó chỉ
   *    đụng bản sao; version cũ giữ nguyên từng ô để bản đặc tả đã
   *    nộp và đề đã sinh đọc lại đúng nội dung tại thời điểm của
   *    chúng.
   * 3. Tăng exam_matrices.version lên số mới (các cột cấu hình trên
   *    exam_matrices vẫn là bản hiện hành do updateMatrix áp patch
   *    ngay sau fork trong cùng transaction).
   *
   * Chỉ gọi trong transaction do hàm bao mở. Ma trận còn draft KHÔNG
   * đi qua đây: draft sửa tại chỗ trên version đang mở (version chỉ
   * bắt đầu bất biến từ khi ma trận rời draft — cùng mốc mà luật cũ
   * bắt đầu tăng số version).
   */
  private async forkMatrixVersion(
    matrix: ExamMatrixRow, actorId: string,
    config: ReturnType<QuizMatricesService['matrixVersionConfigOf']>,
    tx: DbTx,
  ): Promise<ExamMatrixVersionRow> {
    const current = await this.ensureCurrentMatrixVersionRow(matrix, actorId, tx);
    const currentCells = await this.repo.listMatrixCellsByVersionId(current.id, tx);
    const next = await this.repo.insertMatrixVersion({
      matrixId: matrix.id, version: matrix.version + 1, ...config, createdBy: actorId,
    }, tx);
    for (const cell of currentCells) {
      await this.repo.insertMatrixCell({
        matrixId: matrix.id, matrixVersionId: next.id,
        curriculumNodeId: cell.curriculumNodeId, cognitiveLevel: cell.cognitiveLevel,
        qtype: cell.qtype, questionCount: cell.questionCount, cellScore: cell.cellScore,
        minutes: cell.minutes, tfScale: cell.tfScale, position: cell.position,
      }, tx);
    }
    await this.repo.updateMatrix(matrix.id, { version: matrix.version + 1 }, tx);
    return next;
  }

  private async getMatrixCellRow(matrix: ExamMatrixRow, cellId: string): Promise<ExamMatrixCellRow> {
    const row = await this.repo.getMatrixCell(cellId);
    if (!row || row.matrixId !== matrix.id) {
      throw new NotFoundException({ message: `Exam matrix cell ${cellId} not found`, code: 'quiz.matrix_cell_not_found' });
    }
    return row;
  }

  /**
   * Thêm ô vào ma trận (matrix:edit): ĐƠN VỊ KIẾN THỨC phải
   * thuộc chương trình của ma trận (ô neo ĐVK — issue #249, ma trận
   * không gắn YCCĐ), mức phải thuộc bộ mức của ma trận, và khi ma
   * trận có phạm vi đã dạy (scope_node_ids) thì ĐVK phải nằm trong
   * phạm vi.
   */
  async createMatrixCell(actorId: string, matrixId: string, input: CreateExamMatrixCellDto): Promise<ExamMatrixView> {
    const matrix = await this.shared.getMatrixRow(matrixId);
    await this.shared.requireMatrixCap(actorId, matrix, QUIZ_CAPABILITIES.manageMatrix);
    this.assertValidTfScale(input.tfScale);
    if (matrix.levelSet === 'three' && input.cognitiveLevel === 'van_dung_cao') {
      throw new BadRequestException({ message: 'van_dung_cao is not part of the three-level set of this matrix', code: 'quiz.matrix_level_not_in_set' });
    }
    if (matrix.scopeNodeIds && matrix.scopeNodeIds.length && !matrix.scopeNodeIds.includes(input.curriculumNodeId)) {
      throw new BadRequestException({ message: 'Curriculum node is outside the taught scope of this matrix', code: 'quiz.matrix_cell_out_of_scope' });
    }
    const node = await this.curriculum.getNode(actorId, input.curriculumNodeId);
    if (node.curriculumId !== matrix.curriculumId) {
      throw new BadRequestException({ message: 'Curriculum node does not belong to the curriculum of this matrix', code: 'quiz.matrix_cell_node_mismatch' });
    }
    const cells = await this.repo.listMatrixCells(matrix.id);
    if (cells.some((c) => c.curriculumNodeId === input.curriculumNodeId && c.cognitiveLevel === input.cognitiveLevel && c.qtype === input.qtype)) {
      throw new BadRequestException({ message: 'A cell already exists for this curriculum node, level and question type', code: 'quiz.matrix_cell_exists' });
    }
    const position = input.position ?? (cells.length ? Math.max(...cells.map((c) => c.position)) + 1 : 1);
    const cellValues = {
      matrixId: matrix.id, curriculumNodeId: input.curriculumNodeId,
      cognitiveLevel: input.cognitiveLevel, qtype: input.qtype,
      questionCount: input.questionCount, cellScore: input.cellScore,
      minutes: input.minutes ?? null, tfScale: input.tfScale ?? null, position,
    };
    // Ô là thành phần của chữ ký nội dung: ghi ô + tính lại chữ ký
    // chạy trong MỘT transaction ở cả hai đường dưới đây — nếu tập
    // ô sau ghi làm ma trận trùng toàn bộ với một ma trận khác
    // trong cùng bank, ràng buộc duy nhất (bank, chữ ký) huỷ cả
    // thao tác thay vì để lại ô đã ghi mà chữ ký không ghi được,
    // và lỗi được dịch thành 409 tường minh.
    try {
      if (matrix.status !== 'draft') {
        // Ma trận đã rời draft: ô mới thuộc về VERSION MỚI — fork
        // toàn bộ ô hiện hành sang version mới rồi mới thêm ô vào
        // bản sao, version cũ không thêm ô nào; chữ ký tính lại từ
        // tập ô của version mới trong cùng transaction.
        await this.repo.dbHandle.transaction(async (tx) => {
          const next = await this.forkMatrixVersion(matrix, actorId, this.matrixVersionConfigOf(matrix), tx);
          await this.repo.insertMatrixCell({ ...cellValues, matrixVersionId: next.id }, tx);
          await this.refreshMatrixContentSignature(matrix.id, tx);
        });
      } else {
        // Ma trận còn draft: ô ghi thẳng vào version đang mở, chữ
        // ký tính lại trong cùng transaction.
        await this.repo.dbHandle.transaction(async (tx) => {
          const current = await this.ensureCurrentMatrixVersionRow(matrix, actorId, tx);
          await this.repo.insertMatrixCell({ ...cellValues, matrixVersionId: current.id }, tx);
          await this.refreshMatrixContentSignature(matrix.id, tx);
        });
      }
    } catch (err) {
      this.rethrowAsDuplicateContentConflict(err);
    }
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'exam_matrix_cell_created', payload: { matrixId: matrix.id, actorId } });
    return this.matrixView(await this.shared.getMatrixRow(matrixId));
  }

  /** Sửa một ô (matrix:edit) — khoá ĐVK/mức/dạng không đổi qua sửa; muốn đổi thì xoá ô tạo lại. */
  async updateMatrixCell(actorId: string, matrixId: string, cellId: string, input: UpdateExamMatrixCellDto): Promise<ExamMatrixView> {
    const matrix = await this.shared.getMatrixRow(matrixId);
    await this.shared.requireMatrixCap(actorId, matrix, QUIZ_CAPABILITIES.manageMatrix);
    const cell = await this.getMatrixCellRow(matrix, cellId);
    this.assertValidTfScale(input.tfScale);
    const patch: Partial<ExamMatrixCellRow> = {};
    if (input.questionCount !== undefined) patch.questionCount = input.questionCount;
    if (input.cellScore !== undefined) patch.cellScore = input.cellScore;
    if (input.minutes !== undefined) patch.minutes = input.minutes;
    if (input.tfScale !== undefined) patch.tfScale = input.tfScale;
    if (input.position !== undefined) patch.position = input.position;
    if (Object.keys(patch).length) {
      // Chỉ số câu/điểm ô thuộc thành phần chữ ký nội dung: sửa
      // hai trường này thì tính lại chữ ký trong CÙNG transaction
      // với thao tác ghi (va chạm ràng buộc duy nhất huỷ cả thao
      // tác, dịch 409). Sửa phút/thang Đ–S/vị trí không đổi chữ ký
      // nên không tính lại — nhưng trên ma trận đã rời draft vẫn
      // phải fork version như mọi sửa ô (bản đặc tả khớp nội dung
      // tại version, không khớp theo trường).
      const touchesSignature = patch.questionCount !== undefined || patch.cellScore !== undefined;
      if (matrix.status !== 'draft') {
        // Sửa ô trên ma trận đã rời draft: fork sang version mới
        // rồi sửa BẢN SAO của ô (định vị theo khoá tự nhiên trong
        // version mới) — ô của version cũ giữ nguyên giá trị; fork
        // đã tăng số version trong cùng transaction.
        try {
          await this.repo.dbHandle.transaction(async (tx) => {
            const next = await this.forkMatrixVersion(matrix, actorId, this.matrixVersionConfigOf(matrix), tx);
            const copies = await this.repo.listMatrixCellsByVersionId(next.id, tx);
            const copy = copies.find((c) => c.curriculumNodeId === cell.curriculumNodeId
              && c.cognitiveLevel === cell.cognitiveLevel && c.qtype === cell.qtype);
            if (copy) await this.repo.updateMatrixCell(copy.id, patch, tx);
            if (touchesSignature) await this.refreshMatrixContentSignature(matrix.id, tx);
          });
        } catch (err) {
          this.rethrowAsDuplicateContentConflict(err);
        }
      } else if (touchesSignature) {
        try {
          await this.repo.dbHandle.transaction(async (tx) => {
            await this.repo.updateMatrixCell(cell.id, patch, tx);
            await this.refreshMatrixContentSignature(matrix.id, tx);
          });
        } catch (err) {
          this.rethrowAsDuplicateContentConflict(err);
        }
      } else {
        await this.repo.updateMatrixCell(cell.id, patch);
      }
    }
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'exam_matrix_cell_updated', payload: { matrixId: matrix.id, cellId: cell.id, actorId } });
    return this.matrixView(await this.shared.getMatrixRow(matrixId));
  }

  /** Xoá một ô khỏi ma trận (matrix:edit). */
  async deleteMatrixCell(actorId: string, matrixId: string, cellId: string): Promise<ExamMatrixView> {
    const matrix = await this.shared.getMatrixRow(matrixId);
    await this.shared.requireMatrixCap(actorId, matrix, QUIZ_CAPABILITIES.manageMatrix);
    const cell = await this.getMatrixCellRow(matrix, cellId);
    // Xoá ô đổi tập ô của chữ ký nội dung: xoá + tính lại chữ ký
    // trong MỘT transaction ở cả hai đường, cùng lý do nguyên tử
    // như thêm ô (xem createMatrixCell).
    try {
      if (matrix.status !== 'draft') {
        // Xoá ô trên ma trận đã rời draft: fork sang version mới
        // rồi xoá BẢN SAO của ô trong version mới — version cũ vẫn
        // còn ô; chữ ký tính lại từ tập ô của version mới trong
        // cùng transaction.
        await this.repo.dbHandle.transaction(async (tx) => {
          const next = await this.forkMatrixVersion(matrix, actorId, this.matrixVersionConfigOf(matrix), tx);
          const copies = await this.repo.listMatrixCellsByVersionId(next.id, tx);
          const copy = copies.find((c) => c.curriculumNodeId === cell.curriculumNodeId
            && c.cognitiveLevel === cell.cognitiveLevel && c.qtype === cell.qtype);
          if (copy) await this.repo.deleteMatrixCell(copy.id, tx);
          await this.refreshMatrixContentSignature(matrix.id, tx);
        });
      } else {
        await this.repo.dbHandle.transaction(async (tx) => {
          await this.repo.deleteMatrixCell(cell.id, tx);
          await this.refreshMatrixContentSignature(matrix.id, tx);
        });
      }
    } catch (err) {
      this.rethrowAsDuplicateContentConflict(err);
    }
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'exam_matrix_cell_deleted', payload: { matrixId: matrix.id, cellId: cell.id, actorId } });
    return this.matrixView(await this.shared.getMatrixRow(matrixId));
  }

  // Signature giữ dạng Pick 3 trường như phía main (không lấy dạng
  // hàng đầy đủ của P5): đường importAvailability (lát I-1) gọi hàm
  // này bằng ô DỰ THẢO chưa có bản ghi DB, trong khi thân hàm chỉ
  // chuyển tiếp cell sang cellCandidatesForUser (cũng chỉ cần 3
  // trường này) — siết thành hàng đầy đủ sẽ phá đường I-1 mà không
  // đổi hành vi nào. Việc bỏ chùm của P5 (xoá tfClustersOf) giữ nguyên.
  private async cellAvailableCount(actorId: string, cell: Pick<ExamMatrixCellRow, 'curriculumNodeId' | 'cognitiveLevel' | 'qtype'>): Promise<number> {
    const candidates = await this.shared.cellCandidatesForUser(actorId, cell);
    return candidates.length;
  }

  /**
   * Khả dụng ngân hàng theo từng ô cho người gọi (matrix:use):
   * cần / có / thiếu. Generate khoá cứng khi bất kỳ ô nào thiếu.
   */
  async matrixAvailability(actorId: string, matrixId: string): Promise<{ matrixId: string; cells: MatrixCellAvailability[]; sufficient: boolean }> {
    const matrix = await this.shared.getMatrixRow(matrixId);
    await this.shared.requireMatrixCap(actorId, matrix, QUIZ_CAPABILITIES.viewMatrix);
    const cells = await this.repo.listMatrixCells(matrix.id);
    const out: MatrixCellAvailability[] = [];
    for (const cell of cells) {
      const available = await this.cellAvailableCount(actorId, cell);
      out.push({ cellId: cell.id, required: cell.questionCount, available, deficit: Math.max(0, cell.questionCount - available) });
    }
    return { matrixId: matrix.id, cells: out, sufficient: out.every((c) => c.deficit === 0) };
  }

  /**
   * Khả dụng ngân hàng cho các ô DỰ THẢO của đường nhập ma trận từ
   * file (lát I-1, issue #233): ô chưa có bản ghi DB nên không có
   * cellId — kết quả neo theo bộ ba (ĐVK, mức, dạng) của ô dự thảo.
   * Cùng một cơ chế đếm ứng viên với {@link matrixAvailability} (câu
   * ready gắn bất kỳ YCCĐ nào thuộc ĐVK ở đúng mức, lọc theo quyền
   * dùng ngân hàng của người gọi; Đúng–Sai đếm theo chùm).
   */
  async importAvailability(actorId: string, cells: { curriculumNodeId: string; cognitiveLevel: string; qtype: string; questionCount: number }[]): Promise<MatrixImportCellAvailability[]> {
    const out: MatrixImportCellAvailability[] = [];
    for (const cell of cells) {
      const available = await this.cellAvailableCount(actorId, cell);
      out.push({
        curriculumNodeId: cell.curriculumNodeId,
        cognitiveLevel: cell.cognitiveLevel as MatrixImportCellAvailability['cognitiveLevel'],
        qtype: cell.qtype as MatrixImportCellAvailability['qtype'],
        required: cell.questionCount, available, deficit: Math.max(0, cell.questionCount - available),
      });
    }
    return out;
  }
}

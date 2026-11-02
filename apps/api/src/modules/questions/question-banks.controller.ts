import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { QuestionBanksService } from './question-banks.service';
import { BANK_KINDS, type BankKind } from '@lms/db/repositories/question-banks';
import { MatrixBanksService } from '../quiz/matrix-banks.service';
import {
  approveMatrixContributionSchema, rejectMatrixContributionSchema,
  type ApproveMatrixContributionDto, type RejectMatrixContributionDto,
} from '../quiz/dto/quiz.dto';
import {
  approveContributionSchema, createContributionSchema, createQuestionBankSchema, rejectContributionSchema,
  type ApproveContributionDto, type CreateContributionDto, type CreateQuestionBankDto, type RejectContributionDto,
} from './dto/questions.dto';

@ApiTags('question-banks')
@Controller({ path: 'question-banks', version: '1' })
/**
 * API lớp BANK của feat Ngân hàng câu hỏi chung (issue #70): bank bốn
 * scope (QB-1) và hàng chờ đóng góp/duyệt vào bank chung (QB-4).
 *
 * Đây là controller sở hữu duy nhất của tiền tố `/question-banks`
 * (issue #343): bề mặt ma trận của bank (danh sách ma trận trong
 * bank + hàng chờ đóng góp ma trận, MB-1 của issue #111) trước đây
 * nằm ở một controller riêng của module quiz cùng khai tiền tố này,
 * đã chuyển về lớp này; các handler đó vẫn uỷ thác
 * `MatrixBanksService` của module quiz — chỉ lớp controller di
 * chuyển, tầng service không đổi.
 */
export class QuestionBanksController {
  constructor(
    private readonly banks: QuestionBanksService,
    private readonly matrixBanks: MatrixBanksService,
  ) {}

  @Post()
  /**
   * POST /question-banks — tạo bank (personal trả bank hiện hữu nếu đã có; team theo cohort; school/course có cổng capability riêng).
   */
  async create(@Body({ schema: createQuestionBankSchema }) dto: CreateQuestionBankDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.banks.createBank(actor.id, dto);
  }
  @Get()
  /**
   * GET /question-banks?kind= — các bank actor vào được theo loại món
   * (mặc định question; exam/matrix dùng cùng khuôn bank đa loại), kèm
   * capability của actor tại từng bank (bộ chuyển bank cho UI).
   */
  async list(@Query('kind') kind: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    const k: BankKind = (BANK_KINDS as readonly string[]).includes(kind ?? '') ? (kind as BankKind) : 'question';
    return this.banks.listBanks(actor.id, k);
  }
  @Get(':id')
  /**
   * GET /question-banks/:id — chi tiết một bank (404 khi không tồn tại, 403 khi không vào được).
   */
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.banks.getBank(actor.id, id);
  }
  @Post(':id/contributions')
  /**
   * POST /question-banks/:id/contributions — đề xuất đóng góp một câu vào bank đích (QB-4).
   */
  async propose(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: createContributionSchema }) dto: CreateContributionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.banks.proposeContribution(actor.id, id, dto);
  }
  @Get(':id/contributions')
  /**
   * GET /question-banks/:id/contributions?status= — hàng chờ đóng góp (người duyệt thấy tất cả; người khác chỉ thấy của mình).
   */
  async listContributions(@Param('id', { schema: uuidIdSchema }) id: string, @Query('status') status: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    return this.banks.listContributions(actor.id, id, status || undefined);
  }
  @Post(':id/contributions/:contributionId/approve')
  /**
   * POST /question-banks/:id/contributions/:contributionId/approve — duyệt đề xuất (QB-4): copy vào bank đích hoặc tạo version mới trên câu đích.
   */
  async approve(@Param('id', { schema: uuidIdSchema }) id: string, @Param('contributionId', { schema: uuidIdSchema }) contributionId: string, @Body({ schema: approveContributionSchema }) dto: ApproveContributionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.banks.approveContribution(actor.id, id, contributionId, dto);
  }
  @Post(':id/contributions/:contributionId/reject')
  /**
   * POST /question-banks/:id/contributions/:contributionId/reject — từ chối đề xuất, lý do bắt buộc.
   */
  async reject(@Param('id', { schema: uuidIdSchema }) id: string, @Param('contributionId', { schema: uuidIdSchema }) contributionId: string, @Body({ schema: rejectContributionSchema }) dto: RejectContributionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.banks.rejectContribution(actor.id, id, contributionId, dto.reason);
  }

  // --- Bề mặt ma trận của bank (MB-1, issue #111) ---------------------------
  // Các handler dưới đây trước đây nằm ở QuestionBankMatricesController
  // của module quiz cùng khai tiền tố `question-banks`; đã chuyển về
  // lớp này để tiền tố có đúng một controller sở hữu (issue #343).
  // Tầng service giữ nguyên: mọi handler vẫn uỷ thác
  // `MatrixBanksService`.

  @Get('matrix-contributions/mine')
  /**
   * GET /question-banks/matrix-contributions/mine — mọi đề xuất đóng
   * góp ma trận của chính người dùng (kết quả duyệt + lý do từ chối).
   */
  async myContributions(@CurrentUser() actor: AuthenticatedUser) {
    return this.matrixBanks.listMyContributions(actor.id);
  }

  @Get(':bankId/matrices')
  /**
   * GET /question-banks/:bankId/matrices — các ma trận trong bank
   * (ready thấy cho mọi thành viên; draft/hidden chỉ chủ/người quản lý).
   */
  async listMatrices(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.matrixBanks.listBankMatrices(actor.id, bankId);
  }

  @Get(':bankId/matrix-contributions')
  /**
   * GET /question-banks/:bankId/matrix-contributions?status= — hàng
   * chờ đóng góp của bank (người duyệt thấy tất cả, người gửi chỉ thấy
   * của mình).
   */
  async listMatrixContributions(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @Query('status') status: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    return this.matrixBanks.listContributions(actor.id, bankId, status);
  }

  @Post(':bankId/matrix-contributions/:contributionId/approve')
  /**
   * POST /question-banks/:bankId/matrix-contributions/:contributionId/approve
   * — duyệt đóng góp: copy sâu ma trận vào bank đích thành MẪU.
   */
  async approveMatrixContribution(
    @Param('bankId', { schema: uuidIdSchema }) bankId: string,
    @Param('contributionId', { schema: uuidIdSchema }) contributionId: string,
    @Body({ schema: approveMatrixContributionSchema }) _dto: ApproveMatrixContributionDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.matrixBanks.approveContribution(actor.id, bankId, contributionId);
  }

  @Post(':bankId/matrix-contributions/:contributionId/reject')
  /**
   * POST /question-banks/:bankId/matrix-contributions/:contributionId/reject
   * — từ chối đóng góp, lý do bắt buộc và hiện lại cho người gửi.
   */
  async rejectMatrixContribution(
    @Param('bankId', { schema: uuidIdSchema }) bankId: string,
    @Param('contributionId', { schema: uuidIdSchema }) contributionId: string,
    @Body({ schema: rejectMatrixContributionSchema }) dto: RejectMatrixContributionDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.matrixBanks.rejectContribution(actor.id, bankId, contributionId, dto);
  }
}

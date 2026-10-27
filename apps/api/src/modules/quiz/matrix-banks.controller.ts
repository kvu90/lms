import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import {
  approveMatrixContributionSchema, copyExamMatrixSchema, createMatrixContributionSchema, rejectMatrixContributionSchema,
  type ApproveMatrixContributionDto, type CopyExamMatrixDto, type CreateMatrixContributionDto, type RejectMatrixContributionDto,
} from './dto/quiz.dto';
import { MatrixBanksService } from './matrix-banks.service';

@ApiTags('quizzes')
@Controller({ path: 'exam-matrices', version: '1' })
/**
 * Lớp BANK trên ma trận (MB-1, issue #111): copy mẫu → ma trận làm việc
 * và đề xuất đóng góp vào bank chung. Các route CRUD ma trận/ô sống ở
 * ExamMatricesController (Chặng 3); ở đây chỉ có hai hành động bank
 * neo trên một ma trận cụ thể.
 */
export class ExamMatrixBankController {
  constructor(private readonly matrixBanks: MatrixBanksService) {}

  @Get(':id/attribution')
  /**
   * GET /exam-matrices/:id/attribution — dòng ghi công của ma trận
   * theo đúng khuôn attribution của câu hỏi: nguồn đã copy, tác giả
   * gốc, bank nguồn và hai bộ đếm dùng thật (lượt copy đi + số
   * version đề đã sinh từ ma trận). Cổng: quyền xem trên ma trận.
   */
  async attribution(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.matrixBanks.getAttribution(actor.id, id);
  }

  @Post(':id/copy')
  /**
   * POST /exam-matrices/:id/copy — copy sâu ma trận (kèm toàn bộ ô) về
   * bank đích; không gửi targetBankId thì về bank ma trận cá nhân của
   * người copy. Bản copy là ma trận LÀM VIỆC (draft, không phải mẫu),
   * derived_from_matrix_id trỏ về nguồn.
   */
  async copy(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: copyExamMatrixSchema }) dto: CopyExamMatrixDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.matrixBanks.copyMatrix(actor.id, id, dto);
  }

  @Post(':id/contributions')
  /**
   * POST /exam-matrices/:id/contributions — đề xuất đóng góp ma trận
   * ready này vào một bank ma trận dùng chung (hàng chờ duyệt QB-4).
   */
  async propose(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: createMatrixContributionSchema }) dto: CreateMatrixContributionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.matrixBanks.proposeContribution(actor.id, id, dto);
  }
}

@ApiTags('question-banks')
@Controller({ path: 'question-banks', version: '1' })
/**
 * Bề mặt ma trận của một bank (MB-1): danh sách ma trận trong bank và
 * hàng chờ đóng góp. Bank tự thân (tạo/liệt kê/chi tiết) sống ở
 * QuestionBanksController với bank_kind='matrix'.
 */
export class QuestionBankMatricesController {
  constructor(private readonly matrixBanks: MatrixBanksService) {}

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
  async listContributions(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @Query('status') status: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    return this.matrixBanks.listContributions(actor.id, bankId, status);
  }

  @Post(':bankId/matrix-contributions/:contributionId/approve')
  /**
   * POST /question-banks/:bankId/matrix-contributions/:contributionId/approve
   * — duyệt đóng góp: copy sâu ma trận vào bank đích thành MẪU.
   */
  async approve(
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
  async reject(
    @Param('bankId', { schema: uuidIdSchema }) bankId: string,
    @Param('contributionId', { schema: uuidIdSchema }) contributionId: string,
    @Body({ schema: rejectMatrixContributionSchema }) dto: RejectMatrixContributionDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.matrixBanks.rejectContribution(actor.id, bankId, contributionId, dto);
  }
}

import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { QuestionBanksService } from './question-banks.service';
import {
  approveContributionSchema, createContributionSchema, createQuestionBankSchema, rejectContributionSchema,
  type ApproveContributionDto, type CreateContributionDto, type CreateQuestionBankDto, type RejectContributionDto,
} from './dto/questions.dto';

@ApiTags('question-banks')
@Controller({ path: 'question-banks', version: '1' })
/**
 * API lớp BANK của feat Ngân hàng câu hỏi chung (issue #70): bank bốn
 * scope (QB-1) và hàng chờ đóng góp/duyệt vào bank chung (QB-4).
 */
export class QuestionBanksController {
  constructor(private readonly banks: QuestionBanksService) {}

  @Post()
  /**
   * POST /question-banks — tạo bank (personal trả bank hiện hữu nếu đã có; team theo cohort; school/course có cổng capability riêng).
   */
  async create(@Body({ schema: createQuestionBankSchema }) dto: CreateQuestionBankDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.banks.createBank(actor.id, dto);
  }
  @Get()
  /**
   * GET /question-banks — các bank actor vào được, kèm capability của actor tại từng bank (bộ chuyển bank cho UI).
   */
  async list(@CurrentUser() actor: AuthenticatedUser) {
    return this.banks.listBanks(actor.id);
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
}

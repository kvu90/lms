import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { ExamPapersService } from './exam-papers.service';
import {
  approveExamPaperContributionSchema, copyExamPaperSchema, createExamPaperContributionSchema,
  createExamPaperSchema, deployExamPaperSchema, rejectExamPaperContributionSchema,
  setExamPaperSlotsSchema, setExamPaperStatusSchema, updateExamPaperSchema,
  type ApproveExamPaperContributionDto, type CopyExamPaperDto, type CreateExamPaperContributionDto,
  type CreateExamPaperDto, type DeployExamPaperDto, type RejectExamPaperContributionDto,
  type SetExamPaperSlotsDto, type SetExamPaperStatusDto, type UpdateExamPaperDto,
} from './dto/exam-papers.dto';

@ApiTags('exam-papers')
@Controller({ path: 'exam-papers', version: '1' })
/**
 * API lớp Ngân hàng đề (feat issue #113, EB-1): thực thể ĐỀ snapshot
 * trong các bank `bank_kind='exam'` — soạn đề tự do, version hoá, copy
 * deep copy truy vết, đóng góp/duyệt khuôn QB-4 và triển khai vào
 * quiz ghim paper version. Mọi cổng quyền neo tại context của bank đề
 * (capability exam:*).
 */
export class ExamPapersController {
  constructor(private readonly papers: ExamPapersService) {}

  @Get('banks/:bankId/papers')
  /**
   * GET /exam-papers/banks/:bankId/papers — danh sách đề trong một bank đề (đề draft/hidden chỉ tác giả/người duyệt thấy).
   */
  async list(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.papers.listPapers(actor.id, bankId);
  }

  @Post('banks/:bankId/papers')
  /**
   * POST /exam-papers/banks/:bankId/papers — tạo đề snapshot mới (metadata + slots tuỳ chọn; slot ghim version ready mới nhất của câu).
   */
  async create(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @Body({ schema: createExamPaperSchema }) dto: CreateExamPaperDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.papers.createPaper(actor.id, bankId, dto);
  }

  @Get('banks/:bankId/contributions')
  /**
   * GET /exam-papers/banks/:bankId/contributions — hàng chờ đóng góp đề vào bank đích (người duyệt thấy tất cả; người khác chỉ thấy đề xuất của mình).
   */
  async listContributions(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.papers.listContributions(actor.id, bankId);
  }

  @Post('banks/:bankId/contributions')
  /**
   * POST /exam-papers/banks/:bankId/contributions — đề xuất đóng góp một đề ready vào bank đích (khuôn QB-4).
   */
  async propose(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @Body({ schema: createExamPaperContributionSchema }) dto: CreateExamPaperContributionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.papers.proposeContribution(actor.id, bankId, dto);
  }

  @Post('banks/:bankId/contributions/:contributionId/approve')
  /**
   * POST /exam-papers/banks/:bankId/contributions/:contributionId/approve — duyệt đề xuất: copy đề vào bank đích (deep copy + derived_from).
   */
  async approve(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @Param('contributionId', { schema: uuidIdSchema }) contributionId: string, @Body({ schema: approveExamPaperContributionSchema }) dto: ApproveExamPaperContributionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.papers.approveContribution(actor.id, bankId, contributionId, dto);
  }

  @Post('banks/:bankId/contributions/:contributionId/reject')
  /**
   * POST /exam-papers/banks/:bankId/contributions/:contributionId/reject — từ chối đề xuất, lý do bắt buộc.
   */
  async reject(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @Param('contributionId', { schema: uuidIdSchema }) contributionId: string, @Body({ schema: rejectExamPaperContributionSchema }) dto: RejectExamPaperContributionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.papers.rejectContribution(actor.id, bankId, contributionId, dto);
  }

  @Get(':id')
  /**
   * GET /exam-papers/:id — chi tiết đề: version hiện tại + slots đã ghim + truy vết nguồn gốc + khả năng của actor.
   */
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.papers.getPaper(actor.id, id);
  }

  @Patch(':id')
  /**
   * PATCH /exam-papers/:id — sửa metadata: tạo paper version mới (slots giữ nguyên); version cũ bất biến cho quiz đã ghim.
   */
  async update(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updateExamPaperSchema }) dto: UpdateExamPaperDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.papers.updatePaper(actor.id, id, dto);
  }

  @Put(':id/slots')
  /**
   * PUT /exam-papers/:id/slots — thay toàn bộ slots: tạo paper version mới với danh sách câu đã ghim version ready.
   */
  async setSlots(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: setExamPaperSlotsSchema }) dto: SetExamPaperSlotsDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.papers.setSlots(actor.id, id, dto);
  }

  @Post(':id/status')
  /**
   * POST /exam-papers/:id/status — đổi trạng thái vòng đời draft/ready/hidden (ready bắt buộc có slot; hidden không vỡ quiz đã triển khai).
   */
  async setStatus(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: setExamPaperStatusSchema }) dto: SetExamPaperStatusDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.papers.setStatus(actor.id, id, dto);
  }

  @Delete(':id')
  /**
   * DELETE /exam-papers/:id — xoá đề (quiz đã triển khai giữ slots đã chụp, paper_id tự về null).
   */
  async remove(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.papers.deletePaper(actor.id, id);
  }

  @Post(':id/copy')
  /**
   * POST /exam-papers/:id/copy — copy đề về bank đích (mặc định ngân hàng đề cá nhân): deep copy slots, derived_from + ghi công tác giả gốc.
   */
  async copy(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: copyExamPaperSchema }) dto: CopyExamPaperDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.papers.copyPaper(actor.id, id, dto);
  }

  @Post(':id/deploy')
  /**
   * POST /exam-papers/:id/deploy — triển khai đề ready vào một quiz: chụp slots sang quiz_slots và ghim paper version trên quiz.
   */
  async deploy(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: deployExamPaperSchema }) dto: DeployExamPaperDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.papers.deploy(actor.id, id, dto);
  }
}

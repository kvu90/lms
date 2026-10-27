import { BadRequestException, Body, Controller, Delete, Get, Header, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { ExamDossiersService } from './exam-dossiers.service';
import { ExamsService } from './exams.service';
import {
  approveExamContributionSchema, approveExamDossierSchema, copyExamSchema, createExamContributionSchema,
  createExamDossierSchema, createExamSchema, rejectExamContributionSchema, rejectExamDossierSchema,
  setExamSlotsSchema, setExamStatusSchema, swapExamSlotSchema, updateExamSchema,
  withdrawExamSchema,
  type ApproveExamContributionDto, type ApproveExamDossierDto, type CopyExamDto, type CreateExamContributionDto,
  type CreateExamDossierDto, type CreateExamDto, type RejectExamContributionDto, type RejectExamDossierDto,
  type SetExamSlotsDto, type SetExamStatusDto, type SwapExamSlotDto, type UpdateExamDto,
  type WithdrawExamDto,
} from './dto/exams.dto';

@ApiTags('exams')
@Controller({ path: 'exams', version: '1' })
/**
 * API lớp Ngân hàng đề (feat issue #113, EB-1; hợp nhất #226): thực
 * thể ĐỀ trong các bank `bank_kind='exam'` — soạn đề tự do, version
 * hoá, copy deep copy truy vết, đóng góp/duyệt khuôn QB-4 — cộng bề
 * mặt duyệt BỘ HỒ SƠ đề (EB-3, issue #165) ở nửa sau của lớp. Đây là
 * controller sở hữu duy nhất của tiền tố `/exams`: bề mặt hồ sơ đề
 * trước đây nằm ở một controller riêng cùng khai tiền tố này, đã gộp
 * về đây để mỗi tiền tố có đúng một chủ sở hữu (issue #343). Đường
 * `/exams` là canonical; alias `/exam-papers` của toàn bộ bề mặt này
 * nằm ở `ExamPapersAliasController` kèm interceptor deprecation.
 * Ghim đề vào khoá đi qua `/exam-pins` (xem ExamPinsController) —
 * không còn endpoint deploy riêng. Mọi cổng quyền neo tại context
 * của bank đề (capability exam:*).
 */
export class ExamsController {
  constructor(
    private readonly exams: ExamsService,
    private readonly dossiers: ExamDossiersService,
  ) {}

  @Get('banks/:bankId/exams')
  /**
   * GET /exams/banks/:bankId/exams — danh sách đề trong một bank đề (đề draft/hidden chỉ tác giả/người duyệt thấy).
   */
  async list(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.listPapers(actor.id, bankId);
  }

  @Post('banks/:bankId/exams')
  /**
   * POST /exams/banks/:bankId/exams — tạo đề snapshot mới (metadata + slots tuỳ chọn; slot ghim version ready mới nhất của câu).
   */
  async create(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @Body({ schema: createExamSchema }) dto: CreateExamDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.createPaper(actor.id, bankId, dto);
  }

  @Get('banks/:bankId/contributions')
  /**
   * GET /exams/banks/:bankId/contributions — hàng chờ đóng góp đề vào bank đích (người duyệt thấy tất cả; người khác chỉ thấy đề xuất của mình).
   */
  async listContributions(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.listContributions(actor.id, bankId);
  }

  @Post('banks/:bankId/contributions')
  /**
   * POST /exams/banks/:bankId/contributions — đề xuất đóng góp một đề ready vào bank đích (khuôn QB-4).
   */
  async propose(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @Body({ schema: createExamContributionSchema }) dto: CreateExamContributionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.proposeContribution(actor.id, bankId, dto);
  }

  @Post('banks/:bankId/contributions/:contributionId/approve')
  /**
   * POST /exams/banks/:bankId/contributions/:contributionId/approve — duyệt đề xuất: copy đề vào bank đích (deep copy + derived_from).
   */
  async approve(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @Param('contributionId', { schema: uuidIdSchema }) contributionId: string, @Body({ schema: approveExamContributionSchema }) dto: ApproveExamContributionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.approveContribution(actor.id, bankId, contributionId, dto);
  }

  @Post('banks/:bankId/contributions/:contributionId/reject')
  /**
   * POST /exams/banks/:bankId/contributions/:contributionId/reject — từ chối đề xuất, lý do bắt buộc.
   */
  async reject(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @Param('contributionId', { schema: uuidIdSchema }) contributionId: string, @Body({ schema: rejectExamContributionSchema }) dto: RejectExamContributionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.rejectContribution(actor.id, bankId, contributionId, dto);
  }

  @Post('banks/:bankId/contributions/:contributionId/board-approve')
  /**
   * POST /exams/banks/:bankId/contributions/:contributionId/board-approve — duyệt cấp 2 (ban giám hiệu, exam:moderate tại context hệ thống) cho đóng góp đang `pending_board`: mốc chốt, đề vào bank đích.
   */
  async boardApprove(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @Param('contributionId', { schema: uuidIdSchema }) contributionId: string, @Body({ schema: approveExamContributionSchema }) dto: ApproveExamContributionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.boardApproveContribution(actor.id, bankId, contributionId, dto);
  }

  @Post('banks/:bankId/contributions/:contributionId/board-reject')
  /**
   * POST /exams/banks/:bankId/contributions/:contributionId/board-reject — từ chối cấp 2 cho đóng góp đang `pending_board`, lý do bắt buộc.
   */
  async boardReject(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @Param('contributionId', { schema: uuidIdSchema }) contributionId: string, @Body({ schema: rejectExamContributionSchema }) dto: RejectExamContributionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.boardRejectContribution(actor.id, bankId, contributionId, dto);
  }

  @Get(':id')
  /**
   * GET /exams/:id — chi tiết đề: version hiện tại + slots đã ghim + truy vết nguồn gốc + khả năng của actor.
   */
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.getPaper(actor.id, id);
  }

  @Patch(':id')
  /**
   * PATCH /exams/:id — sửa metadata: tạo exam version mới (slots giữ nguyên); version cũ bất biến cho pin đã ghim.
   */
  async update(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updateExamSchema }) dto: UpdateExamDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.updatePaper(actor.id, id, dto);
  }

  @Put(':id/slots')
  /**
   * PUT /exams/:id/slots — thay toàn bộ slots: tạo exam version mới với danh sách câu đã ghim version ready.
   */
  async setSlots(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: setExamSlotsSchema }) dto: SetExamSlotsDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.setSlots(actor.id, id, dto);
  }

  @Post(':id/status')
  /**
   * POST /exams/:id/status — đổi trạng thái vòng đời draft/ready/hidden (ready bắt buộc có slot; hidden không vỡ pin đã ghim; đề đã rút chính thức không đổi ở đây — phải khôi phục trước).
   */
  async setStatus(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: setExamStatusSchema }) dto: SetExamStatusDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.setStatus(actor.id, id, dto);
  }

  @Post(':id/withdraw')
  /**
   * POST /exams/:id/withdraw — rút đề khỏi ngân hàng kèm lý do bắt buộc và truy vết người rút/thời điểm (ngang hàng rút câu hỏi QB-3); pin đã ghim vẫn phục vụ bình thường.
   */
  async withdraw(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: withdrawExamSchema }) dto: WithdrawExamDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.withdrawPaper(actor.id, id, dto);
  }

  @Post(':id/restore')
  /**
   * POST /exams/:id/restore — khôi phục đề đã rút về ready, xoá truy vết lần rút.
   */
  async restore(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.restorePaper(actor.id, id);
  }

  @Delete(':id')
  /**
   * DELETE /exams/:id — xoá đề (pin đã ghim giữ nguyên cấu hình tổ chức; exam version bị xoá theo cascade của pin khi pin bị xoá).
   */
  async remove(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.deletePaper(actor.id, id);
  }

  @Post(':id/copy')
  /**
   * POST /exams/:id/copy — copy đề về bank đích (mặc định ngân hàng đề cá nhân): deep copy slots, derived_from + ghi công tác giả gốc.
   */
  async copy(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: copyExamSchema }) dto: CopyExamDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.copyPaper(actor.id, id, dto);
  }

  @Post(':id/swap')
  /**
   * POST /exams/:id/swap — đổi câu của một slot snapshot bằng swap-cùng-ô (câu thay phải thuộc pool của ô nguồn của slot).
   */
  async swap(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: swapExamSlotSchema }) dto: SwapExamSlotDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.swapSlot(actor.id, id, dto);
  }

  @Get(':id/pins')
  /**
   * GET /exams/:id/pins — các lần ghim của đề (thay danh sách deployments cũ sau gộp Đề #226).
   */
  async pins(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.listPins(actor.id, id);
  }

  @Get(':id/specification')
  /**
   * GET /exams/:id/specification?pinId= — bản đặc tả neo theo ĐỀ (EB-3, E-6): sinh từ ma trận của exam version hiện tại + vị trí câu từ slots của chính đề; pinId (tuỳ chọn) chỉ ghi nhận lần tổ chức cụ thể.
   */
  async specification(@Param('id', { schema: uuidIdSchema }) id: string, @Query('pinId') pinId: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    if (pinId !== undefined && !uuidIdSchema.safeParse(pinId).success) {
      throw new BadRequestException({ message: 'pinId must be a uuid', code: 'quiz.spec_quiz_invalid' });
    }
    return this.exams.getPaperSpecification(actor.id, id, pinId);
  }

  @Get(':id/specification/export')
  @Header('content-disposition', 'attachment')
  /**
   * GET /exams/:id/specification/export?format=xlsx|docx&pinId= — xuất bản đặc tả theo đề ra file.
   */
  async exportSpecification(
    @Param('id', { schema: uuidIdSchema }) id: string,
    @Query('format') format: string | undefined,
    @Query('pinId') pinId: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
    @Res() res: Response,
  ) {
    if (pinId !== undefined && !uuidIdSchema.safeParse(pinId).success) {
      throw new BadRequestException({ message: 'pinId must be a uuid', code: 'quiz.spec_quiz_invalid' });
    }
    const file = await this.exams.exportPaperSpecification(actor.id, id, format ?? 'xlsx', pinId);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.buffer);
  }

  @Get(':id/print')
  @Header('Content-Type', 'text/html; charset=utf-8')
  /**
   * GET /exams/:id/print?pinId=&variantCode= — bản in HTML của đề theo một mã đề của một lần ghim (thứ tự câu hoán vị theo seed của mã; mã đề sống trên pin).
   */
  async print(@Param('id', { schema: uuidIdSchema }) id: string, @Query('pinId') pinId: string | undefined, @Query('variantCode') variantCode: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.printPaperHtml(actor.id, id, pinId ?? '', variantCode ?? '');
  }

  // --- Bề mặt duyệt BỘ HỒ SƠ đề (EB-3, issue #165) -------------------------
  // Các handler dưới đây trước đây nằm ở ExamDossiersController riêng
  // cùng khai tiền tố `exams`; đã gộp về lớp này để tiền tố `exams`
  // có đúng một controller sở hữu (issue #343). Mọi cổng quyền nằm ở
  // service: cấp 1 = exam:moderate tại context bank đích, cấp 2
  // (BGH) = exam:moderate tại context hệ thống.

  @Get('dossiers/mine')
  /**
   * GET /exams/dossiers/mine — mọi bộ hồ sơ của chính người dùng (theo dõi trạng thái + lý do từ chối xuyên bank).
   */
  async listMine(@CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.listMyDossiers(actor.id);
  }

  @Get('banks/:bankId/dossiers')
  /**
   * GET /exams/banks/:bankId/dossiers — hàng chờ bộ hồ sơ của một bank đích (người duyệt thấy tất cả; người khác chỉ thấy bộ của mình).
   */
  async listBankDossiers(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.listBankDossiers(actor.id, bankId);
  }

  @Get('dossiers/:dossierId')
  /**
   * GET /exams/dossiers/:dossierId — chi tiết một bộ hồ sơ kèm vết duyệt từng cấp.
   */
  async getDossier(@Param('dossierId', { schema: uuidIdSchema }) dossierId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.getDossier(actor.id, dossierId);
  }

  @Get('dossiers/:dossierId/specification')
  /**
   * GET /exams/dossiers/:dossierId/specification — bản đặc tả ĐÃ CHỤP tại lúc nộp (tổ trưởng mở ngay trong hàng chờ; lần mở của người duyệt ghi audit).
   */
  async getDossierSpecification(@Param('dossierId', { schema: uuidIdSchema }) dossierId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.getDossierSpecification(actor.id, dossierId);
  }

  @Get('dossiers/:dossierId/specification/export')
  @Header('content-disposition', 'attachment')
  /**
   * GET /exams/dossiers/:dossierId/specification/export?format=xlsx|docx — xuất bản đặc tả đã chụp của bộ hồ sơ.
   */
  async exportDossierSpecification(
    @Param('dossierId', { schema: uuidIdSchema }) dossierId: string,
    @Query('format') format: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
    @Res() res: Response,
  ) {
    const file = await this.dossiers.exportDossierSpecification(actor.id, dossierId, format ?? 'xlsx');
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.buffer);
  }

  @Post('dossiers/:dossierId/submit')
  /**
   * POST /exams/dossiers/:dossierId/submit — nộp bộ hồ sơ: ghim phiên bản đề/ma trận + chụp bản đặc tả tại thời điểm nộp.
   */
  async submitDossier(@Param('dossierId', { schema: uuidIdSchema }) dossierId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.submitDossier(actor.id, dossierId);
  }

  @Delete('dossiers/:dossierId')
  /**
   * DELETE /exams/dossiers/:dossierId — xoá bộ hồ sơ NHÁP (chưa nộp).
   */
  async deleteDossier(@Param('dossierId', { schema: uuidIdSchema }) dossierId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.deleteDossier(actor.id, dossierId);
  }

  @Post('dossiers/:dossierId/approve')
  /**
   * POST /exams/dossiers/:dossierId/approve — duyệt cấp 1 (tổ trưởng/moderate bank đích; khi bật cấp 2 thì đây chỉ là mốc trung gian sang pending_board).
   */
  async approveDossier(@Param('dossierId', { schema: uuidIdSchema }) dossierId: string, @Body({ schema: approveExamDossierSchema }) _dto: ApproveExamDossierDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.approveDossier(actor.id, dossierId);
  }

  @Post('dossiers/:dossierId/reject')
  /**
   * POST /exams/dossiers/:dossierId/reject — từ chối cấp 1, lý do bắt buộc.
   */
  async rejectDossier(@Param('dossierId', { schema: uuidIdSchema }) dossierId: string, @Body({ schema: rejectExamDossierSchema }) dto: RejectExamDossierDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.rejectDossier(actor.id, dossierId, dto);
  }

  @Post('dossiers/:dossierId/board-approve')
  /**
   * POST /exams/dossiers/:dossierId/board-approve — duyệt cấp 2 (ban giám hiệu): mốc chốt, đề vào bank đích.
   */
  async boardApproveDossier(@Param('dossierId', { schema: uuidIdSchema }) dossierId: string, @Body({ schema: approveExamDossierSchema }) _dto: ApproveExamDossierDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.boardApproveDossier(actor.id, dossierId);
  }

  @Post('dossiers/:dossierId/board-reject')
  /**
   * POST /exams/dossiers/:dossierId/board-reject — từ chối cấp 2 (ban giám hiệu), lý do bắt buộc.
   */
  async boardRejectDossier(@Param('dossierId', { schema: uuidIdSchema }) dossierId: string, @Body({ schema: rejectExamDossierSchema }) dto: RejectExamDossierDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.boardRejectDossier(actor.id, dossierId, dto);
  }

  @Post(':id/dossiers')
  /**
   * POST /exams/:id/dossiers — lập bộ hồ sơ (nháp) cho một đề vào bank đích dùng chung.
   */
  async createDossier(@Param('id', { schema: uuidIdSchema }) paperId: string, @Body({ schema: createExamDossierSchema }) dto: CreateExamDossierDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.createDossier(actor.id, paperId, dto);
  }
}

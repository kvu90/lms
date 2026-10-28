import { BadRequestException, Body, Controller, Delete, Get, Header, Param, Patch, Post, Put, Query, Res, UseInterceptors } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { DeprecatedRouteAliasInterceptor } from '../../common/deprecated-route-alias.interceptor';
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

/**
 * Controller alias giữ toàn bộ bề mặt `/exam-papers` chạy song song
 * với bề mặt canonical `/exams` của cụm đề (issue #343).
 *
 * @remarks
 * Chính sách alias: mọi handler trong file này là handler mỏng uỷ
 * thác đúng các method của `ExamsService`/`ExamDossiersService` như
 * handler canonical tương ứng trong `ExamsController` — cùng schema
 * kiểm chứng, cùng logic nghiệp vụ, cùng kết quả trả về; chỉ khác
 * tiền tố path. Đây là khai báo alias duy nhất của tiền tố
 * `exam-papers`: trước đây hai controller nghiệp vụ của module exams
 * cùng khai mảng cặp `['exams', 'exam-papers']`, nay tiền tố
 * canonical `exams` chỉ còn một controller sở hữu và toàn bộ bề mặt
 * alias gom về lớp này.
 *
 * Mỗi lượt gọi qua alias đều đi qua
 * `DeprecatedRouteAliasInterceptor` — interceptor alias dùng chung ở
 * `common/`, mang bảng alias của bề mặt `exam-papers`: response mang header
 * `Deprecation: true` và `Sunset: Sun, 01 Feb 2027 00:00:00 GMT`, và
 * hệ thống ghi một bản ghi log có cấu trúc cho lượt gọi đó (sự kiện
 * `deprecated_route_alias`, kèm method, mẫu alias, mẫu canonical và
 * path cụ thể).
 *
 * Điều kiện gỡ alias: log có cấu trúc của các lượt gọi alias là căn
 * cứ chính — khi log ghi nhận 0 lượt gọi alias trong 14 ngày thì
 * alias đủ điều kiện gỡ. Header Sunset chỉ là hạn ngoài thông báo
 * cho client, không phải căn cứ tự động gỡ alias khi tới hạn mà log
 * vẫn còn lượt gọi.
 *
 * Tên method của mọi handler alias đều mang tiền tố `alias` và mỗi
 * handler khai `operationId` riêng qua `@ApiOperation`: controller
 * alias dùng chung tag `exams` với controller canonical, nếu trùng
 * tên method thì Swagger không sinh được operationId phân biệt cho
 * hai operation cùng tên và lỗi tại bước tạo tài liệu OpenAPI.
 */
@ApiTags('exams')
@Controller({ path: 'exam-papers', version: '1' })
@UseInterceptors(DeprecatedRouteAliasInterceptor)
/**
 * Alias `/exam-papers` của toàn bộ bề mặt `/exams` (đề + đóng góp +
 * bộ hồ sơ đề). Handler canonical tương ứng nằm ở `ExamsController`.
 */
export class ExamPapersAliasController {
  constructor(
    private readonly exams: ExamsService,
    private readonly dossiers: ExamDossiersService,
  ) {}

  @Get('banks/:bankId/exams')
  /**
   * GET /exam-papers/banks/:bankId/exams — alias của GET /exams/banks/:bankId/exams: danh sách đề trong một bank đề.
   */
  @ApiOperation({ operationId: 'examPapersAliasList' })
  async aliasList(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.listPapers(actor.id, bankId);
  }

  @Post('banks/:bankId/exams')
  /**
   * POST /exam-papers/banks/:bankId/exams — alias của POST /exams/banks/:bankId/exams: tạo đề snapshot mới.
   */
  @ApiOperation({ operationId: 'examPapersAliasCreate' })
  async aliasCreate(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @Body({ schema: createExamSchema }) dto: CreateExamDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.createPaper(actor.id, bankId, dto);
  }

  @Get('banks/:bankId/contributions')
  /**
   * GET /exam-papers/banks/:bankId/contributions — alias của GET /exams/banks/:bankId/contributions: hàng chờ đóng góp đề vào bank đích.
   */
  @ApiOperation({ operationId: 'examPapersAliasListContributions' })
  async aliasListContributions(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.listContributions(actor.id, bankId);
  }

  @Post('banks/:bankId/contributions')
  /**
   * POST /exam-papers/banks/:bankId/contributions — alias của POST /exams/banks/:bankId/contributions: đề xuất đóng góp một đề ready vào bank đích.
   */
  @ApiOperation({ operationId: 'examPapersAliasPropose' })
  async aliasPropose(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @Body({ schema: createExamContributionSchema }) dto: CreateExamContributionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.proposeContribution(actor.id, bankId, dto);
  }

  @Post('banks/:bankId/contributions/:contributionId/approve')
  /**
   * POST /exam-papers/banks/:bankId/contributions/:contributionId/approve — alias của POST /exams/banks/:bankId/contributions/:contributionId/approve: duyệt đề xuất đóng góp.
   */
  @ApiOperation({ operationId: 'examPapersAliasApprove' })
  async aliasApprove(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @Param('contributionId', { schema: uuidIdSchema }) contributionId: string, @Body({ schema: approveExamContributionSchema }) dto: ApproveExamContributionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.approveContribution(actor.id, bankId, contributionId, dto);
  }

  @Post('banks/:bankId/contributions/:contributionId/reject')
  /**
   * POST /exam-papers/banks/:bankId/contributions/:contributionId/reject — alias của POST /exams/banks/:bankId/contributions/:contributionId/reject: từ chối đề xuất, lý do bắt buộc.
   */
  @ApiOperation({ operationId: 'examPapersAliasReject' })
  async aliasReject(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @Param('contributionId', { schema: uuidIdSchema }) contributionId: string, @Body({ schema: rejectExamContributionSchema }) dto: RejectExamContributionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.rejectContribution(actor.id, bankId, contributionId, dto);
  }

  @Post('banks/:bankId/contributions/:contributionId/board-approve')
  /**
   * POST /exam-papers/banks/:bankId/contributions/:contributionId/board-approve — alias của POST /exams/banks/:bankId/contributions/:contributionId/approve (đường `board-*` phía `/exams` nay cũng chỉ còn là alias đã deprecated của `approve` theo issue #345): duyệt cấp 2 cho đóng góp đang `pending_board`.
   */
  @ApiOperation({ operationId: 'examPapersAliasBoardApprove' })
  async aliasBoardApprove(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @Param('contributionId', { schema: uuidIdSchema }) contributionId: string, @Body({ schema: approveExamContributionSchema }) dto: ApproveExamContributionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.boardApproveContribution(actor.id, bankId, contributionId, dto);
  }

  @Post('banks/:bankId/contributions/:contributionId/board-reject')
  /**
   * POST /exam-papers/banks/:bankId/contributions/:contributionId/board-reject — alias của POST /exams/banks/:bankId/contributions/:contributionId/reject (đường `board-*` phía `/exams` nay cũng chỉ còn là alias đã deprecated của `reject` theo issue #345): từ chối cấp 2 cho đóng góp đang `pending_board`.
   */
  @ApiOperation({ operationId: 'examPapersAliasBoardReject' })
  async aliasBoardReject(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @Param('contributionId', { schema: uuidIdSchema }) contributionId: string, @Body({ schema: rejectExamContributionSchema }) dto: RejectExamContributionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.boardRejectContribution(actor.id, bankId, contributionId, dto);
  }

  @Get(':id')
  /**
   * GET /exam-papers/:id — alias của GET /exams/:id: chi tiết đề.
   */
  @ApiOperation({ operationId: 'examPapersAliasGet' })
  async aliasGet(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.getPaper(actor.id, id);
  }

  @Patch(':id')
  /**
   * PATCH /exam-papers/:id — alias của PATCH /exams/:id: sửa metadata đề (tạo exam version mới).
   */
  @ApiOperation({ operationId: 'examPapersAliasUpdate' })
  async aliasUpdate(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updateExamSchema }) dto: UpdateExamDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.updatePaper(actor.id, id, dto);
  }

  @Put(':id/slots')
  /**
   * PUT /exam-papers/:id/slots — alias của PUT /exams/:id/slots: thay toàn bộ slots của đề.
   */
  @ApiOperation({ operationId: 'examPapersAliasSetSlots' })
  async aliasSetSlots(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: setExamSlotsSchema }) dto: SetExamSlotsDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.setSlots(actor.id, id, dto);
  }

  @Post(':id/status')
  /**
   * POST /exam-papers/:id/status — alias của POST /exams/:id/status: đổi trạng thái vòng đời của đề.
   */
  @ApiOperation({ operationId: 'examPapersAliasSetStatus' })
  async aliasSetStatus(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: setExamStatusSchema }) dto: SetExamStatusDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.setStatus(actor.id, id, dto);
  }

  @Post(':id/withdraw')
  /**
   * POST /exam-papers/:id/withdraw — alias của POST /exams/:id/withdraw: rút đề khỏi ngân hàng kèm lý do bắt buộc.
   */
  @ApiOperation({ operationId: 'examPapersAliasWithdraw' })
  async aliasWithdraw(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: withdrawExamSchema }) dto: WithdrawExamDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.withdrawPaper(actor.id, id, dto);
  }

  @Post(':id/restore')
  /**
   * POST /exam-papers/:id/restore — alias của POST /exams/:id/restore: khôi phục đề đã rút về ready.
   */
  @ApiOperation({ operationId: 'examPapersAliasRestore' })
  async aliasRestore(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.restorePaper(actor.id, id);
  }

  @Delete(':id')
  /**
   * DELETE /exam-papers/:id — alias của DELETE /exams/:id: xoá đề.
   */
  @ApiOperation({ operationId: 'examPapersAliasRemove' })
  async aliasRemove(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.deletePaper(actor.id, id);
  }

  @Post(':id/copy')
  /**
   * POST /exam-papers/:id/copy — alias của POST /exams/:id/copy: copy đề về bank đích.
   */
  @ApiOperation({ operationId: 'examPapersAliasCopy' })
  async aliasCopy(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: copyExamSchema }) dto: CopyExamDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.copyPaper(actor.id, id, dto);
  }

  @Post(':id/swap')
  /**
   * POST /exam-papers/:id/swap — alias của POST /exams/:id/swap: đổi câu của một slot snapshot bằng swap-cùng-ô.
   */
  @ApiOperation({ operationId: 'examPapersAliasSwap' })
  async aliasSwap(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: swapExamSlotSchema }) dto: SwapExamSlotDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.swapSlot(actor.id, id, dto);
  }

  @Get(':id/pins')
  /**
   * GET /exam-papers/:id/pins — alias của GET /exams/:id/pins: các lần ghim của đề.
   */
  @ApiOperation({ operationId: 'examPapersAliasPins' })
  async aliasPins(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.listPins(actor.id, id);
  }

  @Get(':id/specification')
  /**
   * GET /exam-papers/:id/specification?pinId= — alias của GET /exams/:id/specification: bản đặc tả neo theo đề.
   */
  @ApiOperation({ operationId: 'examPapersAliasSpecification' })
  async aliasSpecification(@Param('id', { schema: uuidIdSchema }) id: string, @Query('pinId') pinId: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    if (pinId !== undefined && !uuidIdSchema.safeParse(pinId).success) {
      throw new BadRequestException({ message: 'pinId must be a uuid', code: 'quiz.spec_quiz_invalid' });
    }
    return this.exams.getPaperSpecification(actor.id, id, pinId);
  }

  @Get(':id/specification/export')
  @Header('content-disposition', 'attachment')
  /**
   * GET /exam-papers/:id/specification/export?format=xlsx|docx&pinId= — alias của GET /exams/:id/specification/export: xuất bản đặc tả theo đề ra file.
   */
  @ApiOperation({ operationId: 'examPapersAliasExportSpecification' })
  async aliasExportSpecification(
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
   * GET /exam-papers/:id/print?pinId=&variantCode= — alias của GET /exams/:id/print: bản in HTML của đề theo một mã đề của một lần ghim.
   */
  @ApiOperation({ operationId: 'examPapersAliasPrint' })
  async aliasPrint(@Param('id', { schema: uuidIdSchema }) id: string, @Query('pinId') pinId: string | undefined, @Query('variantCode') variantCode: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.printPaperHtml(actor.id, id, pinId ?? '', variantCode ?? '');
  }

  @Get('dossiers/mine')
  /**
   * GET /exam-papers/dossiers/mine — alias của GET /exams/dossiers/mine: mọi bộ hồ sơ của chính người dùng.
   */
  @ApiOperation({ operationId: 'examPapersAliasListMine' })
  async aliasListMine(@CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.listMyDossiers(actor.id);
  }

  @Get('banks/:bankId/dossiers')
  /**
   * GET /exam-papers/banks/:bankId/dossiers — alias của GET /exams/banks/:bankId/dossiers: hàng chờ bộ hồ sơ của một bank đích.
   */
  @ApiOperation({ operationId: 'examPapersAliasListBankDossiers' })
  async aliasListBankDossiers(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.listBankDossiers(actor.id, bankId);
  }

  @Get('dossiers/:dossierId')
  /**
   * GET /exam-papers/dossiers/:dossierId — alias của GET /exams/dossiers/:dossierId: chi tiết một bộ hồ sơ kèm vết duyệt từng cấp.
   */
  @ApiOperation({ operationId: 'examPapersAliasGetDossier' })
  async aliasGetDossier(@Param('dossierId', { schema: uuidIdSchema }) dossierId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.getDossier(actor.id, dossierId);
  }

  @Get('dossiers/:dossierId/specification')
  /**
   * GET /exam-papers/dossiers/:dossierId/specification — alias của GET /exams/dossiers/:dossierId/specification: bản đặc tả đã chụp tại lúc nộp.
   */
  @ApiOperation({ operationId: 'examPapersAliasGetDossierSpecification' })
  async aliasGetDossierSpecification(@Param('dossierId', { schema: uuidIdSchema }) dossierId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.getDossierSpecification(actor.id, dossierId);
  }

  @Get('dossiers/:dossierId/specification/export')
  @Header('content-disposition', 'attachment')
  /**
   * GET /exam-papers/dossiers/:dossierId/specification/export?format=xlsx|docx — alias của GET /exams/dossiers/:dossierId/specification/export: xuất bản đặc tả đã chụp của bộ hồ sơ.
   */
  @ApiOperation({ operationId: 'examPapersAliasExportDossierSpecification' })
  async aliasExportDossierSpecification(
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
   * POST /exam-papers/dossiers/:dossierId/submit — alias của POST /exams/dossiers/:dossierId/submit: nộp bộ hồ sơ.
   */
  @ApiOperation({ operationId: 'examPapersAliasSubmitDossier' })
  async aliasSubmitDossier(@Param('dossierId', { schema: uuidIdSchema }) dossierId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.submitDossier(actor.id, dossierId);
  }

  @Delete('dossiers/:dossierId')
  /**
   * DELETE /exam-papers/dossiers/:dossierId — alias của DELETE /exams/dossiers/:dossierId: xoá bộ hồ sơ nháp.
   */
  @ApiOperation({ operationId: 'examPapersAliasDeleteDossier' })
  async aliasDeleteDossier(@Param('dossierId', { schema: uuidIdSchema }) dossierId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.deleteDossier(actor.id, dossierId);
  }

  @Post('dossiers/:dossierId/approve')
  /**
   * POST /exam-papers/dossiers/:dossierId/approve — alias của POST /exams/dossiers/:dossierId/approve: duyệt cấp 1 bộ hồ sơ.
   */
  @ApiOperation({ operationId: 'examPapersAliasApproveDossier' })
  async aliasApproveDossier(@Param('dossierId', { schema: uuidIdSchema }) dossierId: string, @Body({ schema: approveExamDossierSchema }) _dto: ApproveExamDossierDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.approveDossier(actor.id, dossierId);
  }

  @Post('dossiers/:dossierId/reject')
  /**
   * POST /exam-papers/dossiers/:dossierId/reject — alias của POST /exams/dossiers/:dossierId/reject: từ chối cấp 1 bộ hồ sơ, lý do bắt buộc.
   */
  @ApiOperation({ operationId: 'examPapersAliasRejectDossier' })
  async aliasRejectDossier(@Param('dossierId', { schema: uuidIdSchema }) dossierId: string, @Body({ schema: rejectExamDossierSchema }) dto: RejectExamDossierDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.rejectDossier(actor.id, dossierId, dto);
  }

  @Post('dossiers/:dossierId/board-approve')
  /**
   * POST /exam-papers/dossiers/:dossierId/board-approve — alias của POST /exams/dossiers/:dossierId/approve (đường `board-*` phía `/exams` nay cũng chỉ còn là alias đã deprecated của `approve` theo issue #345): duyệt cấp 2 bộ hồ sơ — đường ghi hồ sơ đã đóng nên vẫn trả 410.
   */
  @ApiOperation({ operationId: 'examPapersAliasBoardApproveDossier' })
  async aliasBoardApproveDossier(@Param('dossierId', { schema: uuidIdSchema }) dossierId: string, @Body({ schema: approveExamDossierSchema }) _dto: ApproveExamDossierDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.boardApproveDossier(actor.id, dossierId);
  }

  @Post('dossiers/:dossierId/board-reject')
  /**
   * POST /exam-papers/dossiers/:dossierId/board-reject — alias của POST /exams/dossiers/:dossierId/reject (đường `board-*` phía `/exams` nay cũng chỉ còn là alias đã deprecated của `reject` theo issue #345): từ chối cấp 2 bộ hồ sơ, lý do bắt buộc — đường ghi hồ sơ đã đóng nên vẫn trả 410.
   */
  @ApiOperation({ operationId: 'examPapersAliasBoardRejectDossier' })
  async aliasBoardRejectDossier(@Param('dossierId', { schema: uuidIdSchema }) dossierId: string, @Body({ schema: rejectExamDossierSchema }) dto: RejectExamDossierDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.boardRejectDossier(actor.id, dossierId, dto);
  }

  @Post(':id/dossiers')
  /**
   * POST /exam-papers/:id/dossiers — alias của POST /exams/:id/dossiers: lập bộ hồ sơ (nháp) cho một đề vào bank đích dùng chung.
   */
  @ApiOperation({ operationId: 'examPapersAliasCreateDossier' })
  async aliasCreateDossier(@Param('id', { schema: uuidIdSchema }) paperId: string, @Body({ schema: createExamDossierSchema }) dto: CreateExamDossierDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.createDossier(actor.id, paperId, dto);
  }
}

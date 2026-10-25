import { Body, Controller, Delete, Get, Header, Param, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { uuidIdSchema } from '@lms/contracts';
import type { Response } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { ExamDossiersService } from './exam-dossiers.service';
import {
  approveExamDossierSchema, createExamDossierSchema, rejectExamDossierSchema,
  type ApproveExamDossierDto, type CreateExamDossierDto, type RejectExamDossierDto,
} from './dto/exam-papers.dto';

@ApiTags('exam-papers')
@Controller({ path: 'exam-papers', version: '1' })
/**
 * HTTP bề mặt duyệt BỘ HỒ SƠ đề (EB-3, issue #165): lập/nộp/duyệt bộ
 * hồ sơ tại bank tổ/trường + hàng chờ của bank đích + bản đặc tả đã
 * chụp xem ngay trong hàng chờ (kèm xuất xlsx/docx). Mọi cổng quyền
 * nằm ở service: cấp 1 = exam:moderate tại context bank đích, cấp 2
 * (BGH) = exam:moderate tại context hệ thống.
 */
export class ExamDossiersController {
  constructor(private readonly dossiers: ExamDossiersService) {}

  @Get('dossiers/mine')
  /**
   * GET /exam-papers/dossiers/mine — mọi bộ hồ sơ của chính người dùng (theo dõi trạng thái + lý do từ chối xuyên bank).
   */
  async listMine(@CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.listMyDossiers(actor.id);
  }

  @Get('banks/:bankId/dossiers')
  /**
   * GET /exam-papers/banks/:bankId/dossiers — hàng chờ bộ hồ sơ của một bank đích (người duyệt thấy tất cả; người khác chỉ thấy bộ của mình).
   */
  async listBankDossiers(@Param('bankId', { schema: uuidIdSchema }) bankId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.listBankDossiers(actor.id, bankId);
  }

  @Get('dossiers/:dossierId')
  /**
   * GET /exam-papers/dossiers/:dossierId — chi tiết một bộ hồ sơ kèm vết duyệt từng cấp.
   */
  async getDossier(@Param('dossierId', { schema: uuidIdSchema }) dossierId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.getDossier(actor.id, dossierId);
  }

  @Get('dossiers/:dossierId/specification')
  /**
   * GET /exam-papers/dossiers/:dossierId/specification — bản đặc tả ĐÃ CHỤP tại lúc nộp (tổ trưởng mở ngay trong hàng chờ; lần mở của người duyệt ghi audit).
   */
  async getDossierSpecification(@Param('dossierId', { schema: uuidIdSchema }) dossierId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.getDossierSpecification(actor.id, dossierId);
  }

  @Get('dossiers/:dossierId/specification/export')
  @Header('content-disposition', 'attachment')
  /**
   * GET /exam-papers/dossiers/:dossierId/specification/export?format=xlsx|docx — xuất bản đặc tả đã chụp của bộ hồ sơ.
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
   * POST /exam-papers/dossiers/:dossierId/submit — nộp bộ hồ sơ: ghim phiên bản đề/ma trận + chụp bản đặc tả tại thời điểm nộp.
   */
  async submitDossier(@Param('dossierId', { schema: uuidIdSchema }) dossierId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.submitDossier(actor.id, dossierId);
  }

  @Delete('dossiers/:dossierId')
  /**
   * DELETE /exam-papers/dossiers/:dossierId — xoá bộ hồ sơ NHÁP (chưa nộp).
   */
  async deleteDossier(@Param('dossierId', { schema: uuidIdSchema }) dossierId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.deleteDossier(actor.id, dossierId);
  }

  @Post('dossiers/:dossierId/approve')
  /**
   * POST /exam-papers/dossiers/:dossierId/approve — duyệt cấp 1 (tổ trưởng/moderate bank đích; khi bật cấp 2 thì đây chỉ là mốc trung gian sang pending_board).
   */
  async approveDossier(@Param('dossierId', { schema: uuidIdSchema }) dossierId: string, @Body({ schema: approveExamDossierSchema }) _dto: ApproveExamDossierDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.approveDossier(actor.id, dossierId);
  }

  @Post('dossiers/:dossierId/reject')
  /**
   * POST /exam-papers/dossiers/:dossierId/reject — từ chối cấp 1, lý do bắt buộc.
   */
  async rejectDossier(@Param('dossierId', { schema: uuidIdSchema }) dossierId: string, @Body({ schema: rejectExamDossierSchema }) dto: RejectExamDossierDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.rejectDossier(actor.id, dossierId, dto);
  }

  @Post('dossiers/:dossierId/board-approve')
  /**
   * POST /exam-papers/dossiers/:dossierId/board-approve — duyệt cấp 2 (ban giám hiệu): mốc chốt, đề vào bank đích.
   */
  async boardApproveDossier(@Param('dossierId', { schema: uuidIdSchema }) dossierId: string, @Body({ schema: approveExamDossierSchema }) _dto: ApproveExamDossierDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.boardApproveDossier(actor.id, dossierId);
  }

  @Post('dossiers/:dossierId/board-reject')
  /**
   * POST /exam-papers/dossiers/:dossierId/board-reject — từ chối cấp 2 (ban giám hiệu), lý do bắt buộc.
   */
  async boardRejectDossier(@Param('dossierId', { schema: uuidIdSchema }) dossierId: string, @Body({ schema: rejectExamDossierSchema }) dto: RejectExamDossierDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.boardRejectDossier(actor.id, dossierId, dto);
  }

  @Post(':id/dossiers')
  /**
   * POST /exam-papers/:id/dossiers — lập bộ hồ sơ (nháp) cho một đề vào bank đích dùng chung.
   */
  async createDossier(@Param('id', { schema: uuidIdSchema }) paperId: string, @Body({ schema: createExamDossierSchema }) dto: CreateExamDossierDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.dossiers.createDossier(actor.id, paperId, dto);
  }
}

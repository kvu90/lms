import { BadRequestException, Body, Controller, Delete, Get, Header, Param, Patch, Post, Put, Query, Res, UseInterceptors } from '@nestjs/common';
import { generateFromMatrixSchema, uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { ExamsService } from './exams.service';
import { ExamPapersDeprecationInterceptor } from './deprecation.interceptor';
import type { GenerateFromMatrixDto } from '../quiz/dto/quiz.dto';
import {
  approveExamContributionSchema, copyExamSchema, createExamContributionSchema,
  createExamSchema, rejectExamContributionSchema,
  setExamSlotsSchema, setExamStatusSchema, swapExamSlotSchema, updateExamSchema,
  type ApproveExamContributionDto, type CopyExamDto, type CreateExamContributionDto,
  type CreateExamDto, type RejectExamContributionDto,
  type SetExamSlotsDto, type SetExamStatusDto, type SwapExamSlotDto, type UpdateExamDto,
} from './dto/exams.dto';

@ApiTags('exams')
@Controller({ path: ['exams', 'exam-papers'], version: '1' })
@UseInterceptors(ExamPapersDeprecationInterceptor)
/**
 * API lớp Ngân hàng đề (feat issue #113, EB-1; hợp nhất #226): thực
 * thể ĐỀ trong các bank `bank_kind='exam'` — soạn đề tự do, version
 * hoá, copy deep copy truy vết, đóng góp/duyệt khuôn QB-4. Đường
 * canonical là `/exams`; alias `/exam-papers` giữ kèm header
 * Deprecation/Sunset. Ghim đề vào khoá đi qua `/exam-pins` (xem
 * ExamPinsController) — không còn endpoint deploy riêng. Mọi cổng
 * quyền neo tại context của bank đề (capability exam:*).
 */
export class ExamsController {
  constructor(private readonly exams: ExamsService) {}

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
   * POST /exams/:id/status — đổi trạng thái vòng đời draft/ready/hidden (ready bắt buộc có slot; hidden không vỡ pin đã ghim).
   */
  async setStatus(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: setExamStatusSchema }) dto: SetExamStatusDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.setStatus(actor.id, id, dto);
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
}

@ApiTags('exam-matrices')
@Controller({ path: 'exam-matrices', version: '1' })
/**
 * Generate hai bước (EB-2, điểm E-3): POST /exam-matrices/:id/generate
 * giữ nguyên URL + payload của Chặng 3 nhưng điều phối ở lớp ngân
 * hàng đề: matrix → exams (snapshot) → ghim vào khoá qua
 * exam-pins. Thiếu câu ở bất kỳ ô nào trả 422 kèm chi tiết từng ô.
 */
export class ExamMatrixGenerateController {
  constructor(private readonly exams: ExamsService) {}

  @Post(':id/generate')
  /**
   * POST /exam-matrices/:id/generate — sinh đề từ ma trận (một thao tác): rút một bộ câu cố định thành đề snapshot rồi ghim vào khoá.
   */
  async generate(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: generateFromMatrixSchema }) dto: GenerateFromMatrixDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.generateFromMatrix(actor.id, id, dto);
  }
}

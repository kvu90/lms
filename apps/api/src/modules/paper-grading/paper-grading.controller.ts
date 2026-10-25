/**
 * API chấm bài giấy (CAM-0, issue #112; neo pin theo #226): lô IN
 * phiếu + PDF phiếu dưới `exam-batches` (neo `pinId`), tải ảnh theo
 * BUỔI (lô chụp) và hàng chờ phiếu đã quét dưới `exam-scans`. Mọi
 * route đều qua cổng `quiz:gradepaper` trong PaperGradingService
 * (controller không tự kiểm quyền).
 */
import {
  BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, Res, UploadedFiles, UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { uuidIdSchema } from '@lms/contracts';
import type { Response } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import {
  assignPaperBatchSchema, assignPaperIdentitySchema, createPaperBatchSchema, resolvePaperReadingsSchema,
  type AssignPaperBatch, type AssignPaperIdentity, type CreatePaperBatch, type ResolvePaperReadings,
} from './dto/paper-grading.dto';
import { PaperGradingService } from './paper-grading.service';

/** Giới hạn một lượt tải ảnh: 24 ảnh, mỗi ảnh tối đa 15 MB (ảnh chụp điện thoại lớp học). */
export const PAPER_UPLOAD_MAX_FILES = 24;
export const PAPER_UPLOAD_MAX_BYTES = 15 * 1024 * 1024;

@ApiTags('paper-grading')
@Controller({ path: 'exam-batches', version: '1' })
export class ExamBatchesController {
  constructor(private readonly paper: PaperGradingService) {}

  @Post()
  /** POST /exam-batches?pinId= — sinh một lô phiếu (một mã đề) cho pin, ghim layout + chụp roster. */
  async create(
    @Query('pinId', { schema: uuidIdSchema }) pinId: string,
    @Body({ schema: createPaperBatchSchema }) dto: CreatePaperBatch,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.paper.createBatch(actor.id, pinId, dto);
  }

  @Get()
  /** GET /exam-batches?pinId= — các lô phiếu của pin. */
  async list(@Query('pinId', { schema: uuidIdSchema }) pinId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.paper.listBatches(actor.id, pinId);
  }

  @Get(':batchId')
  /** GET /exam-batches/:batchId — một lô phiếu (layout + roster); pin suy từ chính lô. */
  async get(
    @Param('batchId', { schema: uuidIdSchema }) batchId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.paper.getBatch(actor.id, batchId);
  }

  @Get(':batchId/sheets')
  /** GET /exam-batches/:batchId/sheets?format=pdf — tải PDF phiếu: mặc định phiếu DÙNG CHUNG (?copies=n, mặc định bằng sĩ số); ?kind=personalized phiếu cá nhân hoá theo danh sách; ?studentId=… một phiếu cá nhân hoá. */
  async sheets(
    @Param('batchId', { schema: uuidIdSchema }) batchId: string,
    @Query('format') format: string | undefined,
    @Query('studentId') studentId: string | undefined,
    @Query('kind') kind: string | undefined,
    @Query('copies') copies: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
    @Res() res: Response,
  ) {
    if (format !== undefined && format !== 'pdf') {
      throw new BadRequestException({ message: `Unsupported sheets format ${format}`, code: 'paper.sheets_format_unsupported' });
    }
    const { buffer, fileName } = await this.paper.sheetsPdf(actor.id, batchId, {
      studentId, kind, copies: copies ? Number(copies) : undefined,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(buffer);
  }

  // Không đặt guard capability ở decorator: guard chạy trước interceptor
  // multipart nên chưa biết lô đích — cổng quiz:gradepaper kiểm trong service.
  @Post(':batchId/scans')
  @UseInterceptors(FilesInterceptor('files', PAPER_UPLOAD_MAX_FILES, {
    limits: { fileSize: PAPER_UPLOAD_MAX_BYTES },
  }))
  /** POST /exam-batches/:batchId/scans — tải hàng loạt ảnh chụp (multipart, trường `files`): cổng chất lượng từ chối từng ảnh hỏng kèm lý do; 422 khi mọi ảnh đều bị từ chối. */
  async uploadScans(
    @Param('batchId', { schema: uuidIdSchema }) batchId: string,
    @UploadedFiles() files: { originalname: string; buffer: Buffer; mimetype: string }[],
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.paper.uploadScans(actor.id, batchId, files ?? []);
  }
}

@ApiTags('paper-grading')
@Controller({ path: 'exam-scans', version: '1' })
export class ExamScansController {
  constructor(private readonly paper: PaperGradingService) {}

  // Không đặt guard capability ở decorator: guard chạy trước interceptor
  // multipart nên chưa biết ngữ cảnh — cổng quiz:gradepaper kiểm trong service.
  @Post()
  @UseInterceptors(FilesInterceptor('files', PAPER_UPLOAD_MAX_FILES, {
    limits: { fileSize: PAPER_UPLOAD_MAX_BYTES },
  }))
  /** POST /exam-scans?pinId= — tải ảnh theo BUỔI (một lô chụp): hệ thống định tuyến từng phiếu về lô in theo mã đề/QR; phiếu không định tuyến được vẫn được lưu chưa gắn lô vào hàng chờ. */
  async uploadSession(
    @Query('pinId', { schema: uuidIdSchema }) pinId: string,
    @UploadedFiles() files: { originalname: string; buffer: Buffer; mimetype: string }[],
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.paper.uploadSessionScans(actor.id, pinId, files ?? []);
  }

  @Get()
  /** GET /exam-scans?pinId=…&status=… — hàng chờ phiếu của một pin, lọc theo trạng thái khi cần. */
  async list(
    @Query('pinId', { schema: uuidIdSchema }) pinId: string,
    @Query('status') status: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.paper.listScans(actor.id, pinId, status);
  }

  @Get(':scanId')
  /** GET /exam-scans/:scanId — chi tiết một phiếu (kết quả đọc + hình học lưới để web cắt vùng câu). */
  async get(@Param('scanId', { schema: uuidIdSchema }) scanId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.paper.getScan(actor.id, scanId);
  }

  @Get(':scanId/image/:kind')
  /** GET /exam-scans/:scanId/image/original|warped — ảnh phiếu, chỉ qua cổng quiz:gradepaper. */
  async image(
    @Param('scanId', { schema: uuidIdSchema }) scanId: string,
    @Param('kind') kind: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Res() res: Response,
  ) {
    const { data, mimeType, fileName } = await this.paper.scanImage(actor.id, scanId, kind);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.send(data);
  }

  @Post(':scanId/assign-identity')
  /** POST /exam-scans/:scanId/assign-identity — hàng chờ gán định danh: giáo viên chọn đúng học sinh trong roster (ghi event log như biên bản). */
  async assignIdentity(
    @Param('scanId', { schema: uuidIdSchema }) scanId: string,
    @Body({ schema: assignPaperIdentitySchema }) dto: AssignPaperIdentity,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.paper.assignIdentity(actor.id, scanId, dto.studentId);
  }

  @Post(':scanId/assign-batch')
  /** POST /exam-scans/:scanId/assign-batch — hàng chờ gán lô in: gắn phiếu chưa định tuyến được (hoặc sửa mã đề sai) về đúng lô in; hệ thống đọc lại phiếu theo layout của lô (ghi event log như biên bản). */
  async assignBatch(
    @Param('scanId', { schema: uuidIdSchema }) scanId: string,
    @Body({ schema: assignPaperBatchSchema }) dto: AssignPaperBatch,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.paper.assignBatch(actor.id, scanId, dto.batchId);
  }

  @Post(':scanId/resolve-readings')
  /** POST /exam-scans/:scanId/resolve-readings — hàng chờ ca mơ hồ: giáo viên quyết ô chọn cho từng câu ambiguous. */
  async resolveReadings(
    @Param('scanId', { schema: uuidIdSchema }) scanId: string,
    @Body({ schema: resolvePaperReadingsSchema }) dto: ResolvePaperReadings,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.paper.resolveReadings(actor.id, scanId, dto);
  }

  @Post(':scanId/record')
  /** POST /exam-scans/:scanId/record — ghi phiếu đã sẵn sàng thành attempt thi giấy (điểm vào sổ như attempt online). */
  async record(@Param('scanId', { schema: uuidIdSchema }) scanId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.paper.recordScan(actor.id, scanId);
  }

  @Delete(':scanId')
  /** DELETE /exam-scans/:scanId — xoá phiếu chưa ghi khỏi hàng chờ. */
  async remove(@Param('scanId', { schema: uuidIdSchema }) scanId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.paper.deleteScan(actor.id, scanId);
    return { deleted: true };
  }
}

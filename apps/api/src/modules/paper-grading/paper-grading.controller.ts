/**
 * API chấm bài giấy (CAM-0, issue #112): lô phiếu + PDF phiếu dưới
 * `quizzes/:quizId/paper-batches`, hàng chờ phiếu đã quét dưới
 * `paper-scans`. Mọi route đều qua cổng `quiz:gradepaper` trong
 * PaperGradingService (controller không tự kiểm quyền).
 */
import {
  Body, Controller, Delete, Get, Param, Post, Query, Res, UploadedFiles, UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { uuidIdSchema } from '@lms/contracts';
import type { Response } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import {
  assignPaperIdentitySchema, createPaperBatchSchema, resolvePaperReadingsSchema,
  type AssignPaperIdentity, type CreatePaperBatch, type ResolvePaperReadings,
} from './dto/paper-grading.dto';
import { PaperGradingService } from './paper-grading.service';

/** Giới hạn một lượt tải ảnh: 24 ảnh, mỗi ảnh tối đa 15 MB (ảnh chụp điện thoại lớp học). */
export const PAPER_UPLOAD_MAX_FILES = 24;
export const PAPER_UPLOAD_MAX_BYTES = 15 * 1024 * 1024;

@ApiTags('paper-grading')
@Controller({ path: 'quizzes/:quizId/paper-batches', version: '1' })
export class PaperBatchesController {
  constructor(private readonly paper: PaperGradingService) {}

  @Post()
  /** POST /quizzes/:quizId/paper-batches — sinh một lô phiếu (một mã đề), ghim layout + chụp roster. */
  async create(
    @Param('quizId', { schema: uuidIdSchema }) quizId: string,
    @Body({ schema: createPaperBatchSchema }) dto: CreatePaperBatch,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.paper.createBatch(actor.id, quizId, dto);
  }

  @Get()
  /** GET /quizzes/:quizId/paper-batches — các lô phiếu của quiz. */
  async list(@Param('quizId', { schema: uuidIdSchema }) quizId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.paper.listBatches(actor.id, quizId);
  }

  @Get(':batchId')
  /** GET /quizzes/:quizId/paper-batches/:batchId — một lô phiếu (layout + roster). */
  async get(
    @Param('quizId', { schema: uuidIdSchema }) quizId: string,
    @Param('batchId', { schema: uuidIdSchema }) batchId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.paper.getBatch(actor.id, quizId, batchId);
  }

  @Get(':batchId/sheets.pdf')
  /** GET …/sheets.pdf — tải PDF phiếu: mặc định mọi phiếu cá nhân hoá; ?studentId=… một phiếu; ?kind=blank&copies=n phiếu trắng. */
  async sheetsPdf(
    @Param('quizId', { schema: uuidIdSchema }) quizId: string,
    @Param('batchId', { schema: uuidIdSchema }) batchId: string,
    @Query('studentId') studentId: string | undefined,
    @Query('kind') kind: string | undefined,
    @Query('copies') copies: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
    @Res() res: Response,
  ) {
    const { buffer, fileName } = await this.paper.sheetsPdf(actor.id, quizId, batchId, {
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
  /** POST …/scans — tải hàng loạt ảnh chụp (multipart, trường `files`): cổng chất lượng từ chối từng ảnh hỏng kèm lý do; 422 khi mọi ảnh đều bị từ chối. */
  async uploadScans(
    @Param('quizId', { schema: uuidIdSchema }) quizId: string,
    @Param('batchId', { schema: uuidIdSchema }) batchId: string,
    @UploadedFiles() files: { originalname: string; buffer: Buffer; mimetype: string }[],
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.paper.uploadScans(actor.id, quizId, batchId, files ?? []);
  }
}

@ApiTags('paper-grading')
@Controller({ path: 'paper-scans', version: '1' })
export class PaperScansController {
  constructor(private readonly paper: PaperGradingService) {}

  @Get()
  /** GET /paper-scans?quizId=…&status=… — hàng chờ phiếu của một quiz, lọc theo trạng thái khi cần. */
  async list(
    @Query('quizId', { schema: uuidIdSchema }) quizId: string,
    @Query('status') status: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.paper.listScans(actor.id, quizId, status);
  }

  @Get(':scanId')
  /** GET /paper-scans/:scanId — chi tiết một phiếu (kết quả đọc + hình học lưới để web cắt vùng câu). */
  async get(@Param('scanId', { schema: uuidIdSchema }) scanId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.paper.getScan(actor.id, scanId);
  }

  @Get(':scanId/image/:kind')
  /** GET /paper-scans/:scanId/image/original|warped — ảnh phiếu, chỉ qua cổng quiz:gradepaper. */
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
  /** POST /paper-scans/:scanId/assign-identity — hàng chờ gán định danh: giáo viên chọn đúng học sinh trong roster. */
  async assignIdentity(
    @Param('scanId', { schema: uuidIdSchema }) scanId: string,
    @Body({ schema: assignPaperIdentitySchema }) dto: AssignPaperIdentity,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.paper.assignIdentity(actor.id, scanId, dto.studentId);
  }

  @Post(':scanId/resolve-readings')
  /** POST /paper-scans/:scanId/resolve-readings — hàng chờ ca mơ hồ: giáo viên quyết ô chọn cho từng câu ambiguous. */
  async resolveReadings(
    @Param('scanId', { schema: uuidIdSchema }) scanId: string,
    @Body({ schema: resolvePaperReadingsSchema }) dto: ResolvePaperReadings,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.paper.resolveReadings(actor.id, scanId, dto);
  }

  @Post(':scanId/record')
  /** POST /paper-scans/:scanId/record — ghi phiếu đã sẵn sàng thành attempt thi giấy (điểm vào sổ như attempt online). */
  async record(@Param('scanId', { schema: uuidIdSchema }) scanId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.paper.recordScan(actor.id, scanId);
  }

  @Delete(':scanId')
  /** DELETE /paper-scans/:scanId — xoá phiếu chưa ghi khỏi hàng chờ. */
  async remove(@Param('scanId', { schema: uuidIdSchema }) scanId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.paper.deleteScan(actor.id, scanId);
    return { deleted: true };
  }
}

import { Body, Controller, Delete, Get, Param, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { Public } from '../../common/public.decorator';
import { FilesService, questionFileContentSrc } from './files.service';
import { questionImageMetaServerSchema, uploadMetaServerSchema, type QuestionImageMetaDto, type UploadMetaDto } from './dto/files.dto';


@ApiTags('files')
@Controller({ path: 'files', version: '1' })
/**
 * API file: upload multipart, metadata, URL ký, tải xuống và xoá.
 */
export class FilesController {
  constructor(private readonly files: FilesService) {}

  // Không có @RequireCapability tại đây: các guard chạy trước khi interceptor multipart
  // phân tích body, nên context đích được kiểm tra trong handler thay thế.
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  /**
   * POST /files — tải file lên (multipart; metadata kiểm bằng schema Zod phía server).
   */
  async upload(@UploadedFile() file: { originalname: string; buffer: Buffer; mimetype: string }, @Body({ schema: uploadMetaServerSchema }) meta: UploadMetaDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.files.assertCanUpload(meta.contextId, actor);
    const row = await this.files.upload({
      contextId: meta.contextId, component: meta.component, fileArea: meta.fileArea,
      itemId: meta.itemId, filePath: meta.filePath,
      fileName: file.originalname, data: file.buffer, mimeType: file.mimetype, userId: actor.id,
    });
    return { id: row.id, contentHash: row.contentHash, fileSize: row.fileSize, fileName: row.fileName, contextId: row.contextId };
  }

  // Cùng dạng guard như upload ở gốc: capability được kiểm tra trong
  // handler vì context đích chỉ tồn tại sau khi phân tích multipart.
  @Post('question-image')
  @UseInterceptors(FileInterceptor('file'))
  /**
   * POST /files/question-image — tải MỘT ảnh nhúng cho nội dung câu hỏi vào
   * context của bank đích. Trả `src` là định danh bền để editor chèn vào tài
   * liệu; URL ký chỉ được phát khi phục vụ người đọc (resolveQuestionImageUrls).
   */
  async uploadQuestionImage(@UploadedFile() file: { originalname: string; buffer: Buffer; mimetype: string }, @Body({ schema: questionImageMetaServerSchema }) meta: QuestionImageMetaDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.files.assertCanUpload(meta.contextId, actor);
    const row = await this.files.uploadQuestionImage({
      contextId: meta.contextId, fileArea: meta.fileArea, itemId: meta.itemId,
      fileName: file.originalname, data: file.buffer, userId: actor.id,
    });
    return {
      id: row.id, src: questionFileContentSrc(row.id), fileName: row.fileName,
      mimeType: row.mimeType, fileSize: row.fileSize, contextId: row.contextId, fileArea: row.fileArea,
    };
  }

  @Get(':id')
  /**
   * GET /files/:id — metadata của file.
   */
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    const f = await this.files.getFile(id);
    await this.files.assertCanView(f, actor);
    return { id: f.id, contentHash: f.contentHash, fileSize: f.fileSize, fileName: f.fileName, contextId: f.contextId, component: f.component, fileArea: f.fileArea, mimeType: f.mimeType };
  }

  /** Xin một URL tải xuống đã ký ngắn hạn — bị từ chối (403 Problem Details) nếu không có capability của context file. */
  @Post(':id/signed-url')
  /**
   * POST /files/:id/signed-url — tạo URL tải ký tạm thời.
   */
  async signedUrl(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.files.createSignedUrl(id, actor.id, actor.username === 'guest');
  }

  @Delete(':id')
  /**
   * DELETE /files/:id — xoá file.
   */
  async remove(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    const f = await this.files.getFile(id);
    await this.files.assertCanUpload(f.contextId, actor);
    return this.files.deleteFile(id);
  }

  /** Tải xuống đã ký: route public DUY NHẤT — việc sở hữu một chữ ký chưa hết hạn (được cấp sau khi kiểm tra capability) chính là thông tin xác thực. */
  @Public()
  @Get(':id/download')
  /**
   * GET /files/:id/download — tải nội dung (kiểm quyền hoặc chữ ký tạm thời).
   */
  async download(@Param('id', { schema: uuidIdSchema }) id: string, @Query('sig') sig: string | undefined, @Res() res: Response) {
    this.files.verifySignature(id, sig);
    const { file, data } = await this.files.readContent(id);
    res.setHeader('Content-Type', file.mimeType ?? 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName.replace(/"/g, '')}"`);
    res.send(data);
  }

  /** Luồng stream có guard (thay thế cho URL đã ký): capability được kiểm tra trên chính context của file. */
  @Get(':id/content')
  /**
   * GET /files/content — phục vụ nội dung qua URL đã ký.
   */
  async content(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser, @Res() res: Response) {
    const probe = await this.files.getFile(id);
    await this.files.createSignedUrl(id, actor.id, actor.username === 'guest'); // ném 403 khi không được phép
    void probe;
    const { file, data } = await this.files.readContent(id);
    res.setHeader('Content-Type', file.mimeType ?? 'application/octet-stream');
    res.send(data);
  }
}

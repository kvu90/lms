import { Body, Controller, Delete, Get, Param, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { Public } from '../../common/public.decorator';
import { FilesService } from './files.service';
import { uploadMetaServerSchema, type UploadMetaDto } from './dto/files.dto';


@ApiTags('files')
@Controller({ path: 'files', version: '1' })
/**
 * API file: upload multipart, metadata, URL ký, tải xuống và xoá.
 */
export class FilesController {
  constructor(private readonly files: FilesService) {}

  // No @RequireCapability here: guards run before the multipart interceptor
  // parses the body, so the target context is checked in the handler instead.
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

  @Get(':id')
  /**
   * GET /files/:id — metadata file.
   */
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    const f = await this.files.getFile(id);
    await this.files.assertCanView(f, actor);
    return { id: f.id, contentHash: f.contentHash, fileSize: f.fileSize, fileName: f.fileName, contextId: f.contextId, component: f.component, fileArea: f.fileArea, mimeType: f.mimeType };
  }

  /** Ask for a short-lived signed download URL — denied (403 Problem Details) without the file-context capability. */
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

  /** Signed download: the ONLY public route — possession of an unexpired signature (issued after a capability check) is the credential. */
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

  /** Guarded stream (alternative to signed URL): capability checked on the file's own context. */
  @Get(':id/content')
  /**
   * GET /files/content — phục vụ nội dung qua URL đã ký.
   */
  async content(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser, @Res() res: Response) {
    const probe = await this.files.getFile(id);
    await this.files.createSignedUrl(id, actor.id, actor.username === 'guest'); // throws 403 when not allowed
    void probe;
    const { file, data } = await this.files.readContent(id);
    res.setHeader('Content-Type', file.mimeType ?? 'application/octet-stream');
    res.send(data);
  }
}

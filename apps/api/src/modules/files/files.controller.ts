import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString } from 'class-validator';
import type { Response } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { Public } from '../../common/public.decorator';
import { FilesService } from './files.service';

class UploadMetaDto {
  @Type(() => Number) @IsInt() contextid!: number; @IsString() component!: string; @IsString() filearea!: string;
  @IsOptional() @Type(() => Number) @IsInt() itemid?: number; @IsOptional() @IsString() filepath?: string;
}

@ApiTags('files')
@Controller({ path: 'files', version: '1' })
export class FilesController {
  constructor(private readonly files: FilesService) {}

  // No @RequireCapability here: guards run before the multipart interceptor
  // parses the body, so the target context is checked in the handler instead.
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  async upload(@UploadedFile() file: { originalname: string; buffer: Buffer; mimetype: string }, @Body() meta: UploadMetaDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.files.assertCanUpload(Number(meta.contextid), actor);
    const row = await this.files.upload({
      contextid: Number(meta.contextid), component: meta.component, filearea: meta.filearea,
      itemid: meta.itemid ? Number(meta.itemid) : 0, filepath: meta.filepath,
      filename: file.originalname, data: file.buffer, mimetype: file.mimetype, userid: actor.id,
    });
    return { id: row.id, contenthash: row.contenthash, filesize: row.filesize, filename: row.filename, contextid: row.contextid };
  }

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    const f = await this.files.getFile(id);
    await this.files.assertCanView(f, actor);
    return { id: f.id, contenthash: f.contenthash, filesize: f.filesize, filename: f.filename, contextid: f.contextid, component: f.component, filearea: f.filearea, mimetype: f.mimetype };
  }

  /** Ask for a short-lived signed download URL — denied (403 Problem Details) without the file-context capability. */
  @Post(':id/signed-url')
  async signedUrl(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.files.createSignedUrl(id, actor.id, actor.username === 'guest');
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    const f = await this.files.getFile(id);
    await this.files.assertCanUpload(f.contextid, actor);
    return this.files.deleteFile(id);
  }

  /** Signed download: the ONLY public route — possession of an unexpired signature (issued after a capability check) is the credential. */
  @Public()
  @Get(':id/download')
  async download(@Param('id', ParseIntPipe) id: number, @Query('sig') sig: string | undefined, @Res() res: Response) {
    this.files.verifySignature(id, sig);
    const { file, data } = await this.files.readContent(id);
    res.setHeader('Content-Type', file.mimetype ?? 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename.replace(/"/g, '')}"`);
    res.send(data);
  }

  /** Guarded stream (alternative to signed URL): capability checked on the file's own context. */
  @Get(':id/content')
  async content(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser, @Res() res: Response) {
    const probe = await this.files.getFile(id);
    await this.files.createSignedUrl(id, actor.id, actor.username === 'guest'); // throws 403 when not allowed
    void probe;
    const { file, data } = await this.files.readContent(id);
    res.setHeader('Content-Type', file.mimetype ?? 'application/octet-stream');
    res.send(data);
  }
}

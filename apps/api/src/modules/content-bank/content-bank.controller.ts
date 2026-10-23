import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { ContentBankService } from './content-bank.service';
import { createContentBankContentSchema, updateContentBankContentSchema, uploadContentBankFileSchema, type CreateContentDto, type UpdateContentDto, type UploadContentFileDto } from './dto/content-bank.dto';

/** Controller Content Bank. */
@ApiTags('contentbank')
@Controller({ path: 'contentbank', version: '1' })
export class ContentBankController {
  constructor(private readonly contentBank: ContentBankService) {}
  @Post()
  async create(@Body({ schema: createContentBankContentSchema }) dto: CreateContentDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.contentBank.create(actor.id, dto);
  }
  @Get()
  async list(@Query('contextId') contextId: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    return this.contentBank.listFor(actor.id, contextId || undefined);
  }
  @Get(':id')
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.contentBank.getFor(actor.id, id);
  }
  @Patch(':id')
  async update(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updateContentBankContentSchema }) dto: UpdateContentDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.contentBank.update(actor.id, id, dto);
  }
  @Delete(':id')
  async remove(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.contentBank.remove(actor.id, id); return { deleted: true };
  }
  @Post(':id/file')
  async upload(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: uploadContentBankFileSchema }) dto: UploadContentFileDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.contentBank.uploadFile(actor.id, id, dto);
  }
  @Get(':id/file-url')
  async fileUrl(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.contentBank.signedUrl(actor.id, id);
  }
}

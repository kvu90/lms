import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { ContentBankService } from './content-bank.service';
import { CreateContentDto, UpdateContentDto, UploadContentFileDto } from './dto/content-bank.dto';

/** Controller Content Bank. */
@ApiTags('contentbank')
@Controller({ path: 'contentbank', version: '1' })
export class ContentBankController {
  constructor(private readonly contentBank: ContentBankService) {}
  @Post()
  async create(@Body() dto: CreateContentDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.contentBank.create(actor.id, dto);
  }
  @Get()
  async list(@Query('contextid') contextid: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    return this.contentBank.listFor(actor.id, contextid ? Number(contextid) : undefined);
  }
  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.contentBank.getFor(actor.id, id);
  }
  @Patch(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateContentDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.contentBank.update(actor.id, id, dto);
  }
  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    await this.contentBank.remove(actor.id, id); return { deleted: true };
  }
  @Post(':id/file')
  async upload(@Param('id', ParseIntPipe) id: number, @Body() dto: UploadContentFileDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.contentBank.uploadFile(actor.id, id, dto);
  }
  @Get(':id/file-url')
  async fileUrl(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.contentBank.signedUrl(actor.id, id);
  }
}

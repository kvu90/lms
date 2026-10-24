import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { ContentBankService } from './content-bank.service';
import {
  createContentBankContentSchema, insertContentBankContentSchema, reviewContentBankContentSchema,
  updateContentBankContentSchema, uploadContentBankFileSchema,
  type CreateContentDto, type InsertContentDto, type ReviewContentDto, type UpdateContentDto, type UploadContentFileDto,
} from './dto/content-bank.dto';

/** Controller Content Bank / Kho học liệu (CB-1). */
@ApiTags('contentbank')
@Controller({ path: 'contentbank', version: '1' })
export class ContentBankController {
  constructor(private readonly contentBank: ContentBankService) {}
  @Post()
  async create(@Body({ schema: createContentBankContentSchema }) dto: CreateContentDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.contentBank.create(actor.id, dto);
  }
  /** Các không gian của Kho học liệu mà người dùng thấy: Của tôi / các tổ chuyên môn / Toàn trường. */
  @Get('spaces')
  async spaces(@CurrentUser() actor: AuthenticatedUser) {
    return this.contentBank.listSpaces(actor.id);
  }
  @Get()
  async list(
    @Query('contextId') contextId: string | undefined,
    @Query('scope') scope: string | undefined,
    @Query('spaceId') spaceId: string | undefined,
    @Query('creatorId') creatorId: string | undefined,
    @Query('subjectId') subjectId: string | undefined,
    @Query('grade') grade: string | undefined,
    @Query('level') level: string | undefined,
    @Query('curriculumNodeId') curriculumNodeId: string | undefined,
    @Query('resourceType') resourceType: string | undefined,
    @Query('reviewStatus') reviewStatus: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.contentBank.listFor(actor.id, {
      contextId: contextId || undefined,
      scope: scope || undefined,
      spaceId: spaceId || undefined,
      creatorId: creatorId || undefined,
      subjectId: subjectId || undefined,
      grade: grade ? Number(grade) : undefined,
      level: level || undefined,
      curriculumNodeId: curriculumNodeId || undefined,
      resourceType: resourceType || undefined,
      reviewStatus: reviewStatus || undefined,
    });
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
  /** Gửi duyệt học liệu chia sẻ (scope tổ/trường) cho tổ trưởng. */
  @Post(':id/submit')
  async submit(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.contentBank.submitForReview(actor.id, id);
  }
  /** Tổ trưởng duyệt/từ chối học liệu đang chờ duyệt. */
  @Post(':id/review')
  async review(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: reviewContentBankContentSchema }) dto: ReviewContentDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.contentBank.review(actor.id, id, dto);
  }
  /** "Thêm từ kho": cắm học liệu vào một section của khoá bằng bản sao file. */
  @Post(':id/insert')
  async insert(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: insertContentBankContentSchema }) dto: InsertContentDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.contentBank.insertIntoCourse(actor.id, id, dto);
  }
}

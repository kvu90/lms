import { BadRequestException, Body, Controller, Get, Param, Patch, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { QuestionImportService } from './question-import.service';
import { updateQuestionImportItemSchema, type UpdateQuestionImportItemDto } from './dto/question-import.dto';

@ApiTags('question-imports')
@Controller({ path: 'question-imports', version: '1' })
/**
 * API số hoá đề từ file (issue #52): tải docx/pdf → tách câu → hàng đợi
 * duyệt → duyệt vào ngân hàng câu hỏi kèm gắn YCCĐ + mức.
 */
export class QuestionImportController {
  constructor(private readonly imports: QuestionImportService) {}

  // Không gắn guard quyền ở route: guard chạy trước interceptor multipart
  // nên category đích được kiểm tra quyền trong service (như files/grades).
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 } }))
  /**
   * POST /question-imports — tải file đề (multipart, trường `file` +
   * `categoryId`) và tách câu vào hàng đợi duyệt của category đích.
   */
  async upload(
    @UploadedFile() file: { originalname: string; buffer: Buffer } | undefined,
    @Body('categoryId') categoryId: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    if (!file) {
      throw new BadRequestException({ message: 'An exam file is required in the multipart field "file"', code: 'question_import.file_required' });
    }
    if (!categoryId || !uuidIdSchema.safeParse(categoryId).success) {
      throw new BadRequestException({ message: 'A target question category (categoryId) is required', code: 'question_import.category_required' });
    }
    return this.imports.upload(actor.id, categoryId, file);
  }

  @Get()
  /**
   * GET /question-imports — các đợt nhập của người dùng (quản trị viên: tất cả).
   */
  async list(@CurrentUser() actor: AuthenticatedUser) {
    return this.imports.listBatches(actor.id);
  }

  @Get(':id')
  /**
   * GET /question-imports/:id — chi tiết đợt kèm các mục chờ duyệt.
   */
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.imports.getBatch(actor.id, id);
  }

  @Patch(':id/items/:itemId')
  /**
   * PATCH /question-imports/:id/items/:itemId — sửa payload của mục đang chờ duyệt.
   */
  async updateItem(
    @Param('id', { schema: uuidIdSchema }) id: string,
    @Param('itemId', { schema: uuidIdSchema }) itemId: string,
    @Body({ schema: updateQuestionImportItemSchema }) dto: UpdateQuestionImportItemDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.imports.updateItem(actor.id, id, itemId, dto.payload);
  }

  @Post(':id/items/:itemId/approve')
  /**
   * POST /question-imports/:id/items/:itemId/approve — duyệt mục: tạo câu hỏi chính thức + gắn YCCĐ/mức.
   */
  async approveItem(
    @Param('id', { schema: uuidIdSchema }) id: string,
    @Param('itemId', { schema: uuidIdSchema }) itemId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.imports.approveItem(actor.id, id, itemId);
  }

  @Post(':id/items/:itemId/reject')
  /**
   * POST /question-imports/:id/items/:itemId/reject — từ chối mục (không vào ngân hàng).
   */
  async rejectItem(
    @Param('id', { schema: uuidIdSchema }) id: string,
    @Param('itemId', { schema: uuidIdSchema }) itemId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.imports.rejectItem(actor.id, id, itemId);
  }

  @Post(':id/approve-all')
  /**
   * POST /question-imports/:id/approve-all — duyệt mọi mục đang chờ còn hợp lệ; mục lỗi được bỏ qua và báo lại.
   */
  async approveAll(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.imports.approveAll(actor.id, id);
  }
}

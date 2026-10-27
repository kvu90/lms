import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { BookService } from './books.service';
import {
  importBookDatasetSchema,
  type ImportBookDatasetDto,
} from './dto/books.dto';

@ApiTags('books')
@Controller({ path: 'books', version: '1' })
/**
 * API Sách (K0b tái cấu trúc, issue #67): sách là thực thể độc lập —
 * không nằm dưới chương trình; chương trình chỉ liên quan qua lớp ánh
 * xạ trong cây sách. Đọc cần curriculum:view tại context của môn mô tả
 * (hoặc context hệ thống khi sách không gắn môn), ghi/nạp cần
 * curriculum:manage tại context hệ thống (trong service). Các GET phục
 * vụ chọn khung nhận thêm `forCourseId` như bề mặt chương trình.
 */
export class BooksController {
  constructor(private readonly booksService: BookService) {}

  @Get('dataset-import')
  /** GET /books/dataset-import — trạng thái nạp của từng dataset sách đã kiểm chứng. */
  async listDatasetImportStatus(@CurrentUser() actor: AuthenticatedUser) {
    return this.booksService.listDatasetStatus(actor.id);
  }
  @Post('dataset-import')
  /** POST /books/dataset-import — nạp/nạp lại một dataset sách vào cây sách + ánh xạ (idempotent theo sổ đăng ký; ánh xạ không phân giải được → lỗi cứng `book.mapping_unresolved`, không ghi dở). */
  async importDataset(@Body({ schema: importBookDatasetSchema }) dto: ImportBookDatasetDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.booksService.importDataset(actor.id, dto.datasetKey);
  }
  @Get()
  /** GET /books?kind=&subjectId=&forCourseId= — danh sách sách, lọc theo loại sách và/hoặc môn mô tả khi có. */
  async listBooks(@Query('kind') kind: string | undefined, @Query('subjectId') subjectId: string | undefined, @Query('forCourseId') forCourseId: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    return this.booksService.listBooks(actor.id, subjectId, forCourseId, kind);
  }
  @Get(':id/tree')
  /** GET /books/:id/tree?forCourseId= — cây mục lục của sách: chủ đề → bài, mỗi bài kèm ánh xạ + YCCĐ suy qua ánh xạ. */
  async getBookTree(@Param('id', { schema: uuidIdSchema }) id: string, @Query('forCourseId') forCourseId: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    return this.booksService.getBookTree(actor.id, id, forCourseId);
  }
  @Get(':id/questions')
  /**
   * GET /books/:id/questions — truy nguồn chiều ngược: các câu hỏi
   * ghi nguồn gốc từ cuốn sách này (source_kind='book'). Bề mặt nội
   * bộ phía giáo viên/quản trị, cùng cổng đọc với cây sách.
   */
  async getBookQuestions(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.booksService.listBookQuestions(actor.id, id);
  }
}

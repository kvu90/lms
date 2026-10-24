import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { GradesService } from './grades.service';
import { VnGradebooksService } from './vn-gradebooks.service';
import { commitVnCandidateSchema, createGradeCategorySchema, createGradeItemSchema, createGradeOutcomeSchema, createGradeScaleSchema, createVnActivityMappingSchema, createVnGradebookSchema, dismissVnCandidateSchema, exportGradesVneduSchema, finalizeVnTermResultSchema, finalizeVnYearResultSchema, gradePublicationActionSchema, setGradeLettersSchema, setGradePostingPolicySchema, setGradeSchema, setVnCommentResultSchema, setVnMakeupStatusSchema, updateGradeCategorySchema, updateGradeItemSchema, updateGradeOutcomeSchema, updateGradeSchema, type CommitVnCandidateDto, type CreateGradeCategoryDto, type CreateGradeItemDto, type CreateGradeOutcomeDto, type CreateScaleDto, type CreateVnActivityMappingDto, type CreateVnGradebookDto, type DismissVnCandidateDto, type ExportGradesVneduDto, type FinalizeVnTermResultDto, type FinalizeVnYearResultDto, type GradePublicationActionDto, type SetGradeDto, type SetGradePostingPolicyDto, type SetLettersDto, type SetVnCommentResultDto, type SetVnMakeupStatusDto, type UpdateGradeCategoryDto, type UpdateGradeDto, type UpdateGradeItemDto, type UpdateGradeOutcomeDto } from './dto/grades.dto';

@ApiTags('grades')
@Controller({ path: 'courses', version: '1' })
/**
 * API sổ điểm: category, item, nhập điểm, sổ điểm cá nhân, báo cáo lớp, letters và scales.
 */
export class GradesController {
  constructor(private readonly grades: GradesService) {}

  @Post(':courseId/grades/categories')
  /**
   * POST /courses/:courseId/grades/categories — tạo category điểm.
   */
  async createCategory(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: createGradeCategorySchema }) dto: CreateGradeCategoryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.createCategory(actor.id, courseId, dto);
  }
  @Get(':courseId/grades/categories')
  /**
   * GET /courses/:courseId/grades/categories — liệt kê category.
   */
  async listCategories(@Param('courseId', { schema: uuidIdSchema }) courseId: string) {
    return this.grades.listCategories(courseId);
  }
  @Patch('grades/categories/:categoryId')
  /**
   * PATCH /courses/grades/categories/:categoryId — cập nhật category.
   */
  async updateCategory(@Param('categoryId', { schema: uuidIdSchema }) categoryId: string, @Body({ schema: updateGradeCategorySchema }) dto: UpdateGradeCategoryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.updateCategory(actor.id, categoryId, dto);
  }
  @Delete('grades/categories/:categoryId')
  /**
   * DELETE /courses/grades/categories/:categoryId — xoá category.
   */
  async deleteCategory(@Param('categoryId', { schema: uuidIdSchema }) categoryId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.grades.deleteCategory(actor.id, categoryId);
    return { deleted: true };
  }

  @Post(':courseId/grades/items')
  /**
   * POST /courses/:courseId/grades/items — tạo grade item.
   */
  async createItem(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: createGradeItemSchema }) dto: CreateGradeItemDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.createItem(actor.id, courseId, dto);
  }
  @Get(':courseId/grades/items')
  /**
   * GET /courses/:courseId/grades/items — liệt kê item.
   */
  async listItems(@Param('courseId', { schema: uuidIdSchema }) courseId: string) {
    return this.grades.listItems(courseId);
  }
  @Patch('grades/items/:itemId')
  /**
   * PATCH /courses/grades/items/:itemId — cập nhật item.
   */
  async updateItem(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Body({ schema: updateGradeItemSchema }) dto: UpdateGradeItemDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.updateItem(actor.id, itemId, dto);
  }
  @Delete('grades/items/:itemId')
  /**
   * DELETE /courses/grades/items/:itemId — xoá item.
   */
  async deleteItem(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.grades.deleteItem(actor.id, itemId);
    return { deleted: true };
  }

  @Post('grades/items/:itemId/grades')
  /**
   * POST /courses/grades/items/:itemId/grades — nhập điểm cho user.
   */
  async setGrade(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Body({ schema: setGradeSchema }) dto: SetGradeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.setGrade(actor.id, itemId, dto.userId, dto);
  }
  @Patch('grades/grades/:gradeId')
  /**
   * PATCH /courses/grades/:gradeId — sửa một bản ghi điểm.
   */
  async updateGrade(@Param('gradeId', { schema: uuidIdSchema }) gradeId: string, @Body({ schema: updateGradeSchema }) dto: UpdateGradeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.updateGrade(actor.id, gradeId, dto);
  }
  @Put('grades/items/:itemId/posting-policy')
  /**
   * PUT /courses/grades/items/:itemId/posting-policy — đặt chính sách công bố của item (PH-0): auto | manual.
   */
  async setPostingPolicy(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Body({ schema: setGradePostingPolicySchema }) dto: SetGradePostingPolicyDto, @CurrentUser() actor: AuthenticatedUser) {
    const item = await this.grades.setItemPostingPolicy(actor.id, itemId, dto.policy);
    return { itemId: item.id, policy: item.postingPolicy };
  }
  @Post('grades/items/:itemId/publish')
  /**
   * POST /courses/grades/items/:itemId/publish — công bố điểm của item cho mọi học sinh (ghi vết grade_publications + event_log).
   */
  async publishItem(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Body({ schema: gradePublicationActionSchema }) dto: GradePublicationActionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.setItemPublication(actor.id, itemId, 'publish', dto.note);
  }
  @Post('grades/items/:itemId/unpublish')
  /**
   * POST /courses/grades/items/:itemId/unpublish — rút công bố điểm của item (học sinh mất quyền thấy điểm cho tới khi công bố lại).
   */
  async unpublishItem(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Body({ schema: gradePublicationActionSchema }) dto: GradePublicationActionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.setItemPublication(actor.id, itemId, 'unpublish', dto.note);
  }

  @Get('grades/items/:itemId/users/:userId/history')
  /**
   * GET /courses/grades/items/:itemId/users/:userId/history — lịch sử thay đổi điểm.
   */
  async history(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    const item = await this.grades.getItem(itemId);
    if (actor.id !== userId) {
      // History of another user requires grade:viewall at the course context.
      await this.grades.getReport(actor.id, item.courseId);
    }
    return this.grades.listHistory(itemId, userId);
  }

  @Get(':courseId/gradebook')
  /**
   * GET /courses/:courseId/gradebook — sổ điểm của user (mặc định là chính mình).
   */
  async gradebook(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Query('userId') userId: string | undefined, @CurrentUser() viewer: AuthenticatedUser) {
    const target = userId || viewer.id;
    return this.grades.getGradebook(viewer.id, courseId, target);
  }
  @Get(':courseId/grades/report')
  /**
   * GET /courses/:courseId/grades/report — báo cáo điểm toàn lớp.
   */
  async report(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() viewer: AuthenticatedUser) {
    return this.grades.getReport(viewer.id, courseId);
  }
  @Post(':courseId/grades/regrade')
  /**
   * POST /courses/:courseId/grades/regrade — tính lại điểm toàn khoá học.
   */
  async regrade(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.triggerRegrade(actor.id, courseId);
  }

  @Get(':courseId/grades/export')
  /**
   * GET /courses/:courseId/grades/export — xuất điểm toàn khoá ra CSV (một dòng mỗi người học, một cột mỗi grade item, điểm tổng ở cột cuối).
   */
  async exportCsv(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() actor: AuthenticatedUser, @Res() res: Response) {
    const { filename, csv } = await this.grades.exportGradesCsv(actor.id, courseId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }
  @Post(':courseId/grades/export/vnedu')
  @HttpCode(200)
  /**
   * POST /courses/:courseId/grades/export/vnedu — xuất sổ điểm ra Excel theo cấu trúc vnEdu/TT 22/2021 (issue #53):
   * body mang ánh xạ mục điểm → loại cột (thường xuyên/giữa kỳ/cuối kỳ) do giáo viên xác nhận; trả file .xlsx đính kèm.
   */
  async exportVnedu(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: exportGradesVneduSchema }) dto: ExportGradesVneduDto, @CurrentUser() actor: AuthenticatedUser, @Res() res: Response) {
    const { filename, buffer } = await this.grades.exportGradesVnedu(actor.id, courseId, dto);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }
  @Post(':courseId/grades/import')
  @UseInterceptors(FileInterceptor('file'))
  /**
   * POST /courses/:courseId/grades/import — nhập điểm từ file CSV (multipart, trường `file`; trường tuỳ chọn `userIdentifier`: username|email|userId).
   * Trả báo cáo: số ô đã nhập, số ô bỏ qua, lỗi theo dòng/cột và các cột bị bỏ qua.
   */
  async importCsv(
    @Param('courseId', { schema: uuidIdSchema }) courseId: string,
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @Body('userIdentifier') userIdentifier: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    if (!file) {
      throw new BadRequestException({ message: 'A CSV file is required in the multipart field "file"', code: 'grades.import_file_required' });
    }
    return this.grades.importGradesCsv(actor.id, courseId, file.buffer.toString('utf-8'), { userIdentifier });
  }

  @Get(':courseId/grades/letters')
  /**
   * GET /courses/:courseId/grades/letters — bảng chữ cái điểm.
   */
  async letters(@Param('courseId', { schema: uuidIdSchema }) courseId: string) {
    return this.grades.getLetters(courseId);
  }
  @Put(':courseId/grades/letters')
  /**
   * PUT /courses/:courseId/grades/letters — đặt bảng chữ cái điểm.
   */
  async setLetters(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: setGradeLettersSchema }) dto: SetLettersDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.setLetters(actor.id, courseId, dto.letters);
  }

  @Post(':courseId/grades/scales')
  /**
   * POST /courses/:courseId/grades/scales — tạo scale cho khoá học.
   */
  async createScale(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: createGradeScaleSchema }) dto: CreateScaleDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.createScale(actor.id, courseId, dto);
  }
  @Get(':courseId/grades/scales')
  /**
   * GET /courses/:courseId/grades/scales — liệt kê scales của khoá học.
   */
  async scales(@Param('courseId', { schema: uuidIdSchema }) courseId: string) {
    return this.grades.listScales(courseId);
  }

  @Post(':courseId/grades/outcomes')
  /**
   * POST /courses/:courseId/grades/outcomes — tạo grade outcome mức khoá học.
   */
  async createOutcome(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: createGradeOutcomeSchema }) dto: CreateGradeOutcomeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.createOutcome(actor.id, courseId, dto);
  }
  @Get(':courseId/grades/outcomes')
  /**
   * GET /courses/:courseId/grades/outcomes — liệt kê outcome của khoá học và outcome mức site.
   */
  async listOutcomes(@Param('courseId', { schema: uuidIdSchema }) courseId: string) {
    return this.grades.listOutcomes(courseId);
  }
  @Patch('grades/outcomes/:outcomeId')
  /**
   * PATCH /courses/grades/outcomes/:outcomeId — cập nhật grade outcome.
   */
  async updateOutcome(@Param('outcomeId', { schema: uuidIdSchema }) outcomeId: string, @Body({ schema: updateGradeOutcomeSchema }) dto: UpdateGradeOutcomeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.updateOutcome(actor.id, outcomeId, dto);
  }
  @Delete('grades/outcomes/:outcomeId')
  /**
   * DELETE /courses/grades/outcomes/:outcomeId — xoá grade outcome.
   */
  async deleteOutcome(@Param('outcomeId', { schema: uuidIdSchema }) outcomeId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.grades.deleteOutcome(actor.id, outcomeId);
    return { deleted: true };
  }
}

@ApiTags('grades')
@Controller({ path: 'courses', version: '1' })
/**
 * API sổ điểm VN (GB-VN-1, issue #95): mở sổ TT 22 cho khoá học × học kì,
 * tính/chốt kết quả học kì và cả năm, ghi kết quả môn chỉ-nhận-xét.
 */
export class VnGradebooksController {
  constructor(private readonly vn: VnGradebooksService) {}

  /** Kiểm sổ thuộc đúng khoá học trên đường dẫn; lệch khoá thì coi như không tồn tại. */
  private async bookInCourse(courseId: string, bookId: string) {
    const book = await this.vn.getBook(bookId);
    if (book.courseId !== courseId) {
      throw new BadRequestException({ message: 'VN gradebook belongs to another course', code: 'grades.vn_book_course_mismatch' });
    }
    return book;
  }

  @Post(':courseId/grades/vn-books')
  /**
   * POST /courses/:courseId/grades/vn-books — mở sổ VN (tự sinh cột theo quota số tiết với môn điểm số).
   */
  async createBook(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: createVnGradebookSchema }) dto: CreateVnGradebookDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.vn.createBook(actor.id, courseId, dto);
  }
  @Get(':courseId/grades/vn-books')
  /**
   * GET /courses/:courseId/grades/vn-books — các sổ VN của khoá học kèm cột.
   */
  async listBooks(@Param('courseId', { schema: uuidIdSchema }) courseId: string) {
    return this.vn.listBooks(courseId);
  }
  @Get(':courseId/grades/vn-books/:bookId')
  /**
   * GET /courses/:courseId/grades/vn-books/:bookId — một sổ VN kèm cột.
   */
  async getBook(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Param('bookId', { schema: uuidIdSchema }) bookId: string) {
    await this.bookInCourse(courseId, bookId);
    return this.vn.getBookView(bookId);
  }
  @Get(':courseId/grades/vn-books/:bookId/results/:userId')
  /**
   * GET .../results/:userId — tính kết quả học kì trực tiếp từ điểm cột hiện tại (chưa chốt).
   * Gác actor ở service: chính chủ (đã ghi danh) hoặc grade:viewall tại khoá — tiền lệ getGradebook.
   */
  async computeResult(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Param('bookId', { schema: uuidIdSchema }) bookId: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.bookInCourse(courseId, bookId);
    return this.vn.computeTermResult(actor.id, bookId, userId);
  }
  @Get(':courseId/grades/vn-books/:bookId/results/:userId/snapshots')
  /**
   * GET .../results/:userId/snapshots — các bản chốt kết quả đã ghi cho học sinh trong sổ.
   * Gác actor ở service như route results.
   */
  async listSnapshots(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Param('bookId', { schema: uuidIdSchema }) bookId: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.bookInCourse(courseId, bookId);
    return this.vn.listTermResults(actor.id, bookId, userId);
  }
  @Post(':courseId/grades/vn-books/:bookId/results/:userId/finalize')
  /**
   * POST .../results/:userId/finalize — chốt kết quả học kì (ĐTBmhk) thành bản snapshot mới.
   */
  async finalizeResult(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Param('bookId', { schema: uuidIdSchema }) bookId: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @Body({ schema: finalizeVnTermResultSchema }) dto: FinalizeVnTermResultDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.bookInCourse(courseId, bookId);
    return this.vn.finalizeTermResult(actor.id, bookId, userId, dto.comment);
  }
  @Post(':courseId/grades/vn-books/:bookId/results/:userId/publish')
  /**
   * POST .../results/:userId/publish — công bố kết quả học kì của học sinh trong sổ (PH-0; finalize mới là chốt nội bộ, công bố là bước riêng).
   */
  async publishResult(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Param('bookId', { schema: uuidIdSchema }) bookId: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @Body({ schema: gradePublicationActionSchema }) dto: GradePublicationActionDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.bookInCourse(courseId, bookId);
    return this.vn.setTermResultPublication(actor.id, bookId, userId, 'publish', dto.note);
  }
  @Post(':courseId/grades/vn-books/:bookId/results/:userId/unpublish')
  /**
   * POST .../results/:userId/unpublish — rút công bố kết quả học kì của học sinh trong sổ (PH-0).
   */
  async unpublishResult(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Param('bookId', { schema: uuidIdSchema }) bookId: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @Body({ schema: gradePublicationActionSchema }) dto: GradePublicationActionDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.bookInCourse(courseId, bookId);
    return this.vn.setTermResultPublication(actor.id, bookId, userId, 'unpublish', dto.note);
  }

  @Post(':courseId/grades/vn-books/:bookId/results/:userId/comment-result')
  /**
   * POST .../results/:userId/comment-result — ghi kết quả Đạt/Chưa đạt cho môn chỉ-nhận-xét.
   */
  async setCommentResult(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Param('bookId', { schema: uuidIdSchema }) bookId: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @Body({ schema: setVnCommentResultSchema }) dto: SetVnCommentResultDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.bookInCourse(courseId, bookId);
    return this.vn.setCommentResult(actor.id, bookId, userId, dto);
  }
  @Post(':courseId/grades/vn-books/:bookId/activity-mappings')
  /**
   * POST .../vn-books/:bookId/activity-mappings — khai vai trò điểm cho một hoạt động vào một cột của sổ (GB-VN-2).
   */
  async createActivityMapping(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Param('bookId', { schema: uuidIdSchema }) bookId: string, @Body({ schema: createVnActivityMappingSchema }) dto: CreateVnActivityMappingDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.bookInCourse(courseId, bookId);
    return this.vn.createActivityMapping(actor.id, bookId, dto);
  }
  @Get(':courseId/grades/vn-books/:bookId/activity-mappings')
  /**
   * GET .../vn-books/:bookId/activity-mappings — các khai vai trò điểm của sổ, kèm truy vết nguồn/đích.
   */
  async listActivityMappings(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Param('bookId', { schema: uuidIdSchema }) bookId: string) {
    await this.bookInCourse(courseId, bookId);
    return this.vn.listActivityMappings(bookId);
  }
  @Delete(':courseId/grades/vn-books/:bookId/activity-mappings/:mappingId')
  /**
   * DELETE .../vn-books/:bookId/activity-mappings/:mappingId — gỡ khai vai trò của một hoạt động khỏi sổ.
   */
  async deleteActivityMapping(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Param('bookId', { schema: uuidIdSchema }) bookId: string, @Param('mappingId', { schema: uuidIdSchema }) mappingId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.bookInCourse(courseId, bookId);
    return this.vn.deleteActivityMapping(actor.id, bookId, mappingId);
  }
  @Get(':courseId/grades/vn-books/:bookId/candidates')
  /**
   * GET .../vn-books/:bookId/candidates — hộp ứng viên điểm của sổ: điểm hoạt động + quy đổi thang 10 + trạng thái quyết định (GB-VN-2).
   */
  async listCandidates(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Param('bookId', { schema: uuidIdSchema }) bookId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.bookInCourse(courseId, bookId);
    return this.vn.listCandidates(actor.id, bookId);
  }
  @Post(':courseId/grades/vn-books/:bookId/candidates/:mappingId/students/:userId/commit')
  /**
   * POST .../candidates/:mappingId/students/:userId/commit — GV chốt ứng viên vào cột (truyền value là sửa-chốt, điểm mang cờ overridden).
   */
  async commitCandidate(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Param('bookId', { schema: uuidIdSchema }) bookId: string, @Param('mappingId', { schema: uuidIdSchema }) mappingId: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @Body({ schema: commitVnCandidateSchema }) dto: CommitVnCandidateDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.bookInCourse(courseId, bookId);
    return this.vn.commitCandidate(actor.id, bookId, mappingId, userId, dto);
  }
  @Post(':courseId/grades/vn-books/:bookId/candidates/:mappingId/students/:userId/dismiss')
  /**
   * POST .../candidates/:mappingId/students/:userId/dismiss — GV bỏ qua ứng viên (hiện lại khi điểm hoạt động thay đổi).
   */
  async dismissCandidate(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Param('bookId', { schema: uuidIdSchema }) bookId: string, @Param('mappingId', { schema: uuidIdSchema }) mappingId: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @Body({ schema: dismissVnCandidateSchema }) dto: DismissVnCandidateDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.bookInCourse(courseId, bookId);
    return this.vn.dismissCandidate(actor.id, bookId, mappingId, userId);
  }
  @Post(':courseId/grades/vn-books/:bookId/columns/:itemId/students/:userId/makeup-status')
  /**
   * POST .../columns/:itemId/students/:userId/makeup-status — đặt trạng thái kiểm tra bù cho cột định kì: chờ bù / ghi 0 điểm (Điều 7.5) / gỡ đánh dấu (GB-VN-2).
   */
  async setMakeupStatus(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Param('bookId', { schema: uuidIdSchema }) bookId: string, @Param('itemId', { schema: uuidIdSchema }) itemId: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @Body({ schema: setVnMakeupStatusSchema }) dto: SetVnMakeupStatusDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.bookInCourse(courseId, bookId);
    return this.vn.setMakeupStatus(actor.id, bookId, itemId, userId, dto);
  }
  @Post(':courseId/grades/vn-year-results/:userId/finalize')
  /**
   * POST /courses/:courseId/grades/vn-year-results/:userId/finalize — chốt ĐTBmcn từ hai bản chốt học kì.
   */
  async finalizeYear(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @Body({ schema: finalizeVnYearResultSchema }) dto: FinalizeVnYearResultDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.vn.finalizeYearResult(actor.id, courseId, userId, dto.comment);
  }
  @Post(':courseId/grades/vn-year-results/:userId/publish')
  /**
   * POST /courses/:courseId/grades/vn-year-results/:userId/publish — công bố kết quả cả năm của học sinh trong khoá (PH-0).
   */
  async publishYear(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @Body({ schema: gradePublicationActionSchema }) dto: GradePublicationActionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.vn.setYearResultPublication(actor.id, courseId, userId, 'publish', dto.note);
  }
  @Post(':courseId/grades/vn-year-results/:userId/unpublish')
  /**
   * POST /courses/:courseId/grades/vn-year-results/:userId/unpublish — rút công bố kết quả cả năm của học sinh trong khoá (PH-0).
   */
  async unpublishYear(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @Body({ schema: gradePublicationActionSchema }) dto: GradePublicationActionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.vn.setYearResultPublication(actor.id, courseId, userId, 'unpublish', dto.note);
  }

  @Get(':courseId/grades/vn-year-results/:userId')
  /**
   * GET /courses/:courseId/grades/vn-year-results/:userId — bản chốt cả năm mới nhất của học sinh trong khoá.
   * Gác actor ở service như route results (cùng bệnh rò điểm, phát hiện khi rà soát vá #95).
   */
  async latestYear(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    return (await this.vn.latestYearResult(actor.id, courseId, userId)) ?? null;
  }
}

@ApiTags('grades')
@Controller({ path: 'grades/vn', version: '1' })
/**
 * API xếp mức học tập chung theo Điều 9 TT 22 trên các bản chốt của mọi sổ VN.
 */
export class VnClassificationController {
  constructor(private readonly vn: VnGradebooksService) {}

  @Get('students/:userId/classification')
  /**
   * GET /grades/vn/students/:userId/classification?period=hk1|hk2|year — mức Tốt/Khá/Đạt/Chưa đạt
   * (kèm mức gốc và môn gây điều chỉnh 9.3 nếu có).
   */
  async classification(@Param('userId', { schema: uuidIdSchema }) userId: string, @Query('period') period: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    const p = period ?? 'hk1';
    if (p !== 'hk1' && p !== 'hk2' && p !== 'year') {
      throw new BadRequestException({ message: `Unknown period ${p}`, code: 'grades.vn_bad_period' });
    }
    return this.vn.getStudentClassification(actor.id, userId, p);
  }
}

@ApiTags('grades')
@Controller({ path: 'grades', version: '1' })
/**
 * API grade outcome/scale mức site (không thuộc một khoá học cụ thể).
 */
export class SiteGradesController {
  constructor(private readonly grades: GradesService) {}

  @Post('outcomes')
  /**
   * POST /grades/outcomes — tạo grade outcome mức site.
   */
  async createSiteOutcome(@Body({ schema: createGradeOutcomeSchema }) dto: CreateGradeOutcomeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.createOutcome(actor.id, null, dto);
  }
  @Get('outcomes')
  /**
   * GET /grades/outcomes — liệt kê grade outcome mức site.
   */
  async listSiteOutcomes() {
    return this.grades.listOutcomes();
  }
  @Post('scales')
  /**
   * POST /grades/scales — tạo scale mức site.
   */
  async createSiteScale(@Body({ schema: createGradeScaleSchema }) dto: CreateScaleDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.createSiteScale(actor.id, dto);
  }
}

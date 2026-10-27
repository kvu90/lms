import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { clientIpOf } from '../../common/client-ip';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { QuizService } from './quiz.service';
import { MatrixImportService } from './matrix-import.service';
import {
  createExamMatrixCellSchema, createExamMatrixSchema, gradeQuizQuestionSchema, manualGradeQuizSchema,
  recordQuizAttemptEventSchema, submitQuizResponseSchema, updateExamMatrixCellSchema, updateExamMatrixSchema,
  withdrawExamMatrixSchema,
  type CreateExamMatrixCellDto, type CreateExamMatrixDto, type GradeQuizQuestionDto, type ManualGradeQuizDto,
  type RecordQuizAttemptEventDto, type SubmitQuizResponseDto, type UpdateExamMatrixCellDto, type UpdateExamMatrixDto,
  type WithdrawExamMatrixDto,
} from './dto/quiz.dto';

/**
 * Bề mặt `/quizzes` (soạn bài trong khoá) đã BỎ hẳn theo feat hợp
 * nhất #226: bài kiểm tra trong khoá là một PIN của thực thể Đề —
 * tạo/sửa/attempt đi qua `/exam-pins` (ExamPinsController ở
 * ExamsModule). File này chỉ còn ma trận đề và lượt làm (đường
 * `/quiz-attempts` giữ nguyên theo hồ sơ — tên kỹ thuật mod_quiz
 * không đổi).
 */

@ApiTags('exam-matrices')
@Controller({ path: 'exam-matrices', version: '1' })
/**
 * API ma trận đề (Quiz Chặng 3): thực thể lưu trữ neo Chương trình GDPT
 * 2018, các ô YCCĐ × mức × dạng, kiểm tra khả dụng ngân hàng và (ở
 * ExamsModule) sinh đề từ ma trận. Đây là nền của ngân hàng ma
 * trận trong khu vực Ngân hàng hệ thống về sau.
 */
export class ExamMatricesController {
  constructor(
    private readonly quiz: QuizService,
    private readonly matrixImport: MatrixImportService,
  ) {}

  @Post()
  /**
   * POST /exam-matrices — tạo ma trận (tỉ lệ mục tiêu chụp từ preset khi không cho riêng).
   */
  async create(@Body({ schema: createExamMatrixSchema }) dto: CreateExamMatrixDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.createMatrix(actor.id, dto);
  }
  @Get('template')
  /**
   * GET /exam-matrices/template?subjectId&curriculumId&levelSet&scopeNodeIds —
   * tải workbook MẪU nhập ma trận (.xlsx, lát I-1 của issue #233):
   * hệ sinh sẵn hàng theo đơn vị kiến thức của chương trình + cột khoá
   * "Mã ĐVK", giáo viên chỉ điền số. `scopeNodeIds` truyền dạng danh
   * sách id phân tách bằng dấu phẩy. Route tĩnh phải đứng trước
   * `@Get(':id')` để không bị nuốt thành id.
   */
  async template(@Query('subjectId') subjectId: string | undefined, @Query('curriculumId') curriculumId: string | undefined, @Query('levelSet') levelSet: string | undefined, @Query('scopeNodeIds') scopeNodeIds: string | undefined, @CurrentUser() actor: AuthenticatedUser, @Res() res: Response) {
    if (!subjectId || !uuidIdSchema.safeParse(subjectId).success || !curriculumId || !uuidIdSchema.safeParse(curriculumId).success) {
      throw new BadRequestException({ message: 'subjectId and curriculumId query parameters must be uuids', code: 'quiz.matrix_import_query_invalid' });
    }
    if (levelSet !== undefined && levelSet !== 'three' && levelSet !== 'four') {
      throw new BadRequestException({ message: 'levelSet must be three or four', code: 'quiz.matrix_import_query_invalid' });
    }
    let scope: string[] | null = null;
    if (scopeNodeIds) {
      scope = scopeNodeIds.split(',').map((x) => x.trim()).filter((x) => x !== '');
      if (scope.some((x) => !uuidIdSchema.safeParse(x).success)) {
        throw new BadRequestException({ message: 'scopeNodeIds must be a comma-separated list of uuids', code: 'quiz.matrix_import_query_invalid' });
      }
    }
    const { filename, contentType, buffer } = await this.matrixImport.buildTemplate(actor.id, {
      subjectId, curriculumId, levelSet: levelSet as 'three' | 'four' | undefined, scopeNodeIds: scope,
    });
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }
  @Post('import/preview')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  /**
   * POST /exam-matrices/import/preview (multipart, trường `file`) —
   * parse file mẫu đã điền và trả XEM TRƯỚC (lát I-1, issue #233):
   * dự thảo ma trận + lỗi cứng định vị theo sheet/dòng/cột + cảnh báo
   * tỉ lệ + khả dụng ngân hàng theo ô. KHÔNG ghi DB — ghi nguyên tử
   * là lát I-2. Route tĩnh phải đứng trước `@Post(':id/cells')`.
   *
   * Mã trả LUÔN 200 kể cả khi file sai khuôn (đây là thao tác phân
   * tích, không tạo tài nguyên): lỗi nằm trong payload preview
   * (`valid=false` + `errors[]`), để web hiển thị định vị từng lỗi.
   */
  async importPreview(@UploadedFile() file: { buffer: Buffer } | undefined, @CurrentUser() actor: AuthenticatedUser) {
    if (!file) {
      throw new BadRequestException({ message: 'An .xlsx file is required in the multipart field "file"', code: 'quiz.matrix_import_file_required' });
    }
    return this.matrixImport.previewImport(actor.id, file.buffer);
  }
  @Post('import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  /**
   * POST /exam-matrices/import (multipart, trường `file`) — GHI ma
   * trận từ file đã điền (lát I-2, issue #233): client tải lại chính
   * file đã xem trước; server parse lại từ đầu, chạy lại toàn bộ luật
   * hợp lệ của bước xem trước tại thời điểm ghi rồi ghi NGUYÊN TỬ
   * (ma trận mới + toàn bộ ô trong một transaction) vào bank ma trận
   * cá nhân của người nhập, trạng thái draft. Trả 201 + view ma trận
   * như `GET /exam-matrices/:id`. File không còn hợp lệ tại thời điểm
   * ghi → 422 ProblemDetails mã `quiz.matrix_import_invalid` kèm
   * `matrixImportIssues` định vị từng lỗi, không ghi một phần. Gửi
   * lại cùng một nội dung (double submit/retry) trả ma trận đã có
   * thay vì tạo bản thứ hai. Route tĩnh phải đứng trước
   * `@Post(':id/cells')`.
   */
  async importCommit(@UploadedFile() file: { buffer: Buffer } | undefined, @CurrentUser() actor: AuthenticatedUser) {
    if (!file) {
      throw new BadRequestException({ message: 'An .xlsx file is required in the multipart field "file"', code: 'quiz.matrix_import_file_required' });
    }
    return this.matrixImport.commitImport(actor.id, file.buffer);
  }
  @Get('by-subject/:subjectId')
  /**
   * GET /exam-matrices/by-subject/:subjectId — các ma trận của một môn.
   */
  async listBySubject(@Param('subjectId', { schema: uuidIdSchema }) subjectId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.listMatrices(actor.id, subjectId);
  }
  @Get(':id')
  /**
   * GET /exam-matrices/:id — một ma trận kèm ô + cảnh báo lệch tỉ lệ.
   */
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.getMatrix(actor.id, id);
  }
  @Get(':id/versions/:version')
  /**
   * GET /exam-matrices/:id/versions/:version — nội dung nguyên vẹn
   * của đúng một version bất biến của ma trận (cấu hình + ô tại
   * version đó); version không tồn tại → 404.
   */
  async getVersion(@Param('id', { schema: uuidIdSchema }) id: string, @Param('version') version: string, @CurrentUser() actor: AuthenticatedUser) {
    const parsed = Number(version);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException({ message: 'version must be a positive integer', code: 'quiz.matrix_version_invalid' });
    }
    return this.quiz.getMatrixVersion(actor.id, id, parsed);
  }
  @Get(':id/generated-exams')
  /**
   * GET /exam-matrices/:id/generated-exams — truy nguồn chiều ngược
   * của ma trận: các version đề đã sinh từ ma trận này (kèm số
   * version ma trận đã neo lúc sinh đề). Cổng xem như đọc chi tiết
   * ma trận.
   */
  async generatedExams(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.listGeneratedExams(actor.id, id);
  }
  @Patch(':id')
  /**
   * PATCH /exam-matrices/:id — sửa ma trận (matrix:edit).
   */
  async update(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updateExamMatrixSchema }) dto: UpdateExamMatrixDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.updateMatrix(actor.id, id, dto);
  }
  @Post(':id/withdraw')
  /**
   * POST /exam-matrices/:id/withdraw — rút ma trận khỏi ngân hàng kèm lý do bắt buộc và truy vết người rút/thời điểm (ngang hàng rút đề/câu hỏi); đề đã sinh từ ma trận không bị ảnh hưởng.
   */
  async withdraw(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: withdrawExamMatrixSchema }) dto: WithdrawExamMatrixDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.withdrawMatrix(actor.id, id, dto);
  }
  @Post(':id/restore')
  /**
   * POST /exam-matrices/:id/restore — khôi phục ma trận đã rút về ready, xoá truy vết lần rút.
   */
  async restore(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.restoreMatrix(actor.id, id);
  }
  @Delete(':id')
  /**
   * DELETE /exam-matrices/:id — xoá ma trận (đề đã sinh không bị xoá theo).
   */
  async remove(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.quiz.deleteMatrix(actor.id, id);
    return { deleted: true };
  }
  @Post(':id/cells')
  /**
   * POST /exam-matrices/:id/cells — thêm ô YCCĐ × mức × dạng.
   */
  async addCell(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: createExamMatrixCellSchema }) dto: CreateExamMatrixCellDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.createMatrixCell(actor.id, id, dto);
  }
  @Patch(':id/cells/:cellId')
  /**
   * PATCH /exam-matrices/:id/cells/:cellId — sửa số câu/điểm/thời gian/thang của ô.
   */
  async updateCell(@Param('id', { schema: uuidIdSchema }) id: string, @Param('cellId', { schema: uuidIdSchema }) cellId: string, @Body({ schema: updateExamMatrixCellSchema }) dto: UpdateExamMatrixCellDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.updateMatrixCell(actor.id, id, cellId, dto);
  }
  @Delete(':id/cells/:cellId')
  /**
   * DELETE /exam-matrices/:id/cells/:cellId — xoá ô khỏi ma trận.
   */
  async removeCell(@Param('id', { schema: uuidIdSchema }) id: string, @Param('cellId', { schema: uuidIdSchema }) cellId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.deleteMatrixCell(actor.id, id, cellId);
  }
  @Get(':id/availability')
  /**
   * GET /exam-matrices/:id/availability — khả dụng ngân hàng theo từng ô (cần/có/thiếu; ô Đ–S đếm theo chùm).
   */
  async availability(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.matrixAvailability(actor.id, id);
  }
  // POST /exam-matrices/:id/generate ở ExamsModule (EB-2: generate
  // hai bước matrix → exam → ghim, xem ExamMatrixGenerateController)
  // — route giữ nguyên URL cho GV.
  @Get(':id/specification')
  /**
   * GET /exam-matrices/:id/specification — view model bản đặc tả theo
   * Mẫu 2 CV 7991; truyền `pinId` của bài đã sinh từ ma trận này để
   * có vị trí câu thật.
   */
  async specification(@Param('id', { schema: uuidIdSchema }) id: string, @Query('pinId') pinId: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    if (pinId !== undefined && !uuidIdSchema.safeParse(pinId).success) {
      throw new BadRequestException({ message: 'pinId must be a uuid', code: 'quiz.spec_quiz_invalid' });
    }
    return this.quiz.getMatrixSpecification(actor.id, id, pinId);
  }
  @Get(':id/specification/export')
  /**
   * GET /exam-matrices/:id/specification/export?format=xlsx|docx —
   * xuất bản đặc tả ra file nộp/lưu hồ sơ (kèm `pinId` khi cần vị trí
   * câu thật).
   */
  async exportSpecification(@Param('id', { schema: uuidIdSchema }) id: string, @Query('format') format: string | undefined, @Query('pinId') pinId: string | undefined, @CurrentUser() actor: AuthenticatedUser, @Res() res: Response) {
    if (pinId !== undefined && !uuidIdSchema.safeParse(pinId).success) {
      throw new BadRequestException({ message: 'pinId must be a uuid', code: 'quiz.spec_quiz_invalid' });
    }
    const { filename, contentType, buffer } = await this.quiz.exportMatrixSpecification(actor.id, id, format ?? 'xlsx', pinId);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }
}

@ApiTags('quiz-attempts')
@Controller({ path: 'quiz-attempts', version: '1' })
/**
 * API một lượt làm bài: đọc đề theo trang, lưu câu trả lời, nộp bài và
 * chấm tay từng câu (ủy quyền cho question engine). Đường giữ nguyên
 * theo hồ sơ hợp nhất #226 (attempt neo pin ở tầng dữ liệu).
 */
export class QuizAttemptsController {
  constructor(private readonly quiz: QuizService) {}

  @Get(':id')
  /**
   * GET /quiz-attempts/:id — toàn bộ lượt làm (câu theo trang, đáp án đã lưu, điểm khi đã nộp); quá hạn làm bài thì lượt bị chốt phía server.
   */
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.getAttemptView(actor.id, id);
  }
  @Post(':id/responses')
  /**
   * POST /quiz-attempts/:id/responses — lưu câu trả lời cho một câu (cổng subnet được kiểm lại tại đây theo IP khách thật).
   */
  async respond(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: submitQuizResponseSchema }) dto: SubmitQuizResponseDto, @CurrentUser() actor: AuthenticatedUser, @Req() req: Request) {
    return this.quiz.submitResponse(actor.id, id, dto, clientIpOf(req));
  }
  @Post(':id/submit')
  /**
   * POST /quiz-attempts/:id/submit — nộp bài: engine chấm, điểm bài ghi vào sổ điểm (essay chưa chấm thì lượt ở trạng thái chờ chấm tay).
   */
  async submit(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.submitAttempt(actor.id, id);
  }
  @Post(':id/questions/:questionAttemptId/grade')
  /**
   * POST /quiz-attempts/:id/questions/:questionAttemptId/grade — chấm tay một câu essay (quiz:grade).
   */
  async grade(@Param('id', { schema: uuidIdSchema }) id: string, @Param('questionAttemptId', { schema: uuidIdSchema }) questionAttemptId: string, @Body({ schema: manualGradeQuizSchema }) dto: ManualGradeQuizDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.manualGrade(actor.id, id, { questionAttemptId, mark: dto.mark, comment: dto.comment });
  }
  @Post(':id/events')
  /**
   * POST /quiz-attempts/:id/events — client báo một sự kiện giám sát (thoát fullscreen / mất focus / ngắt kết nối dài). CHỈ GHI NHẬN: không tự kết luận gian lận, không hệ quả lên lượt làm.
   */
  async recordEvent(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: recordQuizAttemptEventSchema }) dto: RecordQuizAttemptEventDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.recordAttemptEvent(actor.id, id, dto);
  }
  @Get(':id/events')
  /**
   * GET /quiz-attempts/:id/events — nhật ký sự kiện giám sát của lượt (chủ lượt hoặc người có quyền chấm/báo cáo).
   */
  async listEvents(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.listAttemptEvents(actor.id, id);
  }
}

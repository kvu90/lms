import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { clientIpOf } from '../../common/client-ip';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { QuizService } from './quiz.service';
import {
  addQuizSlotSchema, clusterQuizSlotsSchema, createExamMatrixCellSchema, createExamMatrixSchema, createQuizFeedbackSchema, createQuizOverrideSchema, createQuizSchema, gradeQuizQuestionSchema, manualGradeQuizSchema, recordQuizAttemptEventSchema, startQuizAttemptSchema,
  submitQuizResponseSchema, swapQuizSlotSchema, updateExamMatrixCellSchema, updateExamMatrixSchema, updateQuizOverrideSchema, updateQuizSchema, updateQuizSlotSchema,
  type AddQuizSlotDto, type ClusterQuizSlotsDto, type CreateExamMatrixCellDto, type CreateExamMatrixDto, type CreateQuizDto, type CreateQuizFeedbackDto, type CreateQuizOverrideDto, type GradeQuizQuestionDto, type ManualGradeQuizDto, type RecordQuizAttemptEventDto, type StartQuizAttemptDto,
  type SubmitQuizResponseDto, type SwapQuizSlotDto, type UpdateExamMatrixCellDto, type UpdateExamMatrixDto, type UpdateQuizDto, type UpdateQuizOverrideDto, type UpdateQuizSlotDto,
} from './dto/quiz.dto';

@ApiTags('quizzes')
@Controller({ path: 'courses/:courseId/quizzes', version: '1' })
/**
 * API tạo và liệt kê hoạt động Quiz trong một khoá học.
 */
export class CourseQuizzesController {
  constructor(private readonly quiz: QuizService) {}

  @Post()
  /**
   * POST /courses/:courseId/quizzes — tạo quiz (kèm course module + grade item).
   */
  async create(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: createQuizSchema }) dto: CreateQuizDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.createQuiz(actor.id, courseId, dto);
  }
  @Get()
  /**
   * GET /courses/:courseId/quizzes — các quiz trong khoá học.
   */
  async list(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.listQuizzes(actor.id, courseId);
  }
}

@ApiTags('quizzes')
@Controller({ path: 'quizzes', version: '1' })
/**
 * API hoạt động Quiz: cài đặt, dựng đề (slots), thông tin cho người xem,
 * bắt đầu lượt làm và báo cáo kết quả cho giáo viên.
 */
export class QuizzesController {
  constructor(private readonly quiz: QuizService) {}

  @Get(':id')
  /**
   * GET /quizzes/:id — thông tin quiz cho người xem (cấu hình, slots, các
   * lượt của chính mình, điểm bài hiện tại, cờ quyền).
   */
  async getForUser(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.getQuizForUser(actor.id, id);
  }
  @Patch(':id')
  /**
   * PATCH /quizzes/:id — sửa cài đặt quiz (quiz:manage).
   */
  async update(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updateQuizSchema }) dto: UpdateQuizDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.updateQuiz(actor.id, id, dto);
  }
  @Delete(':id')
  /**
   * DELETE /quizzes/:id — xoá quiz cùng cm, grade item và các lượt làm.
   */
  async remove(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.quiz.deleteQuiz(actor.id, id);
    return { deleted: true };
  }
  @Post(':id/slots')
  /**
   * POST /quizzes/:id/slots — thêm slot (câu cố định hoặc ngẫu nhiên theo category).
   */
  async addSlot(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: addQuizSlotSchema }) dto: AddQuizSlotDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.addSlot(actor.id, id, dto);
  }
  @Patch(':id/slots/:slotId')
  /**
   * PATCH /quizzes/:id/slots/:slotId — sửa điểm/trang/vị trí của slot.
   */
  async updateSlot(@Param('id', { schema: uuidIdSchema }) id: string, @Param('slotId', { schema: uuidIdSchema }) slotId: string, @Body({ schema: updateQuizSlotSchema }) dto: UpdateQuizSlotDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.updateSlot(actor.id, id, slotId, dto);
  }
  @Delete(':id/slots/:slotId')
  /**
   * DELETE /quizzes/:id/slots/:slotId — xoá slot khỏi đề.
   */
  async removeSlot(@Param('id', { schema: uuidIdSchema }) id: string, @Param('slotId', { schema: uuidIdSchema }) slotId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.removeSlot(actor.id, id, slotId);
  }
  @Post(':id/slots/:slotId/upgrade-version')
  /**
   * POST /quizzes/:id/slots/:slotId/upgrade-version — nâng version đã ghim của slot lên bản ready mới nhất (QB-3, ghi nhật ký).
   */
  async upgradeSlotVersion(@Param('id', { schema: uuidIdSchema }) id: string, @Param('slotId', { schema: uuidIdSchema }) slotId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.upgradeSlotVersion(actor.id, id, slotId);
  }
  @Post(':id/slots/:slotId/swap')
  /**
   * POST /quizzes/:id/slots/:slotId/swap — đổi câu (slot cố định, ứng
   * viên cùng ô) hoặc đổi ô nguồn (slot per-student) cho slot sinh từ
   * ma trận; chỉ khi đề chưa có lượt làm thật.
   */
  async swapSlot(@Param('id', { schema: uuidIdSchema }) id: string, @Param('slotId', { schema: uuidIdSchema }) slotId: string, @Body({ schema: swapQuizSlotSchema }) dto: SwapQuizSlotDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.swapSlot(actor.id, id, slotId, dto);
  }
  @Post(':id/regenerate')
  /**
   * POST /quizzes/:id/regenerate — rút lại các slot do ma trận sinh
   * (chỉ khi đề chưa có lượt làm thật).
   */
  async regenerate(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.regenerateQuiz(actor.id, id);
  }
  @Post(':id/slots/cluster')
  /**
   * POST /quizzes/:id/slots/cluster — gom đúng 4 slot truefalse cùng
   * stimulus thành một chùm Đ–S (đề dựng tay).
   */
  async clusterSlots(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: clusterQuizSlotsSchema }) dto: ClusterQuizSlotsDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.clusterSlots(actor.id, id, dto);
  }
  @Post(':id/slots/uncluster')
  /**
   * POST /quizzes/:id/slots/uncluster — gỡ chùm khỏi các slot đã cho.
   */
  async unclusterSlots(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: clusterQuizSlotsSchema }) dto: ClusterQuizSlotsDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.unclusterSlots(actor.id, id, dto);
  }
  @Get(':id/attempts')
  /**
   * GET /quizzes/:id/attempts — các lượt làm (của chính người xem, hoặc
   * của cả lớp khi có quiz:viewreports).
   */
  async listAttempts(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.listAttemptSummaries(actor.id, id);
  }
  @Get(':id/overrides')
  /**
   * GET /quizzes/:id/overrides — danh sách ghi đè cài đặt thi theo
   * nhóm/người dùng (quiz:manageoverrides).
   */
  async listOverrides(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.listOverrides(actor.id, id);
  }
  @Post(':id/overrides')
  /**
   * POST /quizzes/:id/overrides — tạo ghi đè cho một nhóm hoặc một
   * người dùng (quiz:manageoverrides).
   */
  async createOverride(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: createQuizOverrideSchema }) dto: CreateQuizOverrideDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.createOverride(actor.id, id, dto);
  }
  @Patch(':id/overrides/:overrideId')
  /**
   * PATCH /quizzes/:id/overrides/:overrideId — sửa một ghi đè
   * (quiz:manageoverrides).
   */
  async updateOverride(@Param('id', { schema: uuidIdSchema }) id: string, @Param('overrideId', { schema: uuidIdSchema }) overrideId: string, @Body({ schema: updateQuizOverrideSchema }) dto: UpdateQuizOverrideDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.updateOverride(actor.id, id, overrideId, dto);
  }
  @Delete(':id/overrides/:overrideId')
  /**
   * DELETE /quizzes/:id/overrides/:overrideId — xoá một ghi đè
   * (quiz:manageoverrides).
   */
  async removeOverride(@Param('id', { schema: uuidIdSchema }) id: string, @Param('overrideId', { schema: uuidIdSchema }) overrideId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.quiz.deleteOverride(actor.id, id, overrideId);
    return { deleted: true };
  }
  @Post(':id/attempts')
  /**
   * POST /quizzes/:id/attempts — bắt đầu lượt làm mới (hoặc tiếp tục
   * lượt đang dở); `preview: true` dành cho giáo viên xem trước đề.
   * Mật khẩu vào thi (khi đề/override yêu cầu) đi trong body; cổng
   * subnet xét theo IP khách thật sau proxy.
   */
  async startAttempt(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: startQuizAttemptSchema }) dto: StartQuizAttemptDto, @CurrentUser() actor: AuthenticatedUser, @Req() req: Request) {
    return this.quiz.startAttempt(actor.id, id, { preview: dto.preview, password: dto.password, clientIp: clientIpOf(req) });
  }
  @Get(':id/results')
  /**
   * GET /quizzes/:id/results — kết quả lớp + hàng đợi chấm tay
   * (quiz:viewreports).
   */
  async results(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.getResults(actor.id, id);
  }
  @Get(':id/feedbacks')
  /**
   * GET /quizzes/:id/feedbacks — các dải nhận xét tổng quát theo % điểm
   * (quiz:manage).
   */
  async listFeedbacks(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.listFeedbacks(actor.id, id);
  }
  @Post(':id/feedbacks')
  /**
   * POST /quizzes/:id/feedbacks — tạo một dải nhận xét tổng quát
   * (quiz:manage).
   */
  async createFeedback(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: createQuizFeedbackSchema }) dto: CreateQuizFeedbackDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.createFeedback(actor.id, id, dto);
  }
  @Delete(':id/feedbacks/:feedbackId')
  /**
   * DELETE /quizzes/:id/feedbacks/:feedbackId — xoá một dải nhận xét
   * tổng quát (quiz:manage).
   */
  async removeFeedback(@Param('id', { schema: uuidIdSchema }) id: string, @Param('feedbackId', { schema: uuidIdSchema }) feedbackId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.quiz.deleteFeedback(actor.id, id, feedbackId);
    return { deleted: true };
  }
  @Get(':id/cluster-statistics')
  /**
   * GET /quizzes/:id/cluster-statistics — thống kê đúng–sai theo từng
   * Ý của các chùm Đ–S + phân bố số ý đúng (quiz:viewreports).
   */
  async clusterStatistics(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.clusterStatistics(actor.id, id);
  }
  @Get(':id/grade-by-question/:questionId')
  /**
   * GET /quizzes/:id/grade-by-question/:questionId — hàng đợi chấm một
   * câu cho cả lớp: mọi lượt đã nộp chứa câu, kèm đáp án (quiz:grade).
   */
  async gradeByQuestionQueue(@Param('id', { schema: uuidIdSchema }) id: string, @Param('questionId', { schema: uuidIdSchema }) questionId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.listQuestionGradingQueue(actor.id, id, questionId);
  }
  @Post(':id/grade-by-question')
  /**
   * POST /quizzes/:id/grade-by-question — chấm tay một câu cho nhiều
   * lượt cùng lúc (quiz:grade).
   */
  async gradeByQuestion(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: gradeQuizQuestionSchema }) dto: GradeQuizQuestionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.gradeQuestionForAttempts(actor.id, id, dto);
  }
}

@ApiTags('exam-matrices')
@Controller({ path: 'exam-matrices', version: '1' })
/**
 * API ma trận đề (Quiz Chặng 3): thực thể lưu trữ neo Chương trình GDPT
 * 2018, các ô YCCĐ × mức × dạng, kiểm tra khả dụng ngân hàng và (ở
 * controller quizzes) sinh đề từ ma trận. Đây là nền của ngân hàng ma
 * trận trong khu vực Ngân hàng hệ thống về sau.
 */
export class ExamMatricesController {
  constructor(private readonly quiz: QuizService) {}

  @Post()
  /**
   * POST /exam-matrices — tạo ma trận (tỉ lệ mục tiêu chụp từ preset khi không cho riêng).
   */
  async create(@Body({ schema: createExamMatrixSchema }) dto: CreateExamMatrixDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.createMatrix(actor.id, dto);
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
  @Patch(':id')
  /**
   * PATCH /exam-matrices/:id — sửa ma trận (quiz:managematrix).
   */
  async update(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updateExamMatrixSchema }) dto: UpdateExamMatrixDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.updateMatrix(actor.id, id, dto);
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
  // POST /exam-matrices/:id/generate đã chuyển sang ExamPapersModule
  // (EB-2: generate hai bước matrix → paper → deploy, xem
  // ExamMatrixGenerateController) — route giữ nguyên URL cho GV.
  @Get(':id/specification')
  /**
   * GET /exam-matrices/:id/specification — view model bản đặc tả theo
   * Mẫu 2 CV 7991; truyền `quizId` của đề đã sinh từ ma trận này để có
   * vị trí câu thật.
   */
  async specification(@Param('id', { schema: uuidIdSchema }) id: string, @Query('quizId') quizId: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    if (quizId !== undefined && !uuidIdSchema.safeParse(quizId).success) {
      throw new BadRequestException({ message: 'quizId must be a uuid', code: 'quiz.spec_quiz_invalid' });
    }
    return this.quiz.getMatrixSpecification(actor.id, id, quizId);
  }
  @Get(':id/specification/export')
  /**
   * GET /exam-matrices/:id/specification/export?format=xlsx|docx —
   * xuất bản đặc tả ra file nộp/lưu hồ sơ (kèm `quizId` khi cần vị trí
   * câu thật).
   */
  async exportSpecification(@Param('id', { schema: uuidIdSchema }) id: string, @Query('format') format: string | undefined, @Query('quizId') quizId: string | undefined, @CurrentUser() actor: AuthenticatedUser, @Res() res: Response) {
    if (quizId !== undefined && !uuidIdSchema.safeParse(quizId).success) {
      throw new BadRequestException({ message: 'quizId must be a uuid', code: 'quiz.spec_quiz_invalid' });
    }
    const { filename, contentType, buffer } = await this.quiz.exportMatrixSpecification(actor.id, id, format ?? 'xlsx', quizId);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }
}

@ApiTags('quiz-attempts')
@Controller({ path: 'quiz-attempts', version: '1' })
/**
 * API một lượt làm quiz: đọc đề theo trang, lưu câu trả lời, nộp bài và
 * chấm tay từng câu (ủy quyền cho question engine).
 */
export class QuizAttemptsController {
  constructor(private readonly quiz: QuizService) {}

  @Get(':id')
  /**
   * GET /quiz-attempts/:id — toàn bộ lượt làm (câu theo trang, đáp án đã
   * lưu, điểm khi đã nộp); quá hạn làm bài thì lượt bị chốt phía server.
   */
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.getAttemptView(actor.id, id);
  }
  @Post(':id/responses')
  /**
   * POST /quiz-attempts/:id/responses — lưu câu trả lời cho một câu
   * (cổng subnet được kiểm lại tại đây theo IP khách thật).
   */
  async respond(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: submitQuizResponseSchema }) dto: SubmitQuizResponseDto, @CurrentUser() actor: AuthenticatedUser, @Req() req: Request) {
    return this.quiz.submitResponse(actor.id, id, dto, clientIpOf(req));
  }
  @Post(':id/submit')
  /**
   * POST /quiz-attempts/:id/submit — nộp bài: engine chấm, điểm bài ghi
   * vào sổ điểm (essay chưa chấm thì lượt ở trạng thái chờ chấm tay).
   */
  async submit(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.submitAttempt(actor.id, id);
  }
  @Post(':id/questions/:questionAttemptId/grade')
  /**
   * POST /quiz-attempts/:id/questions/:questionAttemptId/grade — chấm
   * tay một câu essay (quiz:grade).
   */
  async grade(@Param('id', { schema: uuidIdSchema }) id: string, @Param('questionAttemptId', { schema: uuidIdSchema }) questionAttemptId: string, @Body({ schema: manualGradeQuizSchema }) dto: ManualGradeQuizDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.manualGrade(actor.id, id, { questionAttemptId, mark: dto.mark, comment: dto.comment });
  }
  @Post(':id/events')
  /**
   * POST /quiz-attempts/:id/events — client báo một sự kiện giám sát
   * (thoát fullscreen / mất focus / ngắt kết nối dài). CHỈ GHI NHẬN:
   * không tự kết luận gian lận, không hệ quả lên lượt làm.
   */
  async recordEvent(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: recordQuizAttemptEventSchema }) dto: RecordQuizAttemptEventDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.recordAttemptEvent(actor.id, id, dto);
  }
  @Get(':id/events')
  /**
   * GET /quiz-attempts/:id/events — nhật ký sự kiện giám sát của lượt
   * (chủ lượt hoặc người có quyền chấm/báo cáo).
   */
  async listEvents(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.listAttemptEvents(actor.id, id);
  }
}

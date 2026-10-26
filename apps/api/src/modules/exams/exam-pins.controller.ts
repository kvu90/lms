import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { clientIpOf } from '../../common/client-ip';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { QuizService } from '../quiz/quiz.service';
import {
  createExamPinFeedbackSchema, createExamPinOverrideSchema, createExamPinSchema,
  gradeQuizQuestionSchema, startQuizAttemptSchema, updateExamPinOverrideSchema, updateExamPinSchema,
  type CreateExamPinDto, type CreateExamPinFeedbackDto, type CreateExamPinOverrideDto,
  type GradeQuizQuestionDto, type StartQuizAttemptDto, type UpdateExamPinDto, type UpdateExamPinOverrideDto,
} from '../quiz/dto/quiz.dto';
import { ExamsService } from './exams.service';

@ApiTags('exam-pins')
@Controller({ path: 'courses/:courseId/exam-pins', version: '1' })
/**
 * Ghim đề vào khoá (thực thể hợp nhất #226 thay quiz + deployment):
 * tạo pin từ một đề ready trong bank — hoặc tạo đề mới trong bank cá
 * nhân rồi ghim trong cùng một thao tác (`newExam`) — và liệt kê các
 * pin của khoá. Cổng kép: exam:deploy tại bank của đề (ExamsService)
 * + quyền tạo hoạt động tại khoá (CoursesService).
 */
export class CourseExamPinsController {
  constructor(
    private readonly exams: ExamsService,
    private readonly quiz: QuizService,
  ) {}

  @Post()
  /**
   * POST /courses/:courseId/exam-pins — ghim đề vào khoá (kèm course module + grade item).
   */
  async create(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: createExamPinSchema }) dto: CreateExamPinDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.exams.createPin(actor.id, courseId, dto);
  }
  @Get()
  /**
   * GET /courses/:courseId/exam-pins — các pin (bài kiểm tra) trong khoá học.
   */
  async list(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.listPins(actor.id, courseId);
  }
}

@ApiTags('exam-pins')
@Controller({ path: 'exam-pins', version: '1' })
/**
 * API một lần ghim (pin): cấu hình tổ chức, công bố kết quả, lượt
 * làm, kết quả lớp, ghi đè cài đặt thi và dải nhận xét. Nội dung đề
 * (câu hỏi/slots) KHÔNG sửa ở đây — sửa trên thực thể Đề ở `/exams`
 * rồi đổi version đã ghim (bị khoá khi đã có lượt làm thật).
 */
export class ExamPinsController {
  constructor(private readonly quiz: QuizService) {}

  @Get(':pinId')
  /**
   * GET /exam-pins/:pinId — thông tin pin cho người xem (cấu hình, slots hiệu lực, các lượt của chính mình, điểm bài hiện tại, cờ quyền).
   */
  async getForUser(@Param('pinId', { schema: uuidIdSchema }) pinId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.getQuizForUser(actor.id, pinId);
  }
  @Patch(':pinId')
  /**
   * PATCH /exam-pins/:pinId — sửa cấu hình tổ chức của pin (quiz:manage); đổi examVersionId/variantCount bị khoá khi đã có lượt thật.
   */
  async update(@Param('pinId', { schema: uuidIdSchema }) pinId: string, @Body({ schema: updateExamPinSchema }) dto: UpdateExamPinDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.updatePin(actor.id, pinId, dto);
  }
  @Delete(':pinId')
  /**
   * DELETE /exam-pins/:pinId — xoá pin cùng cm, grade item và các lượt làm (đề trong bank không bị ảnh hưởng).
   */
  async remove(@Param('pinId', { schema: uuidIdSchema }) pinId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.quiz.deletePin(actor.id, pinId);
    return { deleted: true };
  }
  @Post(':pinId/publish')
  /**
   * POST /exam-pins/:pinId/publish — công bố kết quả của pin cho học sinh.
   */
  async publish(@Param('pinId', { schema: uuidIdSchema }) pinId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.publishResults(actor.id, pinId);
  }
  @Post(':pinId/unpublish')
  /**
   * POST /exam-pins/:pinId/unpublish — thu hồi công bố kết quả của pin.
   */
  async unpublish(@Param('pinId', { schema: uuidIdSchema }) pinId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.unpublishResults(actor.id, pinId);
  }
  @Get(':pinId/attempts')
  /**
   * GET /exam-pins/:pinId/attempts — các lượt làm (của chính người xem, hoặc của cả lớp khi có quiz:viewreports).
   */
  async listAttempts(@Param('pinId', { schema: uuidIdSchema }) pinId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.listAttemptSummaries(actor.id, pinId);
  }
  @Post(':pinId/attempts')
  /**
   * POST /exam-pins/:pinId/attempts — bắt đầu lượt làm mới (hoặc tiếp tục lượt đang dở); `preview: true` dành cho giáo viên xem trước đề.
   * Mật khẩu vào thi (khi pin/override yêu cầu) đi trong body; cổng subnet xét theo IP khách thật sau proxy.
   */
  async startAttempt(@Param('pinId', { schema: uuidIdSchema }) pinId: string, @Body({ schema: startQuizAttemptSchema }) dto: StartQuizAttemptDto, @CurrentUser() actor: AuthenticatedUser, @Req() req: Request) {
    return this.quiz.startAttempt(actor.id, pinId, { preview: dto.preview, password: dto.password, clientIp: clientIpOf(req) });
  }
  @Get(':pinId/results')
  /**
   * GET /exam-pins/:pinId/results — kết quả lớp + hàng đợi chấm tay (quiz:viewreports).
   */
  async results(@Param('pinId', { schema: uuidIdSchema }) pinId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.getResults(actor.id, pinId);
  }
  @Get(':pinId/grade-by-question/:questionId')
  /**
   * GET /exam-pins/:pinId/grade-by-question/:questionId — hàng đợi chấm một câu cho cả lớp (quiz:grade).
   */
  async gradeByQuestionQueue(@Param('pinId', { schema: uuidIdSchema }) pinId: string, @Param('questionId', { schema: uuidIdSchema }) questionId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.listQuestionGradingQueue(actor.id, pinId, questionId);
  }
  @Post(':pinId/grade-by-question')
  /**
   * POST /exam-pins/:pinId/grade-by-question — chấm tay một câu cho nhiều lượt cùng lúc (quiz:grade).
   */
  async gradeByQuestion(@Param('pinId', { schema: uuidIdSchema }) pinId: string, @Body({ schema: gradeQuizQuestionSchema }) dto: GradeQuizQuestionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.gradeQuestionForAttempts(actor.id, pinId, dto);
  }
  @Get(':pinId/overrides')
  /**
   * GET /exam-pins/:pinId/overrides — danh sách ghi đè cài đặt thi theo nhóm/người dùng (quiz:manageoverrides).
   */
  async listOverrides(@Param('pinId', { schema: uuidIdSchema }) pinId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.listOverrides(actor.id, pinId);
  }
  @Post(':pinId/overrides')
  /**
   * POST /exam-pins/:pinId/overrides — tạo ghi đè cho một nhóm hoặc một người dùng (quiz:manageoverrides).
   */
  async createOverride(@Param('pinId', { schema: uuidIdSchema }) pinId: string, @Body({ schema: createExamPinOverrideSchema }) dto: CreateExamPinOverrideDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.createOverride(actor.id, pinId, dto);
  }
  @Get(':pinId/feedbacks')
  /**
   * GET /exam-pins/:pinId/feedbacks — các dải nhận xét tổng quát theo % điểm (quiz:manage).
   */
  async listFeedbacks(@Param('pinId', { schema: uuidIdSchema }) pinId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.listFeedbacks(actor.id, pinId);
  }
  @Post(':pinId/feedbacks')
  /**
   * POST /exam-pins/:pinId/feedbacks — tạo một dải nhận xét tổng quát (quiz:manage).
   */
  async createFeedback(@Param('pinId', { schema: uuidIdSchema }) pinId: string, @Body({ schema: createExamPinFeedbackSchema }) dto: CreateExamPinFeedbackDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.createFeedback(actor.id, pinId, dto);
  }
}

@ApiTags('exam-pins')
@Controller({ path: 'exam-pin-overrides', version: '1' })
/**
 * Sửa/xoá một ghi đè theo id (pin suy từ chính ghi đè ở tầng service).
 */
export class ExamPinOverridesController {
  constructor(private readonly quiz: QuizService) {}

  @Patch(':overrideId')
  /**
   * PATCH /exam-pin-overrides/:overrideId — sửa một ghi đè (quiz:manageoverrides).
   */
  async update(@Param('overrideId', { schema: uuidIdSchema }) overrideId: string, @Body({ schema: updateExamPinOverrideSchema }) dto: UpdateExamPinOverrideDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.updatePinOverride(actor.id, overrideId, dto);
  }
  @Delete(':overrideId')
  /**
   * DELETE /exam-pin-overrides/:overrideId — xoá một ghi đè (quiz:manageoverrides).
   */
  async remove(@Param('overrideId', { schema: uuidIdSchema }) overrideId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.quiz.deletePinOverride(actor.id, overrideId);
    return { deleted: true };
  }
}

@ApiTags('exam-pins')
@Controller({ path: 'exam-pin-feedbacks', version: '1' })
/**
 * Xoá một dải nhận xét theo id (pin suy từ chính feedback ở tầng service).
 */
export class ExamPinFeedbacksController {
  constructor(private readonly quiz: QuizService) {}

  @Delete(':feedbackId')
  /**
   * DELETE /exam-pin-feedbacks/:feedbackId — xoá một dải nhận xét tổng quát (quiz:manage).
   */
  async remove(@Param('feedbackId', { schema: uuidIdSchema }) feedbackId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.quiz.deletePinFeedback(actor.id, feedbackId);
    return { deleted: true };
  }
}

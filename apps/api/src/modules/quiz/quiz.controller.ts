import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { QuizService } from './quiz.service';
import {
  addQuizSlotSchema, createQuizSchema, manualGradeQuizSchema, startQuizAttemptSchema,
  submitQuizResponseSchema, updateQuizSchema, updateQuizSlotSchema,
  type AddQuizSlotDto, type CreateQuizDto, type ManualGradeQuizDto, type StartQuizAttemptDto,
  type SubmitQuizResponseDto, type UpdateQuizDto, type UpdateQuizSlotDto,
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
  async list(@Param('courseId', { schema: uuidIdSchema }) courseId: string) {
    return this.quiz.listQuizzes(courseId);
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
  @Get(':id/attempts')
  /**
   * GET /quizzes/:id/attempts — các lượt làm (của chính người xem, hoặc
   * của cả lớp khi có quiz:viewreports).
   */
  async listAttempts(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.listAttemptSummaries(actor.id, id);
  }
  @Post(':id/attempts')
  /**
   * POST /quizzes/:id/attempts — bắt đầu lượt làm mới (hoặc tiếp tục
   * lượt đang dở); `preview: true` dành cho giáo viên xem trước đề.
   */
  async startAttempt(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: startQuizAttemptSchema }) dto: StartQuizAttemptDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.startAttempt(actor.id, id, { preview: dto.preview });
  }
  @Get(':id/results')
  /**
   * GET /quizzes/:id/results — kết quả lớp + hàng đợi chấm tay
   * (quiz:viewreports).
   */
  async results(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.getResults(actor.id, id);
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
   * POST /quiz-attempts/:id/responses — lưu câu trả lời cho một câu.
   */
  async respond(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: submitQuizResponseSchema }) dto: SubmitQuizResponseDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.quiz.submitResponse(actor.id, id, dto);
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
}

import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { QuestionsService } from './questions.service';
import { createQuestionCategorySchema, createQuestionSchema, createQuestionUsageSchema, submitQuestionResponseSchema, updateQuestionSchema, type CreateQuestionCategoryDto, type CreateQuestionDto, type CreateUsageDto, type SubmitResponseDto, type UpdateQuestionDto } from './dto/questions.dto';

@ApiTags('questions')
@Controller({ path: 'questions', version: '1' })
/**
 * API ngân hàng câu hỏi: category, câu hỏi và version.
 */
export class QuestionsController {
  constructor(private readonly questions: QuestionsService) {}

  @Post('categories')
  /**
   * POST /question-categories — tạo category.
   */
  async createCategory(@Body({ schema: createQuestionCategorySchema }) dto: CreateQuestionCategoryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.createCategory(actor.id, dto);
  }
  @Get('categories')
  /**
   * GET /question-categories — liệt kê category theo context.
   */
  async listCategories(@Query('contextid') contextid?: string) {
    return this.questions.listCategories(contextid ? Number(contextid) : undefined);
  }
  @Get('categories/:id/questions')
  /**
   * GET /question-categories/:id/questions — câu hỏi trong category.
   */
  async listQuestions(@Param('id', ParseIntPipe) id: number) {
    return this.questions.listQuestions(id);
  }
  @Post()
  /**
   * POST /questions hoặc POST /question-usages — tạo câu hỏi / tạo usage (theo controller).
   */
  async create(@Body({ schema: createQuestionSchema }) dto: CreateQuestionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.createQuestion(actor.id, dto);
  }
  @Get(':id')
  /**
   * GET /questions/:id hoặc /question-usages/:id — chi tiết câu hỏi / usage.
   */
  async get(@Param('id', ParseIntPipe) id: number) {
    return this.questions.getQuestion(id);
  }
  @Patch(':id')
  /**
   * PATCH /questions/:id — sửa câu hỏi (tạo version mới).
   */
  async update(@Param('id', ParseIntPipe) id: number, @Body({ schema: updateQuestionSchema }) dto: UpdateQuestionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.updateQuestion(actor.id, id, dto);
  }
  @Get(':id/versions')
  /**
   * GET /questions/:id/versions — lịch sử version.
   */
  async versions(@Param('id', ParseIntPipe) id: number) {
    return this.questions.listVersions(id);
  }
}

@ApiTags('question-engine')
@Controller({ path: 'question-usages', version: '1' })
/**
 * API lượt làm bài (question usages): tạo usage, bắt đầu/nộp/kết thúc attempt.
 */
export class QuestionUsagesController {
  constructor(private readonly questions: QuestionsService) {}

  @Post()
  async create(@Body({ schema: createQuestionUsageSchema }) dto: CreateUsageDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.createUsage(actor.id, dto);
  }
  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    return this.questions.getUsage(id);
  }
  @Post(':id/start')
  /**
   * POST /question-usages/:id/start — bắt đầu usage.
   */
  async start(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.startUsage(actor.id, id);
  }
  @Post(':id/finish')
  /**
   * POST /question-usages/:id/finish — kết thúc usage.
   */
  async finish(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.finishUsage(actor.id, id);
  }
  @Post(':id/attempts/:attemptId/start')
  /**
   * POST /question-usages/:id/attempts — bắt đầu attempt cho một slot.
   */
  async startAttempt(@Param('attemptId', ParseIntPipe) attemptId: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.startAttempt(actor.id, attemptId);
  }
  @Post(':id/attempts/:attemptId/submit')
  /**
   * POST /question-attempts/:id/submit — nộp câu trả lời.
   */
  async submit(@Param('attemptId', ParseIntPipe) attemptId: number, @Body({ schema: submitQuestionResponseSchema }) dto: SubmitResponseDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.submitResponse(actor.id, attemptId, dto.response ?? null);
  }
  @Post(':id/attempts/:attemptId/finish')
  /**
   * POST /question-attempts/:id/finish — kết thúc attempt.
   */
  async finishAttempt(@Param('attemptId', ParseIntPipe) attemptId: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.finishAttempt(actor.id, attemptId);
  }
}

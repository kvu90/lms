import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { QuestionsService } from './questions.service';
import { createQuestionCategorySchema, createQuestionSchema, createQuestionUsageSchema, createStimulusSchema, submitQuestionResponseSchema, updateQuestionSchema, updateStimulusSchema, type CreateQuestionCategoryDto, type CreateQuestionDto, type CreateStimulusDto, type CreateUsageDto, type SubmitResponseDto, type UpdateQuestionDto, type UpdateStimulusDto } from './dto/questions.dto';

@ApiTags('questions')
@Controller({ path: 'questions', version: '1' })
/**
 * API ngân hàng câu hỏi: category, câu hỏi và version.
 */
export class QuestionsController {
  constructor(private readonly questions: QuestionsService) {}

  @Post('categories')
  /**
   * POST /questions/categories — tạo category.
   */
  async createCategory(@Body({ schema: createQuestionCategorySchema }) dto: CreateQuestionCategoryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.createCategory(actor.id, dto);
  }
  @Get('categories')
  /**
   * GET /questions/categories — liệt kê category theo context.
   */
  async listCategories(@Query('contextid') contextid?: string) {
    return this.questions.listCategories(contextid || undefined);
  }
  @Get('categories/:id/questions')
  /**
   * GET /questions/categories/:id/questions — câu hỏi trong category.
   */
  async listQuestions(@Param('id', { schema: uuidIdSchema }) id: string) {
    return this.questions.listQuestions(id);
  }
  @Post()
  /**
   * POST /questions — tạo câu hỏi (QuestionUsagesController: POST /question-usages — tạo usage).
   */
  async create(@Body({ schema: createQuestionSchema }) dto: CreateQuestionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.createQuestion(actor.id, dto);
  }
  @Get(':id')
  /**
   * GET /questions/:id — chi tiết câu hỏi (QuestionUsagesController: GET /question-usages/:id — chi tiết usage).
   */
  async get(@Param('id', { schema: uuidIdSchema }) id: string) {
    return this.questions.getQuestion(id);
  }
  @Patch(':id')
  /**
   * PATCH /questions/:id — sửa câu hỏi (tạo version mới).
   */
  async update(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updateQuestionSchema }) dto: UpdateQuestionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.updateQuestion(actor.id, id, dto);
  }
  @Get(':id/versions')
  /**
   * GET /questions/:id/versions — lịch sử version.
   */
  async versions(@Param('id', { schema: uuidIdSchema }) id: string) {
    return this.questions.listVersions(id);
  }
}

@ApiTags('stimuli')
@Controller({ path: 'stimuli', version: '1' })
/**
 * API ngữ liệu dùng chung (stimulus): tạo/đọc/sửa/xoá theo category.
 * Stimulus đã có version câu hỏi tham chiếu thì bất biến (stimulus_in_use).
 */
export class StimuliController {
  constructor(private readonly questions: QuestionsService) {}

  @Post()
  /**
   * POST /stimuli — tạo ngữ liệu trong một category.
   */
  async create(@Body({ schema: createStimulusSchema }) dto: CreateStimulusDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.createStimulus(actor.id, dto);
  }
  @Get()
  /**
   * GET /stimuli?categoryId= — ngữ liệu của một category.
   */
  async list(@Query('categoryId', { schema: uuidIdSchema }) categoryId: string) {
    return this.questions.listStimuli(categoryId);
  }
  @Get(':id')
  /**
   * GET /stimuli/:id — chi tiết ngữ liệu.
   */
  async get(@Param('id', { schema: uuidIdSchema }) id: string) {
    return this.questions.getStimulus(id);
  }
  @Patch(':id')
  /**
   * PATCH /stimuli/:id — sửa nội dung (chỉ khi chưa được tham chiếu).
   */
  async update(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updateStimulusSchema }) dto: UpdateStimulusDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.updateStimulus(actor.id, id, dto);
  }
  @Delete(':id')
  /**
   * DELETE /stimuli/:id — xoá ngữ liệu (chỉ khi chưa được tham chiếu).
   */
  async remove(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.questions.deleteStimulus(actor.id, id);
    return { deleted: true };
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
  async get(@Param('id', { schema: uuidIdSchema }) id: string) {
    return this.questions.getUsage(id);
  }
  @Post(':id/start')
  /**
   * POST /question-usages/:id/start — bắt đầu usage.
   */
  async start(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.startUsage(actor.id, id);
  }
  @Post(':id/finish')
  /**
   * POST /question-usages/:id/finish — kết thúc usage.
   */
  async finish(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.finishUsage(actor.id, id);
  }
  @Post(':id/attempts/:attemptId/start')
  /**
   * POST /question-usages/:id/attempts/:attemptId/start — bắt đầu attempt.
   */
  async startAttempt(@Param('attemptId', { schema: uuidIdSchema }) attemptId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.startAttempt(actor.id, attemptId);
  }
  @Post(':id/attempts/:attemptId/submit')
  /**
   * POST /question-usages/:id/attempts/:attemptId/submit — nộp câu trả lời.
   */
  async submit(@Param('attemptId', { schema: uuidIdSchema }) attemptId: string, @Body({ schema: submitQuestionResponseSchema }) dto: SubmitResponseDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.submitResponse(actor.id, attemptId, dto.response ?? null);
  }
  @Post(':id/attempts/:attemptId/finish')
  /**
   * POST /question-usages/:id/attempts/:attemptId/finish — kết thúc attempt.
   */
  async finishAttempt(@Param('attemptId', { schema: uuidIdSchema }) attemptId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.finishAttempt(actor.id, attemptId);
  }
}

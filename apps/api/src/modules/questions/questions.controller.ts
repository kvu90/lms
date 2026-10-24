import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { QuestionsService } from './questions.service';
import { attachQuestionOutcomeSchema, attachQuestionSubjectSchema, createQuestionCategorySchema, createQuestionSchema, createQuestionUsageSchema, createStimulusSchema, submitQuestionResponseSchema, updateQuestionOutcomeLinkSchema, updateQuestionSchema, updateStimulusSchema, type AttachQuestionOutcomeDto, type AttachQuestionSubjectDto, type CreateQuestionCategoryDto, type CreateQuestionDto, type CreateStimulusDto, type CreateUsageDto, type SubmitResponseDto, type UpdateQuestionDto, type UpdateQuestionOutcomeLinkDto, type UpdateStimulusDto } from './dto/questions.dto';

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
   * GET /questions/categories — liệt kê category theo context. Đọc ngân
   * hàng có cổng `question:useall` theo context (issue #55): không có
   * quyền thì category ngoài tầm không xuất hiện / 404 khi chỉ định
   * context.
   */
  async listCategories(@Query('contextId') contextId: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.listCategoriesForViewer(actor.id, contextId || undefined);
  }
  @Get('categories/:id/questions')
  /**
   * GET /questions/categories/:id/questions — câu hỏi trong category
   * (cổng đọc theo context của category, issue #55).
   */
  async listQuestions(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.listQuestionsForViewer(actor.id, id);
  }
  @Post()
  /**
   * POST /questions — tạo câu hỏi (QuestionUsagesController: POST /question-usages — tạo usage).
   */
  async create(@Body({ schema: createQuestionSchema }) dto: CreateQuestionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.createQuestion(actor.id, dto);
  }
  @Get()
  /**
   * GET /questions?subjectId=&outcomeId=&cognitiveLevel=&qtype=&status= — lọc ngân hàng
   * theo gắn kết chương trình (issue #20 Chặng 2, mục A.6).
   */
  async listByCurriculumFilter(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('subjectId') subjectId?: string,
    @Query('outcomeId') outcomeId?: string,
    @Query('cognitiveLevel') cognitiveLevel?: string,
    @Query('qtype') qtype?: string,
    @Query('status') status?: string,
  ) {
    return this.questions.listQuestionsByCurriculumFilterForViewer(actor.id, {
      subjectId: subjectId || undefined,
      outcomeId: outcomeId || undefined,
      cognitiveLevel: cognitiveLevel || undefined,
      qtype: qtype || undefined,
      status: status || undefined,
    });
  }
  @Get(':id/curriculum-links')
  /**
   * GET /questions/:id/curriculum-links — gắn kết chương trình của câu hỏi:
   * { subjectIds, outcomes: [{ outcomeId, cognitiveLevel }] } (cổng đọc
   * như chi tiết câu hỏi, issue #55).
   */
  async getCurriculumLinks(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.getCurriculumLinksForViewer(actor.id, id);
  }
  @Post(':id/subjects')
  /**
   * POST /questions/:id/subjects — gắn câu hỏi vào một môn học.
   */
  async attachSubject(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: attachQuestionSubjectSchema }) dto: AttachQuestionSubjectDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.attachSubject(actor.id, id, dto.subjectId);
  }
  @Delete(':id/subjects/:subjectId')
  /**
   * DELETE /questions/:id/subjects/:subjectId — gỡ gắn môn của câu hỏi.
   */
  async detachSubject(@Param('id', { schema: uuidIdSchema }) id: string, @Param('subjectId', { schema: uuidIdSchema }) subjectId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.detachSubject(actor.id, id, subjectId);
  }
  @Post(':id/outcomes')
  /**
   * POST /questions/:id/outcomes — gắn câu hỏi vào một YCCĐ kèm mức độ nhận thức.
   */
  async attachOutcome(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: attachQuestionOutcomeSchema }) dto: AttachQuestionOutcomeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.attachOutcome(actor.id, id, dto.outcomeId, dto.cognitiveLevel);
  }
  @Patch(':id/outcomes/:outcomeId')
  /**
   * PATCH /questions/:id/outcomes/:outcomeId — đổi mức độ nhận thức của dòng nối.
   */
  async updateOutcomeLink(@Param('id', { schema: uuidIdSchema }) id: string, @Param('outcomeId', { schema: uuidIdSchema }) outcomeId: string, @Body({ schema: updateQuestionOutcomeLinkSchema }) dto: UpdateQuestionOutcomeLinkDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.updateOutcomeLink(actor.id, id, outcomeId, dto.cognitiveLevel);
  }
  @Delete(':id/outcomes/:outcomeId')
  /**
   * DELETE /questions/:id/outcomes/:outcomeId — gỡ gắn YCCĐ của câu hỏi.
   */
  async detachOutcome(@Param('id', { schema: uuidIdSchema }) id: string, @Param('outcomeId', { schema: uuidIdSchema }) outcomeId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.detachOutcome(actor.id, id, outcomeId);
  }
  @Get(':id')
  /**
   * GET /questions/:id — chi tiết câu hỏi kèm đáp án (cổng đọc
   * `question:useall` tại context của category chứa câu, issue #55;
   * QuestionUsagesController: GET /question-usages/:id — chi tiết usage).
   */
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.getQuestionForViewer(actor.id, id);
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
   * GET /questions/:id/versions — lịch sử version (cổng đọc như chi
   * tiết câu hỏi, issue #55).
   */
  async versions(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.listVersionsForViewer(actor.id, id);
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
   * GET /stimuli?categoryId= — ngữ liệu của một category (cổng đọc theo
   * context của category, issue #55).
   */
  async list(@Query('categoryId', { schema: uuidIdSchema }) categoryId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.listStimuliForViewer(actor.id, categoryId);
  }
  @Get(':id')
  /**
   * GET /stimuli/:id — chi tiết ngữ liệu (cổng đọc theo context của
   * category chứa ngữ liệu, issue #55).
   */
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.getStimulusForViewer(actor.id, id);
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
  /**
   * POST /question-usages — tạo usage thô trên câu ngân hàng: phải có
   * `question:useall` tại context của category của mọi câu trong slot
   * (issue #55 — usage thô là đường đọc nội dung câu kèm đáp án).
   */
  async create(@Body({ schema: createQuestionUsageSchema }) dto: CreateUsageDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.questions.assertCanCreateUsage(actor.id, dto.slots.map((s) => s.questionId));
    return this.questions.createUsage(actor.id, dto);
  }
  @Get(':id')
  /**
   * GET /question-usages/:id — chi tiết usage: chỉ chủ sở hữu hoặc
   * người có `question:useall` cấp hệ thống (issue #55).
   */
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.getUsageForViewer(actor.id, id);
  }
  @Post(':id/start')
  /**
   * POST /question-usages/:id/start — bắt đầu usage (chỉ chủ sở hữu;
   * usage gắn lượt quiz đang làm bị khoá kênh thô — issue #60).
   */
  async start(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.questions.assertUsageManipulableViaHttp(actor.id, id);
    return this.questions.startUsage(actor.id, id);
  }
  @Post(':id/finish')
  /**
   * POST /question-usages/:id/finish — kết thúc usage (chỉ chủ sở hữu;
   * usage gắn lượt quiz đang làm bị khoá kênh thô — issue #60).
   */
  async finish(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.questions.assertUsageManipulableViaHttp(actor.id, id);
    return this.questions.finishUsage(actor.id, id);
  }
  @Post(':id/attempts/:attemptId/start')
  /**
   * POST /question-usages/:id/attempts/:attemptId/start — bắt đầu attempt
   * (chỉ chủ sở hữu; usage gắn lượt quiz đang làm bị khoá kênh thô — #60).
   */
  async startAttempt(@Param('id', { schema: uuidIdSchema }) id: string, @Param('attemptId', { schema: uuidIdSchema }) attemptId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.questions.assertAttemptManipulableViaHttp(actor.id, id, attemptId);
    return this.questions.startAttempt(actor.id, attemptId);
  }
  @Post(':id/attempts/:attemptId/submit')
  /**
   * POST /question-usages/:id/attempts/:attemptId/submit — nộp câu trả lời
   * (chỉ chủ sở hữu; usage gắn lượt quiz đang làm bị khoá kênh thô — #60).
   */
  async submit(@Param('id', { schema: uuidIdSchema }) id: string, @Param('attemptId', { schema: uuidIdSchema }) attemptId: string, @Body({ schema: submitQuestionResponseSchema }) dto: SubmitResponseDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.questions.assertAttemptManipulableViaHttp(actor.id, id, attemptId);
    return this.questions.submitResponse(actor.id, attemptId, dto.response ?? null);
  }
  @Post(':id/attempts/:attemptId/finish')
  /**
   * POST /question-usages/:id/attempts/:attemptId/finish — kết thúc attempt
   * (chỉ chủ sở hữu; usage gắn lượt quiz đang làm bị khoá kênh thô — #60).
   */
  async finishAttempt(@Param('id', { schema: uuidIdSchema }) id: string, @Param('attemptId', { schema: uuidIdSchema }) attemptId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.questions.assertAttemptManipulableViaHttp(actor.id, id, attemptId);
    return this.questions.finishAttempt(actor.id, attemptId);
  }
}

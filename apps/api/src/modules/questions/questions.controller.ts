import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { QuestionsService } from './questions.service';
import { createQuestionCategorySchema, createQuestionSchema, createQuestionUsageSchema, submitQuestionResponseSchema, updateQuestionSchema, type CreateQuestionCategoryDto, type CreateQuestionDto, type CreateUsageDto, type SubmitResponseDto, type UpdateQuestionDto } from './dto/questions.dto';

@ApiTags('questions')
@Controller({ path: 'questions', version: '1' })
export class QuestionsController {
  constructor(private readonly questions: QuestionsService) {}

  @Post('categories')
  async createCategory(@Body({ schema: createQuestionCategorySchema }) dto: CreateQuestionCategoryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.createCategory(actor.id, dto);
  }
  @Get('categories')
  async listCategories(@Query('contextid') contextid?: string) {
    return this.questions.listCategories(contextid ? Number(contextid) : undefined);
  }
  @Get('categories/:id/questions')
  async listQuestions(@Param('id', ParseIntPipe) id: number) {
    return this.questions.listQuestions(id);
  }
  @Post()
  async create(@Body({ schema: createQuestionSchema }) dto: CreateQuestionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.createQuestion(actor.id, dto);
  }
  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    return this.questions.getQuestion(id);
  }
  @Patch(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body({ schema: updateQuestionSchema }) dto: UpdateQuestionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.updateQuestion(actor.id, id, dto);
  }
  @Get(':id/versions')
  async versions(@Param('id', ParseIntPipe) id: number) {
    return this.questions.listVersions(id);
  }
}

@ApiTags('question-engine')
@Controller({ path: 'question-usages', version: '1' })
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
  async start(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.startUsage(actor.id, id);
  }
  @Post(':id/finish')
  async finish(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.finishUsage(actor.id, id);
  }
  @Post(':id/attempts/:attemptId/start')
  async startAttempt(@Param('attemptId', ParseIntPipe) attemptId: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.startAttempt(actor.id, attemptId);
  }
  @Post(':id/attempts/:attemptId/submit')
  async submit(@Param('attemptId', ParseIntPipe) attemptId: number, @Body({ schema: submitQuestionResponseSchema }) dto: SubmitResponseDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.submitResponse(actor.id, attemptId, dto.response ?? null);
  }
  @Post(':id/attempts/:attemptId/finish')
  async finishAttempt(@Param('attemptId', ParseIntPipe) attemptId: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.questions.finishAttempt(actor.id, attemptId);
  }
}

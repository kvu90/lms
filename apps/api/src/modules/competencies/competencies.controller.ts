import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { CompetenciesService } from './competencies.service';
import { addCompetencyEvidenceSchema, addTemplateCohortSchema, addTemplateCompetencySchema, competencyNoteSchema, competencyReviewDecisionSchema, createCompetencyFrameworkSchema, createCompetencySchema, createLearningPlanSchema, createLearningPlanTemplateSchema, gradeUserCompetencySchema, linkCompetencySchema, type AddEvidenceDto, type AddTemplateCohortDto, type AddTemplateCompetencyDto, type CreateCompetencyDto, type CreateFrameworkDto, type CreatePlanDto, type CreateTemplateDto, type GradeUsercompDto, type LinkCompetencyDto, type NoteDto, type ReviewDecisionDto } from './dto/competencies.dto';

@ApiTags('competencies')
@Controller({ path: 'competencies', version: '1' })
/**
 * API năng lực: framework, competency, liên kết, template, learning plan, review và evidence.
 */
export class CompetenciesController {
  constructor(private readonly competencies: CompetenciesService) {}

  @Post('frameworks')
  /**
   * POST /competencies/frameworks — tạo framework.
   */
  async createFramework(@Body({ schema: createCompetencyFrameworkSchema }) dto: CreateFrameworkDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.createFramework(actor.id, dto);
  }
  @Get('frameworks')
  /**
   * GET /competencies/frameworks — liệt kê framework.
   */
  async listFrameworks() { return this.competencies.listFrameworks(); }
  @Get('frameworks/:id')
  /**
   * GET /competencies/frameworks/:id — chi tiết framework.
   */
  async getFramework(@Param('id', ParseIntPipe) id: number) { return this.competencies.getFramework(id); }
  @Post('frameworks/:id/competencies')
  /**
   * POST /competencies/frameworks/:id/competencies — thêm competency.
   */
  async createCompetency(@Param('id', ParseIntPipe) id: number, @Body({ schema: createCompetencySchema }) dto: CreateCompetencyDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.createCompetency(actor.id, id, dto);
  }
  @Get('frameworks/:id/competencies')
  /**
   * GET /competencies/frameworks/:id/competencies — liệt kê competency.
   */
  async listCompetencies(@Param('id', ParseIntPipe) id: number) { return this.competencies.listCompetencies(id); }

  @Post('courses/:courseId/links')
  /**
   * POST /competencies/courses/:courseId/links — liên kết competency với khoá học.
   */
  async linkCourse(@Param('courseId', ParseIntPipe) courseId: number, @Body({ schema: linkCompetencySchema }) dto: LinkCompetencyDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.linkCourseCompetency(actor.id, courseId, dto);
  }
  @Get('courses/:courseId/links')
  /**
   * GET /competencies/courses/:courseId/links — competency của khoá học.
   */
  async courseLinks(@Param('courseId', ParseIntPipe) courseId: number) { return this.competencies.listCourseCompetencies(courseId); }
  @Post('modules/:cmId/links')
  /**
   * POST /competencies/modules/:cmId/links — liên kết competency với module.
   */
  async linkModule(@Param('cmId', ParseIntPipe) cmId: number, @Body({ schema: linkCompetencySchema }) dto: LinkCompetencyDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.linkModuleCompetency(actor.id, cmId, dto);
  }
  @Get('modules/:cmId/links')
  /**
   * GET /competencies/modules/:cmId/links — competency của module.
   */
  async moduleLinks(@Param('cmId', ParseIntPipe) cmId: number) { return this.competencies.listModuleCompetencies(cmId); }

  @Post('templates')
  /**
   * POST /competencies/templates — tạo template.
   */
  async createTemplate(@Body({ schema: createLearningPlanTemplateSchema }) dto: CreateTemplateDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.createTemplate(actor.id, dto);
  }
  @Get('templates')
  /**
   * GET /competencies/templates — liệt kê template.
   */
  async listTemplates() { return this.competencies.listTemplates(); }
  @Post('templates/:id/competencies')
  /**
   * POST /competencies/templates/:id/competencies — thêm competency vào template.
   */
  async addTemplateCompetency(@Param('id', ParseIntPipe) id: number, @Body({ schema: addTemplateCompetencySchema }) dto: AddTemplateCompetencyDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.addTemplateCompetency(actor.id, id, dto.competencyId);
  }
  @Post('templates/:id/cohorts')
  /**
   * POST /competencies/templates/:id/cohorts — gắn cohort vào template.
   */
  async addTemplateCohort(@Param('id', ParseIntPipe) id: number, @Body({ schema: addTemplateCohortSchema }) dto: AddTemplateCohortDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.addTemplateCohort(actor.id, id, dto.cohortId);
  }
  @Post('templates/:id/create-plans')
  /**
   * POST /competencies/templates/:id/create-plans — sinh plan cho cohort.
   */
  async createPlans(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.createPlansFromTemplate(actor.id, id);
  }

  @Post('plans')
  /**
   * POST /competencies/plans — tạo plan.
   */
  async createPlan(@Body({ schema: createLearningPlanSchema }) dto: CreatePlanDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.createPlan(actor.id, dto);
  }
  @Get('plans/user/:userId')
  /**
   * GET /competencies/plans/user/:userId — plan của user.
   */
  async plansForUser(@Param('userId', ParseIntPipe) userId: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.listPlansForUser(actor.id, userId);
  }
  @Get('plans/:id')
  /**
   * GET /competencies/plans/:id — chi tiết plan.
   */
  async planView(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.getPlanView(actor.id, id);
  }
  @Post('plans/:id/activate')
  /**
   * POST /competencies/plans/:id/activate — kích hoạt plan.
   */
  async activate(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.activatePlan(actor.id, id);
  }
  @Post('plans/:id/request-review')
  /**
   * POST /competencies/plans/:id/request-review — gửi duyệt plan.
   */
  async requestReview(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.requestPlanReview(actor.id, id);
  }
  @Post('plans/:id/cancel-review')
  /**
   * POST /competencies/plans/:id/cancel-review — huỷ duyệt plan.
   */
  async cancelReview(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.cancelPlanReview(actor.id, id);
  }
  @Post('plans/:id/start-review')
  /**
   * POST /competencies/plans/:id/start-review — bắt đầu duyệt plan.
   */
  async startReview(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.startPlanReview(actor.id, id);
  }
  @Post('plans/:id/stop-review')
  /**
   * POST /competencies/plans/:id/stop-review — dừng duyệt plan.
   */
  async stopReview(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.stopPlanReview(actor.id, id);
  }
  @Post('plans/:id/approve')
  /**
   * POST /competencies/plans/:id/approve — duyệt plan.
   */
  async approve(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.approvePlan(actor.id, id);
  }
  @Post('plans/:id/unapprove')
  /**
   * POST /competencies/plans/:id/unapprove — gỡ duyệt plan.
   */
  async unapprove(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.unapprovePlan(actor.id, id);
  }
  @Post('plans/:id/complete')
  /**
   * POST /competencies/plans/:id/complete — hoàn tất plan.
   */
  async complete(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.completePlan(actor.id, id);
  }

  @Post('evidence')
  /**
   * POST /competencies/evidence — thêm bằng chứng.
   */
  async addEvidence(@Body({ schema: addCompetencyEvidenceSchema }) dto: AddEvidenceDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.addEvidence(actor.id, dto);
  }
  @Get('usercomp/user/:userId')
  /**
   * GET /competencies/usercomp/user/:userId — năng lực của user.
   */
  async usercomps(@Param('userId', ParseIntPipe) userId: number) {
    return this.competencies.listUsercompsForUser(userId);
  }
  @Get('usercomp/:id/evidence')
  /**
   * GET /competencies/usercomp/:id/evidence — bằng chứng của usercomp.
   */
  async evidence(@Param('id', ParseIntPipe) id: number) {
    return this.competencies.listEvidence(id);
  }
  @Post('usercomp/grade')
  /**
   * POST /competencies/usercomp/grade — chấm proficiency.
   */
  async grade(@Body({ schema: gradeUserCompetencySchema }) dto: GradeUsercompDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.gradeUsercomp(actor.id, dto);
  }
  @Post('usercomp/:id/request-review')
  /**
   * POST /competencies/usercomp/:id/request-review — gửi duyệt usercomp.
   */
  async requestUcReview(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.requestUsercompReview(actor.id, id);
  }
  @Post('usercomp/:id/start-review')
  /**
   * POST /competencies/usercomp/:id/start-review — bắt đầu duyệt usercomp.
   */
  async startUcReview(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.startUsercompReview(actor.id, id);
  }
  @Post('usercomp/:id/approve')
  /**
   * POST /competencies/usercomp/:id/approve — duyệt đạt usercomp.
   */
  async approveUcReview(@Param('id', ParseIntPipe) id: number, @Body({ schema: competencyReviewDecisionSchema }) dto: ReviewDecisionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.approveUsercompReview(actor.id, id, dto.grade, dto.note);
  }
  @Post('usercomp/:id/reject')
  /**
   * POST /competencies/usercomp/:id/reject — từ chối usercomp.
   */
  async rejectUcReview(@Param('id', ParseIntPipe) id: number, @Body({ schema: competencyNoteSchema }) dto: NoteDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.competencies.rejectUsercompReview(actor.id, id, dto.note);
  }
}

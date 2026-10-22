import { Body, Controller, Delete, ForbiddenException, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { CoursesService, type CategoryDeleteMode } from './courses.service';
import { createCourseCategorySchema, createCourseModuleSchema, createCourseSchema, createCourseSectionSchema, updateCourseCategorySchema, updateCourseModuleSchema, updateCourseSchema, updateCourseSectionSchema, type CreateCategoryDto, type CreateCmDto, type CreateCourseDto, type CreateSectionDto, type UpdateCategoryDto, type UpdateCmDto, type UpdateCourseDto, type UpdateSectionDto } from './dto/courses.dto';

@ApiTags('courses')
@Controller({ path: 'courses', version: '1' })
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  // --- categories -----------------------------------------------------------
  @Post('categories')
  async createCategory(@Body({ schema: createCourseCategorySchema }) dto: CreateCategoryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.courses.createCategory(actor.id, dto);
  }
  @Get('categories')
  async listCategories() { return this.courses.listCategories(); }
  @Get('categories/tree')
  async categoryTree() { return this.courses.categoryTree(); }
  @Get('categories/:id')
  async getCategory(@Param('id', ParseIntPipe) id: number) { return this.courses.getCategory(id); }
  @Patch('categories/:id')
  async updateCategory(@Param('id', ParseIntPipe) id: number, @Body({ schema: updateCourseCategorySchema }) dto: UpdateCategoryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.courses.updateCategory(actor.id, id, dto);
  }
  @Delete('categories/:id')
  async deleteCategory(@Param('id', ParseIntPipe) id: number, @Query('mode') mode: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    const parsed = mode === undefined ? undefined : (mode as CategoryDeleteMode);
    if (parsed !== undefined && parsed !== 'moveup' && parsed !== 'recursive') {
      throw new ForbiddenException({ message: `Unknown category delete mode ${mode} (expected moveup|recursive)`, code: 'course.category_bad_mode' });
    }
    return this.courses.deleteCategory(actor.id, id, parsed);
  }

  // --- courses ----------------------------------------------------------------
  @Post()
  async create(@Body({ schema: createCourseSchema }) dto: CreateCourseDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.courses.createCourse(actor.id, dto);
  }
  @Get()
  async list(@Query('category') category?: string) {
    return this.courses.listCourses(category ? Number(category) : undefined);
  }
  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() viewer: AuthenticatedUser) {
    // Listing a course's identity is open to enrolled/staff via the content gate;
    // bare metadata for hidden courses still goes through assertCourseAccess.
    const course = await this.courses.assertCourseAccess(viewer.id, id);
    return { ...course, contextId: await this.courses.courseContextId(id), customFields: await this.courses.getCourseCustomFields(id), formatOptions: await this.courses.getFormatOptions(id) };
  }
  @Get(':id/content')
  async content(@Param('id', ParseIntPipe) id: number, @CurrentUser() viewer: AuthenticatedUser) {
    return this.courses.getCourseContent(viewer.id, id);
  }
  @Patch(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body({ schema: updateCourseSchema }) dto: UpdateCourseDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.courses.updateCourse(actor.id, id, dto);
  }
  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    await this.courses.deleteCourse(actor.id, id);
    return { deleted: true };
  }

  // --- sections -----------------------------------------------------------------
  @Post(':id/sections')
  async createSection(@Param('id', ParseIntPipe) id: number, @Body({ schema: createCourseSectionSchema }) dto: CreateSectionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.courses.createSection(actor.id, id, dto);
  }
  @Patch(':id/sections/:sectionId')
  async updateSection(@Param('sectionId', ParseIntPipe) sectionId: number, @Body({ schema: updateCourseSectionSchema }) dto: UpdateSectionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.courses.updateSection(actor.id, sectionId, dto);
  }
  @Delete(':id/sections/:sectionId')
  async deleteSection(@Param('sectionId', ParseIntPipe) sectionId: number, @CurrentUser() actor: AuthenticatedUser) {
    await this.courses.deleteSection(actor.id, sectionId);
    return { deleted: true };
  }
  @Get(':id/sections/:sectionId/access')
  async sectionAccess(@Param('id', ParseIntPipe) id: number, @Param('sectionId', ParseIntPipe) sectionId: number, @CurrentUser() viewer: AuthenticatedUser) {
    await this.courses.assertCourseAccess(viewer.id, id);
    const section = await this.courses.getSection(sectionId);
    const result = await this.courses.checkSectionAccess(viewer.id, section);
    if (!result.available) throw new ForbiddenException({ message: 'This section is not available to you yet', code: 'availability.not_available' });
    return { sectionId, available: true };
  }

  // --- course modules --------------------------------------------------------------
  @Post(':id/modules')
  async createCm(@Param('id', ParseIntPipe) id: number, @Body({ schema: createCourseModuleSchema }) dto: CreateCmDto, @CurrentUser() actor: AuthenticatedUser) {
    const cm = await this.courses.createCm(actor.id, id, dto);
    return { ...cm, contextId: await this.courses.cmContextId(cm.id) };
  }
  @Get(':id/modules/:cmId')
  async getCm(@Param('id', ParseIntPipe) id: number, @Param('cmId', ParseIntPipe) cmId: number, @CurrentUser() viewer: AuthenticatedUser) {
    await this.courses.assertCourseAccess(viewer.id, id);
    const cm = await this.courses.getCm(cmId);
    return { ...cm, contextId: await this.courses.cmContextId(cm.id) };
  }
  /** Attempt to access the activity content — server-side availability gate (show/showc NEVER grant access). */
  @Get(':id/modules/:cmId/access')
  async cmAccess(@Param('id', ParseIntPipe) id: number, @Param('cmId', ParseIntPipe) cmId: number, @CurrentUser() viewer: AuthenticatedUser) {
    await this.courses.assertCourseAccess(viewer.id, id);
    const cm = await this.courses.getCm(cmId);
    const result = await this.courses.checkCmAccess(viewer.id, cm);
    if (!result.available) throw new ForbiddenException({ message: 'This activity is not available to you yet', code: 'availability.not_available' });
    return { cmId, available: true };
  }
  @Post(':id/modules/:cmId/view')
  async viewCm(@Param('cmId', ParseIntPipe) cmId: number, @CurrentUser() viewer: AuthenticatedUser) {
    const cm = await this.courses.recordCmView(viewer.id, cmId);
    return { cmId: cm.id, viewed: true };
  }
  @Patch(':id/modules/:cmId')
  async updateCm(@Param('cmId', ParseIntPipe) cmId: number, @Body({ schema: updateCourseModuleSchema }) dto: UpdateCmDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.courses.updateCm(actor.id, cmId, dto);
  }
  @Delete(':id/modules/:cmId')
  async deleteCm(@Param('cmId', ParseIntPipe) cmId: number, @CurrentUser() actor: AuthenticatedUser) {
    await this.courses.deleteCm(actor.id, cmId);
    return { deleted: true };
  }
}

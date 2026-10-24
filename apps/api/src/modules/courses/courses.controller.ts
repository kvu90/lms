import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { CoursesService, type CategoryDeleteMode } from './courses.service';
import { applyCurriculumFrameSchema, copyCourseContentSchema, createCourseCategorySchema, createCourseModuleSchema, createCourseSchema, createCourseSectionSchema, duplicateCourseSchema, reorderCourseModulesSchema, reorderCourseSectionsSchema, updateCourseCategorySchema, updateCourseModuleSchema, updateCourseSchema, updateCourseSectionSchema, type ApplyFrameDto, type CopyContentDto, type CreateCategoryDto, type CreateCmDto, type CreateCourseDto, type CreateSectionDto, type DuplicateCourseDto, type ReorderModulesDto, type ReorderSectionsDto, type UpdateCategoryDto, type UpdateCmDto, type UpdateCourseDto, type UpdateSectionDto, applyBookFrameSchema, type ApplyBookFrameDto } from './dto/courses.dto';

@ApiTags('courses')
@Controller({ path: 'courses', version: '1' })
/**
 * API khoá học: category, course, section, course module và kiểm tra truy cập theo availability.
 */
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  // --- categories -----------------------------------------------------------
  @Post('categories')
  /**
   * POST /courses/categories — tạo category.
   */
  async createCategory(@Body({ schema: createCourseCategorySchema }) dto: CreateCategoryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.courses.createCategory(actor.id, dto);
  }
  @Get('categories')
  /**
   * GET /courses/categories — liệt kê category.
   */
  async listCategories() { return this.courses.listCategories(); }
  @Get('categories/tree')
  /**
   * GET /courses/categories/tree — cây category kèm khoá học.
   */
  async categoryTree() { return this.courses.categoryTree(); }
  @Get('categories/:id')
  /**
   * GET /courses/categories/:id — chi tiết category.
   */
  async getCategory(@Param('id', { schema: uuidIdSchema }) id: string) { return this.courses.getCategory(id); }
  @Patch('categories/:id')
  /**
   * PATCH /courses/categories/:id — cập nhật category.
   */
  async updateCategory(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updateCourseCategorySchema }) dto: UpdateCategoryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.courses.updateCategory(actor.id, id, dto);
  }
  @Delete('categories/:id')
  /**
   * DELETE /courses/categories/:id — xoá category.
   */
  async deleteCategory(@Param('id', { schema: uuidIdSchema }) id: string, @Query('mode') mode: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    const parsed = mode === undefined ? undefined : (mode as CategoryDeleteMode);
    if (parsed !== undefined && parsed !== 'moveup' && parsed !== 'recursive') {
      throw new ForbiddenException({ message: `Unknown category delete mode ${mode} (expected moveup|recursive)`, code: 'course.category_bad_mode' });
    }
    return this.courses.deleteCategory(actor.id, id, parsed);
  }

  // --- courses ----------------------------------------------------------------
  @Post()
  /**
   * POST /courses — tạo khoá học.
   */
  async create(@Body({ schema: createCourseSchema }) dto: CreateCourseDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.courses.createCourse(actor.id, dto);
  }
  @Get()
  /**
   * GET /courses — liệt kê/tìm khoá học (không gồm khoá mẫu — K1).
   */
  async list(@Query('category') category?: string) {
    return this.courses.listCourses(category || undefined);
  }
  @Get('templates')
  /**
   * GET /courses/templates — khoá mẫu tổ/trường cho wizard tạo khoá (K1, đường 5).
   */
  async templates(@CurrentUser() actor: AuthenticatedUser) {
    return this.courses.listTemplates(actor.id);
  }
  @Post(':id/duplicate')
  /**
   * POST /courses/:id/duplicate — nhân bản khoá theo bảng sao chép Re-run (K1): bản sao nháp, hạn lùi theo mốc mới khi có startDate.
   */
  async duplicate(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: duplicateCourseSchema }) dto: DuplicateCourseDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.courses.duplicateCourse(actor.id, id, dto);
  }
  @Post(':id/import-content')
  /**
   * POST /courses/:id/import-content — "Dùng lại từ khoá khác": chép section/module từ khoá nguồn vào khoá này (K1).
   */
  async importContent(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: copyCourseContentSchema }) dto: CopyContentDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.courses.copyCourseContent(actor.id, id, dto);
  }
  @Post(':id/reorder-sections')
  /**
   * POST /courses/:id/reorder-sections — đổi thứ tự section cho Builder Outline (K1).
   */
  async reorderSections(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: reorderCourseSectionsSchema }) dto: ReorderSectionsDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.courses.reorderSections(actor.id, id, dto.sectionIds);
  }
  @Get(':id')
  /**
   * GET /courses/:id — chi tiết khoá học.
   */
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() viewer: AuthenticatedUser) {
    // Listing a course's identity is open to enrolled/staff via the content gate;
    // bare metadata for hidden courses still goes through assertCourseAccess.
    const course = await this.courses.assertCourseAccess(viewer.id, id);
    return { ...course, contextId: await this.courses.courseContextId(id), customFields: await this.courses.getCourseCustomFields(id), formatOptions: await this.courses.getFormatOptions(id) };
  }
  @Get(':id/content')
  /**
   * GET /courses/:id/content — nội dung (section/cm) đã đánh giá availability cho người xem.
   */
  async content(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() viewer: AuthenticatedUser) {
    return this.courses.getCourseContent(viewer.id, id);
  }
  @Post(':id/curriculum-frame')
  /**
   * POST /courses/:id/curriculum-frame — nạp khung chương trình vào khoá (bản sao có neo, K0a).
   */
  async applyFrame(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: applyCurriculumFrameSchema }) dto: ApplyFrameDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.courses.applyCurriculumFrame(actor.id, id, dto);
  }
  @Post(':id/book-frame')
  /**
   * POST /courses/:id/book-frame — nạp khung SGK vào khoá (bản sao có neo kép: mục bài truy về SGK và YCCĐ chương trình, K0b).
   */
  async applyBookFrame(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: applyBookFrameSchema }) dto: ApplyBookFrameDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.courses.applyBookFrame(actor.id, id, dto);
  }
  @Patch(':id')
  /**
   * PATCH /courses/:id — cập nhật khoá học.
   */
  async update(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updateCourseSchema }) dto: UpdateCourseDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.courses.updateCourse(actor.id, id, dto);
  }
  @Delete(':id')
  /**
   * DELETE /courses/:id — xoá khoá học.
   */
  async remove(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.courses.deleteCourse(actor.id, id);
    return { deleted: true };
  }

  // --- sections -----------------------------------------------------------------
  @Post(':id/sections')
  /**
   * POST /courses/:id/sections — thêm section.
   */
  async createSection(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: createCourseSectionSchema }) dto: CreateSectionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.courses.createSection(actor.id, id, dto);
  }
  @Patch(':id/sections/:sectionId')
  /**
   * PATCH /courses/:id/sections/:sectionId — cập nhật section.
   */
  async updateSection(@Param('sectionId', { schema: uuidIdSchema }) sectionId: string, @Body({ schema: updateCourseSectionSchema }) dto: UpdateSectionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.courses.updateSection(actor.id, sectionId, dto);
  }
  @Delete(':id/sections/:sectionId')
  /**
   * DELETE /courses/:id/sections/:sectionId — xoá section.
   */
  async deleteSection(@Param('sectionId', { schema: uuidIdSchema }) sectionId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.courses.deleteSection(actor.id, sectionId);
    return { deleted: true };
  }
  @Post(':id/sections/:sectionId/duplicate')
  /**
   * POST /courses/:id/sections/:sectionId/duplicate — nhân bản section ngay tại outline (K1).
   */
  async duplicateSection(@Param('sectionId', { schema: uuidIdSchema }) sectionId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.courses.duplicateSection(actor.id, sectionId);
  }
  @Post(':id/sections/:sectionId/reorder-modules')
  /**
   * POST /courses/:id/sections/:sectionId/reorder-modules — đổi thứ tự module trong section cho Builder Outline (K1).
   */
  async reorderModules(@Param('sectionId', { schema: uuidIdSchema }) sectionId: string, @Body({ schema: reorderCourseModulesSchema }) dto: ReorderModulesDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.courses.reorderModules(actor.id, sectionId, dto.moduleIds);
  }
  @Get(':id/sections/:sectionId/access')
  /**
   * GET /courses/:id/sections/:sectionId/access — kết quả availability của section cho user hiện tại.
   */
  async sectionAccess(@Param('id', { schema: uuidIdSchema }) id: string, @Param('sectionId', { schema: uuidIdSchema }) sectionId: string, @CurrentUser() viewer: AuthenticatedUser) {
    await this.courses.assertCourseAccess(viewer.id, id);
    const section = await this.courses.getSection(sectionId);
    const result = await this.courses.checkSectionAccess(viewer.id, section);
    if (!result.available) throw new ForbiddenException({ message: 'This section is not available to you yet', code: 'availability.not_available' });
    return { sectionId, available: true };
  }

  // --- course modules --------------------------------------------------------------
  @Post(':id/modules')
  /**
   * POST /courses/:id/modules — thêm course module.
   */
  async createCm(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: createCourseModuleSchema }) dto: CreateCmDto, @CurrentUser() actor: AuthenticatedUser) {
    const cm = await this.courses.createCm(actor.id, id, dto);
    return { ...cm, contextId: await this.courses.cmContextId(cm.id) };
  }
  @Get(':id/modules/:cmId')
  /**
   * GET /courses/:id/modules/:cmId — chi tiết course module.
   */
  async getCm(@Param('id', { schema: uuidIdSchema }) id: string, @Param('cmId', { schema: uuidIdSchema }) cmId: string, @CurrentUser() viewer: AuthenticatedUser) {
    await this.courses.assertCourseAccess(viewer.id, id);
    const cm = await this.courses.getCm(cmId);
    return { ...cm, contextId: await this.courses.cmContextId(cm.id) };
  }
  /** Attempt to access the activity content — server-side availability gate (show/showc NEVER grant access). */
  @Get(':id/modules/:cmId/access')
  /**
   * GET /courses/:id/modules/:cmId/access — kết quả availability của cm.
   */
  async cmAccess(@Param('id', { schema: uuidIdSchema }) id: string, @Param('cmId', { schema: uuidIdSchema }) cmId: string, @CurrentUser() viewer: AuthenticatedUser) {
    await this.courses.assertCourseAccess(viewer.id, id);
    const cm = await this.courses.getCm(cmId);
    const result = await this.courses.checkCmAccess(viewer.id, cm);
    if (!result.available) throw new ForbiddenException({ message: 'This activity is not available to you yet', code: 'availability.not_available' });
    return { cmId, available: true };
  }
  @Post(':id/modules/:cmId/duplicate')
  /**
   * POST /courses/:id/modules/:cmId/duplicate — nhân bản module ngay tại dòng (K1).
   */
  async duplicateCm(@Param('cmId', { schema: uuidIdSchema }) cmId: string, @CurrentUser() actor: AuthenticatedUser) {
    const cm = await this.courses.duplicateCm(actor.id, cmId);
    return { ...cm, contextId: await this.courses.cmContextId(cm.id) };
  }
  @Post(':id/modules/:cmId/view')
  /**
   * POST /courses/:id/modules/:cmId/view — ghi nhận lượt xem cm (nuôi completion).
   */
  async viewCm(@Param('cmId', { schema: uuidIdSchema }) cmId: string, @CurrentUser() viewer: AuthenticatedUser) {
    const cm = await this.courses.recordCmView(viewer.id, cmId);
    return { cmId: cm.id, viewed: true };
  }
  @Patch(':id/modules/:cmId')
  /**
   * PATCH /courses/:id/modules/:cmId — cập nhật cm.
   */
  async updateCm(@Param('cmId', { schema: uuidIdSchema }) cmId: string, @Body({ schema: updateCourseModuleSchema }) dto: UpdateCmDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.courses.updateCm(actor.id, cmId, dto);
  }
  @Delete(':id/modules/:cmId')
  /**
   * DELETE /courses/:id/modules/:cmId — xoá cm.
   */
  async deleteCm(@Param('cmId', { schema: uuidIdSchema }) cmId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.courses.deleteCm(actor.id, cmId);
    return { deleted: true };
  }
}

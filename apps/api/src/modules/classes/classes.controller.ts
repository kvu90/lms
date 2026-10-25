import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { uuidIdSchema } from '@lms/contracts';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { ClassesService } from './classes.service';
import {
  addClassRosterMemberSchema,
  createClassSchema,
  updateClassSchema,
  type AddClassRosterMemberDto,
  type CreateClassDto,
  type UpdateClassDto,
} from './dto/classes.dto';

@ApiTags('classes')
@Controller({ path: 'classes', version: '1' })
/**
 * API lớp học (issue #184, CLASS-0 — lát nền): vòng đời lớp, roster
 * (≡ backing cohort) và danh sách khoá trong lớp. Bề mặt web đầy đủ cho
 * giáo viên (import Excel, tự báo danh, phân quyền đồng GV) thuộc
 * CLASS-1; lát này chốt hợp đồng dữ liệu + quyền tại context lớp.
 */
export class ClassesController {
  constructor(private readonly classes: ClassesService) {}

  @Post()
  /** POST /classes — tạo lớp (chỉ `name` bắt buộc; chủ lớp mặc định là người tạo). */
  async create(@Body({ schema: createClassSchema }) dto: CreateClassDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.classes.createClass(actor.id, dto);
  }

  @Get()
  /** GET /classes — các lớp của tenant hiệu lực mà người gọi có liên hệ (chủ lớp / vai tại lớp / thành viên roster); quản trị tenant thấy toàn bộ. */
  async list(@CurrentUser() actor: AuthenticatedUser) {
    return this.classes.listClasses(actor.id);
  }

  @Get(':id')
  /** GET /classes/:id — chi tiết lớp (mã tham gia chỉ lộ cho người có quyền quản roster). */
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.classes.getClass(actor.id, id);
  }

  @Patch(':id')
  /** PATCH /classes/:id — sửa thông tin lớp / công tắc tự báo danh / chế độ rời lớp / xoay mã tham gia. */
  async update(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updateClassSchema }) dto: UpdateClassDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.classes.updateClass(actor.id, id, dto);
  }

  @Post(':id/archive')
  /** POST /classes/:id/archive — lưu trữ lớp (đóng băng roster + tạo khoá mới, giữ đọc). */
  async archive(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.classes.archiveClass(actor.id, id);
  }

  @Delete(':id')
  /** DELETE /classes/:id — xoá lớp (chỉ chủ lớp/quản trị tenant; chặn khi lớp còn khoá). */
  async remove(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.classes.deleteClass(actor.id, id);
    return { deleted: true };
  }

  @Get(':id/roster')
  /** GET /classes/:id/roster — danh sách học sinh của lớp (≡ cohort_members của backing cohort). */
  async roster(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.classes.listRoster(actor.id, id);
  }

  @Post(':id/roster')
  /** POST /classes/:id/roster — thêm học sinh vào lớp; ghi danh tự đồng bộ xuống mọi khoá trong lớp. */
  async addToRoster(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: addClassRosterMemberSchema }) dto: AddClassRosterMemberDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.classes.addToRoster(actor.id, id, dto.userId);
    return { added: true };
  }

  @Delete(':id/roster/:userId')
  /** DELETE /classes/:id/roster/:userId — gỡ học sinh khỏi lớp; ghi danh ở các khoá bị đình chỉ/rút theo chế độ rời lớp. */
  async removeFromRoster(@Param('id', { schema: uuidIdSchema }) id: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.classes.removeFromRoster(actor.id, id, userId);
    return { removed: true };
  }

  @Get(':id/courses')
  /** GET /classes/:id/courses — mọi khoá thuộc lớp. */
  async courses(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.classes.listClassCourses(actor.id, id);
  }
}

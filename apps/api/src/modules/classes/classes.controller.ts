import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { uuidIdSchema } from '@lms/contracts';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { ClassesService } from './classes.service';
import {
  addClassRosterMemberSchema,
  createClassSchema,
  importClassRosterSchema,
  joinClassByCodeSchema,
  rosterStudentIdentitySchema,
  setClassStaffRolesSchema,
  updateClassSchema,
  type AddClassRosterMemberDto,
  type CreateClassDto,
  type ImportClassRosterDto,
  type JoinClassByCodeDto,
  type RosterStudentIdentityDto,
  type SetClassStaffRolesDto,
  type UpdateClassDto,
} from './dto/classes.dto';

/** Trần dung lượng file Excel roster tải lên (import tối đa 500 dòng — 5 MB là rộng rãi cho một file danh sách). */
const ROSTER_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

@ApiTags('classes')
@Controller({ path: 'classes', version: '1' })
/**
 * API lớp học (issue #184): CLASS-0 chốt vòng đời lớp + roster + hợp
 * đồng quyền tại context lớp; CLASS-1 bổ sung bề mặt giáo viên — nạp
 * roster theo định danh/import Excel, phân quyền đồng GV, tự báo danh
 * bằng mã tham gia, thành viên đã đình chỉ. Các route đặc thù
 * (join/join-preview/roster-template) khai TRƯỚC route `:id` để không
 * bị nuốt bởi tham số đường dẫn.
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

  @Get('roster-template')
  /** GET /classes/roster-template — file Excel mẫu nạp danh sách học sinh (4 cột kiểu Azota) cho GV tải về điền. */
  async rosterTemplate(@Res() res: Response) {
    const { filename, buffer } = await this.classes.buildRosterTemplateWorkbook();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  @Get('join-preview')
  /** GET /classes/join-preview?code= — xem trước lớp từ mã tham gia (học sinh xác nhận đúng lớp trước khi xin vào). */
  async joinPreview(@Query('code') code: string) {
    return this.classes.previewJoin(code ?? '');
  }

  @Post('join')
  /** POST /classes/join — xin vào lớp bằng mã tham gia: vào thẳng khi lớp trống/lớp bật tự duyệt, còn lại vào hàng chờ duyệt. */
  async join(@Body({ schema: joinClassByCodeSchema }) dto: JoinClassByCodeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.classes.joinByCode(actor.id, dto.joinCode);
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
  /** GET /classes/:id/roster — danh sách học sinh của lớp (≡ cohort_members của backing cohort) kèm thông tin hiển thị. */
  async roster(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.classes.listRoster(actor.id, id);
  }

  @Post(':id/roster')
  /** POST /classes/:id/roster — thêm học sinh vào lớp theo userId; ghi danh tự đồng bộ xuống mọi khoá trong lớp. */
  async addToRoster(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: addClassRosterMemberSchema }) dto: AddClassRosterMemberDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.classes.addToRoster(actor.id, id, dto.userId);
    return { added: true };
  }

  @Post(':id/roster/identity')
  /** POST /classes/:id/roster/identity — thêm học sinh bằng họ tên + email/SĐT: khớp tài khoản có sẵn hoặc tạo tài khoản mới kèm mật khẩu tạm. */
  async addToRosterByIdentity(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: rosterStudentIdentitySchema }) dto: RosterStudentIdentityDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.classes.addRosterStudentByIdentity(actor.id, id, dto);
  }

  @Post(':id/roster/import')
  /** POST /classes/:id/roster/import — nạp roster từ danh sách dòng đã chuẩn hoá (web đọc file Excel rồi gửi lên); trả báo cáo từng dòng. */
  async importRoster(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: importClassRosterSchema }) dto: ImportClassRosterDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.classes.importRoster(actor.id, id, dto.rows);
  }

  @Post(':id/roster/import-file')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: ROSTER_UPLOAD_MAX_BYTES } }))
  /** POST /classes/:id/roster/import-file — nạp roster trực tiếp từ file Excel (multipart, trường `file`); server đọc sheet đầu tiên và trả cùng báo cáo từng dòng như đường JSON. */
  async importRosterFile(@Param('id', { schema: uuidIdSchema }) id: string, @UploadedFile() file: { buffer: Buffer } | undefined, @CurrentUser() actor: AuthenticatedUser) {
    if (!file) {
      throw new BadRequestException({ message: 'An .xlsx file is required in the multipart field "file"', code: 'class.import_file_required' });
    }
    const rows = await this.classes.parseRosterWorkbook(file.buffer);
    return this.classes.importRoster(actor.id, id, rows);
  }

  @Delete(':id/roster/:userId')
  /** DELETE /classes/:id/roster/:userId — gỡ học sinh khỏi lớp; ghi danh ở các khoá bị đình chỉ/rút theo chế độ rời lớp. */
  async removeFromRoster(@Param('id', { schema: uuidIdSchema }) id: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.classes.removeFromRoster(actor.id, id, userId);
    return { removed: true };
  }

  @Get(':id/roster/suspended')
  /** GET /classes/:id/roster/suspended — học sinh đã đình chỉ khỏi lớp (đã gỡ khỏi roster ở chế độ suspend, ghi danh đang SUSPENDED, giữ dữ liệu). */
  async suspendedMembers(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.classes.listSuspendedMembers(actor.id, id);
  }

  @Get(':id/courses')
  /** GET /classes/:id/courses — mọi khoá thuộc lớp. */
  async courses(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.classes.listClassCourses(actor.id, id);
  }

  @Get(':id/staff')
  /** GET /classes/:id/staff — chủ lớp + đồng GV giữ vai tại context lớp, kèm cờ khả năng của người gọi (phân quyền/quản roster). */
  async staff(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.classes.listStaff(actor.id, id);
  }

  @Post(':id/staff')
  /** POST /classes/:id/staff — đặt lại bộ 3 vai lớp (giao bài / chấm bài / quản roster) cho một đồng GV; chỉ người có `class:share`. */
  async setStaff(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: setClassStaffRolesSchema }) dto: SetClassStaffRolesDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.classes.setStaffRoles(actor.id, id, dto);
  }

  @Get(':id/join-requests')
  /** GET /classes/:id/join-requests — hàng chờ duyệt tự báo danh của lớp (chỉ người quản roster). */
  async joinRequests(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.classes.listJoinRequests(actor.id, id);
  }

  @Post(':id/join-requests/:requestId/approve')
  /** POST /classes/:id/join-requests/:requestId/approve — duyệt yêu cầu tự báo danh: học sinh vào roster qua đúng đường ghi danh cấp lớp. */
  async approveJoinRequest(@Param('id', { schema: uuidIdSchema }) id: string, @Param('requestId', { schema: uuidIdSchema }) requestId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.classes.decideJoinRequest(actor.id, id, requestId, true);
  }

  @Post(':id/join-requests/:requestId/reject')
  /** POST /classes/:id/join-requests/:requestId/reject — từ chối yêu cầu tự báo danh (chỉ đóng yêu cầu, không đụng roster). */
  async rejectJoinRequest(@Param('id', { schema: uuidIdSchema }) id: string, @Param('requestId', { schema: uuidIdSchema }) requestId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.classes.decideJoinRequest(actor.id, id, requestId, false);
  }
}

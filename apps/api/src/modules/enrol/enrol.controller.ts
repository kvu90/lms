import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { createEnrolInstanceSchema, enrolUserSchema, selfEnrolSchema, updateEnrolInstanceSchema, type CreateEnrolInstanceDto, type EnrolUserDto, type SelfEnrolDto, type UpdateEnrolInstanceDto } from './dto/enrol.dto';
import { EnrolService } from './enrol.service';

@ApiTags('enrol')
@Controller({ path: 'courses/:courseId/enrol', version: '1' })
/**
 * API ghi danh: enrol instance, ghi danh thủ công/tự ghi danh, đình chỉ và rút.
 *
 * Lớp này khai tiền tố con đầy đủ của chính nó thay vì tiền tố trơ
 * `courses`: tiền tố trơ `courses` chỉ còn module courses sở hữu, mỗi
 * tiền tố đầy đủ khác chỉ có đúng một lớp khai báo. Bảng route giữ
 * nguyên từng ký tự so với trước khi đổi hình thức khai báo.
 */
export class EnrolController {
  constructor(private readonly enrol: EnrolService) {}

  @Post('instances')
  /**
   * POST /courses/:courseId/enrol/instances — tạo phương thức ghi danh.
   */
  async createInstance(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: createEnrolInstanceSchema }) dto: CreateEnrolInstanceDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrol.createInstance(actor.id, courseId, dto);
  }
  @Get('instances')
  /**
   * GET /courses/:courseId/enrol/instances — liệt kê phương thức (khoá ghi danh chỉ hiện với staff quản lý enrol).
   */
  async listInstances(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrol.listInstances(courseId, actor.id);
  }
  @Patch('instances/:instanceId')
  /**
   * PATCH /courses/:courseId/enrol/instances/:instanceId — cập nhật phương thức.
   */
  async updateInstance(@Param('instanceId', { schema: uuidIdSchema }) instanceId: string, @Body({ schema: updateEnrolInstanceSchema }) dto: UpdateEnrolInstanceDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrol.updateInstance(actor.id, instanceId, dto);
  }
  @Delete('instances/:instanceId')
  /**
   * DELETE /courses/:courseId/enrol/instances/:instanceId — xoá phương thức.
   */
  async deleteInstance(@Param('instanceId', { schema: uuidIdSchema }) instanceId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.enrol.deleteInstance(actor.id, instanceId);
    return { deleted: true };
  }

  @Post('instances/:instanceId/enrol')
  /**
   * POST /courses/:courseId/enrol/instances/:instanceId/enrol — ghi danh thủ công.
   */
  async enrolUser(@Param('instanceId', { schema: uuidIdSchema }) instanceId: string, @Body({ schema: enrolUserSchema }) dto: EnrolUserDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrol.enrolUser(actor.id, instanceId, dto.userId, { timeStart: dto.timeStart, timeEnd: dto.timeEnd });
  }
  @Post('instances/:instanceId/self-enrol')
  /**
   * POST /courses/:courseId/enrol/instances/:instanceId/self-enrol — tự ghi danh (có thể cần khoá ghi danh của instance hoặc của một nhóm).
   */
  async selfEnrol(@Param('instanceId', { schema: uuidIdSchema }) instanceId: string, @Body({ schema: selfEnrolSchema }) dto: SelfEnrolDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrol.selfEnrol(actor.id, instanceId, dto.enrolmentKey);
  }
  @Post('instances/:instanceId/self-unenrol')
  /**
   * POST /courses/:courseId/enrol/instances/:instanceId/self-unenrol — học viên tự huỷ ghi danh của chính mình khỏi instance self.
   */
  async selfUnenrol(@Param('instanceId', { schema: uuidIdSchema }) instanceId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrol.selfUnenrol(actor.id, instanceId);
  }
  @Post('instances/:instanceId/users/:userId/suspend')
  /**
   * POST /courses/:courseId/enrol/instances/:instanceId/users/:userId/suspend — đình chỉ ghi danh.
   */
  async suspend(@Param('instanceId', { schema: uuidIdSchema }) instanceId: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrol.setSuspended(actor.id, instanceId, userId, true);
  }
  @Post('instances/:instanceId/users/:userId/reactivate')
  /**
   * POST /courses/:courseId/enrol/instances/:instanceId/users/:userId/reactivate — kích hoạt lại ghi danh.
   */
  async reactivate(@Param('instanceId', { schema: uuidIdSchema }) instanceId: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrol.setSuspended(actor.id, instanceId, userId, false);
  }
  @Delete('instances/:instanceId/users/:userId')
  /**
   * DELETE /courses/:courseId/enrol/instances/:instanceId/users/:userId — rút ghi danh.
   */
  async unenrol(@Param('instanceId', { schema: uuidIdSchema }) instanceId: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrol.unenrolUser(actor.id, instanceId, userId);
  }
}

@ApiTags('enrol')
@Controller({ path: 'courses/:courseId/enrolments', version: '1' })
/**
 * API đọc trạng thái ghi danh của khoá học.
 *
 * Lớp này tách khỏi `EnrolController` vì các route của nó không chung
 * tiền tố con với họ route `courses/:courseId/enrol/instances`: chúng
 * đọc trạng thái ghi danh của khoá học chứ không tác động lên một
 * instance ghi danh. Bảng route giữ nguyên từng ký tự so với trước
 * khi đổi hình thức khai báo.
 */
export class CourseEnrolmentsController {
  constructor(private readonly enrol: EnrolService) {}

  @Get()
  /**
   * GET /courses/:courseId/enrolments — ghi danh của khoá học (chỉ thành viên
   * khoá hoặc người có quyền quản lý enrol mới xem được; người ngoài nhận 404).
   */
  async listEnrolments(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() viewer: AuthenticatedUser) {
    return this.enrol.listEnrolmentsForCourse(courseId, viewer.id);
  }
  @Get('me')
  /**
   * GET /courses/:courseId/enrolments/me — ghi danh của chính user hiện tại.
   */
  async myEnrolment(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() viewer: AuthenticatedUser) {
    return {
      courseId, userId: viewer.id,
      enrolled: await this.enrol.isEnrolled(courseId, viewer.id),
      active: await this.enrol.isEnrolled(courseId, viewer.id, { onlyActive: true }),
    };
  }
}

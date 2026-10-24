import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { createGuardianLinkSchema, type CreateGuardianLinkDto } from './dto/guardians.dto';
import { GuardiansService } from './guardians.service';

@ApiTags('guardians')
@Controller({ path: 'guardian-links', version: '1' })
/**
 * API liên kết giám hộ PH–HS (PH-0, issue #116): trường xác lập/thu hồi
 * liên kết theo hồ sơ đã xác minh; học sinh và phụ huynh tự xem phần liên
 * quan tới mình.
 */
export class GuardianLinksController {
  constructor(private readonly guardians: GuardiansService) {}

  @Post()
  /**
   * POST /guardian-links — tạo liên kết giám hộ (guardian:manage từ gán vai thật).
   */
  async create(@Body({ schema: createGuardianLinkSchema }) dto: CreateGuardianLinkDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.guardians.createLink(actor.id, dto);
  }

  @Get()
  /**
   * GET /guardian-links?guardianUserId=&studentUserId=&status= — liệt kê liên kết (người quản lý, hoặc chính chủ khi lọc theo mình).
   */
  async list(@Query('guardianUserId') guardianUserId: string | undefined, @Query('studentUserId') studentUserId: string | undefined, @Query('status') status: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    return this.guardians.listLinks(actor.id, { guardianUserId, studentUserId, status });
  }

  @Get('mine/students')
  /**
   * GET /guardian-links/mine/students — các con đang liên kết với chính actor (bề mặt phụ huynh).
   */
  async myStudents(@CurrentUser() actor: AuthenticatedUser) {
    return this.guardians.myStudents(actor.id);
  }

  @Get('mine/guardians')
  /**
   * GET /guardian-links/mine/guardians — những người giám hộ đang liên kết với chính actor (học sinh tự xem).
   */
  async myGuardians(@CurrentUser() actor: AuthenticatedUser) {
    return this.guardians.myGuardians(actor.id);
  }

  @Delete(':linkId')
  /**
   * DELETE /guardian-links/:linkId — thu hồi liên kết (không xoá cứng, giữ vết audit).
   */
  async revoke(@Param('linkId', { schema: uuidIdSchema }) linkId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.guardians.revokeLink(actor.id, linkId);
  }
}

@ApiTags('guardians')
@Controller({ path: 'guardian', version: '1' })
/**
 * Bề mặt đọc chỉ-xem của phụ huynh (PH-0, issue #116 — qua API, chưa có UI;
 * đăng nhập phụ huynh riêng là PH-1): quyền đọc suy từ liên kết giám hộ
 * đang hiệu lực, dữ liệu sau cổng công bố như chính học sinh tự xem, mọi
 * lần xem ghi audit vào event_log.
 */
export class GuardianViewsController {
  constructor(private readonly guardians: GuardiansService) {}

  @Get('students/:studentId/courses/:courseId/gradebook')
  /**
   * GET /guardian/students/:studentId/courses/:courseId/gradebook — sổ điểm đã công bố của con trong khoá.
   */
  async gradebook(@Param('studentId', { schema: uuidIdSchema }) studentId: string, @Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.guardians.studentGradebook(actor.id, studentId, courseId);
  }

  @Get('students/:studentId/courses/:courseId/vn-books/:bookId/results')
  /**
   * GET /guardian/students/:studentId/courses/:courseId/vn-books/:bookId/results — kết quả học kì VN đã công bố của con trong sổ.
   */
  async vnResult(@Param('studentId', { schema: uuidIdSchema }) studentId: string, @Param('courseId', { schema: uuidIdSchema }) courseId: string, @Param('bookId', { schema: uuidIdSchema }) bookId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.guardians.studentVnTermResult(actor.id, studentId, courseId, bookId);
  }
}

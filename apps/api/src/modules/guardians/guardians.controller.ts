import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { createGuardianLinkSchema, guardianDigestPreferenceSchema, type CreateGuardianLinkDto, type GuardianDigestPreferenceDto } from './dto/guardians.dto';
import { GuardianDigestService } from './guardian-digest.service';
import { GuardianViewService } from './guardian-view.service';
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

@ApiTags('guardians')
@Controller({ path: 'guardian', version: '1' })
/**
 * Bề mặt phụ huynh chỉ-xem PH-1 (issue #130): tổng quan 4 khối + kết quả
 * học tập đã công bố theo môn cho một con. Cổng liên kết trả 404 đồng
 * nhất khi phụ huynh không có liên kết đang hiệu lực tới học sinh (kể
 * cả học sinh không tồn tại): không lộ sự tồn tại của dữ liệu người
 * khác. Đường ghi duy nhất trên bề mặt này là tuỳ chọn digest PH-2 của
 * CHÍNH phụ huynh cho con mình (dữ liệu của phụ huynh, không phải dữ
 * liệu của con — cùng ngoại lệ với mốc xem trước của PH-1).
 */
export class GuardianSurfaceController {
  constructor(
    private readonly view: GuardianViewService,
    private readonly digests: GuardianDigestService,
  ) {}

  @Get('students/:studentId/overview')
  /**
   * GET /guardian/students/:studentId/overview — 4 khối: tóm tắt tuần,
   * kết quả mới đã công bố từ lần xem trước của phụ huynh, thông báo lớp,
   * tiến độ % theo khoá. Đồng thời cập nhật mốc xem trước của phụ huynh.
   */
  async overview(@Param('studentId', { schema: uuidIdSchema }) studentId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.view.overview(actor.id, studentId);
  }

  @Get('students/:studentId/results')
  /**
   * GET /guardian/students/:studentId/results — kết quả học tập ĐÃ CÔNG
   * BỐ theo môn/khoá: ĐTB/mức + nhận xét tổng kỳ, kết quả năm, điểm tổng
   * khoá đã qua cổng công bố. Không lời phê chi tiết, không bài nộp gốc.
   */
  async results(@Param('studentId', { schema: uuidIdSchema }) studentId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.view.results(actor.id, studentId);
  }

  @Get('students/:studentId/digest-preference')
  /**
   * GET /guardian/students/:studentId/digest-preference — tần suất
   * digest PH-2 hiện hành của chính phụ huynh cho con này (mặc định
   * weekly khi chưa đặt). Qua cổng liên kết như mọi bề mặt phụ huynh.
   */
  async digestPreference(@Param('studentId', { schema: uuidIdSchema }) studentId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.digests.getPreference(actor.id, studentId);
  }

  @Put('students/:studentId/digest-preference')
  /**
   * PUT /guardian/students/:studentId/digest-preference — phụ huynh
   * đặt tần suất digest cho con này (weekly | daily | off); hiệu lực
   * từ cửa sổ kế tiếp. Đây là dữ liệu tuỳ chọn của chính phụ huynh —
   * không phải đường ghi lên dữ liệu của con.
   */
  async setDigestPreference(@Param('studentId', { schema: uuidIdSchema }) studentId: string, @Body({ schema: guardianDigestPreferenceSchema }) dto: GuardianDigestPreferenceDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.digests.setPreference(actor.id, studentId, dto.frequency);
  }
}

import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseInterceptors } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { DeprecatedRouteAliasInterceptor } from '../../common/deprecated-route-alias.interceptor';
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
 * Bề mặt phụ huynh chỉ-xem (PH-0, issue #116 và PH-1, issue #130):
 * điểm theo từng bài đã công bố của con trong khoá, tổng quan 4 khối,
 * kết quả học tập đã công bố theo môn và tuỳ chọn digest của chính
 * phụ huynh cho con mình.
 *
 * Một lớp duy nhất sở hữu tiền tố `guardian`: trước đây hai lớp cùng
 * khai tiền tố này trong cùng file (lớp xem điểm theo khoá và lớp bề
 * mặt tổng quan/kết quả/digest). Quyền đọc suy từ liên kết giám hộ
 * đang hiệu lực, dữ liệu sau cổng công bố như chính học sinh tự xem,
 * mọi lần xem ghi audit vào event_log. Cổng liên kết trả 404 đồng
 * nhất khi phụ huynh không có liên kết đang hiệu lực tới học sinh (kể
 * cả học sinh không tồn tại): không lộ sự tồn tại của dữ liệu người
 * khác. Đường ghi duy nhất trên bề mặt này là tuỳ chọn digest PH-2 của
 * CHÍNH phụ huynh cho con mình (dữ liệu của phụ huynh, không phải dữ
 * liệu của con — cùng ngoại lệ với mốc xem trước của PH-1).
 *
 * Bảng route giữ nguyên từng ký tự so với trước khi hợp nhất hai lớp,
 * trừ một ngoại lệ làm phẳng của issue #346: path gradebook của phụ
 * huynh từ `students/:studentId/courses/:courseId/gradebook` (3 cấp
 * tài nguyên dưới gốc `guardian`) chuyển thành
 * `students/:studentId/gradebooks/:courseId` (2 cấp); path cũ giữ lại
 * dưới dạng handler alias kèm header Deprecation/Sunset và log alias,
 * uỷ quyền nguyên vẹn cho cùng logic đọc điểm đã công bố.
 */
export class GuardianController {
  constructor(
    private readonly guardians: GuardiansService,
    private readonly view: GuardianViewService,
    private readonly digests: GuardianDigestService,
  ) {}

  @Get('students/:studentId/gradebooks/:courseId')
  /**
   * GET /guardian/students/:studentId/gradebooks/:courseId — điểm theo từng bài đã công bố của con trong khoá.
   */
  async gradebook(@Param('studentId', { schema: uuidIdSchema }) studentId: string, @Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.guardians.studentGradebook(actor.id, studentId, courseId);
  }

  @Get('students/:studentId/courses/:courseId/gradebook')
  @UseInterceptors(DeprecatedRouteAliasInterceptor)
  /**
   * GET /guardian/students/:studentId/courses/:courseId/gradebook — alias cũ của GET
   * /guardian/students/:studentId/gradebooks/:courseId (issue #346): path cũ có 3 cấp
   * tài nguyên nên làm phẳng về 2 cấp; response qua alias mang header
   * Deprecation/Sunset và mỗi lượt gọi sinh log `deprecated_route_alias`.
   * Logic đọc điểm giữ nguyên: vẫn qua cổng liên kết giám hộ và cổng
   * công bố điểm như handler canonical, chỉ khác path gọi vào.
   */
  async legacyGradebook(@Param('studentId', { schema: uuidIdSchema }) studentId: string, @Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.guardians.studentGradebook(actor.id, studentId, courseId);
  }

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

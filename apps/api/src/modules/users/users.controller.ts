import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseInterceptors } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { DeprecatedRouteAliasInterceptor } from '../../common/deprecated-route-alias.interceptor';
import { RequireCapability } from '../../common/require-capability.decorator';
import { createUserSchema, listUsersQueryServerSchema, setUserPreferenceSchema, updateUserSchema, type CreateUserDto, type ListUsersQueryDto, type SetPreferenceDto, type UpdateUserDto } from './dto/users.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@Controller({ path: 'users', version: '1' })
/**
 * API người dùng: quản trị tài khoản và hồ sơ cá nhân (/users, /users/me).
 */
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  @RequireCapability('user:create')
  /**
   * POST /users — tạo tài khoản (capability user:create).
   */
  async create(@Body({ schema: createUserSchema }) dto: CreateUserDto) {
    const user = await this.users.createUser(dto);
    return { id: user.id, username: user.username, email: user.email, firstName: user.firstName, lastName: user.lastName };
  }

  @Get()
  @RequireCapability('user:viewdetails')
  /**
   * GET /users — tìm kiếm/phân trang tài khoản (user:viewdetails), kèm lọc
   * theo trạng thái (đang hoạt động/bị đình chỉ/đã xoá) và sắp xếp theo
   * tên/ngày tạo/lần đăng nhập gần nhất theo hợp đồng truy vấn; không truyền
   * tham số mới thì giữ hành vi mặc định vốn có (ẩn tài khoản đã xoá, thứ tự
   * theo id).
   */
  async list(@Query({ schema: listUsersQueryServerSchema }) query: ListUsersQueryDto, @CurrentUser() viewer: AuthenticatedUser) {
    const result = await this.users.listUsers(query.search, query.page ?? 1, query.pageSize ?? 20, {
      status: query.status,
      sortBy: query.sortBy,
      sortDirection: query.sortDirection,
    });
    // View của cả trang lắp MỘT lần theo lô (DL-07, issue #489) thay
    // vì gọi getProfileView lặp cho từng user.
    const views = await this.users.getProfileViews(result.users, viewer.id);
    return { users: views, total: result.total, page: result.page, pageSize: result.pageSize };
  }

  @Get('me')
  /**
   * GET /users/me — hồ sơ của chính người đang đăng nhập.
   */
  async me(@CurrentUser() viewer: AuthenticatedUser) { return this.users.getProfileView(viewer.id, viewer.id); }

  @Get('me/capabilities')
  /**
   * GET /users/me/capabilities — quyền của chính người đang đăng nhập:
   * cờ site admin, các gán vai trò theo context và capability đã phân
   * giải tại các context liên quan. Chỉ trả dữ liệu của người gọi (không
   * nhận tham số user), không cần capability quản trị.
   */
  async myCapabilities(@CurrentUser() viewer: AuthenticatedUser) {
    return this.users.getMyAccess(viewer.id, { isGuest: viewer.username === 'guest' });
  }

  @Get(':id')
  @RequireCapability('user:viewdetails', 'param:userId:userctx')
  /**
   * GET /users/:id — hồ sơ một user (email ẩn nếu thiếu capability).
   */
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() viewer: AuthenticatedUser) {
    return this.users.getProfileView(id, viewer.id);
  }

  @Patch(':id')
  /**
   * PATCH /users/:id — cập nhật hồ sơ. Định danh người sửa được
   * truyền xuống service để chốt chặn trường `password` ở trường
   * hợp tự sửa (tự đổi mật khẩu chỉ qua luồng đổi mật khẩu có tái
   * xác thực) và để thu hồi phiên của tài khoản đích khi mật khẩu
   * bị đặt qua đường này.
   */
  async update(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updateUserSchema }) dto: UpdateUserDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.users.assertCanUpdateProfile(actor.id, id);
    const user = await this.users.updateUser(id, dto, actor.id);
    return this.users.getProfileView(user.id, actor.id);
  }

  @Post(':id/suspend')
  @RequireCapability('user:update')
  /**
   * POST /users/:id/suspend — đình chỉ tài khoản.
   */
  async suspend(@Param('id', { schema: uuidIdSchema }) id: string) {
    const user = await this.users.setSuspended(id, true);
    return { id: user.id, suspended: user.suspended };
  }
  @Post(':id/reactivate')
  @RequireCapability('user:update')
  /**
   * POST /users/:id/reactivate — khôi phục tài khoản. Động từ chuẩn
   * của cặp đối nghĩa đình chỉ là `suspend`/`reactivate` theo danh
   * sách hành động đóng (issue #345); path cũ `:id/unsuspend` giữ qua
   * handler alias ngay dưới.
   */
  async reactivate(@Param('id', { schema: uuidIdSchema }) id: string) {
    const user = await this.users.setSuspended(id, false);
    return { id: user.id, suspended: user.suspended };
  }
  @Post(':id/unsuspend')
  @RequireCapability('user:update')
  @UseInterceptors(DeprecatedRouteAliasInterceptor)
  /**
   * POST /users/:id/unsuspend — alias cũ của POST /users/:id/reactivate:
   * uỷ quyền nguyên vẹn cho handler canonical (cùng cổng capability
   * `user:update`); response mang header Deprecation/Sunset và lượt
   * gọi được ghi log alias có cấu trúc (căn cứ điều kiện gỡ alias: 0
   * lượt gọi trong 14 ngày).
   */
  async unsuspend(@Param('id', { schema: uuidIdSchema }) id: string) {
    return this.reactivate(id);
  }
  @Delete(':id')
  @RequireCapability('user:delete')
  /**
   * DELETE /users/:id — xoá mềm tài khoản.
   */
  async remove(@Param('id', { schema: uuidIdSchema }) id: string) {
    const user = await this.users.deleteUser(id);
    return { id: user.id, deleted: user.deleted };
  }

  @Put(':id/preferences')
  /**
   * PUT /users/me/preferences/:name — ghi tuỳ chọn cá nhân.
   */
  async setPreference(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: setUserPreferenceSchema }) dto: SetPreferenceDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.users.assertCanUpdateProfile(actor.id, id);
    await this.users.setPreference(id, dto.name, dto.value ?? null);
    return { saved: true };
  }
  @Get(':id/preferences/:name')
  /**
   * GET /users/me/preferences/:name — đọc tuỳ chọn cá nhân.
   */
  async getPreference(@Param('id', { schema: uuidIdSchema }) id: string, @Param('name') name: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.users.assertCanUpdateProfile(actor.id, id);
    return { name, value: (await this.users.getPreference(id, name)) ?? null };
  }
}

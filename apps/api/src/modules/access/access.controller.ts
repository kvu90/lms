import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { RequireCapability } from '../../common/require-capability.decorator';
import { ContextsService } from './contexts.service';
import { assignRoleSchema, capabilityMatrixQuerySchema, createContextSchema, createRoleSchema, hasCapabilityQueryServerSchema, listAssignmentsQueryServerSchema, listUsersWithAssignmentsQueryServerSchema, overrideCapabilitySchema, replaceRoleCapabilitiesSchema, updateRoleSchema, type AssignRoleDto, type CapabilityMatrixQueryDto, type CreateContextDto, type CreateRoleDto, type HasCapabilityQueryDto, type ListAssignmentsQueryDto, type ListUsersWithAssignmentsQueryDto, type OverrideCapabilityDto, type ReplaceRoleCapabilitiesDto, type UpdateRoleDto } from './dto/access.dto';
import { PermissionEvaluator } from './permission-evaluator.service';
import { RolesService } from './roles.service';

@ApiTags('access')
@Controller({ path: 'access', version: '1' })
/**
 * API quản trị phân quyền: context, role, capability, gán role và kiểm tra quyền.
 * Mọi endpoint đều qua PermissionEvaluator với capability role:* tại context hệ thống.
 */
export class AccessController {
  constructor(
    private readonly contexts: ContextsService,
    private readonly roles: RolesService,
    private readonly evaluator: PermissionEvaluator,
  ) {}

  @Post('contexts')
  @RequireCapability('site:config')
  /**
   * POST /access/contexts — tạo context mới dưới context cha.
   */
  async createContext(@Body({ schema: createContextSchema }) dto: CreateContextDto) {
    return this.contexts.createContext(dto.contextLevel, dto.instanceId, dto.parentId);
  }
  @Get('contexts')
  @RequireCapability('role:manage')
  /**
   * GET /access/contexts — liệt kê cây context.
   */
  async listContexts() { return this.contexts.listContexts(); }
  @Get('contexts/:id')
  @RequireCapability('role:manage')
  /**
   * GET /access/contexts/:id — chi tiết một context.
   */
  async getContext(@Param('id', { schema: uuidIdSchema }) id: string) { return this.contexts.getContext(id); }

  @Post('roles')
  @RequireCapability('role:manage')
  /**
   * POST /access/roles — tạo role mới.
   */
  async createRole(@Body({ schema: createRoleSchema }) dto: CreateRoleDto) { return this.roles.createRole(dto); }
  @Get('roles')
  @RequireCapability('role:manage')
  /**
   * GET /access/roles — liệt kê role kèm tổng hợp phía server (số người
   * dùng phân biệt đang giữ từng role và tổng hợp năng lực từ tập ghi
   * đè đã lưu của role), đủ để dựng thẻ role từ một lần gọi.
   */
  async listRoles() { return this.roles.listRoles(); }
  @Get('roles/:id')
  @RequireCapability('role:manage')
  /**
   * GET /access/roles/:id — chi tiết role.
   */
  async getRole(@Param('id', { schema: uuidIdSchema }) id: string) { return this.roles.getRole(id); }
  @Patch('roles/:id')
  @RequireCapability('role:manage')
  /**
   * PATCH /access/roles/:id — cập nhật role.
   */
  async updateRole(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updateRoleSchema }) dto: UpdateRoleDto) { return this.roles.updateRole(id, dto); }
  @Delete('roles/:id')
  @RequireCapability('role:manage')
  /**
   * DELETE /access/roles/:id — xoá role; bị chặn khi role là role dựng
   * sẵn (archetype) hoặc đang còn người giữ, hai trường hợp phân biệt
   * bằng mã lỗi riêng.
   */
  async deleteRole(@Param('id', { schema: uuidIdSchema }) id: string) { await this.roles.deleteRole(id); return { deleted: true }; }

  @Get('capabilities')
  @RequireCapability('role:manage')
  /**
   * GET /access/capabilities — liệt kê capability đã khai báo.
   */
  async listCapabilities() { return this.roles.listCapabilities(); }
  @Get('roles/:id/capabilities')
  @RequireCapability('role:manage')
  /**
   * GET /access/roles/:id/capabilities — ma trận override đã lưu của role.
   */
  async listRoleCapabilities(@Param('id', { schema: uuidIdSchema }) id: string) { return this.roles.listRoleCapabilities(id); }
  @Get('capability-matrix')
  @RequireCapability('role:manage')
  /**
   * GET /access/capability-matrix?contextId=… — ma trận ghi đè đã lưu
   * của MỌI role tại đúng một context trong một lần gọi (trang
   * Permissions toàn trang dựng bảng chuyển vị từ đáp ứng này thay vì
   * gọi ma trận riêng cho từng role): mỗi role kèm số người giữ phân
   * biệt và tập ghi đè tại context được hỏi; role không có ghi đè tại
   * context đó mang tập rỗng, ghi đè của context khác không xuất
   * hiện. Context không tồn tại trả 404 `access.context_not_found`
   * như các đường đọc hiện hành của module.
   */
  async getCapabilityMatrix(@Query({ schema: capabilityMatrixQuerySchema }) query: CapabilityMatrixQueryDto) {
    return this.roles.getCapabilityMatrix(query.contextId);
  }
  @Put('roles/:id/capabilities')
  @RequireCapability('role:override', 'body:contextId')
  /**
   * PUT /access/roles/:id/capabilities — lưu ma trận override thay toàn
   * bộ của role tại một context trong một lần gọi nguyên tử: sau khi áp
   * dụng, tập ghi đè của role tại context đó bằng đúng tập gửi lên.
   */
  async replaceRoleCapabilities(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: replaceRoleCapabilitiesSchema }) dto: ReplaceRoleCapabilitiesDto, @CurrentUser() actor: AuthenticatedUser) {
    const overrides = await this.roles.replaceRoleCapabilities(id, dto.contextId, dto.overrides, actor.id);
    return { roleId: id, contextId: dto.contextId, overrides };
  }

  @Post('assignments')
  @RequireCapability('role:assign')
  /**
   * POST /access/assignments — gán role cho user tại context.
   */
  async assign(@Body({ schema: assignRoleSchema }) dto: AssignRoleDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.roles.assignRole(dto.userId, dto.roleId, dto.contextId, actor.id);
  }
  @Get('assignments')
  @RequireCapability('role:assign')
  /**
   * GET /access/assignments — liệt kê gán role cho bảng quản trị: lọc
   * theo user/context/role, tìm kiếm theo người dùng (tên và email),
   * phân trang phía server kèm tổng số dòng khớp, mỗi dòng kèm tên và
   * email của người dùng được gán.
   */
  async listAssignments(@Query({ schema: listAssignmentsQueryServerSchema }) query: ListAssignmentsQueryDto) {
    return this.roles.listAssignmentsPage(
      { userId: query.userId, contextId: query.contextId, roleId: query.roleId, search: query.search },
      query.page,
      query.pageSize,
    );
  }
  @Get('users-with-assignments')
  @RequireCapability('role:assign')
  /**
   * GET /access/users-with-assignments — liệt kê người dùng kèm toàn
   * bộ gán vai của họ cho bảng người dùng của trang vai trò: phân
   * trang theo NGƯỜI DÙNG (mỗi người đúng một dòng, `total` đếm
   * người), lọc đồng thời phía server theo tìm kiếm (họ tên, email,
   * tên đăng nhập), vai trò (người có ít nhất một gán với vai đó,
   * mảng gán trả về không bị cắt theo vai lọc) và trạng thái tài
   * khoản; mỗi dòng gán kèm tên vai, số cấp context và `component`
   * để nhận biết gán do ghi danh. Cổng `role:assign` tại context hệ
   * thống như đường đọc bảng gán vai; truy vấn phá hợp đồng bị
   * validation chặn bằng lỗi `http.validation_failed`.
   */
  async listUsersWithAssignments(@Query({ schema: listUsersWithAssignmentsQueryServerSchema }) query: ListUsersWithAssignmentsQueryDto) {
    return this.roles.listUsersWithAssignmentsPage(
      { search: query.search, roleId: query.roleId, status: query.status },
      query.page,
      query.pageSize,
    );
  }
  @Delete('assignments/:id')
  @RequireCapability('role:assign')
  /**
   * DELETE /access/assignments/:id — gỡ gán role.
   */
  async unassign(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) { await this.roles.unassignRole(id, actor.id); return { deleted: true }; }

  @Post('overrides')
  @RequireCapability('role:override', 'body:contextId')
  /**
   * POST /access/overrides — đặt override capability cho role tại context.
   */
  async override(@Body({ schema: overrideCapabilitySchema }) dto: OverrideCapabilityDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.roles.setCapabilityOverride(dto.roleId, dto.capability, dto.contextId, dto.permission, actor.id);
    return { updated: true };
  }

  /** Đầu dò debug/admin: evaluator trả lời gì cho (user, capability, context)? */
  @Get('has-capability')
  @RequireCapability('role:manage')
  /**
   * GET /access/has-capability — kiểm tra capability của một user tại context (dùng cho client và kiểm chứng).
   */
  async hasCapability(@Query({ schema: hasCapabilityQueryServerSchema }) query: HasCapabilityQueryDto) {
    const allowed = await this.evaluator.hasCapability(query.userId, query.capability, query.contextId);
    return { userId: query.userId, capability: query.capability, contextId: query.contextId, allowed };
  }
}

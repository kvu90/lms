import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { PlatformRoute } from '../../common/platform-route.decorator';
import { ControlPlaneRegistryService } from './control-plane.service';
import {
  changeSpaceStatusSchema,
  createSpaceRegistrationSchema,
  recordSpaceSchemaMigrationRunSchema,
  updateSpaceRegistrationSchema,
  updateSpaceSchemaRegistrySchema,
  type ChangeSpaceStatusDto,
  type CreateSpaceRegistrationDto,
  type RecordSpaceSchemaMigrationRunDto,
  type UpdateSpaceRegistrationDto,
  type UpdateSpaceSchemaRegistryDto,
} from './dto/control-plane.dto';

/**
 * Bề mặt HTTP của control plane (issue #580) — tiền tố riêng
 * `control-plane`, tách khỏi mọi tiền tố nghiệp vụ:
 * - `POST /control-plane/spaces` — tạo dòng đăng ký không gian.
 * - `PATCH /control-plane/spaces/:id` — cập nhật dòng đăng ký.
 * - `POST /control-plane/spaces/:id/status` — đổi trạng thái vòng đời.
 * - `GET /control-plane/spaces/:id/history` — lịch sử quản trị của sổ.
 * - `GET /control-plane/spaces/by-slug/:slug` — tra cứu định tuyến.
 * - `GET|PUT /control-plane/spaces/:id/schema-registry` — đọc/ghi
 *   trạng thái schema của kho.
 * - `GET|POST /control-plane/spaces/:id/schema-migration-runs` —
 *   đọc/ghi nhật ký lượt chạy migration của kho.
 *
 * Mọi route đều qua service gác capability quản trị platform
 * (`tenant:manage` tại context hệ thống); controller chỉ là lớp vận
 * chuyển mỏng theo khuôn các controller hiện hữu.
 *
 * Tách bề mặt (issue #584): toàn bộ controller mang
 * `@PlatformRoute()` — chỉ token mang audience `platform` (cấp từ
 * bề mặt đăng nhập quản trị platform riêng) mới được gọi; token
 * nghiệp vụ thường bị `AudienceGuard` từ chối trước cả cổng
 * capability của service.
 */
@PlatformRoute()
@Controller({ path: 'control-plane/spaces', version: '1' })
export class ControlPlaneController {
  constructor(private readonly registry: ControlPlaneRegistryService) {}

  @Post()
  async create(@Body({ schema: createSpaceRegistrationSchema }) dto: CreateSpaceRegistrationDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.registry.createRegistration(actor.id, dto);
  }

  @Get('by-slug/:slug')
  async bySlug(@Param('slug') slug: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.registry.getBySlug(actor.id, slug);
  }

  @Patch(':id')
  async update(
    @Param('id', { schema: uuidIdSchema }) id: string,
    @Body({ schema: updateSpaceRegistrationSchema }) dto: UpdateSpaceRegistrationDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.registry.updateRegistration(actor.id, id, dto);
  }

  @Post(':id/status')
  async changeStatus(
    @Param('id', { schema: uuidIdSchema }) id: string,
    @Body({ schema: changeSpaceStatusSchema }) dto: ChangeSpaceStatusDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.registry.changeStatus(actor.id, id, dto);
  }

  @Get(':id/history')
  async history(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.registry.listHistory(actor.id, id);
  }

  @Get(':id/schema-registry')
  async getSchemaRegistry(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.registry.getSchemaRegistry(actor.id, id);
  }

  @Put(':id/schema-registry')
  async updateSchemaRegistry(
    @Param('id', { schema: uuidIdSchema }) id: string,
    @Body({ schema: updateSpaceSchemaRegistrySchema }) dto: UpdateSpaceSchemaRegistryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.registry.updateSchemaRegistry(actor.id, id, dto);
  }

  @Get(':id/schema-migration-runs')
  async listMigrationRuns(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.registry.listMigrationRuns(actor.id, id);
  }

  @Post(':id/schema-migration-runs')
  async recordMigrationRun(
    @Param('id', { schema: uuidIdSchema }) id: string,
    @Body({ schema: recordSpaceSchemaMigrationRunSchema }) dto: RecordSpaceSchemaMigrationRunDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.registry.recordMigrationRun(actor.id, id, dto);
  }
}

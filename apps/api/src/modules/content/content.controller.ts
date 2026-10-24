import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { ContentService } from './content.service';
import {
  createPageSchema, createResourceSchema, updatePageSchema, updateResourceSchema,
  type CreatePageDto, type CreateResourceDto, type UpdatePageDto, type UpdateResourceDto,
} from './dto/content.dto';

@ApiTags('content')
@Controller({ path: 'courses/:courseId/pages', version: '1' })
/** API tạo trang đọc (mod_page) trong một khoá học. */
export class CoursePagesController {
  constructor(private readonly content: ContentService) {}

  @Post()
  /** POST /courses/:courseId/pages — tạo trang đọc kèm course module. */
  async create(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: createPageSchema }) dto: CreatePageDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.content.createPage(actor.id, courseId, dto);
  }
}

@ApiTags('content')
@Controller({ path: 'pages', version: '1' })
/** API trang đọc: đọc cho người xem, sửa và xoá cho người quản hoạt động. */
export class PagesController {
  constructor(private readonly content: ContentService) {}

  @Get(':id')
  /** GET /pages/:id — nội dung trang đọc cho người xem (qua cổng khoá học). */
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() viewer: AuthenticatedUser) {
    return this.content.getPageForUser(viewer.id, id);
  }

  @Patch(':id')
  /** PATCH /pages/:id — sửa trang đọc. */
  async update(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updatePageSchema }) dto: UpdatePageDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.content.updatePage(actor.id, id, dto);
  }

  @Delete(':id')
  /** DELETE /pages/:id — xoá trang đọc và course module của nó. */
  async remove(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.content.deletePage(actor.id, id);
    return { deleted: true };
  }
}

@ApiTags('content')
@Controller({ path: 'courses/:courseId/resources', version: '1' })
/** API tạo tài nguyên (mod_resource) trong một khoá học. */
export class CourseResourcesController {
  constructor(private readonly content: ContentService) {}

  @Post()
  /** POST /courses/:courseId/resources — tạo tài nguyên (file hoặc liên kết) kèm course module. */
  async create(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: createResourceSchema }) dto: CreateResourceDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.content.createResource(actor.id, courseId, dto);
  }
}

@ApiTags('content')
@Controller({ path: 'resources', version: '1' })
/** API tài nguyên: đọc cho người xem (file kèm URL đã ký), sửa và xoá. */
export class ResourcesController {
  constructor(private readonly content: ContentService) {}

  @Get(':id')
  /** GET /resources/:id — tài nguyên cho người xem (qua cổng khoá học). */
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() viewer: AuthenticatedUser) {
    return this.content.getResourceForUser(viewer.id, id);
  }

  @Patch(':id')
  /** PATCH /resources/:id — sửa tài nguyên. */
  async update(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updateResourceSchema }) dto: UpdateResourceDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.content.updateResource(actor.id, id, dto);
  }

  @Delete(':id')
  /** DELETE /resources/:id — xoá tài nguyên và course module của nó. */
  async remove(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.content.deleteResource(actor.id, id);
    return { deleted: true };
  }
}

@ApiTags('content')
@Controller({ path: 'courses/:courseId', version: '1' })
/** API trang học (player) và tiến độ học trong khoá. */
export class PlayerController {
  constructor(private readonly content: ContentService) {}

  @Get('player/:cmId')
  /** GET /courses/:courseId/player/:cmId — dữ liệu player cho một mục; ghi last-access của người xem. */
  async player(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Param('cmId', { schema: uuidIdSchema }) cmId: string, @CurrentUser() viewer: AuthenticatedUser) {
    return this.content.getPlayer(viewer.id, courseId, cmId);
  }

  @Get('progress/me')
  /** GET /courses/:courseId/progress/me — tiến độ của chính người xem + điểm Học tiếp. */
  async myProgress(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() viewer: AuthenticatedUser) {
    return this.content.getMyProgress(viewer.id, courseId);
  }

  @Get('progress/class-markers')
  /** GET /courses/:courseId/progress/class-markers — mốc "lớp đã học tới đây" theo từng lớp (nhóm). */
  async classMarkers(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() viewer: AuthenticatedUser) {
    return this.content.getClassMarkers(viewer.id, courseId);
  }
}

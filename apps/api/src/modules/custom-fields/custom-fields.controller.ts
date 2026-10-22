import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RequireCapability } from '../../common/require-capability.decorator';
import { CustomFieldsService, type FieldConfig } from './custom-fields.service';
import { createCustomFieldCategorySchema, createCustomFieldSchema, type CreateCategoryDto, type CreateFieldDto } from './dto/custom-fields.dto';


@ApiTags('custom-fields')
@Controller({ path: 'custom-fields', version: '1' })
/**
 * API định nghĩa trường tuỳ biến (quản trị): category và field.
 */
export class CustomFieldsController {
  constructor(private readonly service: CustomFieldsService) {}
  @Post('categories')
  @RequireCapability('lms/customfield:manage')
  /**
   * POST /custom-fields/categories — tạo category.
   */
  async createCategory(@Body({ schema: createCustomFieldCategorySchema }) dto: CreateCategoryDto) { return this.service.createCategory(dto); }
  @Get('categories')
  @RequireCapability('lms/customfield:manage')
  /**
   * GET /custom-fields/categories — liệt kê category theo component/area.
   */
  async listCategories(@Query('component') component = 'core_user', @Query('area') area = 'user') { return this.service.listCategories(component, area); }
  @Delete('categories/:id')
  @RequireCapability('lms/customfield:manage')
  /**
   * DELETE /custom-fields/categories/:id — xoá category.
   */
  async deleteCategory(@Param('id', ParseIntPipe) id: number) { await this.service.deleteCategory(id); return { deleted: true }; }
  @Post('fields')
  @RequireCapability('lms/customfield:manage')
  /**
   * POST /custom-fields/categories/:id/fields — thêm field vào category.
   */
  async createField(@Body({ schema: createCustomFieldSchema }) dto: CreateFieldDto) { return this.service.createField(dto.categoryid, { ...dto, configdata: dto.configdata as FieldConfig | undefined }); }
  @Get('fields')
  @RequireCapability('lms/customfield:manage')
  /**
   * GET /custom-fields/categories/:id/fields — liệt kê field.
   */
  async listFields(@Query('component') component = 'core_user', @Query('area') area = 'user') { return this.service.listFields(component, area); }
  @Delete('fields/:id')
  @RequireCapability('lms/customfield:manage')
  /**
   * DELETE /custom-fields/fields/:id — xoá field.
   */
  async deleteField(@Param('id', ParseIntPipe) id: number) { await this.service.deleteField(id); return { deleted: true }; }
}

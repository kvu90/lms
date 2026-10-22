import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsInt, IsObject, IsOptional, IsString } from 'class-validator';
import { RequireCapability } from '../../common/require-capability.decorator';
import { CustomFieldsService, type FieldConfig } from './custom-fields.service';

class CreateCategoryDto { @IsString() name!: string; @IsString() component!: string; @IsString() area!: string }
class CreateFieldDto {
  @IsInt() categoryid!: number; @IsString() shortname!: string; @IsString() name!: string; @IsString() type!: string;
  @IsOptional() @IsObject() configdata?: FieldConfig;
}

@ApiTags('custom-fields')
@Controller({ path: 'custom-fields', version: '1' })
export class CustomFieldsController {
  constructor(private readonly service: CustomFieldsService) {}
  @Post('categories')
  @RequireCapability('lms/customfield:manage')
  async createCategory(@Body() dto: CreateCategoryDto) { return this.service.createCategory(dto); }
  @Get('categories')
  @RequireCapability('lms/customfield:manage')
  async listCategories(@Query('component') component = 'core_user', @Query('area') area = 'user') { return this.service.listCategories(component, area); }
  @Delete('categories/:id')
  @RequireCapability('lms/customfield:manage')
  async deleteCategory(@Param('id', ParseIntPipe) id: number) { await this.service.deleteCategory(id); return { deleted: true }; }
  @Post('fields')
  @RequireCapability('lms/customfield:manage')
  async createField(@Body() dto: CreateFieldDto) { return this.service.createField(dto.categoryid, dto); }
  @Get('fields')
  @RequireCapability('lms/customfield:manage')
  async listFields(@Query('component') component = 'core_user', @Query('area') area = 'user') { return this.service.listFields(component, area); }
  @Delete('fields/:id')
  @RequireCapability('lms/customfield:manage')
  async deleteField(@Param('id', ParseIntPipe) id: number) { await this.service.deleteField(id); return { deleted: true }; }
}

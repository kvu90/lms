import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { RequireCapability } from '../../common/require-capability.decorator';
import { indexRawDocumentSchema, searchIndexItemSchema, type IndexItemDto, type IndexRawDto } from './dto/search.dto';
import { SearchService } from './search.service';

/** Controller tìm kiếm toàn cục — kết quả luôn qua lọc quyền ở service. */
@ApiTags('search')
@Controller({ path: 'search', version: '1' })
export class SearchController {
  constructor(private readonly search: SearchService) {}
  @Get()
  async query(@Query('q') q: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.search.search(actor.id, q ?? '');
  }
  @Get('areas')
  async areas() { return this.search.listAreas(); }
  // Các route ghi/xoá/reindex dưới đây là thao tác bảo trì chỉ mục: gác bằng
  // search:manage tại system context (vá H2+H5, sổ #134). Luồng nạp index hợp
  // lệ trong hệ thống gọi thẳng SearchService ở tầng service, không qua HTTP.
  @Post('index')
  @RequireCapability('search:manage')
  async index(@Body({ schema: searchIndexItemSchema }) dto: IndexItemDto) { return { indexed: await this.search.indexItem(dto.area, dto.itemId) }; }
  @Post('index-raw')
  @RequireCapability('search:manage')
  async indexRaw(@Body({ schema: indexRawDocumentSchema }) dto: IndexRawDto) { return this.search.indexRaw(dto); }
  @Post('reindex')
  @RequireCapability('search:manage')
  async reindex() { return this.search.reindexAll(); }
  @Delete(':area/:itemId')
  @RequireCapability('search:manage')
  async remove(@Param('area') area: string, @Param('itemId', { schema: uuidIdSchema }) itemId: string) {
    await this.search.removeDoc(area, itemId); return { deleted: true };
  }
}

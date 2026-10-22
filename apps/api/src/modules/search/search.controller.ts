import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
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
  @Post('index')
  async index(@Body({ schema: searchIndexItemSchema }) dto: IndexItemDto) { return { indexed: await this.search.indexItem(dto.area, dto.itemid) }; }
  @Post('index-raw')
  async indexRaw(@Body({ schema: indexRawDocumentSchema }) dto: IndexRawDto) { return this.search.indexRaw(dto); }
  @Post('reindex')
  async reindex() { return this.search.reindexAll(); }
  @Delete(':area/:itemid')
  async remove(@Param('area') area: string, @Param('itemid', { schema: uuidIdSchema }) itemid: string) {
    await this.search.removeDoc(area, itemid); return { deleted: true };
  }
}

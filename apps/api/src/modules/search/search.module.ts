import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { SocialModule } from '../social/social.module';
import { SearchController } from './search.controller';
import { PostgresSearchEngine, SEARCH_ENGINE, SearchService } from './search.service';
import { SearchRepository } from './search.repository';

/**
 * SearchModule facade: SearchService. Engine là PORT (SEARCH_ENGINE) với
 * adapter Postgres thật; area là registry đảo ngược.
 */
@Module({
  // SocialModule để SearchService dùng BlogService.canView làm cổng
  // audience cho area blog (issue #48). SocialModule không import
  // SearchModule nên không có vòng lặp.
  imports: [AccessModule, SocialModule],
  controllers: [SearchController],
  providers: [SearchRepository, SearchService, PostgresSearchEngine, { provide: SEARCH_ENGINE, useClass: PostgresSearchEngine }],
  exports: [SearchService],
})
export class SearchModule {}

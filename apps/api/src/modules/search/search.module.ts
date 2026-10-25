import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { SearchController } from './search.controller';
import { PostgresSearchEngine, SEARCH_ENGINE, SearchService } from './search.service';
import { SearchRepository } from './search.repository';

/**
 * SearchModule facade: SearchService. Engine là PORT (SEARCH_ENGINE) với
 * adapter Postgres thật; area là registry đảo ngược.
 */
@Module({
  imports: [AccessModule],
  controllers: [SearchController],
  providers: [SearchRepository, SearchService, PostgresSearchEngine, { provide: SEARCH_ENGINE, useClass: PostgresSearchEngine }],
  exports: [SearchService],
})
export class SearchModule {}

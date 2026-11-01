import { Module } from '@nestjs/common';
import { SearchRepository } from '@lms/db/repositories/search';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { AccessModule } from '../access/access.module';
import { SearchController } from './search.controller';
import { PostgresSearchEngine, SEARCH_ENGINE, SearchService } from './search.service';

/**
 * SearchModule facade: SearchService. Engine là PORT (SEARCH_ENGINE) với
 * adapter Postgres thật; area là registry đảo ngược.
 */
@Module({
  imports: [AccessModule, SpaceRoutingModule],
  controllers: [SearchController],
  providers: [
    // Repository của package @lms/db chạy trên handle Kysely đã định
    // tuyến theo không gian (issue #648).
    {
      provide: SearchRepository,
      useFactory: (spaceDatabase: SpaceDatabaseService) => new SearchRepository(spaceDatabase.routedKysely),
      inject: [SpaceDatabaseService],
    },
    SearchService, PostgresSearchEngine, { provide: SEARCH_ENGINE, useClass: PostgresSearchEngine },
  ],
  exports: [SearchService],
})
export class SearchModule {}

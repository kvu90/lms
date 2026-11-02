import { Module } from '@nestjs/common';
import { ContentBankRepository } from '@lms/db/repositories/content-bank';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { FilesModule } from '../files/files.module';
import { SearchModule } from '../search/search.module';
import { ContentBankController } from './content-bank.controller';
import { ContentBankService } from './content-bank.service';

/**
 * ContentBankModule facade: ContentBankService. CoursesModule phục vụ
 * điểm cắm "Thêm từ kho" (tạo course module + sao file vào context của
 * module).
 *
 * Từ issue #646, ContentBankRepository sống ở `@lms/db` (lớp
 * thuần, không phụ thuộc Nest) nên module lắp nó bằng factory
 * provider với handle Kysely định tuyến của kho trung tâm
 * (`SpaceDatabaseService.routedKysely`).
 */
@Module({
  imports: [AccessModule, FilesModule, SearchModule, CoursesModule, SpaceRoutingModule],
  controllers: [ContentBankController],
  providers: [
    {
      provide: ContentBankRepository,
      useFactory: (spaceDb: SpaceDatabaseService) => new ContentBankRepository(spaceDb.routedKysely),
      inject: [SpaceDatabaseService],
    },
    ContentBankService,
  ],
  exports: [ContentBankService],
})
export class ContentBankModule {}

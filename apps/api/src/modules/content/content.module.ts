import { Module } from '@nestjs/common';
import { ContentRepository } from '@lms/db/repositories/content';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { CompletionModule } from '../completion/completion.module';
import { CoursesModule } from '../courses/courses.module';
import { FilesModule } from '../files/files.module';
import {
  CoursePagesController, CourseResourcesController, PagesController, PlayerController, ResourcesController,
} from './content.controller';
import { ContentService } from './content.service';

/**
 * ContentModule facade: học liệu trong khoá (mod_page + mod_resource),
 * trang học (player), tiến độ học và mốc lớp. Phụ thuộc Courses (course
 * module + cổng truy cập), Completion (trạng thái hoàn thành), Files
 * (tệp + URL đã ký) và Access (PermissionEvaluator) — không vòng phụ
 * thuộc vì không module nào trong số đó phụ thuộc Content.
 *
 * Từ issue #646, ContentRepository sống ở `@lms/db` (lớp thuần,
 * không phụ thuộc Nest) nên module lắp nó bằng factory provider
 * với handle Kysely định tuyến của kho trung tâm
 * (`SpaceDatabaseService.routedKysely`).
 */
@Module({
  imports: [AccessModule, CoursesModule, CompletionModule, FilesModule, EventsModule, SpaceRoutingModule],
  controllers: [CoursePagesController, PagesController, CourseResourcesController, ResourcesController, PlayerController],
  providers: [
    {
      provide: ContentRepository,
      useFactory: (spaceDb: SpaceDatabaseService) => new ContentRepository(spaceDb.routedKysely),
      inject: [SpaceDatabaseService],
    },
    ContentService,
  ],
  exports: [ContentService],
})
/** Module học liệu + player + tiến độ học (K2). */
export class ContentModule {}

import { Module } from '@nestjs/common';
import { CompetenciesRepository } from '@lms/db/repositories/competencies';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { CompletionModule } from '../completion/completion.module';
import { CoursesModule } from '../courses/courses.module';
import { GroupsModule } from '../groups/groups.module';
import { MessagingModule } from '../messaging/messaging.module';
import { UsersModule } from '../users/users.module';
import { CompetenciesController } from './competencies.controller';
import { CompetenciesService } from './competencies.service';

/**
 * Facade của CompetenciesModule: CompetenciesService. Các kết quả completion được
 * tiêu thụ qua các hook đã đăng ký vào CompletionService; các yêu cầu review đi
 * ra ngoài thông qua facade của MessagingService (không dùng repository xuyên module).
 *
 * Từ issue #646, CompetenciesRepository sống ở `@lms/db` (lớp
 * thuần, không phụ thuộc Nest) nên module lắp nó bằng factory
 * provider với handle Kysely định tuyến của kho trung tâm
 * (`SpaceDatabaseService.routedKysely`).
 */
@Module({
  imports: [AccessModule, CoursesModule, GroupsModule, CompletionModule, MessagingModule, UsersModule, EventsModule, SpaceRoutingModule],
  controllers: [CompetenciesController],
  providers: [
    {
      provide: CompetenciesRepository,
      useFactory: (spaceDb: SpaceDatabaseService) => new CompetenciesRepository(spaceDb.routedKysely),
      inject: [SpaceDatabaseService],
    },
    CompetenciesService,
  ],
  exports: [CompetenciesService],
})
/** Module năng lực và kế hoạch học tập. */
export class CompetenciesModule {}

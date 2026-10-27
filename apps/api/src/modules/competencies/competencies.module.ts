import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { CompletionModule } from '../completion/completion.module';
import { CoursesModule } from '../courses/courses.module';
import { GroupsModule } from '../groups/groups.module';
import { MessagingModule } from '../messaging/messaging.module';
import { UsersModule } from '../users/users.module';
import { CompetenciesController } from './competencies.controller';
import { CompetenciesRepository } from './competencies.repository';
import { CompetenciesService } from './competencies.service';

/**
 * Facade của CompetenciesModule: CompetenciesService. Các kết quả completion được
 * tiêu thụ qua các hook đã đăng ký vào CompletionService; các yêu cầu review đi
 * ra ngoài thông qua facade của MessagingService (không dùng repository xuyên module).
 */
@Module({
  imports: [AccessModule, CoursesModule, GroupsModule, CompletionModule, MessagingModule, UsersModule, EventsModule],
  controllers: [CompetenciesController],
  providers: [CompetenciesRepository, CompetenciesService],
  exports: [CompetenciesService],
})
/** Module năng lực và kế hoạch học tập. */
export class CompetenciesModule {}

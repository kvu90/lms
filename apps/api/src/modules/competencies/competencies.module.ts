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
 * CompetenciesModule facade: CompetenciesService. Completion outcomes are
 * consumed via hooks registered into CompletionService; review requests go
 * out through the MessagingService facade (no cross-module repositories).
 */
@Module({
  imports: [AccessModule, CoursesModule, GroupsModule, CompletionModule, MessagingModule, UsersModule, EventsModule],
  controllers: [CompetenciesController],
  providers: [CompetenciesRepository, CompetenciesService],
  exports: [CompetenciesService],
})
export class CompetenciesModule {}

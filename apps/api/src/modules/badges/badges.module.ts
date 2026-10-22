import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { CompetenciesModule } from '../competencies/competencies.module';
import { CompletionModule } from '../completion/completion.module';
import { CoursesModule } from '../courses/courses.module';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
import { GroupsModule } from '../groups/groups.module';
import { MessagingModule } from '../messaging/messaging.module';
import { UsersModule } from '../users/users.module';
import { BadgesController } from './badges.controller';
import { BadgesRepository } from './badges.repository';
import { BADGE_AWARD_QUEUE, BadgesService } from './badges.service';

/**
 * BadgesModule facade: BadgesService. Criteria evaluation consumes
 * Completion/Competencies/Groups (cohort leaf)/CustomFields (profile leaf)
 * ONLY through their facades and registered hooks/events; award
 * notifications go through MessagingService.
 */
@Module({
  imports: [
    AccessModule, CoursesModule, CompletionModule, CompetenciesModule, MessagingModule, UsersModule, GroupsModule, CustomFieldsModule, EventsModule,
    BullModule.registerQueue({ name: BADGE_AWARD_QUEUE }),
  ],
  controllers: [BadgesController],
  providers: [BadgesRepository, BadgesService],
  exports: [BadgesService],
})
/** Module huy hiệu. */
export class BadgesModule {}

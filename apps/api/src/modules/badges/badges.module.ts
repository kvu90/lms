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
 * Facade của BadgesModule: BadgesService. Việc đánh giá tiêu chí tiêu thụ
 * Completion/Competencies/Groups (lá cohort)/CustomFields (lá profile)
 * CHỈ thông qua facade của chúng và các hook/event đã đăng ký; thông báo
 * trao huy hiệu đi qua MessagingService.
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

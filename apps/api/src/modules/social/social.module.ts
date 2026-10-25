import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { EnrolModule } from '../enrol/enrol.module';
import { GradesModule } from '../grades/grades.module';
import { CommentsService } from './comments.service';
import { NotesService } from './notes.service';
import { RatingsService } from './ratings.service';
import { CommentsController, NotesController, RatingsController, TagsController } from './social.controller';
import { SocialRepository } from './social.repository';
import { TagsService } from './tags.service';

/**
 * SocialModule — the four polymorphic sub-systems of report §2#16
 * (Tags / Comments / Ratings / Notes) sharing one repository over
 * (component, itemType/area, itemId, contextId) tables with no hard FKs.
 * Each sub-service is exported as its own facade.
 */
@Module({
  imports: [AccessModule, CoursesModule, EnrolModule, GradesModule],
  controllers: [TagsController, CommentsController, RatingsController, NotesController],
  providers: [SocialRepository, TagsService, CommentsService, RatingsService, NotesService],
  exports: [TagsService, CommentsService, RatingsService, NotesService],
})
/** Module xã hội: tag, bình luận, đánh giá, ghi chú. */
export class SocialModule {}

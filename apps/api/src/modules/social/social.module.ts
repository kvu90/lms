import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { EnrolModule } from '../enrol/enrol.module';
import { GradesModule } from '../grades/grades.module';
import { BlogService } from './blog.service';
import { CommentsService } from './comments.service';
import { NotesService } from './notes.service';
import { RatingsService } from './ratings.service';
import { BlogController, CommentsController, NotesController, RatingsController, TagsController } from './social.controller';
import { SocialRepository } from './social.repository';
import { TagsService } from './tags.service';

/**
 * SocialModule — the five polymorphic sub-systems of report §2#16
 * (Tags / Comments / Ratings / Blog / Notes) sharing one repository over
 * (component, itemtype/area, itemid, contextid) tables with no hard FKs.
 * Each sub-service is exported as its own facade.
 */
@Module({
  imports: [AccessModule, CoursesModule, EnrolModule, GradesModule],
  controllers: [TagsController, CommentsController, RatingsController, BlogController, NotesController],
  providers: [SocialRepository, TagsService, CommentsService, RatingsService, BlogService, NotesService],
  exports: [TagsService, CommentsService, RatingsService, BlogService, NotesService],
})
export class SocialModule {}

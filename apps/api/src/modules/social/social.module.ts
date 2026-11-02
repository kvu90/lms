import { Module } from '@nestjs/common';
import { SocialRepository } from '@lms/db/repositories/social';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { EnrolModule } from '../enrol/enrol.module';
import { GradesModule } from '../grades/grades.module';
import { CommentsService } from './comments.service';
import { NotesService } from './notes.service';
import { RatingsService } from './ratings.service';
import { CommentsController, NotesController, RatingsController, TagsController } from './social.controller';
import { TagsService } from './tags.service';

/**
 * SocialModule — bốn hệ thống con đa hình của report §2#16
 * (Tags / Comments / Ratings / Notes) dùng chung một repository trên
 * các bảng (component, itemType/area, itemId, contextId) không có FK cứng.
 * Mỗi service con được export dưới dạng facade riêng của nó.
 *
 * Từ issue #647, repository dùng chung sống ở `@lms/db` trên
 * Kysely (lớp thuần, không phụ thuộc Nest) nên module lắp nó bằng
 * factory provider trên handle định tuyến theo không gian
 * (`SpaceDatabaseService.routedKysely`) — cùng khuôn lắp repository
 * của pilot control plane.
 */
@Module({
  imports: [AccessModule, CoursesModule, EnrolModule, GradesModule, SpaceRoutingModule],
  controllers: [TagsController, CommentsController, RatingsController, NotesController],
  providers: [
    {
      provide: SocialRepository,
      useFactory: (spaceDb: SpaceDatabaseService) => new SocialRepository(spaceDb.routedKysely),
      inject: [SpaceDatabaseService],
    },
    TagsService, CommentsService, RatingsService, NotesService,
  ],
  exports: [TagsService, CommentsService, RatingsService, NotesService],
})
/** Module xã hội: tag, bình luận, đánh giá, ghi chú. */
export class SocialModule {}

import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { CompletionModule } from '../completion/completion.module';
import { CoursesModule } from '../courses/courses.module';
import { FilesModule } from '../files/files.module';
import {
  CoursePagesController, CourseResourcesController, PagesController, PlayerController, ResourcesController,
} from './content.controller';
import { ContentRepository } from './content.repository';
import { ContentService } from './content.service';

/**
 * ContentModule facade: học liệu trong khoá (mod_page + mod_resource),
 * trang học (player), tiến độ học và mốc lớp. Phụ thuộc Courses (course
 * module + cổng truy cập), Completion (trạng thái hoàn thành), Files
 * (tệp + URL đã ký) và Access (PermissionEvaluator) — không vòng phụ
 * thuộc vì không module nào trong số đó phụ thuộc Content.
 */
@Module({
  imports: [AccessModule, CoursesModule, CompletionModule, FilesModule, EventsModule],
  controllers: [CoursePagesController, PagesController, CourseResourcesController, ResourcesController, PlayerController],
  providers: [ContentRepository, ContentService],
  exports: [ContentService],
})
/** Module học liệu + player + tiến độ học (K2). */
export class ContentModule {}

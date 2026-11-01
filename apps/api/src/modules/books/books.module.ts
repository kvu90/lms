import { Module } from '@nestjs/common';
import { BookRepository } from '@lms/db/repositories/books';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { CurriculumModule } from '../curriculum/curriculum.module';
import { BooksController } from './books.controller';
import { BookService } from './books.service';

/**
 * BooksModule: tầng sách độc lập (K0b tái cấu trúc) — sách + cây mục lục + ánh xạ sang chương trình + sổ nạp dataset. Phụ thuộc Access (PermissionEvaluator + ContextsService), Curriculum (sổ chương trình để phân giải ánh xạ), Courses (đăng ký book frame provider).
 *
 * Từ issue #647, repository của module sống ở `@lms/db` trên
 * Kysely (lớp thuần, không phụ thuộc Nest) nên module lắp nó bằng
 * factory provider trên handle định tuyến theo không gian
 * (`SpaceDatabaseService.routedKysely`) — cùng khuôn lắp repository
 * của pilot control plane.
 */
@Module({
  imports: [AccessModule, CoursesModule, CurriculumModule, SpaceRoutingModule],
  controllers: [BooksController],
  providers: [
    {
      provide: BookRepository,
      useFactory: (spaceDb: SpaceDatabaseService) => new BookRepository(spaceDb.routedKysely),
      inject: [SpaceDatabaseService],
    },
    BookService,
  ],
  exports: [BookService],
})
/** Module sách: thực thể sách độc lập, cây mục lục, ánh xạ chương trình, nạp dataset sách đã kiểm chứng. */
export class BooksModule {}

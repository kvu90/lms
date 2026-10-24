import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { CurriculumModule } from '../curriculum/curriculum.module';
import { BooksController } from './books.controller';
import { BooksRepository } from './books.repository';
import { BooksService } from './books.service';

/** BooksModule: tầng sách độc lập (K0b tái cấu trúc) — sách + cây mục lục + ánh xạ sang chương trình + sổ nạp dataset. Phụ thuộc Access (PermissionEvaluator + ContextsService), Curriculum (sổ chương trình để phân giải ánh xạ), Courses (đăng ký book frame provider). */
@Module({
  imports: [AccessModule, CoursesModule, CurriculumModule],
  controllers: [BooksController],
  providers: [BooksRepository, BooksService],
  exports: [BooksService],
})
/** Module sách: thực thể sách độc lập, cây mục lục, ánh xạ chương trình, nạp dataset sách đã kiểm chứng. */
export class BooksModule {}

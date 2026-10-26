import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { CurriculumController } from './curriculum.controller';
import { CurriculumRepository } from './curriculum.repository';
import { CurriculumService } from './curriculum.service';
import { ProgramDumpService } from './program-dump.service';
import { ProgramImportService } from './program-import.service';

/** CurriculumModule: chương trình GDPT 2018 (port từ giaokhoa). Phụ thuộc Access cho PermissionEvaluator + ContextsService; Courses để đăng ký frame provider (K0a). Tầng sách đã tách hẳn sang BooksModule (K0b tái cấu trúc). */
@Module({
  imports: [AccessModule, CoursesModule],
  controllers: [CurriculumController],
  providers: [CurriculumRepository, CurriculumService, ProgramImportService, ProgramDumpService],
  exports: [CurriculumService, CurriculumRepository, ProgramImportService, ProgramDumpService],
})
/** Module chương trình học: subjects, curricula, cây nodes, learning outcomes. */
export class CurriculumModule {}

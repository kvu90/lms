import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { CurriculumController } from './curriculum.controller';
import { CurriculumRepository } from './curriculum.repository';
import { CurriculumService } from './curriculum.service';
import { ProgramImportService } from './program-import.service';
import { TextbookRepository } from './textbook.repository';
import { TextbookService } from './textbook.service';

/** CurriculumModule: chương trình GDPT 2018 (port từ giaokhoa) + tầng SGK (K0b). Phụ thuộc Access cho PermissionEvaluator + ContextsService; Courses để đăng ký frame provider (K0a + K0b). */
@Module({
  imports: [AccessModule, CoursesModule],
  controllers: [CurriculumController],
  providers: [CurriculumRepository, CurriculumService, ProgramImportService, TextbookRepository, TextbookService],
  exports: [CurriculumService],
})
/** Module chương trình học: subjects, curricula, cây nodes, learning outcomes. */
export class CurriculumModule {}

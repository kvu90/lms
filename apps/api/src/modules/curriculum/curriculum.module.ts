import { Module } from '@nestjs/common';
import { CurriculumRepository } from '@lms/db/repositories/curriculum';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { CurriculumController } from './curriculum.controller';
import { CurriculumService } from './curriculum.service';
import { ProgramDumpService } from './program-dump.service';
import { ProgramImportService } from './program-import.service';

/**
 * CurriculumModule: chương trình GDPT 2018 (port từ giaokhoa). Phụ
 * thuộc Access cho PermissionEvaluator + ContextsService; Courses để
 * đăng ký frame provider (K0a). Tầng sách đã tách hẳn sang
 * BooksModule (K0b tái cấu trúc).
 *
 * Từ issue #646, CurriculumRepository sống ở `@lms/db` (lớp thuần,
 * không phụ thuộc Nest) nên module lắp nó bằng factory provider:
 * handle là handle Kysely định tuyến của kho trung tâm
 * (`SpaceDatabaseService.routedKysely`, dựng trên cùng
 * TenantAwarePool với phía Drizzle để GUC/RLS theo ngữ cảnh tenant
 * hoạt động như cũ).
 */
@Module({
  imports: [AccessModule, CoursesModule, SpaceRoutingModule],
  controllers: [CurriculumController],
  providers: [
    {
      provide: CurriculumRepository,
      useFactory: (spaceDb: SpaceDatabaseService) => new CurriculumRepository(spaceDb.routedKysely),
      inject: [SpaceDatabaseService],
    },
    CurriculumService, ProgramImportService, ProgramDumpService,
  ],
  exports: [CurriculumService, CurriculumRepository, ProgramImportService, ProgramDumpService],
})
/** Module chương trình học: subjects, curricula, cây nodes, learning outcomes. */
export class CurriculumModule {}

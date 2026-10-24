import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { CurriculumController } from './curriculum.controller';
import { CurriculumRepository } from './curriculum.repository';
import { CurriculumService } from './curriculum.service';

/** CurriculumModule: chương trình GDPT 2018 (port từ giaokhoa). Phụ thuộc Access cho PermissionEvaluator + ContextsService. */
@Module({
  imports: [AccessModule],
  controllers: [CurriculumController],
  providers: [CurriculumRepository, CurriculumService],
  exports: [CurriculumService],
})
/** Module chương trình học: subjects, curricula, cây nodes, learning outcomes. */
export class CurriculumModule {}

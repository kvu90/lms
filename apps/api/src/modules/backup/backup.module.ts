import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { FilesModule } from '../files/files.module';
import { BackupController } from './backup.controller';
import { BackupRepository } from './backup.repository';
import { BackupService } from './backup.service';

/** BackupModule facade: BackupService (contributor registry đảo ngược). */
@Module({
  imports: [AccessModule, CoursesModule, FilesModule],
  controllers: [BackupController],
  providers: [BackupRepository, BackupService],
  exports: [BackupService],
})
export class BackupModule {}

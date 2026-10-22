import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { BackupService } from './backup.service';
import { CreateBackupDto, RestoreDto } from './dto/backup.dto';

/** Controller Backup/Restore: jobs, steps, mappings, checklist. */
@ApiTags('backup')
@Controller({ path: 'backup', version: '1' })
export class BackupController {
  constructor(private readonly backup: BackupService) {}
  @Get('contributors')
  async contributors() { return this.backup.listContributors(); }
  @Post('jobs')
  async createBackup(@Body() dto: CreateBackupDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.backup.createBackup(actor.id, dto.courseId, dto.anonymize ?? false);
  }
  @Post('restore')
  async restore(@Body() dto: RestoreDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.backup.restore(actor.id, dto.backupJobId, dto.mode, dto.targetCourseId);
  }
  @Get('jobs')
  async jobs() { return this.backup.listJobs(); }
  @Get('jobs/:id')
  async job(@Param('id', ParseIntPipe) id: number) { return this.backup.getJob(id); }
  @Get('jobs/:id/steps')
  async steps(@Param('id', ParseIntPipe) id: number) { return this.backup.listSteps(id); }
  @Get('jobs/:id/mappings')
  async mappings(@Param('id', ParseIntPipe) id: number) { return this.backup.listMappings(id); }
  @Get('jobs/:id/checklist')
  async checklist(@Param('id', ParseIntPipe) id: number) { return this.backup.restoreChecklist(id); }
}

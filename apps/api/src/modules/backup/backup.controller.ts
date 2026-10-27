import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { BackupService } from './backup.service';
import { createBackupSchema, restoreCourseSchema, type CreateBackupDto, type RestoreDto } from './dto/backup.dto';

/** Controller Backup/Restore: các job, các bước, các ánh xạ, checklist. */
@ApiTags('backup')
@Controller({ path: 'backup', version: '1' })
export class BackupController {
  constructor(private readonly backup: BackupService) {}
  @Get('contributors')
  async contributors() { return this.backup.listContributors(); }
  @Post('jobs')
  async createBackup(@Body({ schema: createBackupSchema }) dto: CreateBackupDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.backup.createBackup(actor.id, dto.courseId ?? null, dto.anonymize ?? false, dto.scope ?? (dto.courseId ? 'course' : 'site'));
  }
  @Post('restore')
  async restore(@Body({ schema: restoreCourseSchema }) dto: RestoreDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.backup.restore(actor.id, dto.backupJobId, dto.mode, dto.targetCourseId);
  }
  @Get('jobs')
  async jobs(@CurrentUser() actor: AuthenticatedUser) { return this.backup.listJobs(actor.id); }
  @Get('jobs/:id')
  async job(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) { return this.backup.getJobForRead(actor.id, id); }
  @Get('jobs/:id/steps')
  async steps(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) { return this.backup.listSteps(actor.id, id); }
  @Get('jobs/:id/mappings')
  async mappings(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) { return this.backup.listMappings(actor.id, id); }
  @Get('jobs/:id/checklist')
  async checklist(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) { return this.backup.restoreChecklist(actor.id, id); }
}

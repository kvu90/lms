import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { FilesModule } from '../files/files.module';
import { UsersModule } from '../users/users.module';
import { PrivacyController } from './privacy.controller';
import { PrivacyRepository } from './privacy.repository';
import { PrivacyService } from './privacy.service';

/** PrivacyModule facade: PrivacyService (provider registry đảo ngược). */
@Module({
  imports: [AccessModule, FilesModule, UsersModule],
  controllers: [PrivacyController],
  providers: [PrivacyRepository, PrivacyService],
  exports: [PrivacyService],
})
export class PrivacyModule {}

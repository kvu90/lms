import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessModule } from '../access/access.module';
import { FileSigningService } from './file-signing.service';
import { FilesController } from './files.controller';
import { FilesListener } from './files.listener';
import { FilesRepository } from './files.repository';
import { FILE_CLEANUP_QUEUE, FilesService } from './files.service';
import { OBJECT_STORAGE } from './storage';
import { createObjectStorage } from './storage-factory';

@Module({
  imports: [AccessModule, BullModule.registerQueue({ name: FILE_CLEANUP_QUEUE })],
  controllers: [FilesController],
  providers: [
    FilesRepository, FilesService, FileSigningService, FilesListener,
    // Driver vật lý được chọn theo env (FILE_STORAGE_DRIVER=local|s3, mặc định local).
    { provide: OBJECT_STORAGE, useFactory: (config: ConfigService) => createObjectStorage(config), inject: [ConfigService] },
  ],
  exports: [FilesService],
})
/** Module quản lý file. */
export class FilesModule {}

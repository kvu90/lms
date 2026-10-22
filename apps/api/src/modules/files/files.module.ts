import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { FileSigningService } from './file-signing.service';
import { FilesController } from './files.controller';
import { FilesListener } from './files.listener';
import { FilesRepository } from './files.repository';
import { FILE_CLEANUP_QUEUE, FilesService } from './files.service';
import { LocalObjectStorage, OBJECT_STORAGE } from './storage';

@Module({
  imports: [AccessModule, BullModule.registerQueue({ name: FILE_CLEANUP_QUEUE })],
  controllers: [FilesController],
  providers: [
    FilesRepository, FilesService, FileSigningService, FilesListener,
    { provide: OBJECT_STORAGE, useClass: LocalObjectStorage },
  ],
  exports: [FilesService],
})
/** Module quản lý file. */
export class FilesModule {}

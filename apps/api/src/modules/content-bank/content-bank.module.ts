import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { FilesModule } from '../files/files.module';
import { SearchModule } from '../search/search.module';
import { ContentBankController } from './content-bank.controller';
import { ContentBankRepository } from './content-bank.repository';
import { ContentBankService } from './content-bank.service';

/** ContentBankModule facade: ContentBankService. CoursesModule phục vụ điểm cắm "Thêm từ kho" (tạo course module + sao file vào context của module). */
@Module({
  imports: [AccessModule, FilesModule, SearchModule, CoursesModule],
  controllers: [ContentBankController],
  providers: [ContentBankRepository, ContentBankService],
  exports: [ContentBankService],
})
export class ContentBankModule {}

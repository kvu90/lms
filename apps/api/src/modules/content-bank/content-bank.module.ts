import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { FilesModule } from '../files/files.module';
import { SearchModule } from '../search/search.module';
import { ContentBankController } from './content-bank.controller';
import { ContentBankRepository } from './content-bank.repository';
import { ContentBankService } from './content-bank.service';

/** ContentBankModule facade: ContentBankService. */
@Module({
  imports: [AccessModule, FilesModule, SearchModule],
  controllers: [ContentBankController],
  providers: [ContentBankRepository, ContentBankService],
  exports: [ContentBankService],
})
export class ContentBankModule {}

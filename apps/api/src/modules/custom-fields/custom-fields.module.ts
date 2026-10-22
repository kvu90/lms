import { Module } from '@nestjs/common';
import { CustomFieldsController } from './custom-fields.controller';
import { CustomFieldsRepository } from './custom-fields.repository';
import { CustomFieldsService } from './custom-fields.service';

@Module({
  controllers: [CustomFieldsController],
  providers: [CustomFieldsRepository, CustomFieldsService],
  exports: [CustomFieldsService],
})
/** Module trường tuỳ biến. */
export class CustomFieldsModule {}

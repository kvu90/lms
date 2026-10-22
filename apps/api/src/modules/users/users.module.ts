import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
import { PasswordService } from './password.service';
import { UsersController } from './users.controller';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

/** UsersModule facade: UsersService + PasswordService. Imports Access (evaluator/contexts) and EventsModule (global outbox) per the dependency graph. */
@Module({
  imports: [AccessModule, CustomFieldsModule, EventsModule],
  controllers: [UsersController],
  providers: [UsersRepository, UsersService, PasswordService],
  exports: [UsersService, PasswordService],
})
export class UsersModule {}

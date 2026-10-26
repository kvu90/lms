import { forwardRef, Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { BetterAuthModule } from '../auth/better-auth/better-auth.module';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
import { PasswordService } from './password.service';
import { UsersController } from './users.controller';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

/** UsersModule facade: UsersService + PasswordService. Imports Access (evaluator/contexts) and EventsModule (global outbox) per the dependency graph. */
/**
 * Vòng phụ thuộc tường minh với BetterAuthModule (GĐ2 chặng 2.6):
 * BetterAuthModule cần PasswordService của module này, UsersService
 * cần CredentialBridgeService của BetterAuthModule để đồng bộ dòng
 * credential sau mỗi lần ghi mật khẩu — forwardRef ở CẢ hai phía là
 * cách NestJS chốt cho vòng module kiểu này; chuỗi provider kết thúc
 * ở PasswordService (không phụ thuộc ngược) nên khởi tạo xác định.
 */
@Module({
  imports: [AccessModule, CustomFieldsModule, EventsModule, forwardRef(() => BetterAuthModule)],
  controllers: [UsersController],
  providers: [UsersRepository, UsersService, PasswordService],
  exports: [UsersService, PasswordService],
})
/** Module người dùng và mật khẩu. */
export class UsersModule {}

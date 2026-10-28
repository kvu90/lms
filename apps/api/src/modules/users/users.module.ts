import { forwardRef, Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { AuthModule } from '../auth/auth.module';
import { BetterAuthModule } from '../auth/better-auth/better-auth.module';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
import { PasswordService } from './password.service';
import { UsersController } from './users.controller';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

/** Facade của UsersModule: UsersService + PasswordService. Import Access (evaluator/contexts) và EventsModule (outbox toàn cục) theo đồ thị phụ thuộc. */
/**
 * Vòng phụ thuộc tường minh với BetterAuthModule (GĐ2 chặng 2.6):
 * BetterAuthModule cần PasswordService của module này, UsersService
 * cần CredentialBridgeService của BetterAuthModule để đồng bộ dòng
 * credential sau mỗi lần ghi mật khẩu — forwardRef ở CẢ hai phía là
 * cách NestJS chốt cho vòng module kiểu này; chuỗi provider kết thúc
 * ở PasswordService (không phụ thuộc ngược) nên khởi tạo xác định.
 * Vòng thứ hai với AuthModule: AuthModule cần UsersService,
 * UsersService cần AuthRepository của AuthModule để thu hồi family
 * refresh mỗi lần đặt mật khẩu qua đường sửa hồ sơ — cũng forwardRef
 * ở cả hai phía; chuỗi provider kết thúc ở AuthRepository (chỉ phụ
 * thuộc tầng dữ liệu).
 */
@Module({
  imports: [AccessModule, CustomFieldsModule, EventsModule, forwardRef(() => BetterAuthModule), forwardRef(() => AuthModule)],
  controllers: [UsersController],
  providers: [UsersRepository, UsersService, PasswordService],
  exports: [UsersService, PasswordService],
})
/** Module người dùng và mật khẩu. */
export class UsersModule {}

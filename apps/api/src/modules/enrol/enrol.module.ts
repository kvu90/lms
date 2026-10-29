import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { GroupsModule } from '../groups/groups.module';
import { MessagingModule } from '../messaging/messaging.module';
import { TenantsModule } from '../tenants/tenants.module';
import { CourseEnrolmentsController, EnrolController } from './enrol.controller';
import { EnrolRepository } from './enrol.repository';
import { EnrolService } from './enrol.service';

/**
 * Facade của EnrolModule: EnrolService. Phụ thuộc Courses, Groups, Access
 * (report §3.12). Completion đăng ký đầu dò dữ liệu liên quan của nó vào
 * EnrolService; Enrol đăng ký bộ kiểm tra isEnrolled của nó vào CoursesService —
 * cả hai đều qua đăng ký, không qua import vòng. MessagingModule được import
 * trực tiếp cho tin nhắn chào mừng: Messaging chỉ phụ thuộc Access/Users/
 * Events, nên không có chu trình module (cùng mẫu với Badges/Reports).
 */
@Module({
  imports: [AccessModule, CoursesModule, GroupsModule, EventsModule, MessagingModule, TenantsModule],
  controllers: [EnrolController, CourseEnrolmentsController],
  providers: [EnrolRepository, EnrolService],
  exports: [EnrolService],
})
/** Module ghi danh. */
export class EnrolModule {}

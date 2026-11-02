import { Module } from '@nestjs/common';
import { EnrolRepository } from '@lms/db/repositories/enrol';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { GroupsModule } from '../groups/groups.module';
import { MessagingModule } from '../messaging/messaging.module';
import { TenantsModule } from '../tenants/tenants.module';
import { CourseEnrolmentsController, EnrolController } from './enrol.controller';
import { EnrolService } from './enrol.service';
import { EnrolTransitionalRepository } from './enrol-transitional.repository';

/**
 * Facade của EnrolModule: EnrolService. Phụ thuộc Courses, Groups, Access
 * (report §3.12). Completion đăng ký đầu dò dữ liệu liên quan của nó vào
 * EnrolService; Enrol đăng ký bộ kiểm tra isEnrolled của nó vào CoursesService —
 * cả hai đều qua đăng ký, không qua import vòng. MessagingModule được import
 * trực tiếp cho tin nhắn chào mừng: Messaging chỉ phụ thuộc Access/Users/
 * Events, nên không có chu trình module (cùng mẫu với Badges/Reports).
 */
@Module({
  imports: [AccessModule, CoursesModule, GroupsModule, EventsModule, MessagingModule, TenantsModule, SpaceRoutingModule],
  controllers: [EnrolController, CourseEnrolmentsController],
  providers: [
    {
      // EnrolRepository nay là repository Kysely của `@lms/db`
      // (issue #645): provider dựng bằng factory với handle kho
      // trung tâm ĐÃ ĐỊNH TUYẾN THEO KHÔNG GIAN (`routedKysely`
      // của SpaceDatabaseService), cùng khuôn với các repository
      // đã chuyển trước đó.
      provide: EnrolRepository,
      useFactory: (spaceDb: SpaceDatabaseService) => new EnrolRepository(spaceDb.routedKysely),
      inject: [SpaceDatabaseService],
    },
    // Repository chuyển tiếp Drizzle của điểm nối C-8/C (điểm vào
    // `setSuspended` giữ chữ ký transaction của payments) — chủ
    // đóng D4 #656, xem file của nó.
    EnrolTransitionalRepository,
    EnrolService,
  ],
  exports: [EnrolService],
})
/** Module ghi danh. */
export class EnrolModule {}

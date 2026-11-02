import { Module } from '@nestjs/common';
import { ClassesRepository } from '@lms/db/repositories/classes';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { ControlPlaneModule } from '../control-plane/control-plane.module';
import { CoursesModule } from '../courses/courses.module';
import { EnrolModule } from '../enrol/enrol.module';
import { GroupsModule } from '../groups/groups.module';
import { TenantsModule } from '../tenants/tenants.module';
import { UsersModule } from '../users/users.module';
import { ClassesController } from './classes.controller';
import { ClassesService } from './classes.service';
import { ClassesTransitionalRepository } from './classes-transitional.repository';

/**
 * ClassesModule — LỚP HỌC HẠNG NHẤT (issue #184, CLASS-0): vòng đời lớp,
 * backing cohort (roster), context CLASS=45 + bộ quyền tại lớp, và móc
 * vật chất hoá ghi danh cấp lớp vào đường tạo khoá (đăng ký
 * CourseClassHook vào CoursesService — Courses không import Classes).
 * EnrolModule/GroupsModule cung cấp đúng máy móc cohort sync sẵn có.
 */
@Module({
  imports: [AccessModule, CoursesModule, GroupsModule, EnrolModule, TenantsModule, UsersModule, EventsModule, SpaceRoutingModule, ControlPlaneModule],
  controllers: [ClassesController],
  providers: [
    {
      // ClassesRepository nay là repository Kysely của `@lms/db`
      // (issue #645): provider dựng bằng factory với handle kho
      // trung tâm ĐÃ ĐỊNH TUYẾN THEO KHÔNG GIAN (`routedKysely`
      // của SpaceDatabaseService), cùng khuôn với các repository
      // đã chuyển trước đó.
      provide: ClassesRepository,
      useFactory: (spaceDb: SpaceDatabaseService) => new ClassesRepository(spaceDb.routedKysely),
      inject: [SpaceDatabaseService],
    },
    // Repository chuyển tiếp Drizzle của giao dịch tạo lớp (điểm
    // dừng của điểm nối C-8/B) — chủ đóng đợt access #651, xem
    // file của nó.
    ClassesTransitionalRepository,
    ClassesService,
  ],
  exports: [ClassesService, ClassesRepository],
})
export class ClassesModule {}

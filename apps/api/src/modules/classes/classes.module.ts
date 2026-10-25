import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { EnrolModule } from '../enrol/enrol.module';
import { GroupsModule } from '../groups/groups.module';
import { TenantsModule } from '../tenants/tenants.module';
import { UsersModule } from '../users/users.module';
import { ClassesController } from './classes.controller';
import { ClassesRepository } from './classes.repository';
import { ClassesService } from './classes.service';

/**
 * ClassesModule — LỚP HỌC HẠNG NHẤT (issue #184, CLASS-0): vòng đời lớp,
 * backing cohort (roster), context CLASS=45 + bộ quyền tại lớp, và móc
 * vật chất hoá ghi danh cấp lớp vào đường tạo khoá (đăng ký
 * CourseClassHook vào CoursesService — Courses không import Classes).
 * EnrolModule/GroupsModule cung cấp đúng máy móc cohort sync sẵn có.
 */
@Module({
  imports: [AccessModule, CoursesModule, GroupsModule, EnrolModule, TenantsModule, UsersModule, EventsModule],
  controllers: [ClassesController],
  providers: [ClassesRepository, ClassesService],
  exports: [ClassesService, ClassesRepository],
})
export class ClassesModule {}

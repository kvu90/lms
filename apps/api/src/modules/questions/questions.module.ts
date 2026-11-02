import { forwardRef, Module } from '@nestjs/common';
import { QuestionBanksRepository } from '@lms/db/repositories/question-banks';
import { QuestionsRepository } from '@lms/db/repositories/questions';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { FilesModule } from '../files/files.module';
import { GroupsModule } from '../groups/groups.module';
import { QuizModule } from '../quiz/quiz.module';
import { TenantsModule } from '../tenants/tenants.module';
import { QuestionBanksController } from './question-banks.controller';
import { QuestionBanksService } from './question-banks.service';
import { QuestionBanksTransitionalRepository } from './question-banks-transitional.repository';
import { QuestionsController, QuestionUsagesController, StimuliController } from './questions.controller';
import { QuestionsService } from './questions.service';

/**
 * QuestionsModule facade: QuestionsService (bank + engine) +
 * QuestionBanksService (lớp bank có danh tính của feat Ngân hàng câu
 * hỏi chung, cần Groups cho cohort của bank tổ). Depends on Access +
 * Groups.
 *
 * Vòng module Questions ↔ Quiz là tường minh từ issue #343 (dọn
 * controller trùng path): `QuestionBanksController` của module này —
 * chủ duy nhất của tiền tố `question-banks` — uỷ thác bề mặt ma trận
 * của bank cho MatrixBanksService của QuizModule, trong khi
 * QuizModule dùng facade của Questions; hai phía đều khai
 * `forwardRef` theo khuôn vòng module đã có của repo (Users ↔ Auth ↔
 * BetterAuth).
 *
 * QuestionsRepository nay là repository Kysely của `@lms/db` (issue
 * #642): provider dựng bằng factory với handle kho trung tâm ĐÃ
 * ĐỊNH TUYẾN THEO KHÔNG GIAN (`routedKysely` của
 * SpaceDatabaseService — cùng pool dùng chung có gắn ngữ cảnh
 * tenant mà tầng Drizzle đang chạy trên đó), không phải handle
 * tĩnh theo một database cố định.
 *
 * QuestionBanksRepository cũng là repository Kysely của `@lms/db`
 * (issue #644), dựng bằng cùng khuôn factory. Riêng giao dịch
 * `buildBank` còn giữ phía Drizzle (điểm chuyển tiếp C-7) nên
 * module đăng ký thêm `QuestionBanksTransitionalRepository` phía
 * Drizzle cho đúng hai lệnh ghi của luồng đó; chủ đóng C-7 là PR
 * merge cuối trong ba issue #644/#651/#653.
 */
@Module({
  imports: [AccessModule, EventsModule, GroupsModule, TenantsModule, FilesModule, SpaceRoutingModule, forwardRef(() => QuizModule)],
  controllers: [QuestionsController, QuestionUsagesController, StimuliController, QuestionBanksController],
  providers: [
    {
      provide: QuestionsRepository,
      useFactory: (spaceDb: SpaceDatabaseService) => new QuestionsRepository(spaceDb.routedKysely),
      inject: [SpaceDatabaseService],
    },
    {
      provide: QuestionBanksRepository,
      useFactory: (spaceDb: SpaceDatabaseService) => new QuestionBanksRepository(spaceDb.routedKysely),
      inject: [SpaceDatabaseService],
    },
    QuestionsService, QuestionBanksTransitionalRepository, QuestionBanksService,
  ],
  exports: [QuestionsService, QuestionBanksService],
})
/** Module ngân hàng câu hỏi và question engine. */
export class QuestionsModule {}

/**
 * Bề mặt HTTP phía trung tâm của kho ngân hàng hệ thống (issue #585),
 * chung tiền tố `system-bank` với controller quản trị:
 * - `GET /system-bank/discovery` — khám phá câu đang phát hành (lọc
 *   theo dạng/YCCĐ/mức độ; kết quả kèm danh sách phiên bản để chọn
 *   đúng phiên bản nhập). Yêu cầu ngữ cảnh trung tâm, không sinh
 *   capability mới.
 * - `POST /system-bank/import` — nhập bản chụp một phiên bản vào kho
 *   trung tâm (đích mặc định bank cá nhân của người nhập; cổng
 *   `question:add` tại category đích).
 * - `GET /system-bank/events/pending` — liệt kê sự kiện kho ngân
 *   hàng (hiện tại: rút câu) về các câu chính trung tâm đã nhập mà
 *   trung tâm chưa ghi nhận; trung tâm lấy định danh sự kiện từ
 *   chính danh sách này. Qua cổng `question:useall` tại context hệ
 *   thống ở service: danh sách là thông báo vận hành của trung
 *   tâm, không mở cho mọi thành viên của trung tâm.
 * - `POST /system-bank/events/:id/acknowledge` — ghi nhận trung tâm
 *   đã nhận một sự kiện kho ngân hàng (hiện tại: rút câu). Cùng
 *   cổng `question:useall` như đường liệt kê, kiểm ở service
 *   TRƯỚC khi ghi: trượt cổng thì không có vết ghi nhận nào.
 *
 * Controller chỉ là lớp vận chuyển mỏng; gác quyền và luật nghiệp vụ
 * nằm ở service. Đường thi (mở đề, chạy bài, chấm) không gọi các
 * route này — đề/bài chỉ đọc bản chụp trong kho trung tâm.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { SystemBankService } from './system-bank.service';
import {
  discoverSystemBankQuestionsSchema,
  importSystemBankQuestionSchema,
  type DiscoverSystemBankQuestionsDto,
  type ImportSystemBankQuestionDto,
} from './dto/system-bank.dto';

@Controller({ path: 'system-bank', version: '1' })
export class SystemBankDiscoveryController {
  constructor(private readonly bank: SystemBankService) {}

  @Get('discovery')
  async discover(@Query({ schema: discoverSystemBankQuestionsSchema }) query: DiscoverSystemBankQuestionsDto) {
    return this.bank.discover(query);
  }

  @Post('import')
  async importQuestion(
    @Body({ schema: importSystemBankQuestionSchema }) dto: ImportSystemBankQuestionDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.bank.importSystemQuestion(actor.id, dto);
  }

  @Get('events/pending')
  async listPendingEvents(@CurrentUser() actor: AuthenticatedUser) {
    return this.bank.listPendingEvents(actor.id);
  }

  @Post('events/:id/acknowledge')
  async acknowledgeEvent(
    @Param('id', { schema: uuidIdSchema }) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.bank.acknowledgeEvent(actor.id, id);
  }
}

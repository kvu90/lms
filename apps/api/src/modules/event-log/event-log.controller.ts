import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { listEventLogsQueryServerSchema, type ListEventLogsQueryDto } from './dto/event-log.dto';
import { EventLogService } from './event-log.service';

/** Controller Event Log (logstore): đường đọc nhật ký sự kiện cho báo cáo "ai đã làm gì". */
@ApiTags('event-logs')
@Controller({ path: 'event-logs', version: '1' })
export class EventLogController {
  constructor(private readonly eventLog: EventLogService) {}

  @Get()
  /**
   * GET /event-logs — truy vấn nhật ký sự kiện: lọc theo người thực hiện
   * (userId), người bị tác động (relatedUserId), khoá (courseId), context,
   * component, loại sự kiện (eventType) và khoảng thời gian (from/to);
   * phân trang page/pageSize. Quyền `log:view` được kiểm trong
   * service tại context phù hợp với phạm vi truy vấn.
   */
  async list(@Query({ schema: listEventLogsQueryServerSchema }) query: ListEventLogsQueryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.eventLog.listLogs(actor.id, query);
  }
}

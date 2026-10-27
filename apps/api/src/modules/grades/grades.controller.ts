import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { GradesService } from './grades.service';
import { createGradeItemSchema, exportGradesSchema, type CreateGradeItemDto, type ExportGradesDto } from './dto/grades.dto';

@ApiTags('grades')
@Controller({ path: 'courses/:courseId/grade-items', version: '1' })
/**
 * API điểm theo bài (issue #224): grade item = một bài/hoạt động, nhập
 * điểm của bài, công bố điểm cấp bài, lưới xem học sinh × các bài và
 * xuất vnEdu từ điểm đã công bố. KHÔNG còn sổ điểm tổng hợp của khoá
 * và KHÔNG còn Sổ điểm VN.
 *
 * Lớp này giữ các handler tạo/liệt kê grade item của khoá học ở path
 * canonical theo chuẩn đường dẫn module điểm (issue #342). Lớp khai
 * tiền tố con đầy đủ của chính nó thay vì tiền tố trơ `courses`: tiền
 * tố trơ `courses` chỉ còn module courses sở hữu, mỗi tiền tố đầy đủ
 * khác chỉ có đúng một lớp khai báo. Bảng route giữ nguyên từng ký tự
 * so với trước khi đổi hình thức khai báo. Các handler gắn với một
 * grade item / một bản ghi điểm nằm ở `grade-items.controller.ts`; các
 * path cũ vẫn tới được qua các controller alias trong
 * `legacy-grades.controller.ts`.
 */
export class CourseGradeItemsController {
  constructor(private readonly grades: GradesService) {}

  @Post()
  /**
   * POST /courses/:courseId/grade-items — tạo grade item.
   */
  async createItem(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: createGradeItemSchema }) dto: CreateGradeItemDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.createItem(actor.id, courseId, dto);
  }
  @Get()
  /**
   * GET /courses/:courseId/grade-items — liệt kê item (các bài có điểm) của khoá.
   */
  async listItems(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.listItems(actor.id, courseId);
  }
}

@ApiTags('grades')
@Controller({ path: 'courses/:courseId/gradebook', version: '1' })
/**
 * API lưới điểm theo bài của khoá học ở path canonical theo chuẩn đường
 * dẫn module điểm (issue #342): điểm THEO TỪNG BÀI của một học sinh
 * trong khoá và lưới CHỈ-ĐỌC học sinh × các bài cho giáo viên. Lớp khai
 * tiền tố con đầy đủ của chính nó thay vì tiền tố trơ `courses`, bảng
 * route giữ nguyên từng ký tự so với trước khi đổi hình thức khai báo.
 * Không điểm tổng, không trọng số (issue #224).
 */
export class CourseGradebookController {
  constructor(private readonly grades: GradesService) {}

  @Get()
  /**
   * GET /courses/:courseId/gradebook — điểm THEO TỪNG BÀI của một học
   * sinh trong khoá (mặc định là chính mình): danh sách bài + điểm +
   * trạng thái công bố. Thay cho sổ điểm tổng hợp cũ và cho ĐX-2 xem
   * ĐTB khoá (issue #224): không còn điểm tổng/trung bình của khoá.
   */
  async gradebook(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Query('userId') userId: string | undefined, @CurrentUser() viewer: AuthenticatedUser) {
    const target = userId || viewer.id;
    return this.grades.listUserActivityGrades(viewer.id, courseId, target);
  }
  @Get('report')
  /**
   * GET /courses/:courseId/gradebook/report — lưới CHỈ-ĐỌC học sinh × các
   * bài của khoá cho giáo viên: một hàng mỗi học sinh đã ghi danh, mỗi
   * ô là điểm của đúng bài đó. Không điểm tổng, không trọng số (issue #224).
   */
  async report(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() viewer: AuthenticatedUser) {
    return this.grades.getCourseActivityGrid(viewer.id, courseId);
  }
}

@ApiTags('grades')
@Controller({ path: 'courses/:courseId/grade-exports', version: '1' })
/**
 * API xuất điểm của khoá học ở path canonical theo chuẩn đường dẫn
 * module điểm (issue #342). Lớp khai tiền tố con đầy đủ của chính nó
 * thay vì tiền tố trơ `courses`, bảng route giữ nguyên từng ký tự so
 * với trước khi đổi hình thức khai báo.
 */
export class CourseGradeExportsController {
  constructor(private readonly grades: GradesService) {}

  @Post()
  @HttpCode(200)
  /**
   * POST /courses/:courseId/grade-exports — xuất điểm ra file theo nhà
   * cung cấp đích khai trong thân yêu cầu (trường `provider`); hiện
   * chỉ có `provider: 'vnedu'`: xuất điểm ra Excel theo cấu trúc vnEdu
   * (issue #53), body còn lại mang ánh xạ bài → loại cột (thường
   * xuyên/giữa kỳ/cuối kỳ) do giáo viên xác nhận; trả file .xlsx đính
   * kèm. Định dạng và nội dung file xuất giữ nguyên như đường xuất
   * vnEdu trước đây, chỉ đổi nơi khai nhà cung cấp: từ path sang thân
   * yêu cầu (issue #342).
   * Nguồn (issue #224): chỉ các bài ĐÃ CÔNG BỐ mới được xuất; bài chưa công bố bị từ chối.
   */
  async exportGrades(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: exportGradesSchema }) dto: ExportGradesDto, @CurrentUser() actor: AuthenticatedUser, @Res() res: Response) {
    // Tách trường `provider` ra khỏi payload: phần còn lại giữ đúng khuôn vnEdu và truyền nguyên vào service xuất vnEdu.
    const { provider: _provider, ...rest } = dto;
    const { filename, buffer } = await this.grades.exportGradesVnedu(actor.id, courseId, rest);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }
}

import { Body, Controller, Delete, Get, Param, Patch, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { AssignmentsService } from './assignments.service';
import {
  createAssignmentSchema, gradeAssignmentSubmissionSchema, updateAssignmentSchema,
  type CreateAssignmentDto, type GradeAssignmentSubmissionDto, type UpdateAssignmentDto,
} from './dto/assignments.dto';

/** Giới hạn kích thước một tệp bài nộp (ảnh chụp từ điện thoại thường dưới vài MB; chừa biên cho tệp tài liệu). */
export const ASSIGN_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

@ApiTags('assignments')
@Controller({ path: 'courses/:courseId/assignments', version: '1' })
/**
 * API tạo và liệt kê hoạt động Bài tập nộp tệp/ảnh trong một khoá học.
 */
export class CourseAssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Post()
  /**
   * POST /courses/:courseId/assignments — tạo bài tập (kèm course module + grade item).
   */
  async create(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: createAssignmentSchema }) dto: CreateAssignmentDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.assignments.createAssignment(actor.id, courseId, dto);
  }
  @Get()
  /**
   * GET /courses/:courseId/assignments — các bài tập nộp tệp/ảnh trong khoá học.
   */
  async list(@Param('courseId', { schema: uuidIdSchema }) courseId: string) {
    return this.assignments.listAssignments(courseId);
  }
}

@ApiTags('assignments')
@Controller({ path: 'assignments', version: '1' })
/**
 * API hoạt động Bài tập nộp tệp/ảnh: cài đặt, bài nộp của học sinh (tải
 * tệp, chốt nộp, mở lại) và bề mặt chấm của giáo viên (danh sách bài nộp,
 * chi tiết kèm URL xem tệp, nhập điểm + lời phê).
 */
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Get(':id')
  /**
   * GET /assignments/:id — thông tin bài tập cho người xem (cấu hình,
   * bài nộp của chính mình kèm điểm/lời phê, các cờ quyền).
   */
  async getForUser(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.assignments.getAssignmentForUser(actor.id, id);
  }
  @Patch(':id')
  /**
   * PATCH /assignments/:id — sửa cài đặt bài tập (assign:manage).
   */
  async update(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updateAssignmentSchema }) dto: UpdateAssignmentDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.assignments.updateAssignment(actor.id, id, dto);
  }
  @Delete(':id')
  /**
   * DELETE /assignments/:id — xoá bài tập cùng cm, grade item, bài nộp và tệp (assign:manage).
   */
  async remove(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.assignments.deleteAssignment(actor.id, id);
    return { deleted: true };
  }

  @Post(':id/submission/files')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: ASSIGN_UPLOAD_MAX_BYTES } }))
  /**
   * POST /assignments/:id/submission/files — tải một tệp/ảnh vào bài nộp
   * nháp của chính mình (multipart; assign:submit).
   */
  async uploadFile(@Param('id', { schema: uuidIdSchema }) id: string, @UploadedFile() file: { originalname: string; buffer: Buffer; mimetype: string }, @CurrentUser() actor: AuthenticatedUser) {
    return this.assignments.uploadSubmissionFile(actor.id, id, {
      fileName: file.originalname, data: file.buffer, mimeType: file.mimetype,
    });
  }
  @Delete(':id/submission/files/:fileId')
  /**
   * DELETE /assignments/:id/submission/files/:fileId — gỡ một tệp khỏi bài nộp nháp của chính mình.
   */
  async removeFile(@Param('id', { schema: uuidIdSchema }) id: string, @Param('fileId', { schema: uuidIdSchema }) fileId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.assignments.removeSubmissionFile(actor.id, id, fileId);
    return { deleted: true };
  }
  @Post(':id/submission/submit')
  /**
   * POST /assignments/:id/submission/submit — chốt nộp bài (sau hạn vẫn nhận, đánh dấu trễ).
   */
  async submit(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.assignments.submitSubmission(actor.id, id);
  }
  @Post(':id/submission/reopen')
  /**
   * POST /assignments/:id/submission/reopen — mở lại bài đã nộp về nháp để sửa (chỉ khi chưa bị chấm).
   */
  async reopen(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.assignments.reopenSubmission(actor.id, id);
  }

  @Get(':id/submissions')
  /**
   * GET /assignments/:id/submissions — danh sách bài nộp cả lớp kèm
   * trạng thái theo hạn (assign:viewallsubmissions hoặc assign:grade).
   */
  async listSubmissions(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.assignments.listSubmissionsForTeacher(actor.id, id);
  }
  @Get(':id/submissions/:userId')
  /**
   * GET /assignments/:id/submissions/:userId — chi tiết một bài nộp để
   * chấm: tệp kèm URL đã ký xem toàn màn + điểm/lời phê hiện tại.
   */
  async getSubmission(@Param('id', { schema: uuidIdSchema }) id: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.assignments.getSubmissionForTeacher(actor.id, id, userId);
  }
  @Post(':id/submissions/:userId/grade')
  /**
   * POST /assignments/:id/submissions/:userId/grade — chấm một bài nộp:
   * điểm + lời phê, điểm ghi thẳng vào sổ điểm (assign:grade).
   */
  async grade(@Param('id', { schema: uuidIdSchema }) id: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @Body({ schema: gradeAssignmentSubmissionSchema }) dto: GradeAssignmentSubmissionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.assignments.gradeSubmission(actor.id, id, userId, dto);
  }
}

import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UploadedFile, UseInterceptors } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { AssignmentsService } from './assignments.service';
import {
  createAssignAnnotationSchema, createAssignFeedbackMessageSchema, createAssignmentSchema,
  createTeacherCommentBankEntrySchema, gradeAssignmentSubmissionSchema, releaseAssignmentGradesSchema,
  updateAssignAnnotationSchema, updateAssignmentSchema, upsertAssignRubricSchema,
  type CreateAssignAnnotationDto, type CreateAssignFeedbackMessageDto, type CreateAssignmentDto,
  type CreateTeacherCommentBankEntryDto, type GradeAssignmentSubmissionDto,
  type ReleaseAssignmentGradesDto, type UpdateAssignAnnotationDto, type UpdateAssignmentDto,
  type UpsertAssignRubricDto,
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
   * POST /assignments/:id/submissions/:userId/grade — LƯU gói chấm nháp
   * (điểm/mức + lời phê cấu trúc + kết quả rubric): học sinh chưa thấy,
   * sổ điểm chưa nhận; sửa gói đã trả qua cùng endpoint này sẽ ghi vết
   * kiểm toán (assign:grade).
   */
  async grade(@Param('id', { schema: uuidIdSchema }) id: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @Body({ schema: gradeAssignmentSubmissionSchema }) dto: GradeAssignmentSubmissionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.assignments.gradeSubmission(actor.id, id, userId, dto);
  }
  @Post(':id/submissions/:userId/release')
  /**
   * POST /assignments/:id/submissions/:userId/release — TRẢ BÀI cho một
   * học sinh: công bố nguyên tử gói chấm + ghi điểm vào sổ điểm tại thời
   * điểm trả (assign:grade).
   */
  async release(@Param('id', { schema: uuidIdSchema }) id: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.assignments.releaseSubmission(actor.id, id, userId);
  }
  @Post(':id/release-batch')
  /**
   * POST /assignments/:id/release-batch — TRẢ BÀI theo đợt: mọi gói chấm
   * nháp đã đầy đủ (hoặc các học sinh liệt kê trong body); gói chưa đầy
   * đủ được kê vào skippedUserIds (assign:grade).
   */
  async releaseBatch(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: releaseAssignmentGradesSchema }) dto: ReleaseAssignmentGradesDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.assignments.releaseBatch(actor.id, id, dto.userIds);
  }

  @Get(':id/rubric')
  /**
   * GET /assignments/:id/rubric — bảng chấm của bài (bản công khai cho
   * học sinh; mô tả dành cho người chấm chỉ hiện với vai chấm/quản lý).
   */
  async getRubric(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return { rubric: await this.assignments.getRubric(actor.id, id) };
  }
  @Put(':id/rubric')
  /**
   * PUT /assignments/:id/rubric — dựng/cập nhật bảng chấm (thay toàn
   * bộ; khoá sau khi đã có bài được trả) — assign:manage.
   */
  async putRubric(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: upsertAssignRubricSchema }) dto: UpsertAssignRubricDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.assignments.upsertRubric(actor.id, id, dto);
  }

  @Get(':id/submissions/:userId/annotations')
  /**
   * GET /assignments/:id/submissions/:userId/annotations — các dấu chấm
   * vector trên bài nộp (bề mặt chấm của giáo viên).
   */
  async listAnnotations(@Param('id', { schema: uuidIdSchema }) id: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.assignments.listAnnotationsForTeacher(actor.id, id, userId);
  }
  @Post(':id/submissions/:userId/annotations')
  /**
   * POST /assignments/:id/submissions/:userId/annotations — thả một dấu
   * chấm vector (đúng/sai/vẽ tay/ghi chú...) lên tệp của bài nộp
   * (assign:grade).
   */
  async createAnnotation(@Param('id', { schema: uuidIdSchema }) id: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @Body({ schema: createAssignAnnotationSchema }) dto: CreateAssignAnnotationDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.assignments.createAnnotation(actor.id, id, userId, dto);
  }
  @Patch(':id/submissions/:userId/annotations/:annotationId')
  /**
   * PATCH /assignments/:id/submissions/:userId/annotations/:annotationId — sửa một dấu chấm (assign:grade).
   */
  async updateAnnotation(@Param('id', { schema: uuidIdSchema }) id: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @Param('annotationId', { schema: uuidIdSchema }) annotationId: string, @Body({ schema: updateAssignAnnotationSchema }) dto: UpdateAssignAnnotationDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.assignments.updateAnnotation(actor.id, id, userId, annotationId, dto);
  }
  @Delete(':id/submissions/:userId/annotations/:annotationId')
  /**
   * DELETE /assignments/:id/submissions/:userId/annotations/:annotationId — xoá một dấu chấm (assign:grade).
   */
  async deleteAnnotation(@Param('id', { schema: uuidIdSchema }) id: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @Param('annotationId', { schema: uuidIdSchema }) annotationId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.assignments.deleteAnnotation(actor.id, id, userId, annotationId);
    return { deleted: true };
  }

  @Get(':id/submissions/:userId/messages')
  /**
   * GET /assignments/:id/submissions/:userId/messages — hội thoại phản
   * hồi trên bài đã trả (của chính học sinh hoặc bề mặt chấm).
   */
  async listMessages(@Param('id', { schema: uuidIdSchema }) id: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.assignments.listFeedbackMessages(actor.id, id, userId);
  }
  @Post(':id/submissions/:userId/messages')
  /**
   * POST /assignments/:id/submissions/:userId/messages — gửi một tin
   * nhắn vào hội thoại phản hồi (chỉ mở sau khi trả bài).
   */
  async postMessage(@Param('id', { schema: uuidIdSchema }) id: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @Body({ schema: createAssignFeedbackMessageSchema }) dto: CreateAssignFeedbackMessageDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.assignments.postFeedbackMessage(actor.id, id, userId, dto.body);
  }
}

@ApiTags('assignments')
@Controller({ path: 'assign-comment-bank', version: '1' })
/**
 * Ngân hàng lời phê cá nhân của giáo viên: các câu nhận xét thường dùng
 * (phân nhóm theo cấu trúc lời phê) để chèn một chạm khi chấm. Phạm vi
 * cá nhân — mọi thao tác chỉ chạm kho của chính người đang đăng nhập.
 */
export class AssignCommentBankController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Get()
  /**
   * GET /assign-comment-bank — các câu lời phê thường dùng của chính mình.
   */
  async list(@CurrentUser() actor: AuthenticatedUser) {
    return this.assignments.listMyCommentBank(actor.id);
  }
  @Post()
  /**
   * POST /assign-comment-bank — thêm một câu vào kho (kể cả lưu nhanh từ câu vừa gõ khi chấm).
   */
  async create(@Body({ schema: createTeacherCommentBankEntrySchema }) dto: CreateTeacherCommentBankEntryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.assignments.addCommentBankEntry(actor.id, dto);
  }
  @Delete(':entryId')
  /**
   * DELETE /assign-comment-bank/:entryId — xoá một câu khỏi kho của chính mình.
   */
  async remove(@Param('entryId', { schema: uuidIdSchema }) entryId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.assignments.deleteCommentBankEntry(actor.id, entryId);
    return { deleted: true };
  }
}

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CoursesService } from '../courses/courses.service';
import { SocialRepository, type NoteRow } from './social.repository';

/**
 * NotesModule (Moodle core_notes): notes ABOUT a user, in three states
 * (report §2#16): 'draft' = personal note (only its creator),
 * 'public' = course note (courseId set; readable only with
 * notes:view at the COURSE context — in practice the course's
 * teachers, NOT other students and NOT the subject), 'site' = site note
 * (notes:view at the system context).
 */
@Injectable()
/**
 * Ghi chú khoá học về học viên (course notes): site/course/personal/draft theo mức hiển thị.
 * Đối chiếu Moodle: notes/classes (note). Note nháp chỉ tác giả thấy.
 */
export class NotesService {
  constructor(
    private readonly repo: SocialRepository,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly courses: CoursesService,
  ) {}

  /**
   * Tạo note về một học viên.
   */
  async createNote(actorId: string, input: {
    userId: string; courseId?: string; content: string; publishState?: string; groupId?: string;
  }): Promise<NoteRow> {
    const publishState = input.publishState ?? 'draft';
    if (!['draft', 'public', 'site'].includes(publishState)) {
      throw new BadRequestException({ message: `Unknown publishState ${publishState}`, code: 'notes.bad_publishstate' });
    }
    if (publishState === 'public' && !input.courseId) {
      throw new BadRequestException({ message: 'A course (public) note requires courseId', code: 'notes.course_required' });
    }
    // 'public' (course) notes are managed at the course context; a 'draft'
    // (personal) note tied to a course is likewise authorised there; anything
    // else falls back to the system context.
    const ctxId = (publishState === 'public' || (publishState === 'draft' && input.courseId))
      ? await this.courses.courseContextId(input.courseId!)
      : (await this.contexts.ensureSystemContext()).id;
    await this.evaluator.requireCapability(actorId, 'notes:create', ctxId);
    return this.repo.insertNote({
      courseId: input.courseId ?? null, userId: input.userId, createdBy: actorId,
      content: input.content, publishState, groupId: input.groupId ?? null, userModified: actorId,
    });
  }

  /**
   * User có được xem note này hay không.
   */
  async canView(note: NoteRow, viewerId: string): Promise<boolean> {
    if (note.createdBy === viewerId) return true;
    if (await this.evaluator.isSiteAdmin(viewerId)) return true;
    if (note.publishState === 'draft') return false;
    if (note.publishState === 'public') {
      const ctx = await this.courses.courseContextId(note.courseId!);
      return this.evaluator.hasCapability(viewerId, 'notes:view', ctx);
    }
    // site note
    const systemCtx = await this.contexts.ensureSystemContext();
    return this.evaluator.hasCapabilityFromRealAssignment(viewerId, 'notes:view', systemCtx.id);
  }

  /**
   * Note viết về một user (đã lọc quyền xem).
   */
  async listNotesAbout(viewerId: string, subjectUserId: string, courseId?: string): Promise<NoteRow[]> {
    const rows = await this.repo.listNotesAbout(subjectUserId);
    const out: NoteRow[] = [];
    for (const note of rows) {
      if (courseId !== undefined && note.publishState === 'public' && note.courseId !== courseId) continue;
      if (await this.canView(note, viewerId)) out.push(note);
    }
    return out;
  }

  /**
   * Lấy note theo id.
   */
  async getNote(viewerId: string, id: string): Promise<NoteRow> {
    const note = await this.repo.getNote(id);
    if (!note) throw new NotFoundException({ message: `Note ${id} not found`, code: 'notes.not_found' });
    if (!(await this.canView(note, viewerId))) {
      throw new ForbiddenException({ message: 'You cannot view this note', code: 'notes.view_forbidden' });
    }
    return note;
  }

  /**
   * Xoá note của chính mình.
   */
  async deleteNote(actorId: string, id: string): Promise<{ deleted: boolean }> {
    const note = await this.repo.getNote(id);
    if (!note) throw new NotFoundException({ message: `Note ${id} not found`, code: 'notes.not_found' });
    if (note.createdBy !== actorId) {
      const ctx = note.publishState === 'public'
        ? await this.courses.courseContextId(note.courseId!)
        : (await this.contexts.ensureSystemContext()).id;
      await this.evaluator.requireCapability(actorId, 'notes:manage', ctx);
    }
    await this.repo.deleteNote(id);
    return { deleted: true };
  }
}

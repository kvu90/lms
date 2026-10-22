import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CoursesService } from '../courses/courses.service';
import { SocialRepository, type NoteRow } from './social.repository';

/**
 * NotesModule (Moodle core_notes): notes ABOUT a user, in three states
 * (report §2#16): 'draft' = personal note (only its creator),
 * 'public' = course note (courseid set; readable only with
 * moodle/notes:view at the COURSE context — in practice the course's
 * teachers, NOT other students and NOT the subject), 'site' = site note
 * (moodle/notes:view at the system context).
 */
@Injectable()
export class NotesService {
  constructor(
    private readonly repo: SocialRepository,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly courses: CoursesService,
  ) {}

  async createNote(actorId: number, input: {
    userid: number; courseid?: number; content: string; publishstate?: string; groupid?: number;
  }): Promise<NoteRow> {
    const publishstate = input.publishstate ?? 'draft';
    if (!['draft', 'public', 'site'].includes(publishstate)) {
      throw new BadRequestException({ message: `Unknown publishstate ${publishstate}`, code: 'notes.bad_publishstate' });
    }
    if (publishstate === 'public' && !input.courseid) {
      throw new BadRequestException({ message: 'A course (public) note requires courseid', code: 'notes.course_required' });
    }
    // 'public' (course) notes are managed at the course context; a 'draft'
    // (personal) note tied to a course is likewise authorised there; anything
    // else falls back to the system context.
    const ctxId = (publishstate === 'public' || (publishstate === 'draft' && input.courseid))
      ? await this.courses.courseContextId(input.courseid!)
      : (await this.contexts.ensureSystemContext()).id;
    await this.evaluator.requireCapability(actorId, 'moodle/notes:create', ctxId);
    return this.repo.insertNote({
      courseid: input.courseid ?? 0, userid: input.userid, createdby: actorId,
      content: input.content, publishstate, groupid: input.groupid ?? 0, usermodified: actorId,
    });
  }

  async canView(note: NoteRow, viewerId: number): Promise<boolean> {
    if (note.createdby === viewerId) return true;
    if (await this.evaluator.isSiteAdmin(viewerId)) return true;
    if (note.publishstate === 'draft') return false;
    if (note.publishstate === 'public') {
      const ctx = await this.courses.courseContextId(note.courseid);
      return this.evaluator.hasCapability(viewerId, 'moodle/notes:view', ctx);
    }
    // site note
    const systemCtx = await this.contexts.ensureSystemContext();
    return this.evaluator.hasCapabilityFromRealAssignment(viewerId, 'moodle/notes:view', systemCtx.id);
  }

  async listNotesAbout(viewerId: number, subjectUserId: number, courseId?: number): Promise<NoteRow[]> {
    const rows = await this.repo.listNotesAbout(subjectUserId);
    const out: NoteRow[] = [];
    for (const note of rows) {
      if (courseId !== undefined && note.publishstate === 'public' && note.courseid !== courseId) continue;
      if (await this.canView(note, viewerId)) out.push(note);
    }
    return out;
  }

  async getNote(viewerId: number, id: number): Promise<NoteRow> {
    const note = await this.repo.getNote(id);
    if (!note) throw new NotFoundException({ message: `Note ${id} not found`, code: 'notes.not_found' });
    if (!(await this.canView(note, viewerId))) {
      throw new ForbiddenException({ message: 'You cannot view this note', code: 'notes.view_forbidden' });
    }
    return note;
  }

  async deleteNote(actorId: number, id: number): Promise<{ deleted: boolean }> {
    const note = await this.repo.getNote(id);
    if (!note) throw new NotFoundException({ message: `Note ${id} not found`, code: 'notes.not_found' });
    if (note.createdby !== actorId) {
      const ctx = note.publishstate === 'public'
        ? await this.courses.courseContextId(note.courseid)
        : (await this.contexts.ensureSystemContext()).id;
      await this.evaluator.requireCapability(actorId, 'moodle/notes:manage', ctx);
    }
    await this.repo.deleteNote(id);
    return { deleted: true };
  }
}

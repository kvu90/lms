import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CoursesService } from '../courses/courses.service';
import { SocialRepository, type CommentRow } from './social.repository';

/**
 * CommentsModule (Moodle core_comment): polymorphic comments over
 * (component, commentarea, itemid, contextid). Capabilities are checked AT
 * THE ITEM'S CONTEXT: comment:view to read, comment:post to add,
 * comment:delete (or authorship) to delete (oracle: comment/tests/
 * externallib_test test_get_comments / test_add_comments_single).
 */
@Injectable()
/**
 * Bình luận theo (context, component, area, item).
 * Đối chiếu Moodle: lib/commentlib (comment). Xoá là xoá mềm; chỉ tác giả hoặc người có capability mới xoá được.
 */
export class CommentsService {
  constructor(
    private readonly repo: SocialRepository,
    private readonly evaluator: PermissionEvaluator,
    private readonly contexts: ContextsService,
    private readonly courses: CoursesService,
  ) {}

  /** For course/module contexts, commenting also requires real course access (the virtual 'user' role alone never opens a course). */
  private async assertItemAccess(actorId: string, contextid: string): Promise<void> {
    const ctx = await this.contexts.getContext(contextid).catch(() => undefined);
    if (!ctx) return;
    if (ctx.contextlevel === 50) await this.courses.assertCourseAccess(actorId, ctx.instanceid!);
    if (ctx.contextlevel === 70) {
      const cm = await this.courses.getCm(ctx.instanceid!);
      await this.courses.assertCourseAccess(actorId, cm.course);
    }
  }

  /**
   * Thêm bình luận vào item.
   */
  async addComment(actorId: string, input: {
    contextid: string; component: string; commentarea: string; itemid: string; content: string;
  }): Promise<CommentRow> {
    await this.evaluator.requireCapability(actorId, 'moodle/comment:post', input.contextid);
    await this.assertItemAccess(actorId, input.contextid);
    return this.repo.insertComment({
      contextid: input.contextid, component: input.component, commentarea: input.commentarea,
      itemid: input.itemid, content: input.content, userid: actorId,
    });
  }

  /**
   * Bình luận của item.
   */
  async listComments(viewerId: string, input: {
    contextid: string; component: string; commentarea: string; itemid: string;
  }): Promise<{ comments: CommentRow[]; count: number; canpost: boolean }> {
    await this.evaluator.requireCapability(viewerId, 'moodle/comment:view', input.contextid);
    await this.assertItemAccess(viewerId, input.contextid);
    const rows = await this.repo.listComments(input.component, input.commentarea, input.itemid, input.contextid);
    const canpost = await this.evaluator.hasCapability(viewerId, 'moodle/comment:post', input.contextid);
    return { comments: rows, count: rows.length, canpost };
  }

  /**
   * Xoá mềm bình luận (kiểm tác giả/capability).
   */
  async deleteComment(actorId: string, commentId: string): Promise<{ deleted: boolean }> {
    const comment = await this.repo.getComment(commentId);
    if (!comment || comment.timedeleted) throw new NotFoundException({ message: `Comment ${commentId} not found`, code: 'comments.not_found' });
    if (comment.userid !== actorId) {
      const canDelete = await this.evaluator.hasCapability(actorId, 'moodle/comment:delete', comment.contextid);
      if (!canDelete) {
        throw new ForbiddenException({ message: 'Only the author or a user with moodle/comment:delete can delete this comment', code: 'comments.delete_forbidden' });
      }
    }
    await this.repo.softDeleteComment(commentId);
    return { deleted: true };
  }
}

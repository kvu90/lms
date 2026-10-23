import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CoursesService } from '../courses/courses.service';
import { EnrolService } from '../enrol/enrol.service';
import { SocialRepository, type BlogPostRow } from './social.repository';

/**
 * BlogModule (Moodle core_blog): posts live in the AUTHOR'S user context
 * and may be ASSOCIATED with a course or a course module
 * (blog_association). Visibility: drafts are author-only; public ('site')
 * posts are readable by blog:view holders — but when a post is associated
 * with a course, readers must also belong to that course (the association
 * narrows the audience, exactly like blog_listing's course filter in
 * blog/tests/lib_test test_overrides).
 */
@Injectable()
/**
 * Blog cá nhân và liên kết bài viết với khoá học/module (association).
 * Đối chiếu Moodle: blog/classes (blog_entry). Quyền xem theo mức hiển thị của bài và quan hệ với khoá học liên kết.
 */
export class BlogService {
  constructor(
    private readonly repo: SocialRepository,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly courses: CoursesService,
    private readonly enrol: EnrolService,
  ) {}

  /**
   * Tạo bài blog.
   */
  async createPost(actorId: string, input: { subject: string; summary?: string; content: string; publishState?: string }): Promise<BlogPostRow> {
    const userCtx = await this.contexts.getByLevelInstance(30, actorId);
    const systemCtx = await this.contexts.ensureSystemContext();
    await this.evaluator.requireCapability(actorId, 'moodle/blog:create', userCtx?.id ?? systemCtx.id);
    const publishState = input.publishState ?? 'draft';
    if (!['draft', 'site'].includes(publishState)) {
      throw new ForbiddenException({ message: `Unknown publishState ${publishState}`, code: 'blog.bad_publishstate' });
    }
    return this.repo.insertPost({
      userId: actorId, subject: input.subject, summary: input.summary ?? '',
      content: input.content, publishState,
    });
  }

  /**
   * Lấy bài blog; ném social.post_not_found khi vắng.
   */
  async getPost(id: string): Promise<BlogPostRow> {
    const row = await this.repo.getPost(id);
    if (!row) throw new NotFoundException({ message: `Blog post ${id} not found`, code: 'blog.not_found' });
    return row;
  }

  /**
   * Liên kết bài với khoá học/module.
   */
  async associate(actorId: string, postId: string, input: { assocType: 'course' | 'coursemodule'; assocId: string }): Promise<{ postId: string; associations: unknown }> {
    const post = await this.getPost(postId);
    if (post.userId !== actorId) {
      const userCtx = await this.contexts.getByLevelInstance(30, post.userId);
      const canManage = userCtx ? await this.evaluator.hasCapability(actorId, 'moodle/blog:manageentries', userCtx.id) : false;
      if (!canManage) throw new ForbiddenException({ message: 'Only the author can associate this post', code: 'blog.associate_forbidden' });
    }
    let contextId: string;
    if (input.assocType === 'course') {
      await this.courses.getCourse(input.assocId);
      contextId = await this.courses.courseContextId(input.assocId);
    } else {
      const cm = await this.courses.getCm(input.assocId);
      contextId = (await this.courses.cmContextId(cm.id)) ?? await this.courses.courseContextId(cm.course);
    }
    await this.repo.addAssociation({ blogId: postId, contextId, assocType: input.assocType, assocId: input.assocId });
    return { postId, associations: await this.repo.listAssociations(postId) };
  }

  /**
   * User có được xem bài này hay không.
   */
  async canView(post: BlogPostRow, viewerId: string): Promise<boolean> {
    if (post.userId === viewerId) return true;
    if (await this.evaluator.isSiteAdmin(viewerId)) return true;
    if (post.publishState === 'draft') return false;
    const systemCtx = await this.contexts.ensureSystemContext();
    if (!(await this.evaluator.hasCapability(viewerId, 'moodle/blog:view', systemCtx.id))) return false;
    const associations = await this.repo.listAssociations(post.id);
    const courseAssociations = associations.filter((a) => a.assocType === 'course');
    if (!courseAssociations.length) return true;
    // Course-associated public posts narrow the audience to course members.
    for (const assoc of courseAssociations) {
      if (await this.enrol.isEnrolled(assoc.assocId, viewerId, { onlyActive: true })) return true;
    }
    return false;
  }

  /**
   * Liệt kê bài blog được phép xem.
   */
  async listPosts(viewerId: string, filter: { userId?: string; courseId?: string; cmid?: string }): Promise<(BlogPostRow & { associations: unknown; contextId: string | null })[]> {
    let candidates: BlogPostRow[];
    if (filter.courseId) {
      const assocs = await this.repo.listAssociationsForTarget('course', filter.courseId);
      candidates = [];
      for (const a of assocs) {
        const post = await this.repo.getPost(a.blogId);
        if (post) candidates.push(post);
      }
    } else if (filter.cmid) {
      const assocs = await this.repo.listAssociationsForTarget('coursemodule', filter.cmid);
      candidates = [];
      for (const a of assocs) {
        const post = await this.repo.getPost(a.blogId);
        if (post) candidates.push(post);
      }
    } else if (filter.userId) {
      candidates = await this.repo.listPostsByUser(filter.userId);
    } else {
      candidates = await this.repo.listPosts();
    }
    const out: (BlogPostRow & { associations: unknown; contextId: string | null })[] = [];
    for (const post of candidates) {
      if (await this.canView(post, viewerId)) {
        // contextId = the author's user context, so polymorphic consumers
        // (tags/comments/ratings) can address the post without guessing.
        const authorCtx = await this.contexts.getByLevelInstance(30, post.userId);
        out.push({ ...post, associations: await this.repo.listAssociations(post.id), contextId: authorCtx?.id ?? null });
      }
    }
    return out;
  }

  /**
   * Cập nhật bài của chính mình.
   */
  async updatePost(actorId: string, id: string, input: { subject?: string; summary?: string; content?: string; publishState?: string }): Promise<BlogPostRow> {
    const post = await this.getPost(id);
    if (post.userId !== actorId) {
      const userCtx = await this.contexts.getByLevelInstance(30, post.userId);
      const canManage = userCtx ? await this.evaluator.hasCapability(actorId, 'moodle/blog:manageentries', userCtx.id) : false;
      if (!canManage) throw new ForbiddenException({ message: 'Only the author can edit this post', code: 'blog.edit_forbidden' });
    }
    const patch: Partial<BlogPostRow> = {};
    if (input.subject !== undefined) patch.subject = input.subject;
    if (input.summary !== undefined) patch.summary = input.summary;
    if (input.content !== undefined) patch.content = input.content;
    if (input.publishState !== undefined) patch.publishState = input.publishState;
    await this.repo.updatePost(id, patch);
    return this.getPost(id);
  }

  /**
   * Xoá bài của chính mình.
   */
  async deletePost(actorId: string, id: string): Promise<{ deleted: boolean }> {
    const post = await this.getPost(id);
    if (post.userId !== actorId) {
      const userCtx = await this.contexts.getByLevelInstance(30, post.userId);
      const canManage = userCtx ? await this.evaluator.hasCapability(actorId, 'moodle/blog:manageentries', userCtx.id) : false;
      if (!canManage) throw new ForbiddenException({ message: 'Only the author can delete this post', code: 'blog.delete_forbidden' });
    }
    await this.repo.deletePost(id);
    return { deleted: true };
  }
}

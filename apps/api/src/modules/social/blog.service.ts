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
export class BlogService {
  constructor(
    private readonly repo: SocialRepository,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly courses: CoursesService,
    private readonly enrol: EnrolService,
  ) {}

  async createPost(actorId: number, input: { subject: string; summary?: string; content: string; publishstate?: string }): Promise<BlogPostRow> {
    const userCtx = await this.contexts.getByLevelInstance(30, actorId);
    const systemCtx = await this.contexts.ensureSystemContext();
    await this.evaluator.requireCapability(actorId, 'moodle/blog:create', userCtx?.id ?? systemCtx.id);
    const publishstate = input.publishstate ?? 'draft';
    if (!['draft', 'site'].includes(publishstate)) {
      throw new ForbiddenException({ message: `Unknown publishstate ${publishstate}`, code: 'blog.bad_publishstate' });
    }
    return this.repo.insertPost({
      userid: actorId, subject: input.subject, summary: input.summary ?? '',
      content: input.content, publishstate,
    });
  }

  async getPost(id: number): Promise<BlogPostRow> {
    const row = await this.repo.getPost(id);
    if (!row) throw new NotFoundException({ message: `Blog post ${id} not found`, code: 'blog.not_found' });
    return row;
  }

  async associate(actorId: number, postId: number, input: { assoctype: 'course' | 'coursemodule'; associd: number }): Promise<{ postId: number; associations: unknown }> {
    const post = await this.getPost(postId);
    if (post.userid !== actorId) {
      const userCtx = await this.contexts.getByLevelInstance(30, post.userid);
      const canManage = userCtx ? await this.evaluator.hasCapability(actorId, 'moodle/blog:manageentries', userCtx.id) : false;
      if (!canManage) throw new ForbiddenException({ message: 'Only the author can associate this post', code: 'blog.associate_forbidden' });
    }
    let contextid: number;
    if (input.assoctype === 'course') {
      await this.courses.getCourse(input.associd);
      contextid = await this.courses.courseContextId(input.associd);
    } else {
      const cm = await this.courses.getCm(input.associd);
      contextid = (await this.courses.cmContextId(cm.id)) ?? await this.courses.courseContextId(cm.course);
    }
    await this.repo.addAssociation({ blogid: postId, contextid, assoctype: input.assoctype, associd: input.associd });
    return { postId, associations: await this.repo.listAssociations(postId) };
  }

  async canView(post: BlogPostRow, viewerId: number): Promise<boolean> {
    if (post.userid === viewerId) return true;
    if (await this.evaluator.isSiteAdmin(viewerId)) return true;
    if (post.publishstate === 'draft') return false;
    const systemCtx = await this.contexts.ensureSystemContext();
    if (!(await this.evaluator.hasCapability(viewerId, 'moodle/blog:view', systemCtx.id))) return false;
    const associations = await this.repo.listAssociations(post.id);
    const courseAssociations = associations.filter((a) => a.assoctype === 'course');
    if (!courseAssociations.length) return true;
    // Course-associated public posts narrow the audience to course members.
    for (const assoc of courseAssociations) {
      if (await this.enrol.isEnrolled(assoc.associd, viewerId, { onlyActive: true })) return true;
    }
    return false;
  }

  async listPosts(viewerId: number, filter: { userid?: number; courseid?: number; cmid?: number }): Promise<(BlogPostRow & { associations: unknown })[]> {
    let candidates: BlogPostRow[];
    if (filter.courseid) {
      const assocs = await this.repo.listAssociationsForTarget('course', filter.courseid);
      candidates = [];
      for (const a of assocs) {
        const post = await this.repo.getPost(a.blogid);
        if (post) candidates.push(post);
      }
    } else if (filter.cmid) {
      const assocs = await this.repo.listAssociationsForTarget('coursemodule', filter.cmid);
      candidates = [];
      for (const a of assocs) {
        const post = await this.repo.getPost(a.blogid);
        if (post) candidates.push(post);
      }
    } else if (filter.userid) {
      candidates = await this.repo.listPostsByUser(filter.userid);
    } else {
      candidates = await this.repo.listPosts();
    }
    const out: (BlogPostRow & { associations: unknown })[] = [];
    for (const post of candidates) {
      if (await this.canView(post, viewerId)) {
        out.push({ ...post, associations: await this.repo.listAssociations(post.id) });
      }
    }
    return out;
  }

  async updatePost(actorId: number, id: number, input: { subject?: string; summary?: string; content?: string; publishstate?: string }): Promise<BlogPostRow> {
    const post = await this.getPost(id);
    if (post.userid !== actorId) {
      const userCtx = await this.contexts.getByLevelInstance(30, post.userid);
      const canManage = userCtx ? await this.evaluator.hasCapability(actorId, 'moodle/blog:manageentries', userCtx.id) : false;
      if (!canManage) throw new ForbiddenException({ message: 'Only the author can edit this post', code: 'blog.edit_forbidden' });
    }
    const patch: Partial<BlogPostRow> = {};
    if (input.subject !== undefined) patch.subject = input.subject;
    if (input.summary !== undefined) patch.summary = input.summary;
    if (input.content !== undefined) patch.content = input.content;
    if (input.publishstate !== undefined) patch.publishstate = input.publishstate;
    await this.repo.updatePost(id, patch);
    return this.getPost(id);
  }

  async deletePost(actorId: number, id: number): Promise<{ deleted: boolean }> {
    const post = await this.getPost(id);
    if (post.userid !== actorId) {
      const userCtx = await this.contexts.getByLevelInstance(30, post.userid);
      const canManage = userCtx ? await this.evaluator.hasCapability(actorId, 'moodle/blog:manageentries', userCtx.id) : false;
      if (!canManage) throw new ForbiddenException({ message: 'Only the author can delete this post', code: 'blog.delete_forbidden' });
    }
    await this.repo.deletePost(id);
    return { deleted: true };
  }
}

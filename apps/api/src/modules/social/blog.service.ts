import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { RolesService } from '../access/roles.service';
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
 * blog/tests/lib_test test_overrides). An association with a course
 * MODULE narrows the audience the same way, to the course containing
 * the module — a module belongs to exactly one course (issue #48, F1).
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
    private readonly roles: RolesService,
    private readonly courses: CoursesService,
    private readonly enrol: EnrolService,
  ) {}

  /**
   * Tạo bài blog.
   */
  async createPost(actorId: string, input: { subject: string; summary?: string; content: string; publishState?: string }): Promise<BlogPostRow> {
    const userCtx = await this.contexts.getByLevelInstance(30, actorId);
    const systemCtx = await this.contexts.ensureSystemContext();
    await this.evaluator.requireCapability(actorId, 'blog:create', userCtx?.id ?? systemCtx.id);
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
      const canManage = userCtx ? await this.evaluator.hasCapability(actorId, 'blog:manageentries', userCtx.id) : false;
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
   * "Thuộc khoá" theo đúng định nghĩa đã chốt ở issue #33/#44: ghi danh
   * đang hiệu lực HOẶC được gán vai tại context khoá. Nhánh gán vai là
   * bắt buộc: giáo viên phụ trách khoá thường chỉ được gán vai
   * (editingteacher) chứ không có ghi danh — chỉ tính ghi danh sẽ chặn
   * nhầm người hợp lệ (điểm ngược ghi trong research blog).
   */
  private async isCourseMember(courseId: string, viewerId: string): Promise<boolean> {
    if (await this.enrol.isEnrolled(courseId, viewerId, { onlyActive: true })) return true;
    const assignments = await this.roles.listAssignments({
      userId: viewerId,
      contextId: await this.courses.courseContextId(courseId),
    });
    return assignments.length > 0;
  }

  /**
   * User có được xem bài này hay không.
   */
  async canView(post: BlogPostRow, viewerId: string): Promise<boolean> {
    if (post.userId === viewerId) return true;
    if (await this.evaluator.isSiteAdmin(viewerId)) return true;
    if (post.publishState === 'draft') return false;
    const systemCtx = await this.contexts.ensureSystemContext();
    if (!(await this.evaluator.hasCapability(viewerId, 'blog:view', systemCtx.id))) return false;
    const associations = await this.repo.listAssociations(post.id);
    if (!associations.length) return true;
    // Mọi association đều thu hẹp audience về (các) khoá liên kết: liên
    // kết trực tiếp với khoá ('course') hoặc qua module ('coursemodule'
    // → khoá chứa module đó — một module chỉ thuộc đúng một khoá, nên
    // bỏ qua loại này như trước F1 là để bài thoát cổng thành bài site).
    // Nhiều association (gồm cả hai loại, khác khoá nhau): giữ đúng ngữ
    // nghĩa hiện tại của nhiều liên kết 'course' — viewer thuộc BẤT KỲ
    // khoá liên kết nào thì xem được (audience là hợp của các khoá).
    // Association không phân giải được khoá (module đã bị xoá) KHÔNG
    // mở rộng audience: bài vẫn bị thu hẹp (fail closed) — việc xoá
    // module không được biến bài gắn khoá thành bài toàn site.
    const courseIds = new Set<string>();
    for (const assoc of associations) {
      if (assoc.assocType === 'course') {
        courseIds.add(assoc.assocId);
      } else if (assoc.assocType === 'coursemodule') {
        try {
          const cm = await this.courses.getCm(assoc.assocId);
          courseIds.add(cm.course);
        } catch {
          // Module không còn tồn tại: giữ thu hẹp, không cộng khoá nào.
        }
      }
    }
    for (const courseId of courseIds) {
      if (await this.isCourseMember(courseId, viewerId)) return true;
    }
    return false;
  }

  /**
   * Cổng audience DÙNG CHUNG cho mọi đường đọc nội dung blog (issue #48):
   * chi tiết bài, lớp phụ trợ comment/tag/rating và global search đều đi
   * qua đây. Bài không tồn tại hoặc viewer không có quyền xem → 404 với
   * đúng mã/thông điệp như bài không tồn tại (`blog.not_found`), không
   * lộ sự tồn tại của bài và tuyệt đối không trả nội dung.
   */
  async assertCanViewPost(postId: string, viewerId: string): Promise<BlogPostRow> {
    const post = await this.repo.getPost(postId);
    if (!post || !(await this.canView(post, viewerId))) {
      throw new NotFoundException({ message: `Blog post ${postId} not found`, code: 'blog.not_found' });
    }
    return post;
  }

  /**
   * Đọc chi tiết một bài cho một viewer cụ thể (đã qua cổng audience).
   */
  async getPostForViewer(id: string, viewerId: string): Promise<BlogPostRow> {
    return this.assertCanViewPost(id, viewerId);
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
      const canManage = userCtx ? await this.evaluator.hasCapability(actorId, 'blog:manageentries', userCtx.id) : false;
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
      const canManage = userCtx ? await this.evaluator.hasCapability(actorId, 'blog:manageentries', userCtx.id) : false;
      if (!canManage) throw new ForbiddenException({ message: 'Only the author can delete this post', code: 'blog.delete_forbidden' });
    }
    await this.repo.deletePost(id);
    return { deleted: true };
  }
}

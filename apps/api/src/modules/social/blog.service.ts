import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { RolesService } from '../access/roles.service';
import { CoursesService } from '../courses/courses.service';
import { EnrolService } from '../enrol/enrol.service';
import {
  BLOG_COMMENTS_POLICIES, BLOG_KINDS, BLOG_QUESTION_STATES, BLOG_SPACE_TYPES, BLOG_STATUSES,
  canTransitionBlogStatus, deriveBlogAudience, legacyPublishState, statusFromLegacyPublishState,
  type BlogKind, type BlogSpaceType, type BlogStatus,
} from './blog-state';
import { SocialRepository, type BlogPostRow } from './social.repository';

export type BlogPostView = BlogPostRow & { publishState: 'draft' | 'site' };

export interface BlogFeedItem extends BlogPostView {
  author: { id: string; displayName: string; username: string };
  tags: string[];
}

export interface BlogFeedResult {
  items: BlogFeedItem[];
  nextCursor: string | null;
}

const STAFF_ARCHETYPES = new Set(['manager', 'coursecreator', 'editingteacher', 'teacher']);

/**
 * Blog học tập (BL1, issue #87): mỗi bài có đúng một không gian chính
 * (khoá | trường | cá nhân), một loại bài và vòng đời tách khỏi
 * audience. Space quyết định audience; association cũ chỉ còn là liên
 * kết hiển thị, không đổi audience. Mọi đường đọc đi qua cổng chung
 * `assertCanViewPost` của #48: không có quyền → 404 như bài không tồn
 * tại. State machine ở blog-state.ts, validate ở cả create và update.
 */
@Injectable()
export class BlogService {
  constructor(
    private readonly repo: SocialRepository,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly roles: RolesService,
    private readonly courses: CoursesService,
    private readonly enrol: EnrolService,
  ) {}

  /** Chiếu hàng DB thành view trả ra API: kèm publishState tương thích ngược cho client cũ. */
  private toView(row: BlogPostRow): BlogPostView {
    return { ...row, publishState: legacyPublishState(row.status as BlogStatus) };
  }

  /**
   * "Thuộc khoá" theo đúng định nghĩa đã chốt ở issue #33/#44: ghi danh
   * đang hiệu lực HOẶC được gán vai tại context khoá. Nhánh gán vai là
   * bắt buộc: giáo viên phụ trách khoá thường chỉ được gán vai
   * (editingteacher) chứ không có ghi danh.
   */
  private async isCourseMember(courseId: string, viewerId: string): Promise<boolean> {
    if (await this.enrol.isEnrolled(courseId, viewerId, { onlyActive: true })) return true;
    const assignments = await this.roles.listAssignments({
      userId: viewerId,
      contextId: await this.courses.courseContextId(courseId),
    });
    return assignments.length > 0;
  }

  /** Staff được đăng thẳng lên không gian trường: site admin hoặc có vai staff tại context hệ thống. */
  private async canPostToSchoolSpace(actorId: string): Promise<boolean> {
    if (await this.evaluator.isSiteAdmin(actorId)) return true;
    const systemCtx = await this.contexts.ensureSystemContext();
    const assignments = await this.roles.listAssignments({ userId: actorId, contextId: systemCtx.id }) as { roleId: string }[];
    for (const assignment of assignments) {
      const role = await this.roles.getRole(assignment.roleId).catch(() => null);
      if (role && STAFF_ARCHETYPES.has(role.archetype ?? '')) return true;
    }
    return false;
  }

  /**
   * Validate + phân giải không gian khi tạo bài hoặc khi đổi space ở
   * bản nháp. Trả space đã chuẩn hoá (space user luôn là chính tác giả;
   * space trường không có space_id).
   */
  private async resolveSpace(
    actorId: string, authorId: string,
    spaceType: BlogSpaceType, spaceId: string | null | undefined,
  ): Promise<{ spaceType: BlogSpaceType; spaceId: string | null }> {
    if (spaceType === 'user') {
      return { spaceType, spaceId: authorId };
    }
    if (spaceType === 'school') {
      if (actorId === authorId && !(await this.canPostToSchoolSpace(actorId))) {
        throw new ForbiddenException({ message: 'Only staff can post directly to the school space', code: 'blog.school_space_forbidden' });
      }
      return { spaceType, spaceId: null };
    }
    // course
    if (!spaceId) {
      throw new BadRequestException({ message: 'spaceId is required for a course space post', code: 'blog.space_id_required' });
    }
    await this.courses.getCourse(spaceId);
    if (actorId === authorId) {
      await this.courses.assertCourseAccess(authorId, spaceId);
    }
    return { spaceType, spaceId };
  }

  /**
   * Tạo bài blog.
   */
  async createPost(actorId: string, input: {
    subject: string; summary?: string; content: string; publishState?: string;
    spaceType?: string; spaceId?: string; kind?: string; status?: string;
    commentsPolicy?: string; questionState?: string; scheduledAt?: string;
  }): Promise<BlogPostView> {
    const userCtx = await this.contexts.getByLevelInstance(30, actorId);
    const systemCtx = await this.contexts.ensureSystemContext();
    await this.evaluator.requireCapability(actorId, 'blog:create', userCtx?.id ?? systemCtx.id);

    const spaceType = (input.spaceType ?? 'user') as BlogSpaceType;
    if (!BLOG_SPACE_TYPES.includes(spaceType)) {
      throw new BadRequestException({ message: `Unknown spaceType ${input.spaceType}`, code: 'blog.bad_space_type' });
    }
    const kind = (input.kind ?? 'article') as BlogKind;
    if (!BLOG_KINDS.includes(kind)) {
      throw new BadRequestException({ message: `Unknown kind ${input.kind}`, code: 'blog.bad_kind' });
    }
    const status = (input.status ?? (input.publishState ? statusFromLegacyPublishState(input.publishState) : 'draft')) as BlogStatus;
    if (!(['draft', 'pending_review', 'published'] as BlogStatus[]).includes(status)) {
      throw new BadRequestException({ message: `Cannot create a post directly in status ${status}`, code: 'blog.bad_initial_status' });
    }
    if (input.commentsPolicy !== undefined && !BLOG_COMMENTS_POLICIES.includes(input.commentsPolicy as never)) {
      throw new BadRequestException({ message: `Unknown commentsPolicy ${input.commentsPolicy}`, code: 'blog.bad_comments_policy' });
    }
    let questionState: string | null = null;
    if (kind === 'question') {
      questionState = input.questionState ?? 'open';
      if (!BLOG_QUESTION_STATES.includes(questionState as never)) {
        throw new BadRequestException({ message: `Unknown questionState ${input.questionState}`, code: 'blog.bad_question_state' });
      }
    } else if (input.questionState !== undefined) {
      throw new BadRequestException({ message: 'questionState only applies to kind=question posts', code: 'blog.question_state_kind' });
    }
    const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
    if (status === 'published' && scheduledAt && scheduledAt.getTime() > Date.now()) {
      throw new BadRequestException({ message: 'A post scheduled in the future cannot be published yet', code: 'blog.scheduled_in_future' });
    }
    const space = await this.resolveSpace(actorId, actorId, spaceType, input.spaceId);
    const row = await this.repo.insertPost({
      userId: actorId, subject: input.subject, summary: input.summary ?? '',
      content: input.content, publishState: legacyPublishState(status),
      spaceType: space.spaceType, spaceId: space.spaceId, kind, status,
      audience: deriveBlogAudience(space.spaceType, status),
      commentsPolicy: input.commentsPolicy ?? 'open',
      questionState,
      publishedAt: status === 'published' ? new Date() : null,
      scheduledAt,
    });
    return this.toView(row);
  }

  /**
   * Lấy bài blog (nội bộ, không qua cổng audience); ném blog.not_found khi vắng.
   */
  async getPost(id: string): Promise<BlogPostRow> {
    const row = await this.repo.getPost(id);
    if (!row) throw new NotFoundException({ message: `Blog post ${id} not found`, code: 'blog.not_found' });
    return row;
  }

  /**
   * Liên kết bài với khoá học/module (tương thích ngược). Từ BL1
   * association CHỈ là liên kết hiển thị: audience do space của bài
   * quyết định, association không thu hẹp cũng không mở rộng.
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
   * User có được xem bài này hay không (mô hình BL1):
   * - tác giả và site admin: mọi trạng thái;
   * - người khác: chỉ published/archived, moderation chưa held/removed;
   *   space khoá → blog:view tại hệ thống + thuộc khoá (ghi danh ∪ gán
   *   vai), space_id null (fail-closed sau di trú) → không ai qua;
   *   space trường/cá nhân → blog:view tại hệ thống.
   */
  async canView(post: BlogPostRow, viewerId: string): Promise<boolean> {
    if (post.userId === viewerId) return true;
    if (await this.evaluator.isSiteAdmin(viewerId)) return true;
    if (post.status !== 'published' && post.status !== 'archived') return false;
    if (post.moderationState === 'held' || post.moderationState === 'removed') return false;
    const systemCtx = await this.contexts.ensureSystemContext();
    if (!(await this.evaluator.hasCapability(viewerId, 'blog:view', systemCtx.id))) return false;
    if (post.spaceType === 'course') {
      if (!post.spaceId) return false;
      return this.isCourseMember(post.spaceId, viewerId);
    }
    return true;
  }

  /**
   * Cổng audience DÙNG CHUNG cho mọi đường đọc nội dung blog (issue
   * #48): chi tiết bài, lớp phụ trợ comment/tag/rating và global search
   * đều đi qua đây. Bài không tồn tại hoặc viewer không có quyền xem →
   * 404 với đúng mã/thông điệp như bài không tồn tại (`blog.not_found`),
   * không lộ sự tồn tại của bài và tuyệt đối không trả nội dung.
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
  async getPostForViewer(id: string, viewerId: string): Promise<BlogPostView> {
    return this.toView(await this.assertCanViewPost(id, viewerId));
  }

  /**
   * Liệt kê bài blog được phép xem (đường cũ, giữ tương thích): ứng
   * viên theo tác giả / khoá (association HOẶC space khoá) / module,
   * lọc bằng canView.
   */
  async listPosts(viewerId: string, filter: { userId?: string; courseId?: string; cmid?: string }): Promise<(BlogPostView & { associations: unknown; contextId: string | null })[]> {
    let candidates: BlogPostRow[];
    if (filter.courseId) {
      const byId = new Map<string, BlogPostRow>();
      for (const a of await this.repo.listAssociationsForTarget('course', filter.courseId)) {
        const post = await this.repo.getPost(a.blogId);
        if (post) byId.set(post.id, post);
      }
      for (const post of await this.repo.listPostsBySpace('course', filter.courseId)) byId.set(post.id, post);
      candidates = [...byId.values()];
    } else if (filter.cmid) {
      candidates = [];
      for (const a of await this.repo.listAssociationsForTarget('coursemodule', filter.cmid)) {
        const post = await this.repo.getPost(a.blogId);
        if (post) candidates.push(post);
      }
    } else if (filter.userId) {
      candidates = await this.repo.listPostsByUser(filter.userId);
    } else {
      candidates = await this.repo.listPosts();
    }
    const out: (BlogPostView & { associations: unknown; contextId: string | null })[] = [];
    for (const post of candidates) {
      if (await this.canView(post, viewerId)) {
        // contextId = the author's user context, so polymorphic consumers
        // (tags/comments/ratings) can address the post without guessing.
        const authorCtx = await this.contexts.getByLevelInstance(30, post.userId);
        out.push({ ...this.toView(post), associations: await this.repo.listAssociations(post.id), contextId: authorCtx?.id ?? null });
      }
    }
    return out;
  }

  private encodeFeedCursor(at: Date, id: string): string {
    return Buffer.from(JSON.stringify({ at: at.toISOString(), id }), 'utf8').toString('base64url');
  }

  private decodeFeedCursor(cursor: string): { at: Date; id: string } {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { at?: string; id?: string };
      const at = parsed.at ? new Date(parsed.at) : new Date(NaN);
      if (!parsed.id || Number.isNaN(at.getTime())) throw new Error('bad cursor');
      return { at, id: parsed.id };
    } catch {
      throw new BadRequestException({ message: 'Invalid feed cursor', code: 'blog.bad_cursor' });
    }
  }

  /**
   * Feed blog theo space (BL1): phân trang con trỏ trên mốc hiển thị
   * (published_at, lùi về created) + id; lọc kind/tag/status/space/tác
   * giả ở SQL rồi lọc audience bằng canView theo từng viewer — trang
   * kết quả chỉ chứa bài viewer được xem, con trỏ trỏ vào bài cuối
   * cùng đã xét nên không trùng/không sót qua các trang.
   */
  async feed(viewerId: string, query: {
    spaceType?: string; spaceId?: string; authorId?: string; kind?: string;
    status?: string; tag?: string; cursor?: string; limit?: number;
  }): Promise<BlogFeedResult> {
    if (query.spaceType !== undefined && !BLOG_SPACE_TYPES.includes(query.spaceType as BlogSpaceType)) {
      throw new BadRequestException({ message: `Unknown spaceType ${query.spaceType}`, code: 'blog.bad_space_type' });
    }
    if (query.kind !== undefined && !BLOG_KINDS.includes(query.kind as BlogKind)) {
      throw new BadRequestException({ message: `Unknown kind ${query.kind}`, code: 'blog.bad_kind' });
    }
    if (query.status !== undefined && !BLOG_STATUSES.includes(query.status as BlogStatus)) {
      throw new BadRequestException({ message: `Unknown status ${query.status}`, code: 'blog.bad_status' });
    }
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const tag = query.tag ? query.tag.trim().toLowerCase().replace(/\s+/g, ' ') : undefined;
    let cursor = query.cursor ? this.decodeFeedCursor(query.cursor) : undefined;
    const items: BlogPostRow[] = [];
    let nextCursor: string | null = null;
    let exhausted = false;
    // Quét ứng viên theo lô cho tới khi đủ một trang bài được xem hoặc
    // cạn ứng viên; mỗi lô bị chặn (limit*2, tối đa 100) để một viewer
    // bị lọc nhiều cũng không kéo vô hạn.
    for (let round = 0; round < 5 && items.length < limit; round += 1) {
      const batchSize = Math.min(Math.max((limit - items.length) * 2, 10), 100);
      const batch = await this.repo.listFeedCandidates({
        spaceType: query.spaceType, spaceId: query.spaceId, authorId: query.authorId,
        kind: query.kind, status: query.status, tag, cursor, limit: batchSize,
      });
      if (!batch.length) { exhausted = true; break; }
      let lastIncluded: BlogPostRow | null = null;
      for (const post of batch) {
        if (await this.canView(post, viewerId)) {
          items.push(post);
          lastIncluded = post;
          if (items.length >= limit) break;
        }
      }
      const lastExamined = batch[batch.length - 1]!;
      cursor = { at: lastExamined.publishedAt ?? lastExamined.created, id: lastExamined.id };
      if (items.length >= limit && lastIncluded) {
        nextCursor = this.encodeFeedCursor(lastIncluded.publishedAt ?? lastIncluded.created, lastIncluded.id);
        break;
      }
      if (batch.length < batchSize) { exhausted = true; break; }
      nextCursor = this.encodeFeedCursor(cursor.at, cursor.id);
    }
    if (exhausted && items.length < limit) nextCursor = null;
    const authors = await this.repo.listAuthorsByIds([...new Set(items.map((p) => p.userId))]);
    const authorById = new Map(authors.map((a) => [a.id, a]));
    const tagsByPost = new Map<string, string[]>();
    if (items.length) {
      const tagRows = await this.repo.listTagNamesForItems('core_blog', 'post', items.map((p) => p.id));
      for (const row of tagRows) {
        const list = tagsByPost.get(row.itemId) ?? [];
        list.push(row.rawName);
        tagsByPost.set(row.itemId, list);
      }
    }
    return {
      items: items.map((post) => {
        const author = authorById.get(post.userId);
        const displayName = author ? `${author.firstName} ${author.lastName}`.trim() || author.username : '';
        return {
          ...this.toView(post),
          author: { id: post.userId, displayName, username: author?.username ?? '' },
          tags: tagsByPost.get(post.id) ?? [],
        };
      }),
      nextCursor,
    };
  }

  /**
   * Cập nhật bài: state machine validate mọi chuyển trạng thái; đổi
   * space/kind chỉ khi bài chưa published; question_state chỉ với
   * kind='question'.
   */
  async updatePost(actorId: string, id: string, input: {
    subject?: string; summary?: string; content?: string; publishState?: string;
    spaceType?: string; spaceId?: string | null; kind?: string; status?: string;
    commentsPolicy?: string; questionState?: string | null;
    scheduledAt?: string | null; pinnedUntil?: string | null;
  }): Promise<BlogPostView> {
    const post = await this.getPost(id);
    if (post.userId !== actorId) {
      const userCtx = await this.contexts.getByLevelInstance(30, post.userId);
      const canManage = userCtx ? await this.evaluator.hasCapability(actorId, 'blog:manageentries', userCtx.id) : false;
      if (!canManage) throw new ForbiddenException({ message: 'Only the author can edit this post', code: 'blog.edit_forbidden' });
    }
    const currentStatus = post.status as BlogStatus;
    if (currentStatus === 'deleted') {
      throw new ForbiddenException({ message: 'A deleted post cannot be edited', code: 'blog.deleted' });
    }
    const patch: Partial<BlogPostRow> = {};
    if (input.subject !== undefined) patch.subject = input.subject;
    if (input.summary !== undefined) patch.summary = input.summary;
    if (input.content !== undefined) patch.content = input.content;
    if (input.commentsPolicy !== undefined) {
      if (!BLOG_COMMENTS_POLICIES.includes(input.commentsPolicy as never)) {
        throw new BadRequestException({ message: `Unknown commentsPolicy ${input.commentsPolicy}`, code: 'blog.bad_comments_policy' });
      }
      patch.commentsPolicy = input.commentsPolicy;
    }

    const wantsSpaceChange =
      (input.spaceType !== undefined && input.spaceType !== post.spaceType) ||
      (input.spaceId !== undefined && (input.spaceId ?? null) !== (post.spaceId ?? null));
    if (wantsSpaceChange) {
      if (currentStatus !== 'draft' && currentStatus !== 'pending_review') {
        throw new BadRequestException({ message: 'Space cannot change after the post is published; use a placement instead', code: 'blog.space_locked' });
      }
      const spaceType = (input.spaceType ?? post.spaceType) as BlogSpaceType;
      if (!BLOG_SPACE_TYPES.includes(spaceType)) {
        throw new BadRequestException({ message: `Unknown spaceType ${input.spaceType}`, code: 'blog.bad_space_type' });
      }
      const space = await this.resolveSpace(actorId, post.userId, spaceType, input.spaceId ?? post.spaceId);
      patch.spaceType = space.spaceType;
      patch.spaceId = space.spaceId;
    }

    let nextKind = post.kind as BlogKind;
    if (input.kind !== undefined && input.kind !== post.kind) {
      if (!BLOG_KINDS.includes(input.kind as BlogKind)) {
        throw new BadRequestException({ message: `Unknown kind ${input.kind}`, code: 'blog.bad_kind' });
      }
      if (currentStatus !== 'draft' && currentStatus !== 'pending_review') {
        throw new BadRequestException({ message: 'Kind cannot change after the post is published', code: 'blog.kind_locked' });
      }
      nextKind = input.kind as BlogKind;
      patch.kind = nextKind;
      if (nextKind !== 'question') patch.questionState = null;
      else if (!post.questionState) patch.questionState = 'open';
    }
    if (input.questionState !== undefined) {
      if (nextKind !== 'question') {
        throw new BadRequestException({ message: 'questionState only applies to kind=question posts', code: 'blog.question_state_kind' });
      }
      if (input.questionState !== null && !BLOG_QUESTION_STATES.includes(input.questionState as never)) {
        throw new BadRequestException({ message: `Unknown questionState ${input.questionState}`, code: 'blog.bad_question_state' });
      }
      patch.questionState = input.questionState;
    }
    if (input.scheduledAt !== undefined) {
      patch.scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
    }
    if (input.pinnedUntil !== undefined) {
      patch.pinnedUntil = input.pinnedUntil ? new Date(input.pinnedUntil) : null;
    }

    const targetStatus = (input.status ?? (input.publishState ? statusFromLegacyPublishState(input.publishState) : undefined)) as BlogStatus | undefined;
    if (targetStatus !== undefined) {
      if (!BLOG_STATUSES.includes(targetStatus)) {
        throw new BadRequestException({ message: `Unknown status ${input.status}`, code: 'blog.bad_status' });
      }
      if (!canTransitionBlogStatus(currentStatus, targetStatus)) {
        throw new BadRequestException({ message: `Invalid blog status transition ${currentStatus} -> ${targetStatus}`, code: 'blog.bad_transition' });
      }
      const effectiveScheduledAt = patch.scheduledAt !== undefined ? patch.scheduledAt : post.scheduledAt;
      if (targetStatus === 'published' && effectiveScheduledAt && effectiveScheduledAt.getTime() > Date.now()) {
        throw new BadRequestException({ message: 'A post scheduled in the future cannot be published yet', code: 'blog.scheduled_in_future' });
      }
      patch.status = targetStatus;
      if (targetStatus === 'published' && !post.publishedAt) patch.publishedAt = new Date();
      if (targetStatus === 'deleted') {
        patch.deletedAt = new Date();
        patch.deletedBy = actorId;
      }
    }
    const effectiveSpaceType = (patch.spaceType ?? post.spaceType) as BlogSpaceType;
    const effectiveStatus = (patch.status ?? currentStatus) as BlogStatus;
    patch.audience = deriveBlogAudience(effectiveSpaceType, effectiveStatus);
    patch.publishState = legacyPublishState(effectiveStatus);
    await this.repo.updatePost(id, patch);
    return this.toView(await this.getPost(id));
  }

  /**
   * Xoá bài của chính mình — xoá MỀM từ BL1 (status='deleted' + dấu
   * vết); bản ghi còn lại cho kiểm toán/privacy, nội dung không qua
   * được cổng xem của bất kỳ ai ngoài tác giả và site admin.
   */
  async deletePost(actorId: string, id: string): Promise<{ deleted: boolean }> {
    const post = await this.getPost(id);
    if (post.userId !== actorId) {
      const userCtx = await this.contexts.getByLevelInstance(30, post.userId);
      const canManage = userCtx ? await this.evaluator.hasCapability(actorId, 'blog:manageentries', userCtx.id) : false;
      if (!canManage) throw new ForbiddenException({ message: 'Only the author can delete this post', code: 'blog.delete_forbidden' });
    }
    await this.repo.softDeletePost(id, actorId);
    return { deleted: true };
  }
}

import { ForbiddenException, Injectable } from '@nestjs/common';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CoursesService } from '../courses/courses.service';
import { mapLegacyBlogPost } from './blog-migration';
import { legacyPublishState, type BlogStatus } from './blog-state';
import { SocialRepository } from './social.repository';

/**
 * Chạy backfill di trú blog cũ → mô hình space của BL1 (issue #87)
 * theo ánh xạ thuần ở blog-migration.ts. Idempotent: ứng viên là các
 * bài còn ở default fail-closed (space_type='user', space_id null);
 * sau khi xử lý mọi bài đều rời khỏi tập ứng viên. Trả thống kê để
 * người vận hành/đội review đối chiếu — đặc biệt số bài fail-closed.
 */
@Injectable()
export class BlogMigrationService {
  constructor(
    private readonly repo: SocialRepository,
    private readonly courses: CoursesService,
    private readonly evaluator: PermissionEvaluator,
  ) {}

  /** Đường vận hành: chỉ site admin mới được chạy backfill di trú. */
  async runAsAdmin(actorId: string): Promise<{ migrated: number; placements: number; failClosed: number }> {
    if (!(await this.evaluator.isSiteAdmin(actorId))) {
      throw new ForbiddenException({ message: 'Only a site admin can run the blog space migration', code: 'blog.migration_forbidden' });
    }
    return this.backfillSpaceModel();
  }

  async backfillSpaceModel(): Promise<{ migrated: number; placements: number; failClosed: number }> {
    const posts = await this.repo.listPostsNeedingSpaceMigration();
    const moduleCourse = new Map<string, string | null>();
    const resolveModuleCourse = (moduleId: string): string | null => {
      // Phân giải đồng bộ từ cache đã nạp ở vòng lặp bên dưới; module
      // chưa từng được nạp (không có trong cache) coi như không phân
      // giải được — nhưng vòng lặp luôn nạp trước khi gọi mapper.
      return moduleCourse.get(moduleId) ?? null;
    };
    let placements = 0;
    let failClosed = 0;
    for (const post of posts) {
      const associations = [...(await this.repo.listAssociations(post.id))]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const assoc of associations) {
        if (assoc.assocType === 'coursemodule' && !moduleCourse.has(assoc.assocId)) {
          try {
            const cm = await this.courses.getCm(assoc.assocId);
            moduleCourse.set(assoc.assocId, cm.course);
          } catch {
            moduleCourse.set(assoc.assocId, null);
          }
        }
      }
      const outcome = mapLegacyBlogPost(post, associations, resolveModuleCourse);
      await this.repo.updatePost(post.id, {
        spaceType: outcome.spaceType,
        spaceId: outcome.spaceId,
        status: outcome.status,
        audience: outcome.audience,
        publishState: legacyPublishState(outcome.status as BlogStatus),
        publishedAt: outcome.status === 'published' ? post.created : null,
      });
      if (outcome.failClosed) failClosed += 1;
      for (const courseId of outcome.placementCourseIds) {
        await this.repo.insertPlacement({
          postId: post.id, spaceType: 'course', spaceId: courseId,
          contextId: await this.courses.courseContextId(courseId),
          status: 'approved', createdBy: post.userId,
        });
        placements += 1;
      }
    }
    return { migrated: posts.length, placements, failClosed };
  }
}

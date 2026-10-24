import { BadRequestException, Injectable } from '@nestjs/common';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CoursesService } from '../courses/courses.service';
import { GradesService } from '../grades/grades.service';
import { BlogService } from './blog.service';
import { SocialRepository, type RatingRow } from './social.repository';

export interface RatingAggregate {
  component: string;
  ratingArea: string;
  itemId: string;
  count: number;
  average: number | null;
  sum: number;
  min: number | null;
  max: number | null;
}

/**
 * RatingsModule (Moodle core_rating): polymorphic ratings over
 * (component, ratingArea, itemId, contextId) against a SCALE. Aggregation
 * (average/count/sum/min/max) is computed over the ratings OF THIS ITEM
 * only (oracle: rating/tests/rating_test test_get_ratings_sql — items with
 * ratings 1,3 aggregate to 2; 1,4 to 2.5; 3,5 to 4). Capabilities:
 * rating:rate to rate, rating:view for aggregates, rating:viewall
 * for the individual rating list — three separate gates, as in Moodle.
 */
@Injectable()
/**
 * Đánh giá sao (ratings) cho item: mỗi user một rating, tổng hợp trả average + count.
 * Đối chiếu Moodle: lib/rating (rating_manager).
 */
export class RatingsService {
  constructor(
    private readonly repo: SocialRepository,
    private readonly evaluator: PermissionEvaluator,
    private readonly grades: GradesService,
    private readonly contexts: ContextsService,
    private readonly courses: CoursesService,
    private readonly blog: BlogService,
  ) {}

  /**
   * Vật chủ là bài blog (component 'core_blog') thì rating THỪA HƯỞNG
   * audience của bài (issue #48): không xem được bài → 404 cho cả chấm,
   * tổng hợp và danh sách. Component khác không đổi.
   */
  private async assertBlogAudience(component: string, itemId: string, viewerId: string): Promise<void> {
    if (component === 'core_blog') await this.blog.assertCanViewPost(itemId, viewerId);
  }

  /** Course/module contexts additionally require real course access (enrolled or staff). */
  private async assertItemAccess(actorId: string, contextId: string): Promise<void> {
    const ctx = await this.contexts.getContext(contextId).catch(() => undefined);
    if (!ctx) return;
    if (ctx.contextLevel === 50) await this.courses.assertCourseAccess(actorId, ctx.instanceId!);
    if (ctx.contextLevel === 70) {
      const cm = await this.courses.getCm(ctx.instanceId!);
      await this.courses.assertCourseAccess(actorId, cm.course);
    }
  }

  /**
   * Kích thước thang cho scaleId mã hoá signed kiểu Moodle: giá trị tuyệt đối
   * là điểm tối đa (scaleId không phải khoá thực thể — xem ADR-013).
   */
  private async scaleMax(scaleId: number): Promise<number> {
    return Math.abs(scaleId);
  }

  /**
   * Đặt/cập nhật rating của user cho item.
   */
  async rate(actorId: string, input: {
    contextId: string; component: string; ratingArea: string; itemId: string; scaleId: number; rating: number;
  }): Promise<RatingRow> {
    await this.assertBlogAudience(input.component, input.itemId, actorId);
    await this.evaluator.requireCapability(actorId, 'rating:rate', input.contextId);
    await this.assertItemAccess(actorId, input.contextId);
    const max = await this.scaleMax(input.scaleId);
    if (!Number.isInteger(input.rating) || input.rating < 0 || (max > 0 && input.rating > max)) {
      throw new BadRequestException({
        message: `Rating ${input.rating} is outside the scale (0..${max})`,
        code: 'ratings.outside_scale',
      });
    }
    return this.repo.upsertRating({
      contextId: input.contextId, component: input.component, ratingArea: input.ratingArea,
      itemId: input.itemId, scaleId: input.scaleId, rating: input.rating, userId: actorId,
    });
  }

  /**
   * Tổng hợp average + count của item.
   */
  async aggregate(viewerId: string, input: {
    contextId: string; component: string; ratingArea: string; itemId: string;
  }): Promise<RatingAggregate> {
    await this.assertBlogAudience(input.component, input.itemId, viewerId);
    await this.evaluator.requireCapability(viewerId, 'rating:view', input.contextId);
    await this.assertItemAccess(viewerId, input.contextId);
    const rows = await this.repo.listRatings(input.component, input.ratingArea, input.itemId, input.contextId);
    const values = rows.map((r) => r.rating);
    const sum = values.reduce((a, b) => a + b, 0);
    return {
      component: input.component, ratingArea: input.ratingArea, itemId: input.itemId,
      count: rows.length,
      average: rows.length ? sum / rows.length : null,
      sum,
      min: rows.length ? Math.min(...values) : null,
      max: rows.length ? Math.max(...values) : null,
    };
  }

  /**
   * Danh sách rating của item.
   */
  async listRatings(viewerId: string, input: {
    contextId: string; component: string; ratingArea: string; itemId: string;
  }): Promise<RatingRow[]> {
    await this.assertBlogAudience(input.component, input.itemId, viewerId);
    await this.evaluator.requireCapability(viewerId, 'rating:viewall', input.contextId);
    await this.assertItemAccess(viewerId, input.contextId);
    return this.repo.listRatings(input.component, input.ratingArea, input.itemId, input.contextId);
  }
}

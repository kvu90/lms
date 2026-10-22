import { BadRequestException, Injectable } from '@nestjs/common';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CoursesService } from '../courses/courses.service';
import { GradesService } from '../grades/grades.service';
import { SocialRepository, type RatingRow } from './social.repository';

export interface RatingAggregate {
  component: string;
  ratingarea: string;
  itemid: string;
  count: number;
  average: number | null;
  sum: number;
  min: number | null;
  max: number | null;
}

/**
 * RatingsModule (Moodle core_rating): polymorphic ratings over
 * (component, ratingarea, itemid, contextid) against a SCALE. Aggregation
 * (average/count/sum/min/max) is computed over the ratings OF THIS ITEM
 * only (oracle: rating/tests/rating_test test_get_ratings_sql — items with
 * ratings 1,3 aggregate to 2; 1,4 to 2.5; 3,5 to 4). Capabilities:
 * lms/rating:rate to rate, lms/rating:view for aggregates, lms/rating:viewall
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
  ) {}

  /** Course/module contexts additionally require real course access (enrolled or staff). */
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
   * Kích thước thang cho scaleid mã hoá signed kiểu Moodle: giá trị tuyệt đối
   * là điểm tối đa (scaleid không phải khoá thực thể — xem ADR-013).
   */
  private async scaleMax(scaleid: number): Promise<number> {
    return Math.abs(scaleid);
  }

  /**
   * Đặt/cập nhật rating của user cho item.
   */
  async rate(actorId: string, input: {
    contextid: string; component: string; ratingarea: string; itemid: string; scaleid: number; rating: number;
  }): Promise<RatingRow> {
    await this.evaluator.requireCapability(actorId, 'lms/rating:rate', input.contextid);
    await this.assertItemAccess(actorId, input.contextid);
    const max = await this.scaleMax(input.scaleid);
    if (!Number.isInteger(input.rating) || input.rating < 0 || (max > 0 && input.rating > max)) {
      throw new BadRequestException({
        message: `Rating ${input.rating} is outside the scale (0..${max})`,
        code: 'ratings.outside_scale',
      });
    }
    return this.repo.upsertRating({
      contextid: input.contextid, component: input.component, ratingarea: input.ratingarea,
      itemid: input.itemid, scaleid: input.scaleid, rating: input.rating, userid: actorId,
    });
  }

  /**
   * Tổng hợp average + count của item.
   */
  async aggregate(viewerId: string, input: {
    contextid: string; component: string; ratingarea: string; itemid: string;
  }): Promise<RatingAggregate> {
    await this.evaluator.requireCapability(viewerId, 'lms/rating:view', input.contextid);
    await this.assertItemAccess(viewerId, input.contextid);
    const rows = await this.repo.listRatings(input.component, input.ratingarea, input.itemid, input.contextid);
    const values = rows.map((r) => r.rating);
    const sum = values.reduce((a, b) => a + b, 0);
    return {
      component: input.component, ratingarea: input.ratingarea, itemid: input.itemid,
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
    contextid: string; component: string; ratingarea: string; itemid: string;
  }): Promise<RatingRow[]> {
    await this.evaluator.requireCapability(viewerId, 'lms/rating:viewall', input.contextid);
    await this.assertItemAccess(viewerId, input.contextid);
    return this.repo.listRatings(input.component, input.ratingarea, input.itemid, input.contextid);
  }
}

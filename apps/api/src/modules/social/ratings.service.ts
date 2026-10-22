import { BadRequestException, Injectable } from '@nestjs/common';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CoursesService } from '../courses/courses.service';
import { GradesService } from '../grades/grades.service';
import { SocialRepository, type RatingRow } from './social.repository';

export interface RatingAggregate {
  component: string;
  ratingarea: string;
  itemid: number;
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
export class RatingsService {
  constructor(
    private readonly repo: SocialRepository,
    private readonly evaluator: PermissionEvaluator,
    private readonly grades: GradesService,
    private readonly contexts: ContextsService,
    private readonly courses: CoursesService,
  ) {}

  /** Course/module contexts additionally require real course access (enrolled or staff). */
  private async assertItemAccess(actorId: number, contextid: number): Promise<void> {
    const ctx = await this.contexts.getContext(contextid).catch(() => undefined);
    if (!ctx) return;
    if (ctx.contextlevel === 50) await this.courses.assertCourseAccess(actorId, ctx.instanceid);
    if (ctx.contextlevel === 70) {
      const cm = await this.courses.getCm(ctx.instanceid);
      await this.courses.assertCourseAccess(actorId, cm.course);
    }
  }

  /** Scale size for a scaleid: from the GradesModule scale registry (site scales), else the id itself is the max. */
  private async scaleMax(scaleid: number): Promise<number> {
    if (scaleid > 0) {
      const siteScales = await this.grades.listScales(0).catch(() => []);
      const scale = siteScales.find((s) => s.id === scaleid);
      if (scale) return scale.scale.split(',').length;
    }
    return Math.abs(scaleid);
  }

  async rate(actorId: number, input: {
    contextid: number; component: string; ratingarea: string; itemid: number; scaleid: number; rating: number;
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

  async aggregate(viewerId: number, input: {
    contextid: number; component: string; ratingarea: string; itemid: number;
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

  async listRatings(viewerId: number, input: {
    contextid: number; component: string; ratingarea: string; itemid: number;
  }): Promise<RatingRow[]> {
    await this.evaluator.requireCapability(viewerId, 'lms/rating:viewall', input.contextid);
    await this.assertItemAccess(viewerId, input.contextid);
    return this.repo.listRatings(input.component, input.ratingarea, input.itemid, input.contextid);
  }
}

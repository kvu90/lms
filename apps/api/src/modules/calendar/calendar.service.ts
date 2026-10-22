import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { OutboxService } from '../../infra/events/outbox.service';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CoursesService } from '../courses/courses.service';
import { EnrolService } from '../enrol/enrol.service';
import { GroupsService } from '../groups/groups.service';
import { CalendarRepository, type CalendarEventRow, type CalendarSubscriptionRow } from './calendar.repository';
import { formatRrule, occurrenceStarts, parseRrule } from './domain/rrule';

export const CALENDAR_REMINDER_QUEUE = 'calendar-reminders';
export const CALENDAR_IMPORT_QUEUE = 'calendar-import';
export const EVENT_TYPES = ['site', 'category', 'course', 'group', 'user'] as const;
export type CalendarEventType = (typeof EVENT_TYPES)[number];

export interface CreateEventInput {
  name: string;
  description?: string;
  eventtype: CalendarEventType;
  courseid?: number;
  groupid?: number;
  categoryid?: number;
  timestart: string;
  timeduration?: number;
  location?: string;
  repeat?: { freq: string; count?: number; until?: string };
}

/**
 * CalendarModule facade (Moodle core_calendar):
 *  - The event TYPE decides who can see it, via the context tree:
 *    site → everyone; category → users of courses in the category;
 *    course → active enrolments (+ staff with a real course:view path);
 *    group → course viewers who are group members (or accessallgroups);
 *    user → only the owner.
 *  - A repeating event is a SERIES: occurrence rows share repeatid with the
 *    root, the root carries the RRULE, and an exception row replaces its
 *    occurrence in listings.
 *  - Subscriptions hold external ICS data; importing is a worker job.
 *  - Reminders are BullMQ DELAYED jobs on 'calendar-reminders'; the worker
 *    turns them into MessagingModule notifications (calendar_reminder
 *    provider) at fire time.
 */
@Injectable()
export class CalendarService {
  constructor(
    private readonly repo: CalendarRepository,
    private readonly courses: CoursesService,
    private readonly enrol: EnrolService,
    private readonly groups: GroupsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly contexts: ContextsService,
    private readonly outbox: OutboxService,
    @InjectQueue(CALENDAR_REMINDER_QUEUE) private readonly reminderQueue: Queue,
    @InjectQueue(CALENDAR_IMPORT_QUEUE) private readonly importQueue: Queue,
  ) {}

  private async systemCtx(): Promise<number> {
    return (await this.contexts.ensureSystemContext()).id;
  }

  /** The context an event is managed in, by type. */
  private async manageContextId(input: { eventtype: string; courseid?: number; categoryid?: number; userid?: number }): Promise<number> {
    switch (input.eventtype) {
      case 'course':
      case 'group':
        return this.courses.courseContextId(input.courseid!);
      case 'category':
        return this.courses.categoryContextId(input.categoryid!);
      case 'user':
        return (await this.contexts.getByLevelInstance(30, input.userid!))?.id ?? this.systemCtx();
      default:
        return this.systemCtx();
    }
  }

  private async requireManage(actorId: number, input: { eventtype: string; courseid?: number; categoryid?: number; userid?: number }): Promise<void> {
    if (input.eventtype === 'user') {
      if (input.userid !== undefined && input.userid !== actorId) {
        // Managing someone else's personal events needs site-level manageentries.
        await this.evaluator.requireCapability(actorId, 'moodle/calendar:manageentries', await this.systemCtx());
        return;
      }
      const ctx = await this.manageContextId({ ...input, userid: actorId });
      await this.evaluator.requireCapability(actorId, 'moodle/calendar:manageownentries', ctx);
      return;
    }
    const capability = input.eventtype === 'group' ? 'moodle/calendar:managegroupentries' : 'moodle/calendar:manageentries';
    await this.evaluator.requireCapability(actorId, capability, await this.manageContextId(input));
  }

  async createEvent(actorId: number, input: CreateEventInput): Promise<{ event: CalendarEventRow; occurrences: CalendarEventRow[] }> {
    if (!EVENT_TYPES.includes(input.eventtype)) {
      throw new BadRequestException({ message: `Unknown event type ${input.eventtype}`, code: 'calendar.bad_type' });
    }
    if (input.eventtype === 'course' && !input.courseid) throw new BadRequestException({ message: 'Course events require courseid', code: 'calendar.course_required' });
    if (input.eventtype === 'group' && (!input.courseid || !input.groupid)) throw new BadRequestException({ message: 'Group events require courseid and groupid', code: 'calendar.group_required' });
    if (input.eventtype === 'category' && !input.categoryid) throw new BadRequestException({ message: 'Category events require categoryid', code: 'calendar.category_required' });
    if (input.eventtype === 'group') {
      const group = await this.groups.getGroup(input.groupid!);
      if (group.courseid !== input.courseid) throw new BadRequestException({ message: 'Group belongs to another course', code: 'calendar.group_course_mismatch' });
    }
    const owner = input.eventtype === 'user' ? actorId : 0;
    await this.requireManage(actorId, { eventtype: input.eventtype, courseid: input.courseid, categoryid: input.categoryid, userid: owner });
    const contextId = await this.manageContextId({ eventtype: input.eventtype, courseid: input.courseid, categoryid: input.categoryid, userid: owner });
    const start = new Date(input.timestart);
    if (Number.isNaN(start.getTime())) throw new BadRequestException({ message: 'Invalid timestart', code: 'calendar.bad_time' });

    const base = {
      name: input.name, description: input.description ?? '', eventtype: input.eventtype,
      courseid: input.courseid ?? 0, groupid: input.groupid ?? 0, categoryid: input.categoryid ?? 0,
      userid: owner, contextid: contextId, timeduration: input.timeduration ?? 0,
      location: input.location ?? '', visible: true,
    };
    if (!input.repeat) {
      const event = await this.repo.insertEvent({ ...base, timestart: start });
      await this.outbox.enqueueStandalone({ aggregate: 'calendar', type: 'calendar_event_created', payload: { eventId: event.id, eventtype: event.eventtype } });
      return { event, occurrences: [event] };
    }
    const spec = parseRrule(input.repeat);
    const starts = occurrenceStarts(start, spec);
    const occurrences: CalendarEventRow[] = [];
    let root: CalendarEventRow | undefined;
    await this.repo.dbHandle.transaction(async (tx) => {
      root = await this.repo.insertEvent({ ...base, timestart: starts[0]!, rrule: formatRrule(spec), repeatid: 0 }, tx as never);
      await this.repo.updateEvent(root.id, { repeatid: root.id }, tx as never);
      root = { ...root, repeatid: root.id };
      occurrences.push(root);
      for (const s of starts.slice(1)) {
        occurrences.push(await this.repo.insertEvent({ ...base, timestart: s, repeatid: root.id }, tx as never));
      }
      await this.outbox.enqueue(tx as never, { aggregate: 'calendar', type: 'calendar_event_created', payload: { eventId: root.id, eventtype: input.eventtype, series: true, count: starts.length } });
    });
    return { event: root!, occurrences };
  }

  async getEvent(id: number): Promise<CalendarEventRow> {
    const row = await this.repo.getEvent(id);
    if (!row) throw new NotFoundException({ message: `Calendar event ${id} not found`, code: 'calendar.event_not_found' });
    return row;
  }

  /** Create an exception: a replacement occurrence for one series instance. */
  async createException(actorId: number, occurrenceId: number, input: { name?: string; timestart: string; description?: string }): Promise<CalendarEventRow> {
    const occurrence = await this.getEvent(occurrenceId);
    if (!occurrence.repeatid) throw new BadRequestException({ message: 'Only a series occurrence can have an exception', code: 'calendar.not_series' });
    await this.requireManage(actorId, { eventtype: occurrence.eventtype, courseid: occurrence.courseid || undefined, categoryid: occurrence.categoryid || undefined, userid: occurrence.userid || undefined });
    const exception = await this.repo.insertEvent({
      name: input.name ?? occurrence.name, description: input.description ?? occurrence.description,
      eventtype: occurrence.eventtype, courseid: occurrence.courseid, groupid: occurrence.groupid,
      categoryid: occurrence.categoryid, userid: occurrence.userid, contextid: occurrence.contextid,
      timestart: new Date(input.timestart), timeduration: occurrence.timeduration,
      repeatid: occurrence.repeatid, isexception: true, exceptionof: occurrence.id, location: occurrence.location,
    });
    return exception;
  }

  async deleteEvent(actorId: number, id: number): Promise<{ deleted: boolean; seriesDeleted: number }> {
    const event = await this.getEvent(id);
    await this.requireManage(actorId, { eventtype: event.eventtype, courseid: event.courseid || undefined, categoryid: event.categoryid || undefined, userid: event.userid || undefined });
    let count = 1;
    if (event.repeatid && event.id === event.repeatid) {
      // Deleting the root deletes the whole series (Moodle semantics).
      const series = await this.repo.listSeries(event.repeatid);
      for (const row of series) { await this.repo.deleteEvent(row.id); count = series.length; }
    } else {
      await this.repo.deleteEvent(id);
    }
    return { deleted: true, seriesDeleted: count };
  }

  // --- visibility --------------------------------------------------------------

  private async canViewCoursePart(viewerId: number, courseId: number): Promise<boolean> {
    if (await this.evaluator.isSiteAdmin(viewerId)) return true;
    if (await this.enrol.isEnrolled(courseId, viewerId, { onlyActive: true })) return true;
    const ctx = await this.courses.courseContextId(courseId);
    return this.evaluator.hasCapabilityFromRealAssignment(viewerId, 'moodle/course:view', ctx, { excludeArchetypes: ['student'] });
  }

  async isVisibleTo(event: CalendarEventRow, viewerId: number): Promise<boolean> {
    if (!event.visible) {
      // Hidden events are visible only to their managers.
      return this.requireManage(viewerId, { eventtype: event.eventtype, courseid: event.courseid || undefined, categoryid: event.categoryid || undefined, userid: event.userid || undefined }).then(() => true).catch(() => false);
    }
    switch (event.eventtype) {
      case 'site':
        return true;
      case 'user':
        return event.userid === viewerId;
      case 'category': {
        if (await this.evaluator.isSiteAdmin(viewerId)) return true;
        const courses = await this.courses.listCourses(event.categoryid);
        for (const c of courses) {
          if (await this.canViewCoursePart(viewerId, c.id)) return true;
        }
        const ctx = await this.courses.categoryContextId(event.categoryid);
        return this.evaluator.hasCapability(viewerId, 'moodle/calendar:manageentries', ctx);
      }
      case 'course':
        return this.canViewCoursePart(viewerId, event.courseid);
      case 'group': {
        if (!(await this.canViewCoursePart(viewerId, event.courseid))) return false;
        if (await this.groups.isMember(event.groupid, viewerId)) return true;
        const ctx = await this.courses.courseContextId(event.courseid);
        return this.evaluator.hasCapability(viewerId, 'moodle/group:accessallgroups', ctx);
      }
      default:
        return false;
    }
  }

  /** Events visible to the viewer in [from, to]; exception rows replace their occurrence. */
  async listEventsForUser(viewerId: number, filter: { from?: string; to?: string; eventtype?: string }): Promise<CalendarEventRow[]> {
    const from = filter.from ? new Date(filter.from) : new Date(Date.now() - 31 * 86400_000);
    const to = filter.to ? new Date(filter.to) : new Date(Date.now() + 62 * 86400_000);
    const rows = await this.repo.listEventsInRange(from, to);
    const exceptedIds = new Set(rows.filter((r) => r.isexception).map((r) => r.exceptionof));
    const visible: CalendarEventRow[] = [];
    for (const row of rows) {
      if (row.isexception === false && row.exceptionof === null && exceptedIds.has(row.id)) continue; // replaced by its exception
      if (filter.eventtype && row.eventtype !== filter.eventtype) continue;
      if (await this.isVisibleTo(row, viewerId)) visible.push(row);
    }
    return visible;
  }

  // --- reminders -----------------------------------------------------------------

  /** Schedule a reminder: a BullMQ delayed job; the worker notifies at fire time. */
  async scheduleReminder(actorId: number, eventId: number, minutesBefore: number): Promise<{ eventId: number; userId: number; remindAt: string; delayMs: number }> {
    const event = await this.getEvent(eventId);
    if (!(await this.isVisibleTo(event, actorId))) {
      throw new ForbiddenException({ message: 'You cannot set a reminder for an event you cannot see', code: 'calendar.reminder_forbidden' });
    }
    const remindAt = new Date(event.timestart.getTime() - minutesBefore * 60_000);
    const delayMs = Math.max(0, remindAt.getTime() - Date.now());
    await this.reminderQueue.add('remind', { eventId, userId: actorId, minutesBefore }, {
      jobId: `cal-reminder-${eventId}-${actorId}-${minutesBefore}`,
      delay: delayMs, attempts: 3, removeOnComplete: true,
    });
    return { eventId, userId: actorId, remindAt: remindAt.toISOString(), delayMs };
  }

  // --- subscriptions ----------------------------------------------------------------

  async createSubscription(actorId: number, input: { name: string; url?: string; icsdata?: string; eventtype?: string; courseid?: number; categoryid?: number; pollinterval?: number }): Promise<CalendarSubscriptionRow> {
    const eventtype = input.eventtype ?? 'site';
    if (eventtype === 'site') {
      await this.evaluator.requireCapability(actorId, 'moodle/calendar:managesubscriptions', await this.systemCtx());
    } else if (eventtype === 'course' && input.courseid) {
      await this.evaluator.requireCapability(actorId, 'moodle/calendar:manageentries', await this.courses.courseContextId(input.courseid));
    }
    const subscription = await this.repo.insertSubscription({
      name: input.name, url: input.url ?? null, icsdata: input.icsdata ?? null,
      eventtype, courseid: input.courseid ?? 0, categoryid: input.categoryid ?? 0,
      userid: actorId, pollinterval: input.pollinterval ?? 604800,
    });
    if (subscription.icsdata) {
      await this.importQueue.add('import', { subscriptionId: subscription.id }, { jobId: `cal-import-${subscription.id}`, attempts: 3 });
    }
    return subscription;
  }

  async listSubscriptions(): Promise<CalendarSubscriptionRow[]> {
    return this.repo.listSubscriptions();
  }

  async requestImport(actorId: number, subscriptionId: number): Promise<{ queued: boolean; subscriptionId: number }> {
    const sub = await this.repo.getSubscription(subscriptionId);
    if (!sub) throw new NotFoundException({ message: `Subscription ${subscriptionId} not found`, code: 'calendar.subscription_not_found' });
    await this.evaluator.requireCapability(actorId, 'moodle/calendar:managesubscriptions', await this.systemCtx());
    await this.importQueue.add('import', { subscriptionId }, { jobId: `cal-import-${subscriptionId}-${Date.now()}`, attempts: 3 });
    return { queued: true, subscriptionId };
  }
}

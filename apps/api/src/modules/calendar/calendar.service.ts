import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { createHash, randomBytes } from 'node:crypto';
import { OutboxService } from '../../infra/events/outbox.service';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CoursesService } from '../courses/courses.service';
import { EnrolService } from '../enrol/enrol.service';
import { GroupsService } from '../groups/groups.service';
import { CalendarRepository, type CalendarEventRow, type CalendarExportTokenRow, type CalendarSubscriptionRow } from './calendar.repository';
import { serializeCalendar } from './domain/ics';
import { formatRrule, occurrenceStarts, parseRrule } from './domain/rrule';

/** Băm token xuất lịch để lưu trữ — token thô chỉ trả về đúng một lần khi tạo/đổi (đúng mẫu webservice tokens). */
function hashExportToken(raw: string): string { return createHash('sha256').update(raw).digest('hex'); }

export const CALENDAR_REMINDER_QUEUE = 'calendar-reminders';
export const CALENDAR_IMPORT_QUEUE = 'calendar-import';
export const EVENT_TYPES = ['site', 'category', 'course', 'group', 'user'] as const;
export type CalendarEventType = (typeof EVENT_TYPES)[number];

export interface CreateEventInput {
  name: string;
  description?: string;
  eventtype: CalendarEventType;
  courseid?: string;
  groupid?: string;
  categoryid?: string;
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
/**
 * Nghiệp vụ lịch: sự kiện theo phạm vi (site/category/course/group/user), chuỗi lặp RRULE và exception từng occurrence.
 * Đối chiếu Moodle: calendar/classes (calendar_event) và lib.php của calendar.
 * Nguyên tắc hiển thị: user chỉ thấy sự kiện thuộc các phạm vi mình liên quan (khoá học đã enrol, nhóm của mình, sự kiện cá nhân/site);
 * exception thay thế occurrence tương ứng của chuỗi thay vì tạo sự kiện độc lập.
 */
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

  private async systemCtx(): Promise<string> {
    return (await this.contexts.ensureSystemContext()).id;
  }

  /** The context an event is managed in, by type. */
  private async manageContextId(input: { eventtype: string; courseid?: string; categoryid?: string; userid?: string }): Promise<string> {
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

  private async requireManage(actorId: string, input: { eventtype: string; courseid?: string; categoryid?: string; userid?: string }): Promise<void> {
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

  /**
   * Tạo sự kiện (có thể kèm RRULE) tại một phạm vi.
   */
  async createEvent(actorId: string, input: CreateEventInput): Promise<{ event: CalendarEventRow; occurrences: CalendarEventRow[] }> {
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
    const owner = input.eventtype === 'user' ? actorId : undefined;
    await this.requireManage(actorId, { eventtype: input.eventtype, courseid: input.courseid, categoryid: input.categoryid, userid: owner });
    const contextId = await this.manageContextId({ eventtype: input.eventtype, courseid: input.courseid, categoryid: input.categoryid, userid: owner });
    const start = new Date(input.timestart);
    if (Number.isNaN(start.getTime())) throw new BadRequestException({ message: 'Invalid timestart', code: 'calendar.bad_time' });

    const base = {
      name: input.name, description: input.description ?? '', eventtype: input.eventtype,
      courseid: input.courseid ?? null, groupid: input.groupid ?? null, categoryid: input.categoryid ?? null,
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
      root = await this.repo.insertEvent({ ...base, timestart: starts[0]!, rrule: formatRrule(spec), repeatid: null }, tx as never);
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

  /**
   * Lấy sự kiện; ném calendar.event_not_found khi vắng.
   */
  async getEvent(id: string): Promise<CalendarEventRow> {
    const row = await this.repo.getEvent(id);
    if (!row) throw new NotFoundException({ message: `Calendar event ${id} not found`, code: 'calendar.event_not_found' });
    return row;
  }

  /** Create an exception: a replacement occurrence for one series instance. */
  /**
   * Tạo exception cho một occurrence của chuỗi lặp (đổi giờ/nội dung riêng lần đó).
   */
  async createException(actorId: string, occurrenceId: string, input: { name?: string; timestart: string; description?: string }): Promise<CalendarEventRow> {
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

  /**
   * Xoá sự kiện (hoặc một occurrence qua exception tuỳ chọn).
   */
  async deleteEvent(actorId: string, id: string): Promise<{ deleted: boolean; seriesDeleted: number }> {
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

  private async canViewCoursePart(viewerId: string, courseId: string | undefined): Promise<boolean> {
    if (!courseId) return false;
    if (await this.evaluator.isSiteAdmin(viewerId)) return true;
    if (await this.enrol.isEnrolled(courseId, viewerId, { onlyActive: true })) return true;
    const ctx = await this.courses.courseContextId(courseId);
    return this.evaluator.hasCapabilityFromRealAssignment(viewerId, 'moodle/course:view', ctx, { excludeArchetypes: ['student'] });
  }

  /**
   * User có được thấy sự kiện này theo phạm vi của nó hay không.
   */
  async isVisibleTo(event: CalendarEventRow, viewerId: string): Promise<boolean> {
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
        const courses = await this.courses.listCourses(event.categoryid ?? undefined);
        for (const c of courses) {
          if (await this.canViewCoursePart(viewerId, c.id)) return true;
        }
        const ctx = await this.courses.categoryContextId(event.categoryid!);
        return this.evaluator.hasCapability(viewerId, 'moodle/calendar:manageentries', ctx);
      }
      case 'course':
        return this.canViewCoursePart(viewerId, event.courseid ?? undefined);
      case 'group': {
        if (!(await this.canViewCoursePart(viewerId, event.courseid ?? undefined))) return false;
        if (await this.groups.isMember(event.groupid!, viewerId)) return true;
        const ctx = await this.courses.courseContextId(event.courseid!);
        return this.evaluator.hasCapability(viewerId, 'moodle/group:accessallgroups', ctx);
      }
      default:
        return false;
    }
  }

  /** Events visible to the viewer in [from, to]; exception rows replace their occurrence. */
  /**
   * Sự kiện hiển thị cho user trong khoảng thời gian, đã mở rộng chuỗi lặp và áp exception.
   */
  async listEventsForUser(viewerId: string, filter: { from?: string; to?: string; eventtype?: string }): Promise<CalendarEventRow[]> {
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

  // --- export (ICS download + URL xuất bằng token) ------------------------------

  /**
   * Xuất lịch của một user thành nội dung .ics: dùng lại đúng đường liệt kê
   * `listEventsForUser` (cùng khoảng thời gian, cùng visibility matrix
   * site/user/course/category/group, occurrence lặp đã materialise và
   * exception đã thay thế) nên file xuất không bao giờ chứa sự kiện mà
   * user không được thấy trên giao diện.
   */
  async exportIcsForUser(userId: string, filter: { from?: string; to?: string; eventtype?: string }): Promise<string> {
    const events = await this.listEventsForUser(userId, filter);
    return serializeCalendar(events);
  }

  /**
   * Tạo hoặc đổi token xuất lịch của chính user: token thô là 32 byte ngẫu
   * nhiên dạng hex (không dùng UUID làm token), DB chỉ lưu hash SHA-256;
   * token thô chỉ xuất hiện trong kết quả của lần gọi này. Đổi token ghi đè
   * hash cũ nên URL xuất cũ chết ngay.
   */
  async createOrRotateExportToken(userId: string): Promise<{ token: string; exportUrl: string; timecreated: Date; timemodified: Date }> {
    const raw = randomBytes(32).toString('hex');
    const row = await this.repo.upsertExportToken(userId, hashExportToken(raw));
    return { token: raw, exportUrl: `/api/v1/calendar/export/${raw}.ics`, timecreated: row.timecreated, timemodified: row.timemodified };
  }

  /**
   * Trạng thái token xuất lịch của user — không bao giờ chứa token thô hay
   * hash của token.
   */
  async getExportTokenStatus(userId: string): Promise<{ hasToken: boolean; timecreated: Date | null; timemodified: Date | null; lastaccess: Date | null }> {
    const row = await this.repo.getExportTokenByUser(userId);
    if (!row) return { hasToken: false, timecreated: null, timemodified: null, lastaccess: null };
    return { hasToken: true, timecreated: row.timecreated, timemodified: row.timemodified, lastaccess: row.lastaccess };
  }

  /**
   * Thu hồi token xuất lịch của user: xoá bản ghi hash khiến URL xuất hiện
   * tại chết ngay; gọi lại khi không còn token vẫn an toàn (revoked=false).
   */
  async revokeExportToken(userId: string): Promise<{ revoked: boolean }> {
    return { revoked: await this.repo.deleteExportToken(userId) };
  }

  /**
   * Xuất lịch qua token thô (đường công khai, không cần JWT): tra hash của
   * token để tìm chủ sở hữu rồi xuất đúng lịch của chủ đó. Token không tồn
   * tại/đã đổi/đã thu hồi → 401 `calendar.export_token_invalid`; token thô
   * không được ghi log ở bất cứ đâu.
   */
  async exportIcsByToken(rawToken: string, filter: { from?: string; to?: string; eventtype?: string }): Promise<string> {
    const row: CalendarExportTokenRow | undefined = await this.repo.getExportTokenByHash(hashExportToken(rawToken));
    if (!row) {
      throw new UnauthorizedException({ message: 'Calendar export token is invalid or has been revoked', code: 'calendar.export_token_invalid' });
    }
    await this.repo.touchExportToken(row.id);
    return this.exportIcsForUser(row.userid, filter);
  }

  // --- reminders -----------------------------------------------------------------

  /** Schedule a reminder: a BullMQ delayed job; the worker notifies at fire time. */
  /**
   * Lên lịch nhắc trước sự kiện (worker calendar-reminder sẽ gửi notification đã dịch).
   */
  async scheduleReminder(actorId: string, eventId: string, minutesBefore: number): Promise<{ eventId: string; userId: string; remindAt: string; delayMs: number }> {
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

  /**
   * Đăng ký lịch ngoài theo URL .ics.
   */
  async createSubscription(actorId: string, input: { name: string; url?: string; icsdata?: string; eventtype?: string; courseid?: string; categoryid?: string; pollinterval?: number }): Promise<CalendarSubscriptionRow> {
    const eventtype = input.eventtype ?? 'site';
    if (eventtype === 'site') {
      await this.evaluator.requireCapability(actorId, 'moodle/calendar:managesubscriptions', await this.systemCtx());
    } else if (eventtype === 'course' && input.courseid) {
      await this.evaluator.requireCapability(actorId, 'moodle/calendar:manageentries', await this.courses.courseContextId(input.courseid));
    }
    const subscription = await this.repo.insertSubscription({
      name: input.name, url: input.url ?? null, icsdata: input.icsdata ?? null,
      eventtype, courseid: input.courseid ?? null, categoryid: input.categoryid ?? null,
      userid: actorId, pollinterval: input.pollinterval ?? 604800,
    });
    if (subscription.icsdata) {
      await this.importQueue.add('import', { subscriptionId: subscription.id }, { jobId: `cal-import-${subscription.id}`, attempts: 3 });
    }
    return subscription;
  }

  /**
   * Subscription của user.
   */
  async listSubscriptions(): Promise<CalendarSubscriptionRow[]> {
    return this.repo.listSubscriptions();
  }

  /**
   * Đưa yêu cầu nhập/đồng bộ subscription vào hàng đợi worker.
   */
  async requestImport(actorId: string, subscriptionId: string): Promise<{ queued: boolean; subscriptionId: string }> {
    const sub = await this.repo.getSubscription(subscriptionId);
    if (!sub) throw new NotFoundException({ message: `Subscription ${subscriptionId} not found`, code: 'calendar.subscription_not_found' });
    await this.evaluator.requireCapability(actorId, 'moodle/calendar:managesubscriptions', await this.systemCtx());
    await this.importQueue.add('import', { subscriptionId }, { jobId: `cal-import-${subscriptionId}-${Date.now()}`, attempts: 3 });
    return { queued: true, subscriptionId };
  }
}

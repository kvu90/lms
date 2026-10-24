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
  eventType: CalendarEventType;
  courseId?: string;
  groupId?: string;
  categoryId?: string;
  timeStart: string;
  timeDuration?: number;
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
 *  - A repeating event is a SERIES: occurrence rows share repeatId with the
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
  private async manageContextId(input: { eventType: string; courseId?: string; categoryId?: string; userId?: string }): Promise<string> {
    switch (input.eventType) {
      case 'course':
      case 'group':
        return this.courses.courseContextId(input.courseId!);
      case 'category':
        return this.courses.categoryContextId(input.categoryId!);
      case 'user':
        return (await this.contexts.getByLevelInstance(30, input.userId!))?.id ?? this.systemCtx();
      default:
        return this.systemCtx();
    }
  }

  private async requireManage(actorId: string, input: { eventType: string; courseId?: string; categoryId?: string; userId?: string }): Promise<void> {
    if (input.eventType === 'user') {
      if (input.userId !== undefined && input.userId !== actorId) {
        // Managing someone else's personal events needs site-level manageentries.
        await this.evaluator.requireCapability(actorId, 'calendar:manageentries', await this.systemCtx());
        return;
      }
      const ctx = await this.manageContextId({ ...input, userId: actorId });
      await this.evaluator.requireCapability(actorId, 'calendar:manageownentries', ctx);
      return;
    }
    const capability = input.eventType === 'group' ? 'calendar:managegroupentries' : 'calendar:manageentries';
    await this.evaluator.requireCapability(actorId, capability, await this.manageContextId(input));
  }

  /**
   * Tạo sự kiện (có thể kèm RRULE) tại một phạm vi.
   */
  async createEvent(actorId: string, input: CreateEventInput): Promise<{ event: CalendarEventRow; occurrences: CalendarEventRow[] }> {
    if (!EVENT_TYPES.includes(input.eventType)) {
      throw new BadRequestException({ message: `Unknown event type ${input.eventType}`, code: 'calendar.bad_type' });
    }
    if (input.eventType === 'course' && !input.courseId) throw new BadRequestException({ message: 'Course events require courseId', code: 'calendar.course_required' });
    if (input.eventType === 'group' && (!input.courseId || !input.groupId)) throw new BadRequestException({ message: 'Group events require courseId and groupId', code: 'calendar.group_required' });
    if (input.eventType === 'category' && !input.categoryId) throw new BadRequestException({ message: 'Category events require categoryId', code: 'calendar.category_required' });
    if (input.eventType === 'group') {
      const group = await this.groups.getGroup(input.groupId!);
      if (group.courseId !== input.courseId) throw new BadRequestException({ message: 'Group belongs to another course', code: 'calendar.group_course_mismatch' });
    }
    const owner = input.eventType === 'user' ? actorId : undefined;
    await this.requireManage(actorId, { eventType: input.eventType, courseId: input.courseId, categoryId: input.categoryId, userId: owner });
    const contextId = await this.manageContextId({ eventType: input.eventType, courseId: input.courseId, categoryId: input.categoryId, userId: owner });
    const start = new Date(input.timeStart);
    if (Number.isNaN(start.getTime())) throw new BadRequestException({ message: 'Invalid timeStart', code: 'calendar.bad_time' });

    const base = {
      name: input.name, description: input.description ?? '', eventType: input.eventType,
      courseId: input.courseId ?? null, groupId: input.groupId ?? null, categoryId: input.categoryId ?? null,
      userId: owner, contextId: contextId, timeDuration: input.timeDuration ?? 0,
      location: input.location ?? '', visible: true,
    };
    if (!input.repeat) {
      const event = await this.repo.insertEvent({ ...base, timeStart: start });
      await this.outbox.enqueueStandalone({ aggregate: 'calendar', type: 'calendar_event_created', payload: { eventId: event.id, eventType: event.eventType } });
      return { event, occurrences: [event] };
    }
    const spec = parseRrule(input.repeat);
    const starts = occurrenceStarts(start, spec);
    const occurrences: CalendarEventRow[] = [];
    let root: CalendarEventRow | undefined;
    await this.repo.dbHandle.transaction(async (tx) => {
      root = await this.repo.insertEvent({ ...base, timeStart: starts[0]!, rrule: formatRrule(spec), repeatId: null }, tx as never);
      await this.repo.updateEvent(root.id, { repeatId: root.id }, tx as never);
      root = { ...root, repeatId: root.id };
      occurrences.push(root);
      for (const s of starts.slice(1)) {
        occurrences.push(await this.repo.insertEvent({ ...base, timeStart: s, repeatId: root.id }, tx as never));
      }
      await this.outbox.enqueue(tx as never, { aggregate: 'calendar', type: 'calendar_event_created', payload: { eventId: root.id, eventType: input.eventType, series: true, count: starts.length } });
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
  async createException(actorId: string, occurrenceId: string, input: { name?: string; timeStart: string; description?: string }): Promise<CalendarEventRow> {
    const occurrence = await this.getEvent(occurrenceId);
    if (!occurrence.repeatId) throw new BadRequestException({ message: 'Only a series occurrence can have an exception', code: 'calendar.not_series' });
    await this.requireManage(actorId, { eventType: occurrence.eventType, courseId: occurrence.courseId || undefined, categoryId: occurrence.categoryId || undefined, userId: occurrence.userId || undefined });
    const exception = await this.repo.insertEvent({
      name: input.name ?? occurrence.name, description: input.description ?? occurrence.description,
      eventType: occurrence.eventType, courseId: occurrence.courseId, groupId: occurrence.groupId,
      categoryId: occurrence.categoryId, userId: occurrence.userId, contextId: occurrence.contextId,
      timeStart: new Date(input.timeStart), timeDuration: occurrence.timeDuration,
      repeatId: occurrence.repeatId, isException: true, exceptionOf: occurrence.id, location: occurrence.location,
    });
    return exception;
  }

  /**
   * Xoá sự kiện (hoặc một occurrence qua exception tuỳ chọn).
   */
  async deleteEvent(actorId: string, id: string): Promise<{ deleted: boolean; seriesDeleted: number }> {
    const event = await this.getEvent(id);
    await this.requireManage(actorId, { eventType: event.eventType, courseId: event.courseId || undefined, categoryId: event.categoryId || undefined, userId: event.userId || undefined });
    let count = 1;
    if (event.repeatId && event.id === event.repeatId) {
      // Deleting the root deletes the whole series (Moodle semantics).
      const series = await this.repo.listSeries(event.repeatId);
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
    return this.evaluator.hasCapabilityFromRealAssignment(viewerId, 'course:view', ctx, { excludeArchetypes: ['student'] });
  }

  /**
   * User có được thấy sự kiện này theo phạm vi của nó hay không.
   */
  async isVisibleTo(event: CalendarEventRow, viewerId: string): Promise<boolean> {
    if (!event.visible) {
      // Hidden events are visible only to their managers.
      return this.requireManage(viewerId, { eventType: event.eventType, courseId: event.courseId || undefined, categoryId: event.categoryId || undefined, userId: event.userId || undefined }).then(() => true).catch(() => false);
    }
    switch (event.eventType) {
      case 'site':
        return true;
      case 'user':
        return event.userId === viewerId;
      case 'category': {
        if (await this.evaluator.isSiteAdmin(viewerId)) return true;
        const courses = await this.courses.listCourses(event.categoryId ?? undefined);
        for (const c of courses) {
          if (await this.canViewCoursePart(viewerId, c.id)) return true;
        }
        const ctx = await this.courses.categoryContextId(event.categoryId!);
        return this.evaluator.hasCapability(viewerId, 'calendar:manageentries', ctx);
      }
      case 'course':
        return this.canViewCoursePart(viewerId, event.courseId ?? undefined);
      case 'group': {
        if (!(await this.canViewCoursePart(viewerId, event.courseId ?? undefined))) return false;
        if (await this.groups.isMember(event.groupId!, viewerId)) return true;
        const ctx = await this.courses.courseContextId(event.courseId!);
        return this.evaluator.hasCapability(viewerId, 'group:accessallgroups', ctx);
      }
      default:
        return false;
    }
  }

  /** Events visible to the viewer in [from, to]; exception rows replace their occurrence. */
  /**
   * Sự kiện hiển thị cho user trong khoảng thời gian, đã mở rộng chuỗi lặp và áp exception.
   */
  async listEventsForUser(viewerId: string, filter: { from?: string; to?: string; eventType?: string }): Promise<CalendarEventRow[]> {
    const from = filter.from ? new Date(filter.from) : new Date(Date.now() - 31 * 86400_000);
    const to = filter.to ? new Date(filter.to) : new Date(Date.now() + 62 * 86400_000);
    const rows = await this.repo.listEventsInRange(from, to);
    const exceptedIds = new Set(rows.filter((r) => r.isException).map((r) => r.exceptionOf));
    const visible: CalendarEventRow[] = [];
    for (const row of rows) {
      if (row.isException === false && row.exceptionOf === null && exceptedIds.has(row.id)) continue; // replaced by its exception
      if (filter.eventType && row.eventType !== filter.eventType) continue;
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
  async exportIcsForUser(userId: string, filter: { from?: string; to?: string; eventType?: string }): Promise<string> {
    const events = await this.listEventsForUser(userId, filter);
    return serializeCalendar(events);
  }

  /**
   * Tạo hoặc đổi token xuất lịch của chính user: token thô là 32 byte ngẫu
   * nhiên dạng hex (không dùng UUID làm token), DB chỉ lưu hash SHA-256;
   * token thô chỉ xuất hiện trong kết quả của lần gọi này. Đổi token ghi đè
   * hash cũ nên URL xuất cũ chết ngay.
   */
  async createOrRotateExportToken(userId: string): Promise<{ token: string; exportUrl: string; createdAt: Date; updatedAt: Date }> {
    const raw = randomBytes(32).toString('hex');
    const row = await this.repo.upsertExportToken(userId, hashExportToken(raw));
    return { token: raw, exportUrl: `/api/v1/calendar/export/${raw}.ics`, createdAt: row.createdAt, updatedAt: row.updatedAt };
  }

  /**
   * Trạng thái token xuất lịch của user — không bao giờ chứa token thô hay
   * hash của token.
   */
  async getExportTokenStatus(userId: string): Promise<{ hasToken: boolean; createdAt: Date | null; updatedAt: Date | null; lastAccess: Date | null }> {
    const row = await this.repo.getExportTokenByUser(userId);
    if (!row) return { hasToken: false, createdAt: null, updatedAt: null, lastAccess: null };
    return { hasToken: true, createdAt: row.createdAt, updatedAt: row.updatedAt, lastAccess: row.lastAccess };
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
  async exportIcsByToken(rawToken: string, filter: { from?: string; to?: string; eventType?: string }): Promise<string> {
    const row: CalendarExportTokenRow | undefined = await this.repo.getExportTokenByHash(hashExportToken(rawToken));
    if (!row) {
      throw new UnauthorizedException({ message: 'Calendar export token is invalid or has been revoked', code: 'calendar.export_token_invalid' });
    }
    await this.repo.touchExportToken(row.id);
    return this.exportIcsForUser(row.userId, filter);
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
    const remindAt = new Date(event.timeStart.getTime() - minutesBefore * 60_000);
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
  async createSubscription(actorId: string, input: { name: string; url?: string; icsData?: string; eventType?: string; courseId?: string; categoryId?: string; pollInterval?: number }): Promise<CalendarSubscriptionRow> {
    const eventType = input.eventType ?? 'site';
    if (eventType === 'site') {
      await this.evaluator.requireCapability(actorId, 'calendar:managesubscriptions', await this.systemCtx());
    } else if (eventType === 'course' && input.courseId) {
      await this.evaluator.requireCapability(actorId, 'calendar:manageentries', await this.courses.courseContextId(input.courseId));
    }
    const subscription = await this.repo.insertSubscription({
      name: input.name, url: input.url ?? null, icsData: input.icsData ?? null,
      eventType, courseId: input.courseId ?? null, categoryId: input.categoryId ?? null,
      userId: actorId, pollInterval: input.pollInterval ?? 604800,
    });
    if (subscription.icsData) {
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
    await this.evaluator.requireCapability(actorId, 'calendar:managesubscriptions', await this.systemCtx());
    await this.importQueue.add('import', { subscriptionId }, { jobId: `cal-import-${subscriptionId}-${Date.now()}`, attempts: 3 });
    return { queued: true, subscriptionId };
  }
}

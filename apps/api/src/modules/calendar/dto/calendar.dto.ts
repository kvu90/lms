import {
  calendarRemindSchema,
  createCalendarEventSchema,
  createCalendarExceptionSchema,
  createCalendarSubscriptionSchema,
  type CalendarRemind,
  type CreateCalendarEvent,
  type CreateCalendarException,
  type CreateCalendarSubscription,
} from '@lms/contracts';

/**
 * Validation của Calendar dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất.
 */
export {
  calendarRemindSchema,
  createCalendarEventSchema,
  createCalendarExceptionSchema,
  createCalendarSubscriptionSchema,
};
export type CreateEventDto = CreateCalendarEvent;
export type CreateExceptionDto = CreateCalendarException;
export type CreateSubscriptionDto = CreateCalendarSubscription;
export type RemindDto = CalendarRemind;

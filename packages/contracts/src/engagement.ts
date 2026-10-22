import { z } from 'zod';

/** P4 Communication & Engagement contracts — shared shapes between api, worker-facing payloads and web. */

/* ---- Messaging ---- */

export const messageSchema = z.object({
  id: z.number().int(),
  conversationid: z.number().int(),
  useridfrom: z.number().int(),
  subject: z.string(),
  fullmessage: z.string(),
  timecreated: z.string(),
});
export type LmsMessage = z.infer<typeof messageSchema>;

export const conversationSchema = z.object({
  id: z.number().int(),
  type: z.number().int(), // 1 individual, 2 group
  name: z.string().nullable(),
  members: z.array(z.number().int()),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const notificationSchema = z.object({
  id: z.number().int(),
  useridto: z.number().int(),
  subject: z.string(),
  fullmessage: z.string(),
  eventtype: z.string(),
  timeread: z.string().nullable(),
  timecreated: z.string(),
});
export type LmsNotification = z.infer<typeof notificationSchema>;

export const messagePreferenceSchema = z.object({
  provider: z.string(),
  channel: z.string(),
  loggedin: z.boolean(),
  loggedoff: z.boolean(),
});
export type MessagePreference = z.infer<typeof messagePreferenceSchema>;

/* ---- Calendar ---- */

export const CALENDAR_EVENT_TYPES = ['site', 'category', 'course', 'group', 'user'] as const;
export const calendarEventSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  eventtype: z.enum(CALENDAR_EVENT_TYPES),
  timestart: z.string(),
  timeduration: z.number().int(),
  repeatid: z.number().int(),
  isexception: z.boolean(),
});
export type CalendarEvent = z.infer<typeof calendarEventSchema>;

/* ---- Badges ---- */

export const badgeSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  type: z.number().int(), // 1 site, 2 course
  status: z.number().int(), // 0 inactive, 1 active, 2 retired, 3 archived, 4 disabled
});
export type Badge = z.infer<typeof badgeSchema>;

export const issuedBadgeSchema = z.object({
  id: z.number().int(),
  badgeid: z.number().int(),
  userid: z.number().int(),
  uniquehash: z.string(),
  dateissued: z.string(),
  dateexpire: z.string().nullable(),
  revoked: z.boolean(),
});
export type IssuedBadge = z.infer<typeof issuedBadgeSchema>;

/* ---- Competencies ---- */

export const PLAN_STATUSES = [0, 1, 2, 3, 4] as const; // draft, active, waitingforreview, inreview, complete
export const learningPlanSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  userid: z.number().int(),
  templateid: z.number().int().nullable(),
  status: z.number().int(),
});
export type LearningPlan = z.infer<typeof learningPlanSchema>;

export const userCompetencySchema = z.object({
  id: z.number().int(),
  userid: z.number().int(),
  competencyid: z.number().int(),
  grade: z.number().int().nullable(),
  proficiency: z.boolean().nullable(),
  status: z.number().int(), // review: 0 none, 1 waiting, 2 inreview
});
export type UserCompetency = z.infer<typeof userCompetencySchema>;

/* ---- Social ---- */

export const tagSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  ordering: z.number().int(),
});
export type Tag = z.infer<typeof tagSchema>;

export const commentSchema = z.object({
  id: z.number().int(),
  userid: z.number().int(),
  content: z.string(),
  contextid: z.number().int(),
});
export type LmsComment = z.infer<typeof commentSchema>;

export const ratingAggregateSchema = z.object({
  count: z.number().int(),
  average: z.number(),
  sum: z.number(),
  min: z.number().nullable(),
  max: z.number().nullable(),
});
export type RatingAggregate = z.infer<typeof ratingAggregateSchema>;

export const blogPostSchema = z.object({
  id: z.number().int(),
  userid: z.number().int(),
  subject: z.string(),
  content: z.string(),
  publishstate: z.enum(['draft', 'site']),
});
export type BlogPost = z.infer<typeof blogPostSchema>;

export const noteSchema = z.object({
  id: z.number().int(),
  userid: z.number().int(), // subject user
  courseid: z.number().int(),
  createdby: z.number().int(),
  content: z.string(),
  publishstate: z.enum(['draft', 'public', 'site']),
});
export type Note = z.infer<typeof noteSchema>;

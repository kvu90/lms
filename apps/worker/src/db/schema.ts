import { bigint, boolean, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

/**
 * Worker's view of the shared schema. The worker needs `outbox_events` plus
 * the subset its processors touch (the full canonical schema lives in
 * apps/api/src/db/schema.ts; the worker keeps its own subset view of it).
 */
export const outboxEvents = pgTable('outbox_events', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`).$defaultFn(() => uuidv7()),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().unique(),
  aggregate: text('aggregate').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
});

/** Worker's view of `files` (canonical schema in apps/api) — needed for refcount checks during orphan cleanup. */
export const files = pgTable('files', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  contenthash: text('contenthash').notNull(),
  contextid: uuid('contextid').notNull(),
  component: text('component').notNull(),
  filearea: text('filearea').notNull(),
  itemid: uuid('itemid'),
  filepath: text('filepath').notNull().default('/'),
  filename: text('filename').notNull(),
  userid: uuid('userid'),
  filesize: integer('filesize').notNull(),
  mimetype: text('mimetype'),
  status: integer('status').notNull().default(0),
  source: text('source'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('files_contextid_idx').on(table.contextid),
      index('files_itemid_idx').on(table.itemid),
      index('files_userid_idx').on(table.userid),
  ]);


/** Worker's view of enrol tables (canonical schema in apps/api) — needed by the enrol-expiry processor. */
export const enrol = pgTable('enrol', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  courseid: uuid('courseid').notNull(),
  enrol: text('enrol').notNull(),
  status: integer('status').notNull().default(0),
  roleid: uuid('roleid'),
  customint1: uuid('customint1'),
  customtext1: text('customtext1').notNull().default('suspend'),
},
  (table) => [
      index('enrol_courseid_idx').on(table.courseid),
      index('enrol_roleid_idx').on(table.roleid),
      index('enrol_customint1_idx').on(table.customint1),
  ]);


/** status: 0=ACTIVE, 1=SUSPENDED, 2=WITHDRAWN. */
export const userEnrolments = pgTable('user_enrolments', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  enrolid: uuid('enrolid').notNull(),
  userid: uuid('userid').notNull(),
  status: integer('status').notNull().default(0),
  timestart: timestamp('timestart', { withTimezone: true }).notNull().defaultNow(),
  timeend: timestamp('timeend', { withTimezone: true }),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('user_enrolments_enrolid_idx').on(table.enrolid),
      index('user_enrolments_userid_idx').on(table.userid),
  ]);


/** Worker's view of completion tables — needed by the completion-recalculate processor. */
export const courseModules = pgTable('course_modules', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  course: uuid('course').notNull(),
},
  (table) => [
      index('course_modules_course_idx').on(table.course),
  ]);


export const courseModulesCompletion = pgTable('course_modules_completion', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  coursemoduleid: uuid('coursemoduleid').notNull(),
  userid: uuid('userid').notNull(),
  completionstate: integer('completionstate').notNull().default(0),
  viewed: boolean('viewed').notNull().default(false),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
      index('course_modules_completion_coursemoduleid_idx').on(t.coursemoduleid),
      index('course_modules_completion_userid_idx').on(t.userid),unique('cmc_unique_worker').on(t.coursemoduleid, t.userid)]);

export const courseCompletionCriteria = pgTable('course_completion_criteria', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  course: uuid('course').notNull(),
  criteriatype: text('criteriatype').notNull(),
  moduleinstance: uuid('moduleinstance'),
  date: timestamp('date', { withTimezone: true }),
  sortorder: integer('sortorder').notNull().default(0),
},
  (table) => [
      index('course_completion_criteria_course_idx').on(table.course),
      index('course_completion_criteria_moduleinstance_idx').on(table.moduleinstance),
  ]);


export const courseCompletionSettings = pgTable('course_completion_settings', {
  course: uuid('course').primaryKey(),
  method: integer('method').notNull().default(1),
});

export const courseCompletions = pgTable('course_completions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userid: uuid('userid').notNull(),
  course: uuid('course').notNull(),
  status: text('status').notNull().default('not_started'),
  timeenrolled: timestamp('timeenrolled', { withTimezone: true }).notNull().defaultNow(),
  timestarted: timestamp('timestarted', { withTimezone: true }),
  timecompleted: timestamp('timecompleted', { withTimezone: true }),
  reaggregate: timestamp('reaggregate', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
      index('course_completions_userid_idx').on(t.userid),
      index('course_completions_course_idx').on(t.course),unique('cc_unique_worker').on(t.userid, t.course)]);

/** Worker's view of grade tables (canonical schema in apps/api) — needed by the grade-regrade processor. */
export const gradeCategories = pgTable('grade_categories', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  courseid: uuid('courseid').notNull(),
  parent: uuid('parent'),
  fullname: text('fullname').notNull().default(''),
  aggregation: text('aggregation').notNull().default('natural'),
  droplow: integer('droplow').notNull().default(0),
  keephigh: integer('keephigh').notNull().default(0),
  aggregateonlygraded: boolean('aggregateonlygraded').notNull().default(false),
  depth: integer('depth').notNull().default(1),
},
  (table) => [
      index('grade_categories_courseid_idx').on(table.courseid),
      index('grade_categories_parent_idx').on(table.parent),
  ]);


export const gradeItems = pgTable('grade_items', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  courseid: uuid('courseid').notNull(),
  categoryid: uuid('categoryid'),
  itemname: text('itemname').notNull().default(''),
  itemtype: text('itemtype').notNull().default('manual'),
  iteminstance: uuid('iteminstance'),
  gradetype: text('gradetype').notNull().default('value'),
  scaleid: uuid('scaleid'),
  outcomeid: uuid('outcomeid'),
  idnumber: text('idnumber'),
  calculation: text('calculation'),
  grademax: doublePrecision('grademax').notNull().default(100),
  grademin: doublePrecision('grademin').notNull().default(0),
  gradepass: doublePrecision('gradepass').notNull().default(0),
  weightoverride: boolean('weightoverride').notNull().default(false),
  aggregationcoef: doublePrecision('aggregationcoef').notNull().default(0),
  extracredit: boolean('extracredit').notNull().default(false),
  multiplicator: doublePrecision('multiplicator').notNull().default(1),
  plusfactor: doublePrecision('plusfactor').notNull().default(0),
},
  (table) => [
      index('grade_items_courseid_idx').on(table.courseid),
      index('grade_items_categoryid_idx').on(table.categoryid),
      index('grade_items_iteminstance_idx').on(table.iteminstance),
  ]);


export const gradeGrades = pgTable('grade_grades', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  itemid: uuid('itemid').notNull(),
  userid: uuid('userid').notNull(),
  rawgrade: doublePrecision('rawgrade'),
  finalgrade: doublePrecision('finalgrade'),
  hidden: boolean('hidden').notNull().default(false),
  locked: boolean('locked').notNull().default(false),
  overridden: boolean('overridden').notNull().default(false),
  excluded: boolean('excluded').notNull().default(false),
  frozen: boolean('frozen').notNull().default(false),
  feedback: text('feedback'),
  aggregationstatus: text('aggregationstatus').notNull().default('unknown'),
  aggregationweight: doublePrecision('aggregationweight'),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
      index('grade_grades_itemid_idx').on(t.itemid),
      index('grade_grades_userid_idx').on(t.userid),unique('gg_unique_worker').on(t.itemid, t.userid)]);

export const gradeGradesHistory = pgTable('grade_grades_history', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  action: integer('action').notNull().default(2),
  oldid: uuid('oldid'),
  itemid: uuid('itemid').notNull(),
  userid: uuid('userid').notNull(),
  rawgrade: doublePrecision('rawgrade'),
  finalgrade: doublePrecision('finalgrade'),
  overridden: boolean('overridden').notNull().default(false),
  excluded: boolean('excluded').notNull().default(false),
  frozen: boolean('frozen').notNull().default(false),
  source: text('source'),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  loggeduser: uuid('loggeduser'),
},
  (table) => [
      index('grade_grades_history_oldid_idx').on(table.oldid),
      index('grade_grades_history_itemid_idx').on(table.itemid),
      index('grade_grades_history_userid_idx').on(table.userid),
      index('grade_grades_history_loggeduser_idx').on(table.loggeduser),
  ]);


// ---------------------------------------------------------------------------
// Worker views of the communication & engagement tables (canonical
// schema in apps/api). Only the columns the processors touch.
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  username: text('username').notNull(),
  email: text('email').notNull().default(''),
  firstname: text('firstname').notNull().default(''),
  lastname: text('lastname').notNull().default(''),
  suspended: boolean('suspended').notNull().default(false),
  deleted: boolean('deleted').notNull().default(false),
  lastlogin: timestamp('lastlogin', { withTimezone: true }),
});

export const userPreferences = pgTable('user_preferences', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userid: uuid('userid').notNull(),
  name: text('name').notNull(),
  value: text('value'),
}, (t) => [
      index('user_preferences_userid_idx').on(t.userid),unique('user_preferences_unique_worker').on(t.userid, t.name)]);

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  useridfrom: uuid('useridfrom'),
  useridto: uuid('useridto').notNull(),
  subject: text('subject').notNull().default(''),
  fullmessage: text('fullmessage').notNull().default(''),
  smallmessage: text('smallmessage').notNull().default(''),
  component: text('component').notNull().default(''),
  eventtype: text('eventtype').notNull().default(''),
  contexturl: text('contexturl'),
  contexturlname: text('contexturlname'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timeread: timestamp('timeread', { withTimezone: true }),
},
  (table) => [
      index('notifications_useridfrom_idx').on(table.useridfrom),
      index('notifications_useridto_idx').on(table.useridto),
  ]);


export const notificationDispatchLog = pgTable('notification_dispatch_log', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  notificationid: uuid('notificationid'),
  userid: uuid('userid').notNull(),
  provider: text('provider').notNull(),
  channel: text('channel').notNull(),
  status: text('status').notNull(),
  subject: text('subject').notNull().default(''),
  dedupekey: text('dedupekey'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
      index('notification_dispatch_log_notificationid_idx').on(t.notificationid),
      index('notification_dispatch_log_userid_idx').on(t.userid),unique('notification_dispatch_log_dedupe_worker').on(t.dedupekey)]);

export const calendarEvents = pgTable('calendar_events', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  eventtype: text('eventtype').notNull().default('user'),
  courseid: uuid('courseid'),
  groupid: uuid('groupid'),
  categoryid: uuid('categoryid'),
  userid: uuid('userid'),
  contextid: uuid('contextid'),
  subscriptionid: uuid('subscriptionid'),
  uuid: text('uuid'),
  repeatid: uuid('repeatid'),
  timestart: timestamp('timestart', { withTimezone: true }).notNull(),
  timeduration: integer('timeduration').notNull().default(0),
  visible: boolean('visible').notNull().default(true),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('calendar_events_courseid_idx').on(table.courseid),
      index('calendar_events_groupid_idx').on(table.groupid),
      index('calendar_events_categoryid_idx').on(table.categoryid),
      index('calendar_events_userid_idx').on(table.userid),
      index('calendar_events_contextid_idx').on(table.contextid),
      index('calendar_events_subscriptionid_idx').on(table.subscriptionid),
      index('calendar_events_repeatid_idx').on(table.repeatid),
  ]);


export const calendarSubscriptions = pgTable('calendar_subscriptions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  url: text('url'),
  icsdata: text('icsdata'),
  eventtype: text('eventtype').notNull().default('site'),
  courseid: uuid('courseid'),
  categoryid: uuid('categoryid'),
  userid: uuid('userid'),
  pollinterval: integer('pollinterval').notNull().default(604800),
  lastupdated: timestamp('lastupdated', { withTimezone: true }),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('calendar_subscriptions_courseid_idx').on(table.courseid),
      index('calendar_subscriptions_categoryid_idx').on(table.categoryid),
      index('calendar_subscriptions_userid_idx').on(table.userid),
  ]);


export const badge = pgTable('badge', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  type: integer('type').notNull().default(1),
  courseid: uuid('courseid'),
  issuername: text('issuername').notNull().default(''),
  status: integer('status').notNull().default(0),
  expiredate: timestamp('expiredate', { withTimezone: true }),
  expireperiod: integer('expireperiod'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('badge_courseid_idx').on(table.courseid),
  ]);


export const badgeCriteria = pgTable('badge_criteria', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  badgeid: uuid('badgeid').notNull(),
  criteriatype: text('criteriatype').notNull(),
  method: integer('method').notNull().default(1),
  params: jsonb('params').notNull().default({}),
  description: text('description').notNull().default(''),
},
  (table) => [
      index('badge_criteria_badgeid_idx').on(table.badgeid),
  ]);


export const badgeIssued = pgTable('badge_issued', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  badgeid: uuid('badgeid').notNull(),
  userid: uuid('userid').notNull(),
  uniquehash: text('uniquehash').notNull(),
  snapshot: jsonb('snapshot').notNull().default({}),
  evidence: jsonb('evidence').notNull().default({}),
  dateissued: timestamp('dateissued', { withTimezone: true }).notNull().defaultNow(),
  dateexpire: timestamp('dateexpire', { withTimezone: true }),
  visible: boolean('visible').notNull().default(true),
  revoked: boolean('revoked').notNull().default(false),
  issuernotified: boolean('issuernotified').notNull().default(false),
}, (t) => [
      index('badge_issued_badgeid_idx').on(t.badgeid),
      index('badge_issued_userid_idx').on(t.userid),unique('badge_issued_badge_user_worker').on(t.badgeid, t.userid)]);

export const badgeManualAward = pgTable('badge_manual_award', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  badgeid: uuid('badgeid').notNull(),
  recipientid: uuid('recipientid').notNull(),
  issuerid: uuid('issuerid').notNull(),
  datemet: timestamp('datemet', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('badge_manual_award_badgeid_idx').on(table.badgeid),
      index('badge_manual_award_recipientid_idx').on(table.recipientid),
      index('badge_manual_award_issuerid_idx').on(table.issuerid),
  ]);


/** Worker view of `cohort_members` (canonical schema in apps/api groups module) — needed by the badge `cohort` criteria leaf. */
export const cohortMembers = pgTable('cohort_members', {
  cohortid: uuid('cohortid').notNull(),
  userid: uuid('userid').notNull(),
  timeadded: timestamp('timeadded', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('cohort_members_unique_worker').on(t.cohortid, t.userid)]);

/** Worker view of the custom field tables (canonical schema in apps/api custom-fields module) — needed by the badge `profile` criteria leaf. */
export const customfieldCategory = pgTable('customfield_category', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull().default(''),
  component: text('component').notNull(),
  area: text('area').notNull(),
});

export const customfieldField = pgTable('customfield_field', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  categoryid: uuid('categoryid').notNull(),
  shortname: text('shortname').notNull(),
  name: text('name').notNull().default(''),
  type: text('type').notNull().default('text'),
});

export const customfieldData = pgTable('customfield_data', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  fieldid: uuid('fieldid').notNull(),
  instanceid: uuid('instanceid').notNull(),
  value: text('value'),
});


export const competencyUsercomp = pgTable('competency_usercomp', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userid: uuid('userid').notNull(),
  competencyid: uuid('competencyid').notNull(),
  planid: uuid('planid'),
  courseid: uuid('courseid'),
  status: integer('status').notNull().default(0),
  proficiency: boolean('proficiency'),
  grade: integer('grade'),
},
  (table) => [
      index('competency_usercomp_userid_idx').on(table.userid),
      index('competency_usercomp_competencyid_idx').on(table.competencyid),
      index('competency_usercomp_planid_idx').on(table.planid),
      index('competency_usercomp_courseid_idx').on(table.courseid),
  ]);


// ---------------------------------------------------------------------------
// Platform Services (worker view)
// ---------------------------------------------------------------------------

/** Tài liệu tìm kiếm (worker reindex). */
export const searchDocuments = pgTable('search_documents', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  area: text('area').notNull(),
  itemid: uuid('itemid').notNull(),
  contextid: uuid('contextid').notNull(),
  title: text('title').notNull().default(''),
  content: text('content').notNull().default(''),
  ownerid: uuid('ownerid'),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
      index('search_documents_itemid_idx').on(t.itemid),
      index('search_documents_contextid_idx').on(t.contextid),
      index('search_documents_ownerid_idx').on(t.ownerid),unique('search_documents_area_item_unique').on(t.area, t.itemid)]);

/** Các khoá học (worker backup/analytics cần đọc tiêu đề). */
export const course = pgTable('course', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  category: uuid('category').notNull(),
  fullname: text('fullname').notNull(),
  shortname: text('shortname').notNull().unique(),
  summary: text('summary').notNull().default(''),
  visible: boolean('visible').notNull().default(true),
},
  (table) => [
      index('course_category_idx').on(table.category),
  ]);


/** Context (worker cần course context cho search/analytics). */
export const contextTable = pgTable('context', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  contextlevel: integer('contextlevel').notNull(),
  instanceid: uuid('instanceid'),
  path: text('path').notNull(),
  depth: integer('depth').notNull(),
},
  (table) => [
      index('context_instanceid_idx').on(table.instanceid),
  ]);


/** Việc sao lưu/khôi phục (worker backup/restore processors). */
export const backupJobs = pgTable('backup_jobs', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  type: text('type').notNull(),
  scope: text('scope').notNull().default('course'),
  courseid: uuid('courseid'),
  targetcourseid: uuid('targetcourseid'),
  mode: text('mode').notNull().default('new'),
  status: text('status').notNull().default('pending'),
  anonymize: boolean('anonymize').notNull().default(false),
  userid: uuid('userid').notNull(),
  archive: jsonb('archive'),
  error: text('error'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timefinished: timestamp('timefinished', { withTimezone: true }),
},
  (table) => [
      index('backup_jobs_courseid_idx').on(table.courseid),
      index('backup_jobs_targetcourseid_idx').on(table.targetcourseid),
      index('backup_jobs_userid_idx').on(table.userid),
  ]);

export const backupJobSteps = pgTable('backup_job_steps', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  jobid: uuid('jobid').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull().default('pending'),
  detail: jsonb('detail'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('backup_job_steps_jobid_idx').on(table.jobid),
  ]);


/** Mô hình/dự đoán/insight analytics (worker run). */
export const analyticsModels = pgTable('analytics_models', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull().unique(),
  target: text('target').notNull(),
  indicators: jsonb('indicators').notNull().default([]),
  enabled: boolean('enabled').notNull().default(true),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
});
export const analyticsPredictions = pgTable('analytics_predictions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  modelid: uuid('modelid').notNull(),
  userid: uuid('userid').notNull(),
  contextid: uuid('contextid').notNull(),
  courseid: uuid('courseid'),
  score: doublePrecision('score').notNull().default(0),
  data: jsonb('data'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('analytics_predictions_modelid_idx').on(table.modelid),
      index('analytics_predictions_userid_idx').on(table.userid),
      index('analytics_predictions_contextid_idx').on(table.contextid),
      index('analytics_predictions_courseid_idx').on(table.courseid),
  ]);

export const insights = pgTable('insights', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  modelid: uuid('modelid').notNull(),
  predictionid: uuid('predictionid'),
  userid: uuid('userid').notNull(),
  recipientid: uuid('recipientid').notNull(),
  contextid: uuid('contextid').notNull(),
  courseid: uuid('courseid'),
  heading: text('heading').notNull().default(''),
  data: jsonb('data'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('insights_modelid_idx').on(table.modelid),
      index('insights_predictionid_idx').on(table.predictionid),
      index('insights_userid_idx').on(table.userid),
      index('insights_recipientid_idx').on(table.recipientid),
      index('insights_contextid_idx').on(table.contextid),
      index('insights_courseid_idx').on(table.courseid),
  ]);


/** Báo cáo + lịch (worker report schedule). */
export const reportbuilderReport = pgTable('reportbuilder_report', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  datasource: text('datasource').notNull(),
  columns: jsonb('columns').notNull().default([]),
  filters: jsonb('filters').notNull().default({}),
  createdby: uuid('createdby').notNull(),
  contextid: uuid('contextid'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('reportbuilder_report_createdby_idx').on(table.createdby),
      index('reportbuilder_report_contextid_idx').on(table.contextid),
  ]);

export const reportbuilderSchedule = pgTable('reportbuilder_schedule', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  reportid: uuid('reportid').notNull(),
  createdby: uuid('createdby').notNull(),
  cron: text('cron').notNull().default('daily'),
  enabled: boolean('enabled').notNull().default(true),
  lastrun: timestamp('lastrun', { withTimezone: true }),
  lastresult: jsonb('lastresult'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('reportbuilder_schedule_reportid_idx').on(table.reportid),
      index('reportbuilder_schedule_createdby_idx').on(table.createdby),
  ]);


/** Thanh toán (worker reconciliation + webhook twin). */
export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  accountid: uuid('accountid').notNull(),
  userid: uuid('userid').notNull(),
  amount: integer('amount').notNull(),
  currency: text('currency').notNull(),
  status: text('status').notNull().default('pending'),
  gateway: text('gateway').notNull().default('manual'),
  externaltransactionid: text('externaltransactionid'),
  component: text('component').notNull().default(''),
  itemid: uuid('itemid'),
  data: jsonb('data'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('payments_accountid_idx').on(table.accountid),
      index('payments_userid_idx').on(table.userid),
      index('payments_itemid_idx').on(table.itemid),
  ]);


/** Yêu cầu privacy (worker export/delete processors). */
export const privacyRequests = pgTable('privacy_requests', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userid: uuid('userid').notNull(),
  type: text('type').notNull(),
  status: text('status').notNull().default('pending'),
  requestedby: uuid('requestedby').notNull(),
  approvedby: uuid('approvedby'),
  result: jsonb('result'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('privacy_requests_userid_idx').on(table.userid),
      index('privacy_requests_requestedby_idx').on(table.requestedby),
      index('privacy_requests_approvedby_idx').on(table.approvedby),
  ]);

export const privacyExportFiles = pgTable('privacy_export_files', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  requestid: uuid('requestid').notNull(),
  fileid: uuid('fileid'),
  subsystem: text('subsystem').notNull().default(''),
  manifest: jsonb('manifest'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('privacy_export_files_requestid_idx').on(table.requestid),
      index('privacy_export_files_fileid_idx').on(table.fileid),
  ]);


/** Worker view of the question bank tables (canonical schema in apps/api questions module) — needed by the backup processor to count/export the bank sections of an archive. */
export const questionCategories = pgTable('question_categories', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  contextid: uuid('contextid').notNull(),
  parent: uuid('parent'),
}, (t) => [index('question_categories_contextid_idx').on(t.contextid)]);

export const question = pgTable('question', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  category: uuid('category').notNull(),
  qtype: text('qtype').notNull(),
  name: text('name').notNull(),
}, (t) => [index('question_category_idx').on(t.category)]);

export const questionBankEntries = pgTable('question_bank_entries', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  questioncategoryid: uuid('questioncategoryid').notNull(),
  questionid: uuid('questionid').notNull(),
  latestversion: integer('latestversion').notNull().default(1),
}, (t) => [index('question_bank_entries_questioncategoryid_idx').on(t.questioncategoryid)]);

export const questionVersions = pgTable('question_versions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  questionbankentryid: uuid('questionbankentryid').notNull(),
  questionid: uuid('questionid').notNull(),
  version: integer('version').notNull(),
}, (t) => [index('question_versions_questionid_idx').on(t.questionid)]);

/** Các bảng phụ trợ platform services cho worker: sections, id mappings, roles/assignments. */
export const courseSections = pgTable('course_sections', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  course: uuid('course').notNull(),
  section: integer('section').notNull().default(0),
  name: text('name'),
  summary: text('summary').notNull().default(''),
  visible: boolean('visible').notNull().default(true),
},
  (table) => [
      index('course_sections_course_idx').on(table.course),
  ]);

export const backupIdMappings = pgTable('backup_id_mappings', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  jobid: uuid('jobid').notNull(),
  itemtype: text('itemtype').notNull(),
  oldid: uuid('oldid').notNull(),
  newid: uuid('newid').notNull(),
},
  (table) => [
      index('backup_id_mappings_jobid_idx').on(table.jobid),
      index('backup_id_mappings_oldid_idx').on(table.oldid),
      index('backup_id_mappings_newid_idx').on(table.newid),
  ]);

export const role = pgTable('role', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull().default(''),
  shortname: text('shortname').notNull().unique(),
  archetype: text('archetype'),
});
export const roleAssignments = pgTable('role_assignments', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  roleid: uuid('roleid').notNull(),
  userid: uuid('userid').notNull(),
  contextid: uuid('contextid').notNull(),
},
  (table) => [
      index('role_assignments_roleid_idx').on(table.roleid),
      index('role_assignments_userid_idx').on(table.userid),
      index('role_assignments_contextid_idx').on(table.contextid),
  ]);

export const blogPosts = pgTable('blog_posts', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userid: uuid('userid').notNull(),
  subject: text('subject').notNull().default(''),
  summary: text('summary').notNull().default(''),
  content: text('content').notNull().default(''),
  publishstate: text('publishstate').notNull().default('draft'),
},
  (table) => [
      index('blog_posts_userid_idx').on(table.userid),
  ]);

export const contentbankContent = pgTable('contentbank_content', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  contenttype: text('contenttype').notNull().default('file-based'),
  contextid: uuid('contextid').notNull(),
  creatorid: uuid('creatorid').notNull(),
  visibility: text('visibility').notNull().default('draft'),
  fileid: uuid('fileid'),
},
  (table) => [
      index('contentbank_content_contextid_idx').on(table.contextid),
      index('contentbank_content_creatorid_idx').on(table.creatorid),
      index('contentbank_content_fileid_idx').on(table.fileid),
  ]);


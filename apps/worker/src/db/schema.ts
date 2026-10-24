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
  contentHash: text('content_hash').notNull(),
  contextId: uuid('context_id').notNull(),
  component: text('component').notNull(),
  fileArea: text('file_area').notNull(),
  itemId: uuid('item_id'),
  filePath: text('file_path').notNull().default('/'),
  fileName: text('file_name').notNull(),
  userId: uuid('user_id'),
  fileSize: integer('file_size').notNull(),
  mimeType: text('mime_type'),
  status: integer('status').notNull().default(0),
  source: text('source'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('files_context_id_idx').on(table.contextId),
      index('files_item_id_idx').on(table.itemId),
      index('files_user_id_idx').on(table.userId),
  ]);


/** Worker's view of enrol tables (canonical schema in apps/api) — needed by the enrol-expiry processor. */
export const enrol = pgTable('enrol', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  courseId: uuid('course_id').notNull(),
  enrol: text('enrol').notNull(),
  status: integer('status').notNull().default(0),
  roleId: uuid('role_id'),
  customInt1: uuid('custom_int1'),
  customText1: text('custom_text1').notNull().default('suspend'),
},
  (table) => [
      index('enrol_course_id_idx').on(table.courseId),
      index('enrol_role_id_idx').on(table.roleId),
      index('enrol_custom_int1_idx').on(table.customInt1),
  ]);


/** status: 0=ACTIVE, 1=SUSPENDED, 2=WITHDRAWN. */
export const userEnrolments = pgTable('user_enrolments', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  enrolId: uuid('enrol_id').notNull(),
  userId: uuid('user_id').notNull(),
  status: integer('status').notNull().default(0),
  timeStart: timestamp('time_start', { withTimezone: true }).notNull().defaultNow(),
  timeEnd: timestamp('time_end', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('user_enrolments_enrol_id_idx').on(table.enrolId),
      index('user_enrolments_user_id_idx').on(table.userId),
  ]);


/** Worker's view of completion tables — needed by the completion-recalculate processor. */
export const courseModules = pgTable('course_modules', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  course: uuid('course').notNull(),
  visible: boolean('visible').notNull().default(true),
  deletionInProgress: boolean('deletion_in_progress').notNull().default(false),
},
  (table) => [
      index('course_modules_course_idx').on(table.course),
  ]);


export const courseModulesCompletion = pgTable('course_modules_completion', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  courseModuleId: uuid('course_module_id').notNull(),
  userId: uuid('user_id').notNull(),
  completionState: integer('completion_state').notNull().default(0),
  viewed: boolean('viewed').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
      index('course_modules_completion_course_module_id_idx').on(t.courseModuleId),
      index('course_modules_completion_user_id_idx').on(t.userId),unique('cmc_unique_worker').on(t.courseModuleId, t.userId)]);

export const courseCompletionCriteria = pgTable('course_completion_criteria', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  course: uuid('course').notNull(),
  criteriaType: text('criteria_type').notNull(),
  moduleInstance: uuid('module_instance'),
  date: timestamp('date', { withTimezone: true }),
  courseInstance: uuid('course_instance'),
  enrolPeriodDays: integer('enrol_period_days'),
  roleId: uuid('role_id'),
  sortOrder: integer('sort_order').notNull().default(0),
},
  (table) => [
      index('course_completion_criteria_course_idx').on(table.course),
      index('course_completion_criteria_module_instance_idx').on(table.moduleInstance),
  ]);

/** Manual-mark evidence for the self/role criteria types (canonical schema in apps/api). */
export const courseCompletionCritCompl = pgTable('course_completion_crit_compl', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  criteriaId: uuid('criteria_id').notNull(),
  userId: uuid('user_id').notNull(),
  markedBy: uuid('marked_by'),
  timeCompleted: timestamp('time_completed', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
      index('course_completion_crit_compl_user_id_idx').on(t.userId),unique('cccc_unique_worker').on(t.criteriaId, t.userId)]);


export const courseCompletionSettings = pgTable('course_completion_settings', {
  course: uuid('course').primaryKey(),
  method: integer('method').notNull().default(1),
});

export const courseCompletions = pgTable('course_completions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: uuid('user_id').notNull(),
  course: uuid('course').notNull(),
  status: text('status').notNull().default('not_started'),
  timeEnrolled: timestamp('time_enrolled', { withTimezone: true }).notNull().defaultNow(),
  timeStarted: timestamp('time_started', { withTimezone: true }),
  timeCompleted: timestamp('time_completed', { withTimezone: true }),
  reAggregate: timestamp('re_aggregate', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
      index('course_completions_user_id_idx').on(t.userId),
      index('course_completions_course_idx').on(t.course),unique('cc_unique_worker').on(t.userId, t.course)]);

/** Worker's view of grade tables (canonical schema in apps/api) — needed by the grade-regrade processor. */
export const gradeCategories = pgTable('grade_categories', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  courseId: uuid('course_id').notNull(),
  parent: uuid('parent'),
  fullName: text('full_name').notNull().default(''),
  aggregation: text('aggregation').notNull().default('natural'),
  dropLow: integer('drop_low').notNull().default(0),
  keepHigh: integer('keep_high').notNull().default(0),
  aggregateOnlyGraded: boolean('aggregate_only_graded').notNull().default(false),
  depth: integer('depth').notNull().default(1),
},
  (table) => [
      index('grade_categories_course_id_idx').on(table.courseId),
      index('grade_categories_parent_idx').on(table.parent),
  ]);


export const gradeItems = pgTable('grade_items', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  courseId: uuid('course_id').notNull(),
  categoryId: uuid('category_id'),
  itemName: text('item_name').notNull().default(''),
  itemType: text('item_type').notNull().default('manual'),
  itemInstance: uuid('item_instance'),
  gradeType: text('grade_type').notNull().default('value'),
  scaleId: uuid('scale_id'),
  outcomeId: uuid('outcome_id'),
  idNumber: text('id_number'),
  calculation: text('calculation'),
  gradeMax: doublePrecision('grade_max').notNull().default(100),
  gradeMin: doublePrecision('grade_min').notNull().default(0),
  gradePass: doublePrecision('grade_pass').notNull().default(0),
  weightOverride: boolean('weight_override').notNull().default(false),
  aggregationCoef: doublePrecision('aggregation_coef').notNull().default(0),
  extraCredit: boolean('extra_credit').notNull().default(false),
  multiplicator: doublePrecision('multiplicator').notNull().default(1),
  plusFactor: doublePrecision('plus_factor').notNull().default(0),
},
  (table) => [
      index('grade_items_course_id_idx').on(table.courseId),
      index('grade_items_category_id_idx').on(table.categoryId),
      index('grade_items_item_instance_idx').on(table.itemInstance),
  ]);


export const gradeGrades = pgTable('grade_grades', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  itemId: uuid('item_id').notNull(),
  userId: uuid('user_id').notNull(),
  rawGrade: doublePrecision('raw_grade'),
  finalGrade: doublePrecision('final_grade'),
  hidden: boolean('hidden').notNull().default(false),
  locked: boolean('locked').notNull().default(false),
  overridden: boolean('overridden').notNull().default(false),
  excluded: boolean('excluded').notNull().default(false),
  frozen: boolean('frozen').notNull().default(false),
  feedback: text('feedback'),
  aggregationStatus: text('aggregation_status').notNull().default('unknown'),
  aggregationWeight: doublePrecision('aggregation_weight'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
      index('grade_grades_item_id_idx').on(t.itemId),
      index('grade_grades_user_id_idx').on(t.userId),unique('gg_unique_worker').on(t.itemId, t.userId)]);

export const gradeGradesHistory = pgTable('grade_grades_history', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  action: integer('action').notNull().default(2),
  oldId: uuid('old_id'),
  itemId: uuid('item_id').notNull(),
  userId: uuid('user_id').notNull(),
  rawGrade: doublePrecision('raw_grade'),
  finalGrade: doublePrecision('final_grade'),
  overridden: boolean('overridden').notNull().default(false),
  excluded: boolean('excluded').notNull().default(false),
  frozen: boolean('frozen').notNull().default(false),
  source: text('source'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  loggedUser: uuid('logged_user'),
},
  (table) => [
      index('grade_grades_history_old_id_idx').on(table.oldId),
      index('grade_grades_history_item_id_idx').on(table.itemId),
      index('grade_grades_history_user_id_idx').on(table.userId),
      index('grade_grades_history_logged_user_idx').on(table.loggedUser),
  ]);


// ---------------------------------------------------------------------------
// Worker views of the communication & engagement tables (canonical
// schema in apps/api). Only the columns the processors touch.
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  username: text('username').notNull(),
  email: text('email').notNull().default(''),
  firstName: text('first_name').notNull().default(''),
  lastName: text('last_name').notNull().default(''),
  suspended: boolean('suspended').notNull().default(false),
  deleted: boolean('deleted').notNull().default(false),
  lastLogin: timestamp('last_login', { withTimezone: true }),
});

export const userPreferences = pgTable('user_preferences', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: uuid('user_id').notNull(),
  name: text('name').notNull(),
  value: text('value'),
}, (t) => [
      index('user_preferences_user_id_idx').on(t.userId),unique('user_preferences_unique_worker').on(t.userId, t.name)]);

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userIdFrom: uuid('user_id_from'),
  userIdTo: uuid('user_id_to').notNull(),
  subject: text('subject').notNull().default(''),
  fullMessage: text('full_message').notNull().default(''),
  smallMessage: text('small_message').notNull().default(''),
  component: text('component').notNull().default(''),
  eventType: text('event_type').notNull().default(''),
  contextUrl: text('context_url'),
  contextUrlName: text('context_url_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  timeRead: timestamp('time_read', { withTimezone: true }),
},
  (table) => [
      index('notifications_user_id_from_idx').on(table.userIdFrom),
      index('notifications_user_id_to_idx').on(table.userIdTo),
  ]);


export const notificationDispatchLog = pgTable('notification_dispatch_log', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  notificationId: uuid('notification_id'),
  userId: uuid('user_id').notNull(),
  provider: text('provider').notNull(),
  channel: text('channel').notNull(),
  status: text('status').notNull(),
  subject: text('subject').notNull().default(''),
  dedupeKey: text('dedupe_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
      index('notification_dispatch_log_notification_id_idx').on(t.notificationId),
      index('notification_dispatch_log_user_id_idx').on(t.userId),unique('notification_dispatch_log_dedupe_worker').on(t.dedupeKey)]);

export const calendarEvents = pgTable('calendar_events', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  eventType: text('event_type').notNull().default('user'),
  courseId: uuid('course_id'),
  groupId: uuid('group_id'),
  categoryId: uuid('category_id'),
  userId: uuid('user_id'),
  contextId: uuid('context_id'),
  subscriptionId: uuid('subscription_id'),
  uuid: text('uuid'),
  repeatId: uuid('repeat_id'),
  timeStart: timestamp('time_start', { withTimezone: true }).notNull(),
  timeDuration: integer('time_duration').notNull().default(0),
  visible: boolean('visible').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('calendar_events_course_id_idx').on(table.courseId),
      index('calendar_events_group_id_idx').on(table.groupId),
      index('calendar_events_category_id_idx').on(table.categoryId),
      index('calendar_events_user_id_idx').on(table.userId),
      index('calendar_events_context_id_idx').on(table.contextId),
      index('calendar_events_subscription_id_idx').on(table.subscriptionId),
      index('calendar_events_repeat_id_idx').on(table.repeatId),
  ]);


export const calendarSubscriptions = pgTable('calendar_subscriptions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  url: text('url'),
  icsData: text('ics_data'),
  eventType: text('event_type').notNull().default('site'),
  courseId: uuid('course_id'),
  categoryId: uuid('category_id'),
  userId: uuid('user_id'),
  pollInterval: integer('poll_interval').notNull().default(604800),
  lastUpdated: timestamp('last_updated', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('calendar_subscriptions_course_id_idx').on(table.courseId),
      index('calendar_subscriptions_category_id_idx').on(table.categoryId),
      index('calendar_subscriptions_user_id_idx').on(table.userId),
  ]);


export const badge = pgTable('badge', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  type: integer('type').notNull().default(1),
  courseId: uuid('course_id'),
  issuerName: text('issuer_name').notNull().default(''),
  status: integer('status').notNull().default(0),
  expireDate: timestamp('expire_date', { withTimezone: true }),
  expirePeriod: integer('expire_period'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('badge_course_id_idx').on(table.courseId),
  ]);


export const badgeCriteria = pgTable('badge_criteria', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  badgeId: uuid('badge_id').notNull(),
  criteriaType: text('criteria_type').notNull(),
  method: integer('method').notNull().default(1),
  params: jsonb('params').notNull().default({}),
  description: text('description').notNull().default(''),
},
  (table) => [
      index('badge_criteria_badge_id_idx').on(table.badgeId),
  ]);


export const badgeIssued = pgTable('badge_issued', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  badgeId: uuid('badge_id').notNull(),
  userId: uuid('user_id').notNull(),
  uniqueHash: text('unique_hash').notNull(),
  snapshot: jsonb('snapshot').notNull().default({}),
  evidence: jsonb('evidence').notNull().default({}),
  dateIssued: timestamp('date_issued', { withTimezone: true }).notNull().defaultNow(),
  dateExpire: timestamp('date_expire', { withTimezone: true }),
  visible: boolean('visible').notNull().default(true),
  revoked: boolean('revoked').notNull().default(false),
  issuerNotified: boolean('issuer_notified').notNull().default(false),
}, (t) => [
      index('badge_issued_badge_id_idx').on(t.badgeId),
      index('badge_issued_user_id_idx').on(t.userId),unique('badge_issued_badge_user_worker').on(t.badgeId, t.userId)]);

export const badgeManualAward = pgTable('badge_manual_award', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  badgeId: uuid('badge_id').notNull(),
  recipientId: uuid('recipient_id').notNull(),
  issuerId: uuid('issuer_id').notNull(),
  dateMet: timestamp('date_met', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('badge_manual_award_badge_id_idx').on(table.badgeId),
      index('badge_manual_award_recipient_id_idx').on(table.recipientId),
      index('badge_manual_award_issuer_id_idx').on(table.issuerId),
  ]);


/** Worker view of `cohort_members` (canonical schema in apps/api groups module) — needed by the badge `cohort` criteria leaf. */
export const cohortMembers = pgTable('cohort_members', {
  cohortId: uuid('cohort_id').notNull(),
  userId: uuid('user_id').notNull(),
  timeAdded: timestamp('time_added', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('cohort_members_unique_worker').on(t.cohortId, t.userId)]);

/** Worker view of the custom field tables (canonical schema in apps/api custom-fields module) — needed by the badge `profile` criteria leaf. */
export const customFieldCategory = pgTable('custom_field_category', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull().default(''),
  component: text('component').notNull(),
  area: text('area').notNull(),
});

export const customFieldField = pgTable('custom_field_field', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  categoryId: uuid('category_id').notNull(),
  shortName: text('short_name').notNull(),
  name: text('name').notNull().default(''),
  type: text('type').notNull().default('text'),
});

export const customFieldData = pgTable('custom_field_data', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  fieldId: uuid('field_id').notNull(),
  instanceId: uuid('instance_id').notNull(),
  value: text('value'),
});


export const competencyUserComp = pgTable('competency_user_comp', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: uuid('user_id').notNull(),
  competencyId: uuid('competency_id').notNull(),
  planId: uuid('plan_id'),
  courseId: uuid('course_id'),
  status: integer('status').notNull().default(0),
  proficiency: boolean('proficiency'),
  grade: integer('grade'),
},
  (table) => [
      index('competency_user_comp_user_id_idx').on(table.userId),
      index('competency_user_comp_competency_id_idx').on(table.competencyId),
      index('competency_user_comp_plan_id_idx').on(table.planId),
      index('competency_user_comp_course_id_idx').on(table.courseId),
  ]);


// ---------------------------------------------------------------------------
// Platform Services (worker view)
// ---------------------------------------------------------------------------

/** Tài liệu tìm kiếm (worker reindex). */
export const searchDocuments = pgTable('search_documents', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  area: text('area').notNull(),
  itemId: uuid('item_id').notNull(),
  contextId: uuid('context_id').notNull(),
  title: text('title').notNull().default(''),
  content: text('content').notNull().default(''),
  ownerId: uuid('owner_id'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
      index('search_documents_item_id_idx').on(t.itemId),
      index('search_documents_context_id_idx').on(t.contextId),
      index('search_documents_owner_id_idx').on(t.ownerId),unique('search_documents_area_item_unique').on(t.area, t.itemId)]);

/** Các khoá học (worker backup/analytics cần đọc tiêu đề). */
export const course = pgTable('course', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  category: uuid('category').notNull(),
  fullName: text('full_name').notNull(),
  shortName: text('short_name').notNull().unique(),
  summary: text('summary').notNull().default(''),
  visible: boolean('visible').notNull().default(true),
},
  (table) => [
      index('course_category_idx').on(table.category),
  ]);


/** Context (worker cần course context cho search/analytics). */
export const contextTable = pgTable('context', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  contextLevel: integer('context_level').notNull(),
  instanceId: uuid('instance_id'),
  path: text('path').notNull(),
  depth: integer('depth').notNull(),
},
  (table) => [
      index('context_instance_id_idx').on(table.instanceId),
  ]);


/** Việc sao lưu/khôi phục (worker backup/restore processors). */
export const backupJobs = pgTable('backup_jobs', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  type: text('type').notNull(),
  scope: text('scope').notNull().default('course'),
  courseId: uuid('course_id'),
  targetCourseId: uuid('target_course_id'),
  mode: text('mode').notNull().default('new'),
  status: text('status').notNull().default('pending'),
  anonymize: boolean('anonymize').notNull().default(false),
  userId: uuid('user_id').notNull(),
  archive: jsonb('archive'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  timeFinished: timestamp('time_finished', { withTimezone: true }),
},
  (table) => [
      index('backup_jobs_course_id_idx').on(table.courseId),
      index('backup_jobs_target_course_id_idx').on(table.targetCourseId),
      index('backup_jobs_user_id_idx').on(table.userId),
  ]);

export const backupJobSteps = pgTable('backup_job_steps', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  jobId: uuid('job_id').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull().default('pending'),
  detail: jsonb('detail'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('backup_job_steps_job_id_idx').on(table.jobId),
  ]);


/** Mô hình/dự đoán/insight analytics (worker run). */
export const analyticsModels = pgTable('analytics_models', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull().unique(),
  target: text('target').notNull(),
  indicators: jsonb('indicators').notNull().default([]),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const analyticsPredictions = pgTable('analytics_predictions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  modelId: uuid('model_id').notNull(),
  userId: uuid('user_id').notNull(),
  contextId: uuid('context_id').notNull(),
  courseId: uuid('course_id'),
  score: doublePrecision('score').notNull().default(0),
  data: jsonb('data'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('analytics_predictions_model_id_idx').on(table.modelId),
      index('analytics_predictions_user_id_idx').on(table.userId),
      index('analytics_predictions_context_id_idx').on(table.contextId),
      index('analytics_predictions_course_id_idx').on(table.courseId),
  ]);

export const insights = pgTable('insights', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  modelId: uuid('model_id').notNull(),
  predictionId: uuid('prediction_id'),
  userId: uuid('user_id').notNull(),
  recipientId: uuid('recipient_id').notNull(),
  contextId: uuid('context_id').notNull(),
  courseId: uuid('course_id'),
  heading: text('heading').notNull().default(''),
  data: jsonb('data'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('insights_model_id_idx').on(table.modelId),
      index('insights_prediction_id_idx').on(table.predictionId),
      index('insights_user_id_idx').on(table.userId),
      index('insights_recipient_id_idx').on(table.recipientId),
      index('insights_context_id_idx').on(table.contextId),
      index('insights_course_id_idx').on(table.courseId),
  ]);


/** Báo cáo + lịch (worker report schedule). */
export const reportBuilderReport = pgTable('report_builder_report', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  dataSource: text('data_source').notNull(),
  columns: jsonb('columns').notNull().default([]),
  filters: jsonb('filters').notNull().default({}),
  createdBy: uuid('created_by').notNull(),
  contextId: uuid('context_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('report_builder_report_created_by_idx').on(table.createdBy),
      index('report_builder_report_context_id_idx').on(table.contextId),
  ]);

export const reportBuilderSchedule = pgTable('report_builder_schedule', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  reportId: uuid('report_id').notNull(),
  createdBy: uuid('created_by').notNull(),
  cron: text('cron').notNull().default('daily'),
  enabled: boolean('enabled').notNull().default(true),
  lastRun: timestamp('last_run', { withTimezone: true }),
  lastResult: jsonb('last_result'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('report_builder_schedule_report_id_idx').on(table.reportId),
      index('report_builder_schedule_created_by_idx').on(table.createdBy),
  ]);


/** Thanh toán (worker reconciliation + webhook twin). */
export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  accountId: uuid('account_id').notNull(),
  userId: uuid('user_id').notNull(),
  amount: integer('amount').notNull(),
  currency: text('currency').notNull(),
  status: text('status').notNull().default('pending'),
  gateway: text('gateway').notNull().default('manual'),
  externalTransactionId: text('external_transaction_id'),
  component: text('component').notNull().default(''),
  itemId: uuid('item_id'),
  data: jsonb('data'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('payments_account_id_idx').on(table.accountId),
      index('payments_user_id_idx').on(table.userId),
      index('payments_item_id_idx').on(table.itemId),
  ]);


/** Yêu cầu privacy (worker export/delete processors). */
export const privacyRequests = pgTable('privacy_requests', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: uuid('user_id').notNull(),
  type: text('type').notNull(),
  status: text('status').notNull().default('pending'),
  requestedBy: uuid('requested_by').notNull(),
  approvedBy: uuid('approved_by'),
  result: jsonb('result'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('privacy_requests_user_id_idx').on(table.userId),
      index('privacy_requests_requested_by_idx').on(table.requestedBy),
      index('privacy_requests_approved_by_idx').on(table.approvedBy),
  ]);

export const privacyExportFiles = pgTable('privacy_export_files', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  requestId: uuid('request_id').notNull(),
  fileId: uuid('file_id'),
  subsystem: text('subsystem').notNull().default(''),
  manifest: jsonb('manifest'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('privacy_export_files_request_id_idx').on(table.requestId),
      index('privacy_export_files_file_id_idx').on(table.fileId),
  ]);


/** Worker view of the question bank tables (canonical schema in apps/api questions module) — needed by the backup processor to count/export the bank sections of an archive. */
export const questionCategories = pgTable('question_categories', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  contextId: uuid('context_id').notNull(),
  parent: uuid('parent'),
}, (t) => [index('question_categories_context_id_idx').on(t.contextId)]);

export const question = pgTable('question', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  category: uuid('category').notNull(),
  qtype: text('qtype').notNull(),
  name: text('name').notNull(),
}, (t) => [index('question_category_idx').on(t.category)]);

export const questionBankEntries = pgTable('question_bank_entries', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  questionCategoryId: uuid('question_category_id').notNull(),
  questionId: uuid('question_id').notNull(),
  latestVersion: integer('latest_version').notNull().default(1),
}, (t) => [index('question_bank_entries_question_category_id_idx').on(t.questionCategoryId)]);

export const questionVersions = pgTable('question_versions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  questionBankEntryId: uuid('question_bank_entry_id').notNull(),
  questionId: uuid('question_id').notNull(),
  version: integer('version').notNull(),
}, (t) => [index('question_versions_question_id_idx').on(t.questionId)]);

/**
 * Worker view of the quiz tables (canonical schema in apps/api quiz
 * module) — needed by the activity-due-reminder processor (lát N5,
 * issue #50) to find quizzes whose time_close falls inside the
 * reminder window and the attempts that already count as submitted.
 * state: inprogress | needsgrading | finished.
 */
export const quizzes = pgTable('quizzes', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  course: uuid('course').notNull(),
  cmId: uuid('cm_id'),
  name: text('name').notNull(),
  timeClose: timestamp('time_close', { withTimezone: true }),
}, (t) => [index('quizzes_course_idx').on(t.course)]);

export const quizAttempts = pgTable('quiz_attempts', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  quizId: uuid('quiz_id').notNull(),
  userId: uuid('user_id').notNull(),
  state: text('state').notNull().default('inprogress'),
  preview: boolean('preview').notNull().default(false),
}, (t) => [index('quiz_attempts_quiz_id_idx').on(t.quizId), index('quiz_attempts_user_id_idx').on(t.userId)]);

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
  jobId: uuid('job_id').notNull(),
  itemType: text('item_type').notNull(),
  oldId: uuid('old_id').notNull(),
  newId: uuid('new_id').notNull(),
},
  (table) => [
      index('backup_id_mappings_job_id_idx').on(table.jobId),
      index('backup_id_mappings_old_id_idx').on(table.oldId),
      index('backup_id_mappings_new_id_idx').on(table.newId),
  ]);

export const role = pgTable('role', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull().default(''),
  shortName: text('short_name').notNull().unique(),
  archetype: text('archetype'),
});
export const roleAssignments = pgTable('role_assignments', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  roleId: uuid('role_id').notNull(),
  userId: uuid('user_id').notNull(),
  contextId: uuid('context_id').notNull(),
},
  (table) => [
      index('role_assignments_role_id_idx').on(table.roleId),
      index('role_assignments_user_id_idx').on(table.userId),
      index('role_assignments_context_id_idx').on(table.contextId),
  ]);

export const blogPosts = pgTable('blog_posts', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: uuid('user_id').notNull(),
  subject: text('subject').notNull().default(''),
  summary: text('summary').notNull().default(''),
  content: text('content').notNull().default(''),
  publishState: text('publish_state').notNull().default('draft'),
},
  (table) => [
      index('blog_posts_user_id_idx').on(table.userId),
  ]);

export const contentBankContent = pgTable('content_bank_content', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  contentType: text('content_type').notNull().default('file-based'),
  contextId: uuid('context_id').notNull(),
  creatorId: uuid('creator_id').notNull(),
  visibility: text('visibility').notNull().default('draft'),
  fileId: uuid('file_id'),
},
  (table) => [
      index('content_bank_content_context_id_idx').on(table.contextId),
      index('content_bank_content_creator_id_idx').on(table.creatorId),
      index('content_bank_content_file_id_idx').on(table.fileId),
  ]);


/** Immutable domain event log (worker's view — canonical schema in apps/api): the relay mirrors published outbox rows here (logstore). */
export const eventLog = pgTable('event_log', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`).$defaultFn(() => uuidv7()),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().unique(),
  eventType: text('event_type').notNull(),
  contextId: uuid('context_id'),
  userId: uuid('user_id'),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('event_log_context_id_idx').on(table.contextId),
      index('event_log_user_id_idx').on(table.userId),
  ]);

/** Execution log of scheduled/adhoc tasks (worker's view — canonical schema in apps/api). */
export const taskLog = pgTable('task_log', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  taskName: text('task_name').notNull(),
  status: text('status').notNull(),
  message: text('message'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

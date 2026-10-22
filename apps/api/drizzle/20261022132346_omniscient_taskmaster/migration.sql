CREATE TABLE "admin_setting_audit" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"setting_key" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"changed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"key" text NOT NULL UNIQUE,
	"value" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"seq" bigint UNIQUE GENERATED ALWAYS AS IDENTITY (sequence name "event_log_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event_type" text NOT NULL,
	"context_id" uuid,
	"user_id" uuid,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"seq" bigint UNIQUE GENERATED ALWAYS AS IDENTITY (sequence name "outbox_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"aggregate" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "plugin_config" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"plugin" text NOT NULL,
	"name" text NOT NULL,
	"value" text,
	CONSTRAINT "plugin_config_plugin_name_unique" UNIQUE("plugin","name")
);
--> statement-breakpoint
CREATE TABLE "scheduled_task_config" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"task_name" text NOT NULL UNIQUE,
	"schedule" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"task_name" text NOT NULL,
	"status" text NOT NULL,
	"message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "capabilities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL UNIQUE,
	"captype" text DEFAULT 'write' NOT NULL,
	"contextlevel" integer DEFAULT 10 NOT NULL,
	"component" text DEFAULT 'core' NOT NULL,
	"riskbitmask" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"contextlevel" integer NOT NULL,
	"instanceid" uuid,
	"path" text NOT NULL,
	"depth" integer NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "context_level_instance_unique" UNIQUE("contextlevel","instanceid")
);
--> statement-breakpoint
CREATE TABLE "role" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text DEFAULT '' NOT NULL,
	"shortname" text NOT NULL UNIQUE,
	"description" text DEFAULT '' NOT NULL,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"archetype" text
);
--> statement-breakpoint
CREATE TABLE "role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"roleid" uuid NOT NULL,
	"userid" uuid NOT NULL,
	"contextid" uuid NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	"modifierid" uuid,
	"component" text DEFAULT '' NOT NULL,
	"itemid" uuid,
	CONSTRAINT "role_assignments_unique" UNIQUE("roleid","userid","contextid","component","itemid")
);
--> statement-breakpoint
CREATE TABLE "role_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"contextid" uuid NOT NULL,
	"roleid" uuid NOT NULL,
	"capability" text NOT NULL,
	"permission" integer NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	"modifierid" uuid,
	CONSTRAINT "role_capabilities_unique" UNIQUE("contextid","roleid","capability")
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"userid" uuid NOT NULL,
	"name" text NOT NULL,
	"value" text,
	CONSTRAINT "user_preferences_unique" UNIQUE("userid","name")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"username" text NOT NULL UNIQUE,
	"email" text NOT NULL UNIQUE,
	"password_hash" text,
	"firstname" text DEFAULT '' NOT NULL,
	"lastname" text DEFAULT '' NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"force_password_change" boolean DEFAULT false NOT NULL,
	"is_guest" boolean DEFAULT false NOT NULL,
	"lastlogin" timestamp with time zone,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"userid" uuid,
	"username" text NOT NULL,
	"success" boolean NOT NULL,
	"ip" text,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_token_family" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"family_id" text NOT NULL UNIQUE,
	"userid" uuid NOT NULL,
	"current_token_hash" text NOT NULL,
	"previous_token_hash" text,
	"revoked" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customfield_category" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"component" text NOT NULL,
	"area" text NOT NULL,
	"itemid" uuid,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customfield_data" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"fieldid" uuid NOT NULL,
	"instanceid" uuid NOT NULL,
	"value" text,
	"valueformat" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customfield_data_unique" UNIQUE("fieldid","instanceid")
);
--> statement-breakpoint
CREATE TABLE "customfield_field" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"categoryid" uuid NOT NULL,
	"shortname" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"configdata" jsonb DEFAULT '{}' NOT NULL,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"contenthash" text NOT NULL,
	"contextid" uuid NOT NULL,
	"component" text NOT NULL,
	"filearea" text NOT NULL,
	"itemid" uuid,
	"filepath" text DEFAULT '/' NOT NULL,
	"filename" text NOT NULL,
	"userid" uuid,
	"filesize" integer NOT NULL,
	"mimetype" text,
	"status" integer DEFAULT 0 NOT NULL,
	"source" text,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"category" uuid NOT NULL,
	"fullname" text NOT NULL,
	"shortname" text NOT NULL UNIQUE,
	"idnumber" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"format" text DEFAULT 'topics' NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"startdate" timestamp with time zone,
	"enddate" timestamp with time zone,
	"groupmode" integer DEFAULT 0 NOT NULL,
	"enablecompletion" boolean DEFAULT true NOT NULL,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_categories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"idnumber" text,
	"description" text DEFAULT '' NOT NULL,
	"parent" uuid,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"path" text DEFAULT '' NOT NULL,
	"depth" integer DEFAULT 1 NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_format_options" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"courseid" uuid NOT NULL,
	"format" text NOT NULL,
	"sectionid" uuid,
	"name" text NOT NULL,
	"value" text,
	CONSTRAINT "course_format_options_unique" UNIQUE("courseid","format","sectionid","name")
);
--> statement-breakpoint
CREATE TABLE "course_modules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course" uuid NOT NULL,
	"section" uuid NOT NULL,
	"component" text NOT NULL,
	"instanceid" uuid,
	"name" text DEFAULT '' NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"groupmode" integer DEFAULT 0 NOT NULL,
	"availability" jsonb,
	"completion" integer DEFAULT 0 NOT NULL,
	"completionview" boolean DEFAULT false NOT NULL,
	"completionusegrade" boolean DEFAULT false NOT NULL,
	"completionmanual" boolean DEFAULT false NOT NULL,
	"completionexpected" timestamp with time zone,
	"deletioninprogress" boolean DEFAULT false NOT NULL,
	"added" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_sections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course" uuid NOT NULL,
	"section" integer DEFAULT 0 NOT NULL,
	"name" text,
	"summary" text DEFAULT '' NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"availability" jsonb,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_sections_course_section_unique" UNIQUE("course","section")
);
--> statement-breakpoint
CREATE TABLE "cohort" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"idnumber" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"contextid" uuid NOT NULL,
	"component" text DEFAULT '' NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cohort_members" (
	"cohortid" uuid,
	"userid" uuid,
	"timeadded" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cohort_members_pkey" PRIMARY KEY("cohortid","userid")
);
--> statement-breakpoint
CREATE TABLE "course_groups" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"courseid" uuid NOT NULL,
	"name" text NOT NULL,
	"idnumber" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_groups_course_name_unique" UNIQUE("courseid","name")
);
--> statement-breakpoint
CREATE TABLE "groupings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"courseid" uuid NOT NULL,
	"name" text NOT NULL,
	"idnumber" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groupings_course_name_unique" UNIQUE("courseid","name")
);
--> statement-breakpoint
CREATE TABLE "groupings_groups" (
	"groupingid" uuid,
	"groupid" uuid,
	"timeadded" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groupings_groups_pkey" PRIMARY KEY("groupingid","groupid")
);
--> statement-breakpoint
CREATE TABLE "groups_members" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"groupid" uuid NOT NULL,
	"userid" uuid NOT NULL,
	"timeadded" timestamp with time zone DEFAULT now() NOT NULL,
	"component" text DEFAULT '' NOT NULL,
	"itemid" uuid,
	CONSTRAINT "groups_members_unique" UNIQUE("groupid","userid","component","itemid")
);
--> statement-breakpoint
CREATE TABLE "enrol" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"courseid" uuid NOT NULL,
	"enrol" text NOT NULL,
	"status" integer DEFAULT 0 NOT NULL,
	"name" text,
	"roleid" uuid,
	"enrolperiod" integer DEFAULT 0 NOT NULL,
	"timestart" timestamp with time zone,
	"timeend" timestamp with time zone,
	"customint1" uuid,
	"customint2" uuid,
	"customtext1" text DEFAULT 'suspend' NOT NULL,
	"cost" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT '' NOT NULL,
	"paymentaccountid" uuid,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_enrolments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"enrolid" uuid NOT NULL,
	"userid" uuid NOT NULL,
	"status" integer DEFAULT 0 NOT NULL,
	"timestart" timestamp with time zone DEFAULT now() NOT NULL,
	"timeend" timestamp with time zone,
	"modifierid" uuid,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_enrolments_unique" UNIQUE("enrolid","userid")
);
--> statement-breakpoint
CREATE TABLE "course_completion_criteria" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course" uuid NOT NULL,
	"criteriatype" text NOT NULL,
	"moduleinstance" uuid,
	"date" timestamp with time zone,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_completion_settings" (
	"course" uuid PRIMARY KEY,
	"method" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_completions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"userid" uuid NOT NULL,
	"course" uuid NOT NULL,
	"status" text DEFAULT 'not_started' NOT NULL,
	"timeenrolled" timestamp with time zone DEFAULT now() NOT NULL,
	"timestarted" timestamp with time zone,
	"timecompleted" timestamp with time zone,
	"reaggregate" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_completions_unique" UNIQUE("userid","course")
);
--> statement-breakpoint
CREATE TABLE "course_modules_completion" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"coursemoduleid" uuid NOT NULL,
	"userid" uuid NOT NULL,
	"completionstate" integer DEFAULT 0 NOT NULL,
	"viewed" boolean DEFAULT false NOT NULL,
	"overrideby" uuid,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_modules_completion_unique" UNIQUE("coursemoduleid","userid")
);
--> statement-breakpoint
CREATE TABLE "grade_categories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"courseid" uuid NOT NULL,
	"parent" uuid,
	"fullname" text DEFAULT '' NOT NULL,
	"aggregation" text DEFAULT 'natural' NOT NULL,
	"droplow" integer DEFAULT 0 NOT NULL,
	"keephigh" integer DEFAULT 0 NOT NULL,
	"aggregateonlygraded" boolean DEFAULT false NOT NULL,
	"depth" integer DEFAULT 1 NOT NULL,
	"path" text DEFAULT '' NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grade_grades" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"itemid" uuid NOT NULL,
	"userid" uuid NOT NULL,
	"rawgrade" double precision,
	"rawgrademax" double precision DEFAULT 100 NOT NULL,
	"rawgrademin" double precision DEFAULT 0 NOT NULL,
	"finalgrade" double precision,
	"hidden" boolean DEFAULT false NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"locktime" timestamp with time zone,
	"overridden" boolean DEFAULT false NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"frozen" boolean DEFAULT false NOT NULL,
	"feedback" text,
	"information" text,
	"aggregationstatus" text DEFAULT 'unknown' NOT NULL,
	"aggregationweight" double precision,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grade_grades_item_user_unique" UNIQUE("itemid","userid")
);
--> statement-breakpoint
CREATE TABLE "grade_grades_history" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"action" integer DEFAULT 2 NOT NULL,
	"oldid" uuid,
	"itemid" uuid NOT NULL,
	"userid" uuid NOT NULL,
	"rawgrade" double precision,
	"finalgrade" double precision,
	"overridden" boolean DEFAULT false NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"frozen" boolean DEFAULT false NOT NULL,
	"source" text,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	"loggeduser" uuid
);
--> statement-breakpoint
CREATE TABLE "grade_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"courseid" uuid NOT NULL,
	"categoryid" uuid,
	"itemname" text DEFAULT '' NOT NULL,
	"itemtype" text DEFAULT 'manual' NOT NULL,
	"itemmodule" text,
	"iteminstance" uuid,
	"gradetype" text DEFAULT 'value' NOT NULL,
	"grademax" double precision DEFAULT 100 NOT NULL,
	"grademin" double precision DEFAULT 0 NOT NULL,
	"gradepass" double precision DEFAULT 0 NOT NULL,
	"scaleid" uuid,
	"weightoverride" boolean DEFAULT false NOT NULL,
	"aggregationcoef" double precision DEFAULT 0 NOT NULL,
	"extracredit" boolean DEFAULT false NOT NULL,
	"multiplicator" double precision DEFAULT 1 NOT NULL,
	"plusfactor" double precision DEFAULT 0 NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grade_items_course_type_instance_unique" UNIQUE("courseid","itemtype","iteminstance","itemmodule")
);
--> statement-breakpoint
CREATE TABLE "grade_letters" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"contextid" uuid NOT NULL,
	"lowerboundary" double precision NOT NULL,
	"letter" text NOT NULL,
	CONSTRAINT "grade_letters_context_boundary_unique" UNIQUE("contextid","lowerboundary")
);
--> statement-breakpoint
CREATE TABLE "scales" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"courseid" uuid,
	"name" text NOT NULL,
	"scale" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"category" uuid NOT NULL,
	"qtype" text NOT NULL,
	"name" text NOT NULL,
	"createdby" uuid,
	"modifiedby" uuid,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_attempt_step_data" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"attemptstepid" uuid NOT NULL,
	"name" text NOT NULL,
	"value" text,
	CONSTRAINT "question_attempt_step_data_step_name_unique" UNIQUE("attemptstepid","name")
);
--> statement-breakpoint
CREATE TABLE "question_attempt_steps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"questionattemptid" uuid NOT NULL,
	"sequencenumber" integer NOT NULL,
	"state" text NOT NULL,
	"fraction" double precision,
	"userid" uuid,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_attempt_steps_attempt_seq_unique" UNIQUE("questionattemptid","sequencenumber")
);
--> statement-breakpoint
CREATE TABLE "question_attempts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"questionusageid" uuid NOT NULL,
	"slot" integer NOT NULL,
	"behaviour" text DEFAULT 'deferredfeedback' NOT NULL,
	"questionid" uuid NOT NULL,
	"questionversionid" uuid,
	"variant" integer DEFAULT 1 NOT NULL,
	"maxmark" double precision DEFAULT 1 NOT NULL,
	"minfraction" double precision DEFAULT 0 NOT NULL,
	"maxfraction" double precision DEFAULT 1 NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"questionsummary" text,
	"responsesummary" text,
	"rightanswer" text,
	"state" text DEFAULT 'notstarted' NOT NULL,
	"fraction" double precision,
	"userid" uuid,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_attempts_usage_slot_unique" UNIQUE("questionusageid","slot")
);
--> statement-breakpoint
CREATE TABLE "question_bank_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"questioncategoryid" uuid NOT NULL,
	"questionid" uuid NOT NULL CONSTRAINT "question_bank_entries_question_unique" UNIQUE,
	"latestversion" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_categories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"contextid" uuid NOT NULL,
	"info" text DEFAULT '' NOT NULL,
	"parent" uuid,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"stamp" text DEFAULT '' NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_usages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"component" text NOT NULL,
	"instanceid" uuid,
	"owningcontextid" uuid,
	"preferredbehaviour" text DEFAULT 'deferredfeedback' NOT NULL,
	"userid" uuid,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"questionbankentryid" uuid NOT NULL,
	"questionid" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"questiontext" text DEFAULT '' NOT NULL,
	"defaultmark" double precision DEFAULT 1 NOT NULL,
	"answerdata" jsonb DEFAULT '{}' NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_versions_entry_version_unique" UNIQUE("questionbankentryid","version")
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"conversationid" uuid NOT NULL,
	"useridfrom" uuid NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"fullmessage" text DEFAULT '' NOT NULL,
	"smallmessage" text DEFAULT '' NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timeread" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "message_conversation_members" (
	"conversationid" uuid,
	"userid" uuid,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_conversation_members_pkey" PRIMARY KEY("conversationid","userid")
);
--> statement-breakpoint
CREATE TABLE "message_conversations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"type" integer DEFAULT 1 NOT NULL,
	"name" text,
	"component" text,
	"itemtype" text,
	"itemid" uuid,
	"contextid" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_users_blocked" (
	"userid" uuid,
	"blockeduserid" uuid,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_users_blocked_pkey" PRIMARY KEY("userid","blockeduserid")
);
--> statement-breakpoint
CREATE TABLE "notification_dispatch_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"notificationid" uuid,
	"userid" uuid NOT NULL,
	"provider" text NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"dedupekey" text CONSTRAINT "notification_dispatch_log_dedupe_unique" UNIQUE,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"useridfrom" uuid,
	"useridto" uuid NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"fullmessage" text DEFAULT '' NOT NULL,
	"smallmessage" text DEFAULT '' NOT NULL,
	"component" text DEFAULT '' NOT NULL,
	"eventtype" text DEFAULT '' NOT NULL,
	"contexturl" text,
	"contexturlname" text,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timeread" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"eventtype" text DEFAULT 'user' NOT NULL,
	"courseid" uuid,
	"groupid" uuid,
	"categoryid" uuid,
	"userid" uuid,
	"contextid" uuid,
	"subscriptionid" uuid,
	"uuid" text,
	"repeatid" uuid,
	"rrule" text,
	"isexception" boolean DEFAULT false NOT NULL,
	"exceptionof" uuid,
	"timestart" timestamp with time zone NOT NULL,
	"timeduration" integer DEFAULT 0 NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"url" text,
	"icsdata" text,
	"eventtype" text DEFAULT 'site' NOT NULL,
	"courseid" uuid,
	"categoryid" uuid,
	"userid" uuid,
	"pollinterval" integer DEFAULT 604800 NOT NULL,
	"lastupdated" timestamp with time zone,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "badge" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"type" integer DEFAULT 1 NOT NULL,
	"courseid" uuid,
	"issuername" text DEFAULT '' NOT NULL,
	"issuerurl" text DEFAULT '' NOT NULL,
	"issuercontact" text DEFAULT '' NOT NULL,
	"expiredate" timestamp with time zone,
	"expireperiod" integer,
	"status" integer DEFAULT 0 NOT NULL,
	"version" text DEFAULT '' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"usercreated" uuid,
	"usermodified" uuid,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "badge_criteria" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"badgeid" uuid NOT NULL,
	"criteriatype" text NOT NULL,
	"method" integer DEFAULT 1 NOT NULL,
	"params" jsonb DEFAULT '{}' NOT NULL,
	"description" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "badge_issued" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"badgeid" uuid NOT NULL,
	"userid" uuid NOT NULL,
	"uniquehash" text NOT NULL UNIQUE,
	"snapshot" jsonb DEFAULT '{}' NOT NULL,
	"evidence" jsonb DEFAULT '{}' NOT NULL,
	"dateissued" timestamp with time zone DEFAULT now() NOT NULL,
	"dateexpire" timestamp with time zone,
	"visible" boolean DEFAULT true NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"revokedat" timestamp with time zone,
	"issuernotified" boolean DEFAULT false NOT NULL,
	CONSTRAINT "badge_issued_badge_user_unique" UNIQUE("badgeid","userid")
);
--> statement-breakpoint
CREATE TABLE "badge_manual_award" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"badgeid" uuid NOT NULL,
	"recipientid" uuid NOT NULL,
	"issuerid" uuid NOT NULL,
	"issuerrole" uuid,
	"datemet" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "badge_manual_award_unique" UNIQUE("badgeid","recipientid","issuerid")
);
--> statement-breakpoint
CREATE TABLE "competency" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"frameworkid" uuid NOT NULL,
	"shortname" text NOT NULL,
	"idnumber" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"parentid" uuid,
	"path" text DEFAULT '' NOT NULL,
	"depth" integer DEFAULT 1 NOT NULL,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competency_coursecomp" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"courseid" uuid NOT NULL,
	"competencyid" uuid NOT NULL,
	"ruleoutcome" text DEFAULT 'nothing' NOT NULL,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competency_coursecomp_unique" UNIQUE("courseid","competencyid")
);
--> statement-breakpoint
CREATE TABLE "competency_evidence" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"usercompetencyid" uuid NOT NULL,
	"contextid" uuid,
	"actionuserid" uuid NOT NULL,
	"action" text DEFAULT 'evidence' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"url" text,
	"grade" integer,
	"note" text DEFAULT '' NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competency_framework" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"shortname" text NOT NULL,
	"idnumber" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"contextid" uuid NOT NULL,
	"scaleconfiguration" jsonb DEFAULT '{}' NOT NULL,
	"taxonomies" text DEFAULT 'competency' NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competency_modulecomp" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"coursemoduleid" uuid NOT NULL,
	"competencyid" uuid NOT NULL,
	"ruleoutcome" text DEFAULT 'nothing' NOT NULL,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competency_modulecomp_unique" UNIQUE("coursemoduleid","competencyid")
);
--> statement-breakpoint
CREATE TABLE "competency_plan_review" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"planid" uuid NOT NULL,
	"actorid" uuid NOT NULL,
	"action" text NOT NULL,
	"statusfrom" integer NOT NULL,
	"statusto" integer NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competency_plancomp" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"planid" uuid NOT NULL,
	"competencyid" uuid NOT NULL,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competency_plancomp_unique" UNIQUE("planid","competencyid")
);
--> statement-breakpoint
CREATE TABLE "competency_template" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"shortname" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"contextid" uuid NOT NULL,
	"duedate" timestamp with time zone,
	"visible" boolean DEFAULT true NOT NULL,
	"status" integer DEFAULT 1 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competency_templatecohort" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"templateid" uuid NOT NULL,
	"cohortid" uuid NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competency_templatecohort_unique" UNIQUE("templateid","cohortid")
);
--> statement-breakpoint
CREATE TABLE "competency_templatecomp" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"templateid" uuid NOT NULL,
	"competencyid" uuid NOT NULL,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competency_templatecomp_unique" UNIQUE("templateid","competencyid")
);
--> statement-breakpoint
CREATE TABLE "competency_usercomp" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"userid" uuid NOT NULL,
	"competencyid" uuid NOT NULL,
	"planid" uuid,
	"courseid" uuid,
	"status" integer DEFAULT 0 NOT NULL,
	"proficiency" boolean,
	"grade" integer,
	"reviewerid" uuid,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competency_usercomp_unique" UNIQUE("userid","competencyid","planid","courseid")
);
--> statement-breakpoint
CREATE TABLE "learning_plans" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"userid" uuid NOT NULL,
	"templateid" uuid,
	"status" integer DEFAULT 0 NOT NULL,
	"duedate" timestamp with time zone,
	"reviewerid" uuid,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blog_association" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"blogid" uuid NOT NULL,
	"contextid" uuid NOT NULL,
	"assoctype" text NOT NULL,
	"associd" uuid NOT NULL,
	CONSTRAINT "blog_association_unique" UNIQUE("blogid","assoctype","associd")
);
--> statement-breakpoint
CREATE TABLE "blog_posts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"userid" uuid NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"publishstate" text DEFAULT 'draft' NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"lastmodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"contextid" uuid NOT NULL,
	"component" text NOT NULL,
	"commentarea" text NOT NULL,
	"itemid" uuid NOT NULL,
	"content" text NOT NULL,
	"format" integer DEFAULT 1 NOT NULL,
	"userid" uuid NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timedeleted" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"courseid" uuid,
	"userid" uuid NOT NULL,
	"createdby" uuid NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"format" integer DEFAULT 1 NOT NULL,
	"publishstate" text DEFAULT 'draft' NOT NULL,
	"groupid" uuid,
	"usermodified" uuid,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"lastmodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rating" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"contextid" uuid NOT NULL,
	"component" text NOT NULL,
	"ratingarea" text NOT NULL,
	"itemid" uuid NOT NULL,
	"scaleid" integer NOT NULL,
	"rating" integer NOT NULL,
	"userid" uuid NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rating_unique" UNIQUE("contextid","component","ratingarea","itemid","userid")
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"userid" uuid,
	"tagcollid" uuid,
	"name" text NOT NULL,
	"rawname" text NOT NULL,
	"isstandard" boolean DEFAULT false NOT NULL,
	"flag" integer DEFAULT 0 NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_coll_name_unique" UNIQUE("tagcollid","name")
);
--> statement-breakpoint
CREATE TABLE "tag_collection" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"isstandard" boolean DEFAULT false NOT NULL,
	"component" text,
	"searchable" boolean DEFAULT true NOT NULL,
	"customurl" text
);
--> statement-breakpoint
CREATE TABLE "tag_correlation" (
	"tagid" uuid PRIMARY KEY,
	"correlatedtags" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag_instance" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"tagid" uuid NOT NULL,
	"component" text NOT NULL,
	"itemtype" text NOT NULL,
	"itemid" uuid NOT NULL,
	"contextid" uuid NOT NULL,
	"tiuserid" uuid,
	"ordering" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_instance_unique" UNIQUE("tagid","component","itemtype","itemid","contextid","tiuserid")
);
--> statement-breakpoint
CREATE TABLE "search_documents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"area" text NOT NULL,
	"itemid" uuid NOT NULL,
	"contextid" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"ownerid" uuid,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_documents_area_item_unique" UNIQUE("area","itemid")
);
--> statement-breakpoint
CREATE TABLE "external_services" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL UNIQUE,
	"shortname" text NOT NULL UNIQUE,
	"enabled" boolean DEFAULT true NOT NULL,
	"functions" jsonb DEFAULT '[]' NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"tokenhash" text NOT NULL UNIQUE,
	"userid" uuid NOT NULL,
	"serviceid" uuid NOT NULL,
	"validuntil" timestamp with time zone,
	"iprestriction" text,
	"revoked" boolean DEFAULT false NOT NULL,
	"lastaccess" timestamp with time zone,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_id_mappings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"jobid" uuid NOT NULL,
	"itemtype" text NOT NULL,
	"oldid" uuid NOT NULL,
	"newid" uuid NOT NULL,
	CONSTRAINT "backup_id_mappings_unique" UNIQUE("jobid","itemtype","oldid")
);
--> statement-breakpoint
CREATE TABLE "backup_job_steps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"jobid" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"detail" jsonb,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"type" text NOT NULL,
	"courseid" uuid NOT NULL,
	"targetcourseid" uuid,
	"mode" text DEFAULT 'new' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"anonymize" boolean DEFAULT false NOT NULL,
	"userid" uuid NOT NULL,
	"archive" jsonb,
	"error" text,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timefinished" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "analytics_models" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL UNIQUE,
	"target" text NOT NULL,
	"indicators" jsonb DEFAULT '[]' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_predictions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"modelid" uuid NOT NULL,
	"userid" uuid NOT NULL,
	"contextid" uuid NOT NULL,
	"courseid" uuid,
	"score" double precision DEFAULT 0 NOT NULL,
	"data" jsonb,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insights" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"modelid" uuid NOT NULL,
	"predictionid" uuid,
	"userid" uuid NOT NULL,
	"recipientid" uuid NOT NULL,
	"contextid" uuid NOT NULL,
	"courseid" uuid,
	"heading" text DEFAULT '' NOT NULL,
	"data" jsonb,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reportbuilder_audience" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"reportid" uuid NOT NULL,
	"userid" uuid,
	"role" text
);
--> statement-breakpoint
CREATE TABLE "reportbuilder_report" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"datasource" text NOT NULL,
	"columns" jsonb DEFAULT '[]' NOT NULL,
	"filters" jsonb DEFAULT '{}' NOT NULL,
	"createdby" uuid NOT NULL,
	"contextid" uuid,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reportbuilder_schedule" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"reportid" uuid NOT NULL,
	"createdby" uuid NOT NULL,
	"cron" text DEFAULT 'daily' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"lastrun" timestamp with time zone,
	"lastresult" jsonb,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contentbank_content" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"contenttype" text DEFAULT 'file-based' NOT NULL,
	"contextid" uuid NOT NULL,
	"creatorid" uuid NOT NULL,
	"visibility" text DEFAULT 'draft' NOT NULL,
	"fileid" uuid,
	"configdata" jsonb,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"gateway" text DEFAULT 'manual' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_refunds" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"paymentid" uuid NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"externaltransactionid" text,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"accountid" uuid NOT NULL,
	"userid" uuid NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"gateway" text DEFAULT 'manual' NOT NULL,
	"externaltransactionid" text,
	"component" text DEFAULT '' NOT NULL,
	"itemid" uuid,
	"data" jsonb,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_external_tx_unique" UNIQUE("gateway","externaltransactionid")
);
--> statement-breakpoint
CREATE TABLE "privacy_export_files" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"requestid" uuid NOT NULL,
	"fileid" uuid,
	"subsystem" text DEFAULT '' NOT NULL,
	"manifest" jsonb,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "privacy_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"userid" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requestedby" uuid NOT NULL,
	"approvedby" uuid,
	"result" jsonb,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "event_log_context_id_idx" ON "event_log" ("context_id");--> statement-breakpoint
CREATE INDEX "event_log_user_id_idx" ON "event_log" ("user_id");--> statement-breakpoint
CREATE INDEX "context_instanceid_idx" ON "context" ("instanceid");--> statement-breakpoint
CREATE INDEX "role_assignments_userid_idx" ON "role_assignments" ("userid");--> statement-breakpoint
CREATE INDEX "role_assignments_contextid_idx" ON "role_assignments" ("contextid");--> statement-breakpoint
CREATE INDEX "role_assignments_modifierid_idx" ON "role_assignments" ("modifierid");--> statement-breakpoint
CREATE INDEX "role_assignments_itemid_idx" ON "role_assignments" ("itemid");--> statement-breakpoint
CREATE INDEX "role_capabilities_roleid_idx" ON "role_capabilities" ("roleid");--> statement-breakpoint
CREATE INDEX "role_capabilities_modifierid_idx" ON "role_capabilities" ("modifierid");--> statement-breakpoint
CREATE INDEX "login_attempts_userid_idx" ON "login_attempts" ("userid");--> statement-breakpoint
CREATE INDEX "refresh_token_family_userid_idx" ON "refresh_token_family" ("userid");--> statement-breakpoint
CREATE INDEX "customfield_category_itemid_idx" ON "customfield_category" ("itemid");--> statement-breakpoint
CREATE INDEX "customfield_data_instanceid_idx" ON "customfield_data" ("instanceid");--> statement-breakpoint
CREATE INDEX "customfield_field_categoryid_idx" ON "customfield_field" ("categoryid");--> statement-breakpoint
CREATE INDEX "files_contextid_idx" ON "files" ("contextid");--> statement-breakpoint
CREATE INDEX "files_itemid_idx" ON "files" ("itemid");--> statement-breakpoint
CREATE INDEX "files_userid_idx" ON "files" ("userid");--> statement-breakpoint
CREATE INDEX "course_category_idx" ON "course" ("category");--> statement-breakpoint
CREATE INDEX "course_categories_parent_idx" ON "course_categories" ("parent");--> statement-breakpoint
CREATE INDEX "course_format_options_sectionid_idx" ON "course_format_options" ("sectionid");--> statement-breakpoint
CREATE INDEX "course_modules_course_idx" ON "course_modules" ("course");--> statement-breakpoint
CREATE INDEX "course_modules_instanceid_idx" ON "course_modules" ("instanceid");--> statement-breakpoint
CREATE INDEX "course_modules_section_idx" ON "course_modules" ("section");--> statement-breakpoint
CREATE INDEX "cohort_contextid_idx" ON "cohort" ("contextid");--> statement-breakpoint
CREATE INDEX "cohort_members_userid_idx" ON "cohort_members" ("userid");--> statement-breakpoint
CREATE INDEX "groupings_groups_groupid_idx" ON "groupings_groups" ("groupid");--> statement-breakpoint
CREATE INDEX "groups_members_userid_idx" ON "groups_members" ("userid");--> statement-breakpoint
CREATE INDEX "groups_members_itemid_idx" ON "groups_members" ("itemid");--> statement-breakpoint
CREATE INDEX "enrol_courseid_idx" ON "enrol" ("courseid");--> statement-breakpoint
CREATE INDEX "enrol_roleid_idx" ON "enrol" ("roleid");--> statement-breakpoint
CREATE INDEX "enrol_customint1_idx" ON "enrol" ("customint1");--> statement-breakpoint
CREATE INDEX "enrol_customint2_idx" ON "enrol" ("customint2");--> statement-breakpoint
CREATE INDEX "enrol_paymentaccountid_idx" ON "enrol" ("paymentaccountid");--> statement-breakpoint
CREATE INDEX "user_enrolments_userid_idx" ON "user_enrolments" ("userid");--> statement-breakpoint
CREATE INDEX "user_enrolments_modifierid_idx" ON "user_enrolments" ("modifierid");--> statement-breakpoint
CREATE INDEX "course_completion_criteria_course_idx" ON "course_completion_criteria" ("course");--> statement-breakpoint
CREATE INDEX "course_completion_criteria_moduleinstance_idx" ON "course_completion_criteria" ("moduleinstance");--> statement-breakpoint
CREATE INDEX "course_completions_course_idx" ON "course_completions" ("course");--> statement-breakpoint
CREATE INDEX "course_modules_completion_userid_idx" ON "course_modules_completion" ("userid");--> statement-breakpoint
CREATE INDEX "grade_categories_courseid_idx" ON "grade_categories" ("courseid");--> statement-breakpoint
CREATE INDEX "grade_categories_parent_idx" ON "grade_categories" ("parent");--> statement-breakpoint
CREATE INDEX "grade_grades_userid_idx" ON "grade_grades" ("userid");--> statement-breakpoint
CREATE INDEX "grade_grades_history_oldid_idx" ON "grade_grades_history" ("oldid");--> statement-breakpoint
CREATE INDEX "grade_grades_history_itemid_idx" ON "grade_grades_history" ("itemid");--> statement-breakpoint
CREATE INDEX "grade_grades_history_userid_idx" ON "grade_grades_history" ("userid");--> statement-breakpoint
CREATE INDEX "grade_grades_history_loggeduser_idx" ON "grade_grades_history" ("loggeduser");--> statement-breakpoint
CREATE INDEX "grade_items_categoryid_idx" ON "grade_items" ("categoryid");--> statement-breakpoint
CREATE INDEX "grade_items_iteminstance_idx" ON "grade_items" ("iteminstance");--> statement-breakpoint
CREATE INDEX "grade_items_scaleid_idx" ON "grade_items" ("scaleid");--> statement-breakpoint
CREATE INDEX "scales_courseid_idx" ON "scales" ("courseid");--> statement-breakpoint
CREATE INDEX "question_category_idx" ON "question" ("category");--> statement-breakpoint
CREATE INDEX "question_createdby_idx" ON "question" ("createdby");--> statement-breakpoint
CREATE INDEX "question_modifiedby_idx" ON "question" ("modifiedby");--> statement-breakpoint
CREATE INDEX "question_attempt_steps_userid_idx" ON "question_attempt_steps" ("userid");--> statement-breakpoint
CREATE INDEX "question_attempts_questionid_idx" ON "question_attempts" ("questionid");--> statement-breakpoint
CREATE INDEX "question_attempts_questionversionid_idx" ON "question_attempts" ("questionversionid");--> statement-breakpoint
CREATE INDEX "question_attempts_userid_idx" ON "question_attempts" ("userid");--> statement-breakpoint
CREATE INDEX "question_bank_entries_questioncategoryid_idx" ON "question_bank_entries" ("questioncategoryid");--> statement-breakpoint
CREATE INDEX "question_categories_contextid_idx" ON "question_categories" ("contextid");--> statement-breakpoint
CREATE INDEX "question_categories_parent_idx" ON "question_categories" ("parent");--> statement-breakpoint
CREATE INDEX "question_usages_instanceid_idx" ON "question_usages" ("instanceid");--> statement-breakpoint
CREATE INDEX "question_usages_owningcontextid_idx" ON "question_usages" ("owningcontextid");--> statement-breakpoint
CREATE INDEX "question_usages_userid_idx" ON "question_usages" ("userid");--> statement-breakpoint
CREATE INDEX "question_versions_questionid_idx" ON "question_versions" ("questionid");--> statement-breakpoint
CREATE INDEX "message_conversationid_idx" ON "message" ("conversationid");--> statement-breakpoint
CREATE INDEX "message_useridfrom_idx" ON "message" ("useridfrom");--> statement-breakpoint
CREATE INDEX "message_conversation_members_userid_idx" ON "message_conversation_members" ("userid");--> statement-breakpoint
CREATE INDEX "message_conversations_itemid_idx" ON "message_conversations" ("itemid");--> statement-breakpoint
CREATE INDEX "message_conversations_contextid_idx" ON "message_conversations" ("contextid");--> statement-breakpoint
CREATE INDEX "message_users_blocked_blockeduserid_idx" ON "message_users_blocked" ("blockeduserid");--> statement-breakpoint
CREATE INDEX "notification_dispatch_log_notificationid_idx" ON "notification_dispatch_log" ("notificationid");--> statement-breakpoint
CREATE INDEX "notification_dispatch_log_userid_idx" ON "notification_dispatch_log" ("userid");--> statement-breakpoint
CREATE INDEX "notifications_useridfrom_idx" ON "notifications" ("useridfrom");--> statement-breakpoint
CREATE INDEX "notifications_useridto_idx" ON "notifications" ("useridto");--> statement-breakpoint
CREATE INDEX "calendar_events_courseid_idx" ON "calendar_events" ("courseid");--> statement-breakpoint
CREATE INDEX "calendar_events_groupid_idx" ON "calendar_events" ("groupid");--> statement-breakpoint
CREATE INDEX "calendar_events_categoryid_idx" ON "calendar_events" ("categoryid");--> statement-breakpoint
CREATE INDEX "calendar_events_userid_idx" ON "calendar_events" ("userid");--> statement-breakpoint
CREATE INDEX "calendar_events_contextid_idx" ON "calendar_events" ("contextid");--> statement-breakpoint
CREATE INDEX "calendar_events_subscriptionid_idx" ON "calendar_events" ("subscriptionid");--> statement-breakpoint
CREATE INDEX "calendar_events_repeatid_idx" ON "calendar_events" ("repeatid");--> statement-breakpoint
CREATE INDEX "calendar_events_exceptionof_idx" ON "calendar_events" ("exceptionof");--> statement-breakpoint
CREATE INDEX "calendar_subscriptions_courseid_idx" ON "calendar_subscriptions" ("courseid");--> statement-breakpoint
CREATE INDEX "calendar_subscriptions_categoryid_idx" ON "calendar_subscriptions" ("categoryid");--> statement-breakpoint
CREATE INDEX "calendar_subscriptions_userid_idx" ON "calendar_subscriptions" ("userid");--> statement-breakpoint
CREATE INDEX "badge_courseid_idx" ON "badge" ("courseid");--> statement-breakpoint
CREATE INDEX "badge_usercreated_idx" ON "badge" ("usercreated");--> statement-breakpoint
CREATE INDEX "badge_criteria_badgeid_idx" ON "badge_criteria" ("badgeid");--> statement-breakpoint
CREATE INDEX "badge_issued_userid_idx" ON "badge_issued" ("userid");--> statement-breakpoint
CREATE INDEX "badge_manual_award_recipientid_idx" ON "badge_manual_award" ("recipientid");--> statement-breakpoint
CREATE INDEX "badge_manual_award_issuerid_idx" ON "badge_manual_award" ("issuerid");--> statement-breakpoint
CREATE INDEX "badge_manual_award_issuerrole_idx" ON "badge_manual_award" ("issuerrole");--> statement-breakpoint
CREATE INDEX "competency_frameworkid_idx" ON "competency" ("frameworkid");--> statement-breakpoint
CREATE INDEX "competency_parentid_idx" ON "competency" ("parentid");--> statement-breakpoint
CREATE INDEX "competency_coursecomp_competencyid_idx" ON "competency_coursecomp" ("competencyid");--> statement-breakpoint
CREATE INDEX "competency_evidence_usercompetencyid_idx" ON "competency_evidence" ("usercompetencyid");--> statement-breakpoint
CREATE INDEX "competency_evidence_contextid_idx" ON "competency_evidence" ("contextid");--> statement-breakpoint
CREATE INDEX "competency_evidence_actionuserid_idx" ON "competency_evidence" ("actionuserid");--> statement-breakpoint
CREATE INDEX "competency_framework_contextid_idx" ON "competency_framework" ("contextid");--> statement-breakpoint
CREATE INDEX "competency_modulecomp_competencyid_idx" ON "competency_modulecomp" ("competencyid");--> statement-breakpoint
CREATE INDEX "competency_plan_review_planid_idx" ON "competency_plan_review" ("planid");--> statement-breakpoint
CREATE INDEX "competency_plan_review_actorid_idx" ON "competency_plan_review" ("actorid");--> statement-breakpoint
CREATE INDEX "competency_plancomp_competencyid_idx" ON "competency_plancomp" ("competencyid");--> statement-breakpoint
CREATE INDEX "competency_template_contextid_idx" ON "competency_template" ("contextid");--> statement-breakpoint
CREATE INDEX "competency_templatecohort_cohortid_idx" ON "competency_templatecohort" ("cohortid");--> statement-breakpoint
CREATE INDEX "competency_templatecomp_competencyid_idx" ON "competency_templatecomp" ("competencyid");--> statement-breakpoint
CREATE INDEX "competency_usercomp_competencyid_idx" ON "competency_usercomp" ("competencyid");--> statement-breakpoint
CREATE INDEX "competency_usercomp_planid_idx" ON "competency_usercomp" ("planid");--> statement-breakpoint
CREATE INDEX "competency_usercomp_courseid_idx" ON "competency_usercomp" ("courseid");--> statement-breakpoint
CREATE INDEX "competency_usercomp_reviewerid_idx" ON "competency_usercomp" ("reviewerid");--> statement-breakpoint
CREATE INDEX "learning_plans_userid_idx" ON "learning_plans" ("userid");--> statement-breakpoint
CREATE INDEX "learning_plans_templateid_idx" ON "learning_plans" ("templateid");--> statement-breakpoint
CREATE INDEX "learning_plans_reviewerid_idx" ON "learning_plans" ("reviewerid");--> statement-breakpoint
CREATE INDEX "blog_association_contextid_idx" ON "blog_association" ("contextid");--> statement-breakpoint
CREATE INDEX "blog_association_associd_idx" ON "blog_association" ("associd");--> statement-breakpoint
CREATE INDEX "blog_posts_userid_idx" ON "blog_posts" ("userid");--> statement-breakpoint
CREATE INDEX "comments_contextid_idx" ON "comments" ("contextid");--> statement-breakpoint
CREATE INDEX "comments_itemid_idx" ON "comments" ("itemid");--> statement-breakpoint
CREATE INDEX "comments_userid_idx" ON "comments" ("userid");--> statement-breakpoint
CREATE INDEX "notes_courseid_idx" ON "notes" ("courseid");--> statement-breakpoint
CREATE INDEX "notes_userid_idx" ON "notes" ("userid");--> statement-breakpoint
CREATE INDEX "notes_createdby_idx" ON "notes" ("createdby");--> statement-breakpoint
CREATE INDEX "notes_groupid_idx" ON "notes" ("groupid");--> statement-breakpoint
CREATE INDEX "rating_itemid_idx" ON "rating" ("itemid");--> statement-breakpoint
CREATE INDEX "rating_userid_idx" ON "rating" ("userid");--> statement-breakpoint
CREATE INDEX "tag_userid_idx" ON "tag" ("userid");--> statement-breakpoint
CREATE INDEX "tag_instance_itemid_idx" ON "tag_instance" ("itemid");--> statement-breakpoint
CREATE INDEX "tag_instance_contextid_idx" ON "tag_instance" ("contextid");--> statement-breakpoint
CREATE INDEX "tag_instance_tiuserid_idx" ON "tag_instance" ("tiuserid");--> statement-breakpoint
CREATE INDEX "search_documents_itemid_idx" ON "search_documents" ("itemid");--> statement-breakpoint
CREATE INDEX "search_documents_contextid_idx" ON "search_documents" ("contextid");--> statement-breakpoint
CREATE INDEX "search_documents_ownerid_idx" ON "search_documents" ("ownerid");--> statement-breakpoint
CREATE INDEX "external_tokens_userid_idx" ON "external_tokens" ("userid");--> statement-breakpoint
CREATE INDEX "external_tokens_serviceid_idx" ON "external_tokens" ("serviceid");--> statement-breakpoint
CREATE INDEX "backup_id_mappings_jobid_idx" ON "backup_id_mappings" ("jobid");--> statement-breakpoint
CREATE INDEX "backup_id_mappings_oldid_idx" ON "backup_id_mappings" ("oldid");--> statement-breakpoint
CREATE INDEX "backup_id_mappings_newid_idx" ON "backup_id_mappings" ("newid");--> statement-breakpoint
CREATE INDEX "backup_job_steps_jobid_idx" ON "backup_job_steps" ("jobid");--> statement-breakpoint
CREATE INDEX "backup_jobs_courseid_idx" ON "backup_jobs" ("courseid");--> statement-breakpoint
CREATE INDEX "backup_jobs_targetcourseid_idx" ON "backup_jobs" ("targetcourseid");--> statement-breakpoint
CREATE INDEX "backup_jobs_userid_idx" ON "backup_jobs" ("userid");--> statement-breakpoint
CREATE INDEX "analytics_predictions_modelid_idx" ON "analytics_predictions" ("modelid");--> statement-breakpoint
CREATE INDEX "analytics_predictions_userid_idx" ON "analytics_predictions" ("userid");--> statement-breakpoint
CREATE INDEX "analytics_predictions_contextid_idx" ON "analytics_predictions" ("contextid");--> statement-breakpoint
CREATE INDEX "analytics_predictions_courseid_idx" ON "analytics_predictions" ("courseid");--> statement-breakpoint
CREATE INDEX "insights_modelid_idx" ON "insights" ("modelid");--> statement-breakpoint
CREATE INDEX "insights_predictionid_idx" ON "insights" ("predictionid");--> statement-breakpoint
CREATE INDEX "insights_userid_idx" ON "insights" ("userid");--> statement-breakpoint
CREATE INDEX "insights_recipientid_idx" ON "insights" ("recipientid");--> statement-breakpoint
CREATE INDEX "insights_contextid_idx" ON "insights" ("contextid");--> statement-breakpoint
CREATE INDEX "insights_courseid_idx" ON "insights" ("courseid");--> statement-breakpoint
CREATE INDEX "reportbuilder_audience_reportid_idx" ON "reportbuilder_audience" ("reportid");--> statement-breakpoint
CREATE INDEX "reportbuilder_audience_userid_idx" ON "reportbuilder_audience" ("userid");--> statement-breakpoint
CREATE INDEX "reportbuilder_report_createdby_idx" ON "reportbuilder_report" ("createdby");--> statement-breakpoint
CREATE INDEX "reportbuilder_report_contextid_idx" ON "reportbuilder_report" ("contextid");--> statement-breakpoint
CREATE INDEX "reportbuilder_schedule_reportid_idx" ON "reportbuilder_schedule" ("reportid");--> statement-breakpoint
CREATE INDEX "reportbuilder_schedule_createdby_idx" ON "reportbuilder_schedule" ("createdby");--> statement-breakpoint
CREATE INDEX "contentbank_content_contextid_idx" ON "contentbank_content" ("contextid");--> statement-breakpoint
CREATE INDEX "contentbank_content_creatorid_idx" ON "contentbank_content" ("creatorid");--> statement-breakpoint
CREATE INDEX "contentbank_content_fileid_idx" ON "contentbank_content" ("fileid");--> statement-breakpoint
CREATE INDEX "payment_refunds_paymentid_idx" ON "payment_refunds" ("paymentid");--> statement-breakpoint
CREATE INDEX "payments_accountid_idx" ON "payments" ("accountid");--> statement-breakpoint
CREATE INDEX "payments_userid_idx" ON "payments" ("userid");--> statement-breakpoint
CREATE INDEX "payments_itemid_idx" ON "payments" ("itemid");--> statement-breakpoint
CREATE INDEX "privacy_export_files_requestid_idx" ON "privacy_export_files" ("requestid");--> statement-breakpoint
CREATE INDEX "privacy_export_files_fileid_idx" ON "privacy_export_files" ("fileid");--> statement-breakpoint
CREATE INDEX "privacy_requests_userid_idx" ON "privacy_requests" ("userid");--> statement-breakpoint
CREATE INDEX "privacy_requests_requestedby_idx" ON "privacy_requests" ("requestedby");--> statement-breakpoint
CREATE INDEX "privacy_requests_approvedby_idx" ON "privacy_requests" ("approvedby");--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_roleid_role_id_fkey" FOREIGN KEY ("roleid") REFERENCES "role"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_contextid_context_id_fkey" FOREIGN KEY ("contextid") REFERENCES "context"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "role_capabilities" ADD CONSTRAINT "role_capabilities_contextid_context_id_fkey" FOREIGN KEY ("contextid") REFERENCES "context"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "role_capabilities" ADD CONSTRAINT "role_capabilities_roleid_role_id_fkey" FOREIGN KEY ("roleid") REFERENCES "role"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_userid_users_id_fkey" FOREIGN KEY ("userid") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "login_attempts" ADD CONSTRAINT "login_attempts_userid_users_id_fkey" FOREIGN KEY ("userid") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "refresh_token_family" ADD CONSTRAINT "refresh_token_family_userid_users_id_fkey" FOREIGN KEY ("userid") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "customfield_data" ADD CONSTRAINT "customfield_data_fieldid_customfield_field_id_fkey" FOREIGN KEY ("fieldid") REFERENCES "customfield_field"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "customfield_field" ADD CONSTRAINT "customfield_field_categoryid_customfield_category_id_fkey" FOREIGN KEY ("categoryid") REFERENCES "customfield_category"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course" ADD CONSTRAINT "course_category_course_categories_id_fkey" FOREIGN KEY ("category") REFERENCES "course_categories"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_format_options" ADD CONSTRAINT "course_format_options_courseid_course_id_fkey" FOREIGN KEY ("courseid") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_modules" ADD CONSTRAINT "course_modules_course_course_id_fkey" FOREIGN KEY ("course") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_modules" ADD CONSTRAINT "course_modules_section_course_sections_id_fkey" FOREIGN KEY ("section") REFERENCES "course_sections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_sections" ADD CONSTRAINT "course_sections_course_course_id_fkey" FOREIGN KEY ("course") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "cohort_members" ADD CONSTRAINT "cohort_members_cohortid_cohort_id_fkey" FOREIGN KEY ("cohortid") REFERENCES "cohort"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_groups" ADD CONSTRAINT "course_groups_courseid_course_id_fkey" FOREIGN KEY ("courseid") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "groupings" ADD CONSTRAINT "groupings_courseid_course_id_fkey" FOREIGN KEY ("courseid") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "groupings_groups" ADD CONSTRAINT "groupings_groups_groupingid_groupings_id_fkey" FOREIGN KEY ("groupingid") REFERENCES "groupings"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "groupings_groups" ADD CONSTRAINT "groupings_groups_groupid_course_groups_id_fkey" FOREIGN KEY ("groupid") REFERENCES "course_groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "groups_members" ADD CONSTRAINT "groups_members_groupid_course_groups_id_fkey" FOREIGN KEY ("groupid") REFERENCES "course_groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "enrol" ADD CONSTRAINT "enrol_courseid_course_id_fkey" FOREIGN KEY ("courseid") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_enrolments" ADD CONSTRAINT "user_enrolments_enrolid_enrol_id_fkey" FOREIGN KEY ("enrolid") REFERENCES "enrol"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_completion_criteria" ADD CONSTRAINT "course_completion_criteria_course_course_id_fkey" FOREIGN KEY ("course") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_completion_settings" ADD CONSTRAINT "course_completion_settings_course_course_id_fkey" FOREIGN KEY ("course") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_completions" ADD CONSTRAINT "course_completions_course_course_id_fkey" FOREIGN KEY ("course") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_modules_completion" ADD CONSTRAINT "course_modules_completion_coursemoduleid_course_modules_id_fkey" FOREIGN KEY ("coursemoduleid") REFERENCES "course_modules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "grade_categories" ADD CONSTRAINT "grade_categories_courseid_course_id_fkey" FOREIGN KEY ("courseid") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "grade_grades" ADD CONSTRAINT "grade_grades_itemid_grade_items_id_fkey" FOREIGN KEY ("itemid") REFERENCES "grade_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "grade_items" ADD CONSTRAINT "grade_items_courseid_course_id_fkey" FOREIGN KEY ("courseid") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "grade_items" ADD CONSTRAINT "grade_items_categoryid_grade_categories_id_fkey" FOREIGN KEY ("categoryid") REFERENCES "grade_categories"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "grade_items" ADD CONSTRAINT "grade_items_scaleid_scales_id_fkey" FOREIGN KEY ("scaleid") REFERENCES "scales"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "question" ADD CONSTRAINT "question_category_question_categories_id_fkey" FOREIGN KEY ("category") REFERENCES "question_categories"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_attempt_step_data" ADD CONSTRAINT "question_attempt_step_data_PuExrKs0UiDY_fkey" FOREIGN KEY ("attemptstepid") REFERENCES "question_attempt_steps"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_attempt_steps" ADD CONSTRAINT "question_attempt_steps_B0Bkky8ODQIB_fkey" FOREIGN KEY ("questionattemptid") REFERENCES "question_attempts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_attempts" ADD CONSTRAINT "question_attempts_questionusageid_question_usages_id_fkey" FOREIGN KEY ("questionusageid") REFERENCES "question_usages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_attempts" ADD CONSTRAINT "question_attempts_questionid_question_id_fkey" FOREIGN KEY ("questionid") REFERENCES "question"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_attempts" ADD CONSTRAINT "question_attempts_questionversionid_question_versions_id_fkey" FOREIGN KEY ("questionversionid") REFERENCES "question_versions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "question_bank_entries" ADD CONSTRAINT "question_bank_entries_q5y7hJDIZ8O0_fkey" FOREIGN KEY ("questioncategoryid") REFERENCES "question_categories"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_bank_entries" ADD CONSTRAINT "question_bank_entries_questionid_question_id_fkey" FOREIGN KEY ("questionid") REFERENCES "question"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_F7JXlRlHryBB_fkey" FOREIGN KEY ("questionbankentryid") REFERENCES "question_bank_entries"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_questionid_question_id_fkey" FOREIGN KEY ("questionid") REFERENCES "question"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversationid_message_conversations_id_fkey" FOREIGN KEY ("conversationid") REFERENCES "message_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message_conversation_members" ADD CONSTRAINT "message_conversation_members_znrNvaanW0YP_fkey" FOREIGN KEY ("conversationid") REFERENCES "message_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "badge_criteria" ADD CONSTRAINT "badge_criteria_badgeid_badge_id_fkey" FOREIGN KEY ("badgeid") REFERENCES "badge"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "badge_issued" ADD CONSTRAINT "badge_issued_badgeid_badge_id_fkey" FOREIGN KEY ("badgeid") REFERENCES "badge"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "badge_manual_award" ADD CONSTRAINT "badge_manual_award_badgeid_badge_id_fkey" FOREIGN KEY ("badgeid") REFERENCES "badge"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency" ADD CONSTRAINT "competency_frameworkid_competency_framework_id_fkey" FOREIGN KEY ("frameworkid") REFERENCES "competency_framework"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_coursecomp" ADD CONSTRAINT "competency_coursecomp_competencyid_competency_id_fkey" FOREIGN KEY ("competencyid") REFERENCES "competency"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_evidence" ADD CONSTRAINT "competency_evidence_WnNjleutO26Y_fkey" FOREIGN KEY ("usercompetencyid") REFERENCES "competency_usercomp"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_modulecomp" ADD CONSTRAINT "competency_modulecomp_competencyid_competency_id_fkey" FOREIGN KEY ("competencyid") REFERENCES "competency"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_plan_review" ADD CONSTRAINT "competency_plan_review_planid_learning_plans_id_fkey" FOREIGN KEY ("planid") REFERENCES "learning_plans"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_plancomp" ADD CONSTRAINT "competency_plancomp_planid_learning_plans_id_fkey" FOREIGN KEY ("planid") REFERENCES "learning_plans"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_plancomp" ADD CONSTRAINT "competency_plancomp_competencyid_competency_id_fkey" FOREIGN KEY ("competencyid") REFERENCES "competency"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_templatecohort" ADD CONSTRAINT "competency_templatecohort_AlMztlIpZuda_fkey" FOREIGN KEY ("templateid") REFERENCES "competency_template"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_templatecomp" ADD CONSTRAINT "competency_templatecomp_templateid_competency_template_id_fkey" FOREIGN KEY ("templateid") REFERENCES "competency_template"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_templatecomp" ADD CONSTRAINT "competency_templatecomp_competencyid_competency_id_fkey" FOREIGN KEY ("competencyid") REFERENCES "competency"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_usercomp" ADD CONSTRAINT "competency_usercomp_competencyid_competency_id_fkey" FOREIGN KEY ("competencyid") REFERENCES "competency"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "blog_association" ADD CONSTRAINT "blog_association_blogid_blog_posts_id_fkey" FOREIGN KEY ("blogid") REFERENCES "blog_posts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tag_correlation" ADD CONSTRAINT "tag_correlation_tagid_tag_id_fkey" FOREIGN KEY ("tagid") REFERENCES "tag"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tag_instance" ADD CONSTRAINT "tag_instance_tagid_tag_id_fkey" FOREIGN KEY ("tagid") REFERENCES "tag"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "external_tokens" ADD CONSTRAINT "external_tokens_serviceid_external_services_id_fkey" FOREIGN KEY ("serviceid") REFERENCES "external_services"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "backup_id_mappings" ADD CONSTRAINT "backup_id_mappings_jobid_backup_jobs_id_fkey" FOREIGN KEY ("jobid") REFERENCES "backup_jobs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "backup_job_steps" ADD CONSTRAINT "backup_job_steps_jobid_backup_jobs_id_fkey" FOREIGN KEY ("jobid") REFERENCES "backup_jobs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "analytics_predictions" ADD CONSTRAINT "analytics_predictions_modelid_analytics_models_id_fkey" FOREIGN KEY ("modelid") REFERENCES "analytics_models"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_modelid_analytics_models_id_fkey" FOREIGN KEY ("modelid") REFERENCES "analytics_models"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "reportbuilder_audience" ADD CONSTRAINT "reportbuilder_audience_reportid_reportbuilder_report_id_fkey" FOREIGN KEY ("reportid") REFERENCES "reportbuilder_report"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "reportbuilder_schedule" ADD CONSTRAINT "reportbuilder_schedule_reportid_reportbuilder_report_id_fkey" FOREIGN KEY ("reportid") REFERENCES "reportbuilder_report"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_paymentid_payments_id_fkey" FOREIGN KEY ("paymentid") REFERENCES "payments"("id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_accountid_payment_accounts_id_fkey" FOREIGN KEY ("accountid") REFERENCES "payment_accounts"("id");--> statement-breakpoint
ALTER TABLE "privacy_export_files" ADD CONSTRAINT "privacy_export_files_requestid_privacy_requests_id_fkey" FOREIGN KEY ("requestid") REFERENCES "privacy_requests"("id") ON DELETE CASCADE;
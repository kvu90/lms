CREATE TABLE "grade_categories" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "grade_categories_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"courseid" integer NOT NULL,
	"parent" integer,
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
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "grade_grades_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"itemid" integer NOT NULL,
	"userid" integer NOT NULL,
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
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "grade_grades_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"action" integer DEFAULT 2 NOT NULL,
	"oldid" integer,
	"itemid" integer NOT NULL,
	"userid" integer NOT NULL,
	"rawgrade" double precision,
	"finalgrade" double precision,
	"overridden" boolean DEFAULT false NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"frozen" boolean DEFAULT false NOT NULL,
	"source" text,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	"loggeduser" integer
);
--> statement-breakpoint
CREATE TABLE "grade_items" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "grade_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"courseid" integer NOT NULL,
	"categoryid" integer,
	"itemname" text DEFAULT '' NOT NULL,
	"itemtype" text DEFAULT 'manual' NOT NULL,
	"itemmodule" text,
	"iteminstance" integer DEFAULT 0 NOT NULL,
	"gradetype" text DEFAULT 'value' NOT NULL,
	"grademax" double precision DEFAULT 100 NOT NULL,
	"grademin" double precision DEFAULT 0 NOT NULL,
	"gradepass" double precision DEFAULT 0 NOT NULL,
	"scaleid" integer,
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
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "grade_letters_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"contextid" integer NOT NULL,
	"lowerboundary" double precision NOT NULL,
	"letter" text NOT NULL,
	CONSTRAINT "grade_letters_context_boundary_unique" UNIQUE("contextid","lowerboundary")
);
--> statement-breakpoint
CREATE TABLE "question" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "question_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"category" integer NOT NULL,
	"qtype" text NOT NULL,
	"name" text NOT NULL,
	"createdby" integer,
	"modifiedby" integer,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_attempt_step_data" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "question_attempt_step_data_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"attemptstepid" integer NOT NULL,
	"name" text NOT NULL,
	"value" text,
	CONSTRAINT "question_attempt_step_data_step_name_unique" UNIQUE("attemptstepid","name")
);
--> statement-breakpoint
CREATE TABLE "question_attempt_steps" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "question_attempt_steps_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"questionattemptid" integer NOT NULL,
	"sequencenumber" integer NOT NULL,
	"state" text NOT NULL,
	"fraction" double precision,
	"userid" integer,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_attempt_steps_attempt_seq_unique" UNIQUE("questionattemptid","sequencenumber")
);
--> statement-breakpoint
CREATE TABLE "question_attempts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "question_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"questionusageid" integer NOT NULL,
	"slot" integer NOT NULL,
	"behaviour" text DEFAULT 'deferredfeedback' NOT NULL,
	"questionid" integer NOT NULL,
	"questionversionid" integer,
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
	"userid" integer,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_attempts_usage_slot_unique" UNIQUE("questionusageid","slot")
);
--> statement-breakpoint
CREATE TABLE "question_bank_entries" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "question_bank_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"questioncategoryid" integer NOT NULL,
	"questionid" integer NOT NULL CONSTRAINT "question_bank_entries_question_unique" UNIQUE,
	"latestversion" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_categories" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "question_categories_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"contextid" integer NOT NULL,
	"info" text DEFAULT '' NOT NULL,
	"parent" integer,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"stamp" text DEFAULT '' NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_usages" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "question_usages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"component" text NOT NULL,
	"instanceid" integer DEFAULT 0 NOT NULL,
	"owningcontextid" integer,
	"preferredbehaviour" text DEFAULT 'deferredfeedback' NOT NULL,
	"userid" integer,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_versions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "question_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"questionbankentryid" integer NOT NULL,
	"questionid" integer NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"questiontext" text DEFAULT '' NOT NULL,
	"defaultmark" double precision DEFAULT 1 NOT NULL,
	"answerdata" jsonb DEFAULT '{}' NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_versions_entry_version_unique" UNIQUE("questionbankentryid","version")
);
--> statement-breakpoint
CREATE TABLE "scales" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "scales_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"courseid" integer DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"scale" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_questionid_question_id_fkey" FOREIGN KEY ("questionid") REFERENCES "question"("id") ON DELETE CASCADE;
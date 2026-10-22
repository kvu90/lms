CREATE TABLE "cohort" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cohort_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"idnumber" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"contextid" integer NOT NULL,
	"component" text DEFAULT '' NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cohort_members" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cohort_members_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"cohortid" integer NOT NULL,
	"userid" integer NOT NULL,
	"timeadded" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cohort_members_unique" UNIQUE("cohortid","userid")
);
--> statement-breakpoint
CREATE TABLE "course" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "course_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"category" integer NOT NULL,
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
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "course_categories_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"idnumber" text,
	"description" text DEFAULT '' NOT NULL,
	"parent" integer DEFAULT 0 NOT NULL,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"path" text DEFAULT '' NOT NULL,
	"depth" integer DEFAULT 1 NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_completion_criteria" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "course_completion_criteria_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"course" integer NOT NULL,
	"criteriatype" text NOT NULL,
	"moduleinstance" integer,
	"date" timestamp with time zone,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_completion_settings" (
	"course" integer PRIMARY KEY,
	"method" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_completions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "course_completions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userid" integer NOT NULL,
	"course" integer NOT NULL,
	"status" text DEFAULT 'not_started' NOT NULL,
	"timeenrolled" timestamp with time zone DEFAULT now() NOT NULL,
	"timestarted" timestamp with time zone,
	"timecompleted" timestamp with time zone,
	"reaggregate" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_completions_unique" UNIQUE("userid","course")
);
--> statement-breakpoint
CREATE TABLE "course_format_options" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "course_format_options_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"courseid" integer NOT NULL,
	"format" text NOT NULL,
	"sectionid" integer DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"value" text,
	CONSTRAINT "course_format_options_unique" UNIQUE("courseid","format","sectionid","name")
);
--> statement-breakpoint
CREATE TABLE "course_groups" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "course_groups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"courseid" integer NOT NULL,
	"name" text NOT NULL,
	"idnumber" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_groups_course_name_unique" UNIQUE("courseid","name")
);
--> statement-breakpoint
CREATE TABLE "course_modules" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "course_modules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"course" integer NOT NULL,
	"section" integer NOT NULL,
	"component" text NOT NULL,
	"instanceid" integer DEFAULT 0 NOT NULL,
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
CREATE TABLE "course_modules_completion" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "course_modules_completion_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"coursemoduleid" integer NOT NULL,
	"userid" integer NOT NULL,
	"completionstate" integer DEFAULT 0 NOT NULL,
	"viewed" boolean DEFAULT false NOT NULL,
	"overrideby" integer,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_modules_completion_unique" UNIQUE("coursemoduleid","userid")
);
--> statement-breakpoint
CREATE TABLE "course_sections" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "course_sections_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"course" integer NOT NULL,
	"section" integer DEFAULT 0 NOT NULL,
	"name" text,
	"summary" text DEFAULT '' NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"availability" jsonb,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_sections_course_section_unique" UNIQUE("course","section")
);
--> statement-breakpoint
CREATE TABLE "enrol" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "enrol_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"courseid" integer NOT NULL,
	"enrol" text NOT NULL,
	"status" integer DEFAULT 0 NOT NULL,
	"name" text,
	"roleid" integer,
	"enrolperiod" integer DEFAULT 0 NOT NULL,
	"timestart" timestamp with time zone,
	"timeend" timestamp with time zone,
	"customint1" integer DEFAULT 0 NOT NULL,
	"customint2" integer DEFAULT 0 NOT NULL,
	"customtext1" text DEFAULT 'suspend' NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groupings" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "groupings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"courseid" integer NOT NULL,
	"name" text NOT NULL,
	"idnumber" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groupings_course_name_unique" UNIQUE("courseid","name")
);
--> statement-breakpoint
CREATE TABLE "groupings_groups" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "groupings_groups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"groupingid" integer NOT NULL,
	"groupid" integer NOT NULL,
	"timeadded" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groupings_groups_unique" UNIQUE("groupingid","groupid")
);
--> statement-breakpoint
CREATE TABLE "groups_members" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "groups_members_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"groupid" integer NOT NULL,
	"userid" integer NOT NULL,
	"timeadded" timestamp with time zone DEFAULT now() NOT NULL,
	"component" text DEFAULT '' NOT NULL,
	"itemid" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "groups_members_unique" UNIQUE("groupid","userid","component","itemid")
);
--> statement-breakpoint
CREATE TABLE "user_enrolments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_enrolments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"enrolid" integer NOT NULL,
	"userid" integer NOT NULL,
	"status" integer DEFAULT 0 NOT NULL,
	"timestart" timestamp with time zone DEFAULT now() NOT NULL,
	"timeend" timestamp with time zone,
	"modifierid" integer,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_enrolments_unique" UNIQUE("enrolid","userid")
);
--> statement-breakpoint
ALTER TABLE "cohort_members" ADD CONSTRAINT "cohort_members_cohortid_cohort_id_fkey" FOREIGN KEY ("cohortid") REFERENCES "cohort"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course" ADD CONSTRAINT "course_category_course_categories_id_fkey" FOREIGN KEY ("category") REFERENCES "course_categories"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_completion_criteria" ADD CONSTRAINT "course_completion_criteria_course_course_id_fkey" FOREIGN KEY ("course") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_completion_settings" ADD CONSTRAINT "course_completion_settings_course_course_id_fkey" FOREIGN KEY ("course") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_completions" ADD CONSTRAINT "course_completions_course_course_id_fkey" FOREIGN KEY ("course") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_format_options" ADD CONSTRAINT "course_format_options_courseid_course_id_fkey" FOREIGN KEY ("courseid") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_groups" ADD CONSTRAINT "course_groups_courseid_course_id_fkey" FOREIGN KEY ("courseid") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_modules" ADD CONSTRAINT "course_modules_course_course_id_fkey" FOREIGN KEY ("course") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_modules" ADD CONSTRAINT "course_modules_section_course_sections_id_fkey" FOREIGN KEY ("section") REFERENCES "course_sections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_modules_completion" ADD CONSTRAINT "course_modules_completion_coursemoduleid_course_modules_id_fkey" FOREIGN KEY ("coursemoduleid") REFERENCES "course_modules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_sections" ADD CONSTRAINT "course_sections_course_course_id_fkey" FOREIGN KEY ("course") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "enrol" ADD CONSTRAINT "enrol_courseid_course_id_fkey" FOREIGN KEY ("courseid") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "groupings" ADD CONSTRAINT "groupings_courseid_course_id_fkey" FOREIGN KEY ("courseid") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "groupings_groups" ADD CONSTRAINT "groupings_groups_groupingid_groupings_id_fkey" FOREIGN KEY ("groupingid") REFERENCES "groupings"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "groupings_groups" ADD CONSTRAINT "groupings_groups_groupid_course_groups_id_fkey" FOREIGN KEY ("groupid") REFERENCES "course_groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "groups_members" ADD CONSTRAINT "groups_members_groupid_course_groups_id_fkey" FOREIGN KEY ("groupid") REFERENCES "course_groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_enrolments" ADD CONSTRAINT "user_enrolments_enrolid_enrol_id_fkey" FOREIGN KEY ("enrolid") REFERENCES "enrol"("id") ON DELETE CASCADE;
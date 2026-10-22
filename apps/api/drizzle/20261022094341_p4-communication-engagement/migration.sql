CREATE TABLE "badge" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "badge_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"type" integer DEFAULT 1 NOT NULL,
	"courseid" integer,
	"issuername" text DEFAULT '' NOT NULL,
	"issuerurl" text DEFAULT '' NOT NULL,
	"issuercontact" text DEFAULT '' NOT NULL,
	"expiredate" timestamp with time zone,
	"expireperiod" integer,
	"status" integer DEFAULT 0 NOT NULL,
	"version" text DEFAULT '' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"usercreated" integer,
	"usermodified" integer,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "badge_criteria" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "badge_criteria_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"badgeid" integer NOT NULL,
	"criteriatype" text NOT NULL,
	"method" integer DEFAULT 1 NOT NULL,
	"params" jsonb DEFAULT '{}' NOT NULL,
	"description" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "badge_issued" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "badge_issued_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"badgeid" integer NOT NULL,
	"userid" integer NOT NULL,
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
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "badge_manual_award_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"badgeid" integer NOT NULL,
	"recipientid" integer NOT NULL,
	"issuerid" integer NOT NULL,
	"issuerrole" integer,
	"datemet" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "badge_manual_award_unique" UNIQUE("badgeid","recipientid","issuerid")
);
--> statement-breakpoint
CREATE TABLE "blog_association" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "blog_association_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"blogid" integer NOT NULL,
	"contextid" integer NOT NULL,
	"assoctype" text NOT NULL,
	"associd" integer NOT NULL,
	CONSTRAINT "blog_association_unique" UNIQUE("blogid","assoctype","associd")
);
--> statement-breakpoint
CREATE TABLE "blog_posts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "blog_posts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userid" integer NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"publishstate" text DEFAULT 'draft' NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"lastmodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "calendar_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"eventtype" text DEFAULT 'user' NOT NULL,
	"courseid" integer DEFAULT 0 NOT NULL,
	"groupid" integer DEFAULT 0 NOT NULL,
	"categoryid" integer DEFAULT 0 NOT NULL,
	"userid" integer DEFAULT 0 NOT NULL,
	"contextid" integer,
	"subscriptionid" integer,
	"uuid" text,
	"repeatid" integer DEFAULT 0 NOT NULL,
	"rrule" text,
	"isexception" boolean DEFAULT false NOT NULL,
	"exceptionof" integer,
	"timestart" timestamp with time zone NOT NULL,
	"timeduration" integer DEFAULT 0 NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_subscriptions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "calendar_subscriptions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"url" text,
	"icsdata" text,
	"eventtype" text DEFAULT 'site' NOT NULL,
	"courseid" integer DEFAULT 0 NOT NULL,
	"categoryid" integer DEFAULT 0 NOT NULL,
	"userid" integer DEFAULT 0 NOT NULL,
	"pollinterval" integer DEFAULT 604800 NOT NULL,
	"lastupdated" timestamp with time zone,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "comments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"contextid" integer NOT NULL,
	"component" text NOT NULL,
	"commentarea" text NOT NULL,
	"itemid" integer NOT NULL,
	"content" text NOT NULL,
	"format" integer DEFAULT 1 NOT NULL,
	"userid" integer NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timedeleted" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "competency" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "competency_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"frameworkid" integer NOT NULL,
	"shortname" text NOT NULL,
	"idnumber" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"parentid" integer DEFAULT 0 NOT NULL,
	"path" text DEFAULT '' NOT NULL,
	"depth" integer DEFAULT 1 NOT NULL,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competency_coursecomp" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "competency_coursecomp_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"courseid" integer NOT NULL,
	"competencyid" integer NOT NULL,
	"ruleoutcome" text DEFAULT 'nothing' NOT NULL,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competency_coursecomp_unique" UNIQUE("courseid","competencyid")
);
--> statement-breakpoint
CREATE TABLE "competency_evidence" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "competency_evidence_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"usercompetencyid" integer NOT NULL,
	"contextid" integer,
	"actionuserid" integer NOT NULL,
	"action" text DEFAULT 'evidence' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"url" text,
	"grade" integer,
	"note" text DEFAULT '' NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competency_framework" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "competency_framework_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"shortname" text NOT NULL,
	"idnumber" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"contextid" integer NOT NULL,
	"scaleconfiguration" jsonb DEFAULT '{}' NOT NULL,
	"taxonomies" text DEFAULT 'competency' NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competency_modulecomp" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "competency_modulecomp_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"coursemoduleid" integer NOT NULL,
	"competencyid" integer NOT NULL,
	"ruleoutcome" text DEFAULT 'nothing' NOT NULL,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competency_modulecomp_unique" UNIQUE("coursemoduleid","competencyid")
);
--> statement-breakpoint
CREATE TABLE "competency_plan_review" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "competency_plan_review_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"planid" integer NOT NULL,
	"actorid" integer NOT NULL,
	"action" text NOT NULL,
	"statusfrom" integer NOT NULL,
	"statusto" integer NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competency_plancomp" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "competency_plancomp_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"planid" integer NOT NULL,
	"competencyid" integer NOT NULL,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competency_plancomp_unique" UNIQUE("planid","competencyid")
);
--> statement-breakpoint
CREATE TABLE "competency_template" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "competency_template_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"shortname" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"contextid" integer NOT NULL,
	"duedate" timestamp with time zone,
	"visible" boolean DEFAULT true NOT NULL,
	"status" integer DEFAULT 1 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competency_templatecohort" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "competency_templatecohort_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"templateid" integer NOT NULL,
	"cohortid" integer NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competency_templatecohort_unique" UNIQUE("templateid","cohortid")
);
--> statement-breakpoint
CREATE TABLE "competency_templatecomp" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "competency_templatecomp_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"templateid" integer NOT NULL,
	"competencyid" integer NOT NULL,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competency_templatecomp_unique" UNIQUE("templateid","competencyid")
);
--> statement-breakpoint
CREATE TABLE "competency_usercomp" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "competency_usercomp_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userid" integer NOT NULL,
	"competencyid" integer NOT NULL,
	"planid" integer DEFAULT 0 NOT NULL,
	"courseid" integer DEFAULT 0 NOT NULL,
	"status" integer DEFAULT 0 NOT NULL,
	"proficiency" boolean,
	"grade" integer,
	"reviewerid" integer,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competency_usercomp_unique" UNIQUE("userid","competencyid","planid","courseid")
);
--> statement-breakpoint
CREATE TABLE "learning_plans" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "learning_plans_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"userid" integer NOT NULL,
	"templateid" integer,
	"status" integer DEFAULT 0 NOT NULL,
	"duedate" timestamp with time zone,
	"reviewerid" integer,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "message_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"conversationid" integer NOT NULL,
	"useridfrom" integer NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"fullmessage" text DEFAULT '' NOT NULL,
	"smallmessage" text DEFAULT '' NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timeread" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "message_conversation_members" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "message_conversation_members_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"conversationid" integer NOT NULL,
	"userid" integer NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_conversation_members_unique" UNIQUE("conversationid","userid")
);
--> statement-breakpoint
CREATE TABLE "message_conversations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "message_conversations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"type" integer DEFAULT 1 NOT NULL,
	"name" text,
	"component" text,
	"itemtype" text,
	"itemid" integer DEFAULT 0 NOT NULL,
	"contextid" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_users_blocked" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "message_users_blocked_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userid" integer NOT NULL,
	"blockeduserid" integer NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_users_blocked_unique" UNIQUE("userid","blockeduserid")
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"courseid" integer DEFAULT 0 NOT NULL,
	"userid" integer NOT NULL,
	"createdby" integer NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"format" integer DEFAULT 1 NOT NULL,
	"publishstate" text DEFAULT 'draft' NOT NULL,
	"groupid" integer DEFAULT 0 NOT NULL,
	"usermodified" integer,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"lastmodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_dispatch_log" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notification_dispatch_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"notificationid" integer,
	"userid" integer NOT NULL,
	"provider" text NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"dedupekey" text CONSTRAINT "notification_dispatch_log_dedupe_unique" UNIQUE,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"useridfrom" integer,
	"useridto" integer NOT NULL,
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
CREATE TABLE "rating" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rating_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"contextid" integer NOT NULL,
	"component" text NOT NULL,
	"ratingarea" text NOT NULL,
	"itemid" integer NOT NULL,
	"scaleid" integer NOT NULL,
	"rating" integer NOT NULL,
	"userid" integer NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rating_unique" UNIQUE("contextid","component","ratingarea","itemid","userid")
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tag_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userid" integer DEFAULT 0 NOT NULL,
	"tagcollid" integer DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"rawname" text NOT NULL,
	"isstandard" boolean DEFAULT false NOT NULL,
	"flag" integer DEFAULT 0 NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_coll_name_unique" UNIQUE("tagcollid","name")
);
--> statement-breakpoint
CREATE TABLE "tag_collection" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tag_collection_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"isstandard" boolean DEFAULT false NOT NULL,
	"component" text,
	"searchable" boolean DEFAULT true NOT NULL,
	"customurl" text
);
--> statement-breakpoint
CREATE TABLE "tag_correlation" (
	"tagid" integer PRIMARY KEY,
	"correlatedtags" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag_instance" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tag_instance_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tagid" integer NOT NULL,
	"component" text NOT NULL,
	"itemtype" text NOT NULL,
	"itemid" integer NOT NULL,
	"contextid" integer NOT NULL,
	"tiuserid" integer DEFAULT 0 NOT NULL,
	"ordering" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_instance_unique" UNIQUE("tagid","component","itemtype","itemid","contextid","tiuserid")
);
--> statement-breakpoint
ALTER TABLE "badge_criteria" ADD CONSTRAINT "badge_criteria_badgeid_badge_id_fkey" FOREIGN KEY ("badgeid") REFERENCES "badge"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "badge_issued" ADD CONSTRAINT "badge_issued_badgeid_badge_id_fkey" FOREIGN KEY ("badgeid") REFERENCES "badge"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "badge_manual_award" ADD CONSTRAINT "badge_manual_award_badgeid_badge_id_fkey" FOREIGN KEY ("badgeid") REFERENCES "badge"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "blog_association" ADD CONSTRAINT "blog_association_blogid_blog_posts_id_fkey" FOREIGN KEY ("blogid") REFERENCES "blog_posts"("id") ON DELETE CASCADE;--> statement-breakpoint
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
ALTER TABLE "message" ADD CONSTRAINT "message_conversationid_message_conversations_id_fkey" FOREIGN KEY ("conversationid") REFERENCES "message_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message_conversation_members" ADD CONSTRAINT "message_conversation_members_znrNvaanW0YP_fkey" FOREIGN KEY ("conversationid") REFERENCES "message_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tag_correlation" ADD CONSTRAINT "tag_correlation_tagid_tag_id_fkey" FOREIGN KEY ("tagid") REFERENCES "tag"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tag_instance" ADD CONSTRAINT "tag_instance_tagid_tag_id_fkey" FOREIGN KEY ("tagid") REFERENCES "tag"("id") ON DELETE CASCADE;
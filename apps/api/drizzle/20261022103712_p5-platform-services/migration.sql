CREATE TABLE "analytics_models" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "analytics_models_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL UNIQUE,
	"target" text NOT NULL,
	"indicators" jsonb DEFAULT '[]' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_predictions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "analytics_predictions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"modelid" integer NOT NULL,
	"userid" integer NOT NULL,
	"contextid" integer NOT NULL,
	"courseid" integer DEFAULT 0 NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"data" jsonb,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_id_mappings" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "backup_id_mappings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"jobid" integer NOT NULL,
	"itemtype" text NOT NULL,
	"oldid" integer NOT NULL,
	"newid" integer NOT NULL,
	CONSTRAINT "backup_id_mappings_unique" UNIQUE("jobid","itemtype","oldid")
);
--> statement-breakpoint
CREATE TABLE "backup_job_steps" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "backup_job_steps_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"jobid" integer NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"detail" jsonb,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_jobs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "backup_jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"type" text NOT NULL,
	"courseid" integer NOT NULL,
	"targetcourseid" integer,
	"mode" text DEFAULT 'new' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"anonymize" boolean DEFAULT false NOT NULL,
	"userid" integer NOT NULL,
	"archive" jsonb,
	"error" text,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timefinished" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contentbank_content" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "contentbank_content_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"contenttype" text DEFAULT 'file-based' NOT NULL,
	"contextid" integer NOT NULL,
	"creatorid" integer NOT NULL,
	"visibility" text DEFAULT 'draft' NOT NULL,
	"fileid" integer,
	"configdata" jsonb,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_services" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "external_services_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL UNIQUE,
	"shortname" text NOT NULL UNIQUE,
	"enabled" boolean DEFAULT true NOT NULL,
	"functions" jsonb DEFAULT '[]' NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_tokens" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "external_tokens_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tokenhash" text NOT NULL UNIQUE,
	"userid" integer NOT NULL,
	"serviceid" integer NOT NULL,
	"validuntil" timestamp with time zone,
	"iprestriction" text,
	"revoked" boolean DEFAULT false NOT NULL,
	"lastaccess" timestamp with time zone,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insights" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "insights_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"modelid" integer NOT NULL,
	"predictionid" integer,
	"userid" integer NOT NULL,
	"recipientid" integer NOT NULL,
	"contextid" integer NOT NULL,
	"courseid" integer DEFAULT 0 NOT NULL,
	"heading" text DEFAULT '' NOT NULL,
	"data" jsonb,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_accounts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payment_accounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"gateway" text DEFAULT 'manual' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_refunds" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payment_refunds_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"paymentid" integer NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"externaltransactionid" text,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"accountid" integer NOT NULL,
	"userid" integer NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"gateway" text DEFAULT 'manual' NOT NULL,
	"externaltransactionid" text,
	"component" text DEFAULT '' NOT NULL,
	"itemid" integer DEFAULT 0 NOT NULL,
	"data" jsonb,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_external_tx_unique" UNIQUE("gateway","externaltransactionid")
);
--> statement-breakpoint
CREATE TABLE "privacy_export_files" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "privacy_export_files_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"requestid" integer NOT NULL,
	"fileid" integer,
	"subsystem" text DEFAULT '' NOT NULL,
	"manifest" jsonb,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "privacy_requests" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "privacy_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userid" integer NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requestedby" integer NOT NULL,
	"approvedby" integer,
	"result" jsonb,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reportbuilder_audience" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reportbuilder_audience_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"reportid" integer NOT NULL,
	"userid" integer,
	"role" text
);
--> statement-breakpoint
CREATE TABLE "reportbuilder_report" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reportbuilder_report_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"datasource" text NOT NULL,
	"columns" jsonb DEFAULT '[]' NOT NULL,
	"filters" jsonb DEFAULT '{}' NOT NULL,
	"createdby" integer NOT NULL,
	"contextid" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reportbuilder_schedule" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reportbuilder_schedule_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"reportid" integer NOT NULL,
	"createdby" integer NOT NULL,
	"cron" text DEFAULT 'daily' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"lastrun" timestamp with time zone,
	"lastresult" jsonb,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_documents" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "search_documents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"area" text NOT NULL,
	"itemid" integer NOT NULL,
	"contextid" integer NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"ownerid" integer,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_documents_area_item_unique" UNIQUE("area","itemid")
);
--> statement-breakpoint
ALTER TABLE "enrol" ADD COLUMN "cost" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "enrol" ADD COLUMN "currency" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "enrol" ADD COLUMN "paymentaccountid" integer;--> statement-breakpoint
ALTER TABLE "analytics_predictions" ADD CONSTRAINT "analytics_predictions_modelid_analytics_models_id_fkey" FOREIGN KEY ("modelid") REFERENCES "analytics_models"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "backup_id_mappings" ADD CONSTRAINT "backup_id_mappings_jobid_backup_jobs_id_fkey" FOREIGN KEY ("jobid") REFERENCES "backup_jobs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "backup_job_steps" ADD CONSTRAINT "backup_job_steps_jobid_backup_jobs_id_fkey" FOREIGN KEY ("jobid") REFERENCES "backup_jobs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "external_tokens" ADD CONSTRAINT "external_tokens_serviceid_external_services_id_fkey" FOREIGN KEY ("serviceid") REFERENCES "external_services"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_modelid_analytics_models_id_fkey" FOREIGN KEY ("modelid") REFERENCES "analytics_models"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_paymentid_payments_id_fkey" FOREIGN KEY ("paymentid") REFERENCES "payments"("id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_accountid_payment_accounts_id_fkey" FOREIGN KEY ("accountid") REFERENCES "payment_accounts"("id");--> statement-breakpoint
ALTER TABLE "privacy_export_files" ADD CONSTRAINT "privacy_export_files_requestid_privacy_requests_id_fkey" FOREIGN KEY ("requestid") REFERENCES "privacy_requests"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "reportbuilder_audience" ADD CONSTRAINT "reportbuilder_audience_reportid_reportbuilder_report_id_fkey" FOREIGN KEY ("reportid") REFERENCES "reportbuilder_report"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "reportbuilder_schedule" ADD CONSTRAINT "reportbuilder_schedule_reportid_reportbuilder_report_id_fkey" FOREIGN KEY ("reportid") REFERENCES "reportbuilder_report"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX "search_documents_tsv_idx" ON "search_documents" USING gin (to_tsvector('simple', "title" || ' ' || "content"));

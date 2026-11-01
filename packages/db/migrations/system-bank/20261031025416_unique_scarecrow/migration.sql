CREATE TABLE "system_bank_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"type" text NOT NULL,
	"source_question_id" uuid NOT NULL,
	"payload" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_outcome_package_curricula" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"package_id" uuid NOT NULL,
	"curriculum_id" uuid NOT NULL,
	"subject_slug" text NOT NULL,
	"grade" smallint NOT NULL,
	CONSTRAINT "system_outcome_package_curricula_package_curriculum_unique" UNIQUE("package_id","curriculum_id")
);
--> statement-breakpoint
CREATE TABLE "system_outcome_package_mappings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"package_id" uuid NOT NULL,
	"from_outcome_id" uuid NOT NULL,
	"to_outcome_id" uuid NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	CONSTRAINT "system_outcome_package_mappings_package_from_unique" UNIQUE("package_id","from_outcome_id")
);
--> statement-breakpoint
CREATE TABLE "system_outcome_package_nodes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"package_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"curriculum_id" uuid NOT NULL,
	"parent_id" uuid,
	"title" text NOT NULL,
	"kind" text DEFAULT 'topic' NOT NULL,
	"position" integer DEFAULT 1 NOT NULL,
	"duration_periods" integer,
	"duration_percent" double precision,
	CONSTRAINT "system_outcome_package_nodes_package_node_unique" UNIQUE("package_id","node_id"),
	CONSTRAINT "system_outcome_package_nodes_kind_check" CHECK ("kind" in ('strand', 'topic', 'lesson'))
);
--> statement-breakpoint
CREATE TABLE "system_outcome_package_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"package_id" uuid NOT NULL,
	"outcome_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"position" integer DEFAULT 1 NOT NULL,
	"content" jsonb NOT NULL,
	"source_kind" text DEFAULT 'program' NOT NULL,
	"source_ref" text,
	CONSTRAINT "system_outcome_package_outcomes_package_outcome_unique" UNIQUE("package_id","outcome_id"),
	CONSTRAINT "system_outcome_package_outcomes_source_kind_check" CHECK ("source_kind" in ('program', 'derived'))
);
--> statement-breakpoint
CREATE TABLE "system_outcome_packages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"version" text NOT NULL UNIQUE,
	"scope" text NOT NULL,
	"checksum" text NOT NULL,
	"outcome_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_question_importers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"source_question_id" uuid NOT NULL,
	"centre_slug" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"imported_by" uuid,
	CONSTRAINT "system_question_importers_source_centre_unique" UNIQUE("source_question_id","centre_slug")
);
--> statement-breakpoint
CREATE TABLE "system_question_version_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"version_id" uuid NOT NULL,
	"outcome_id" uuid NOT NULL,
	"cognitive_level" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_question_version_outcomes_version_outcome_unique" UNIQUE("version_id","outcome_id"),
	CONSTRAINT "system_question_version_outcomes_cognitive_level_check" CHECK ("cognitive_level" in ('biet', 'hieu', 'van_dung', 'van_dung_cao'))
);
--> statement-breakpoint
CREATE TABLE "system_question_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"question_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"checksum" text NOT NULL,
	"package" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_question_versions_question_version_unique" UNIQUE("question_id","version")
);
--> statement-breakpoint
CREATE TABLE "system_questions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"qtype" text NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"withdrawn_reason" text,
	"withdrawn_by" uuid,
	"withdrawn_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_questions_status_check" CHECK ("status" in ('published', 'withdrawn')),
	CONSTRAINT "system_questions_qtype_check" CHECK ("qtype" in ('multichoice', 'truefalse', 'shortanswer', 'essay'))
);
--> statement-breakpoint
CREATE INDEX "system_bank_events_source_question_id_idx" ON "system_bank_events" ("source_question_id");--> statement-breakpoint
CREATE INDEX "system_bank_events_created_at_idx" ON "system_bank_events" ("created_at");--> statement-breakpoint
CREATE INDEX "system_outcome_package_curricula_package_id_idx" ON "system_outcome_package_curricula" ("package_id");--> statement-breakpoint
CREATE INDEX "system_outcome_package_mappings_package_id_idx" ON "system_outcome_package_mappings" ("package_id");--> statement-breakpoint
CREATE INDEX "system_outcome_package_nodes_package_id_idx" ON "system_outcome_package_nodes" ("package_id");--> statement-breakpoint
CREATE INDEX "system_outcome_package_outcomes_package_id_idx" ON "system_outcome_package_outcomes" ("package_id");--> statement-breakpoint
CREATE INDEX "system_outcome_packages_scope_idx" ON "system_outcome_packages" ("scope");--> statement-breakpoint
CREATE INDEX "system_question_importers_source_question_id_idx" ON "system_question_importers" ("source_question_id");--> statement-breakpoint
CREATE INDEX "system_question_version_outcomes_version_id_idx" ON "system_question_version_outcomes" ("version_id");--> statement-breakpoint
CREATE INDEX "system_question_version_outcomes_outcome_id_idx" ON "system_question_version_outcomes" ("outcome_id");--> statement-breakpoint
CREATE INDEX "system_question_versions_question_id_idx" ON "system_question_versions" ("question_id");--> statement-breakpoint
CREATE INDEX "system_questions_qtype_idx" ON "system_questions" ("qtype");--> statement-breakpoint
CREATE INDEX "system_questions_status_idx" ON "system_questions" ("status");--> statement-breakpoint
ALTER TABLE "system_outcome_package_curricula" ADD CONSTRAINT "system_outcome_package_curricula_pqbQsPtMt8pw_fkey" FOREIGN KEY ("package_id") REFERENCES "system_outcome_packages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "system_outcome_package_mappings" ADD CONSTRAINT "system_outcome_package_mappings_OScdEITI6gp9_fkey" FOREIGN KEY ("package_id") REFERENCES "system_outcome_packages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "system_outcome_package_nodes" ADD CONSTRAINT "system_outcome_package_nodes_vBlvjfGD82wV_fkey" FOREIGN KEY ("package_id") REFERENCES "system_outcome_packages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "system_outcome_package_outcomes" ADD CONSTRAINT "system_outcome_package_outcomes_gAh6cYYuvtz1_fkey" FOREIGN KEY ("package_id") REFERENCES "system_outcome_packages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "system_question_importers" ADD CONSTRAINT "system_question_importers_fJtgdunFiShR_fkey" FOREIGN KEY ("source_question_id") REFERENCES "system_questions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "system_question_version_outcomes" ADD CONSTRAINT "system_question_version_outcomes_bSaivvWUM2KB_fkey" FOREIGN KEY ("version_id") REFERENCES "system_question_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "system_question_versions" ADD CONSTRAINT "system_question_versions_question_id_system_questions_id_fkey" FOREIGN KEY ("question_id") REFERENCES "system_questions"("id") ON DELETE CASCADE;
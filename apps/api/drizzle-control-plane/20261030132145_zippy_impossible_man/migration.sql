CREATE TABLE "space_registry" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"slug" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"database_name" text NOT NULL,
	"storage_mode" text NOT NULL,
	"connection_role_ref" text NOT NULL,
	"secret_ref" text,
	"schema_version" text,
	"plan" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "space_registry_history" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"space_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "space_schema_migration_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"space_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"from_version" text,
	"to_version" text,
	"status" text NOT NULL,
	"steps" jsonb DEFAULT '[]' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "space_schema_registry" (
	"space_id" uuid PRIMARY KEY,
	"current_version" text,
	"last_backup_status" text,
	"last_backup_at" timestamp with time zone,
	"last_restore_status" text,
	"last_restore_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "space_registry_status_idx" ON "space_registry" ("status");--> statement-breakpoint
CREATE INDEX "space_registry_history_space_id_idx" ON "space_registry_history" ("space_id");--> statement-breakpoint
CREATE INDEX "space_schema_migration_runs_space_id_idx" ON "space_schema_migration_runs" ("space_id");--> statement-breakpoint
ALTER TABLE "space_registry_history" ADD CONSTRAINT "space_registry_history_space_id_space_registry_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space_registry"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "space_schema_migration_runs" ADD CONSTRAINT "space_schema_migration_runs_space_id_space_registry_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space_registry"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "space_schema_registry" ADD CONSTRAINT "space_schema_registry_space_id_space_registry_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space_registry"("id") ON DELETE RESTRICT;
CREATE TABLE "space_join_code_directory" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"join_code" text NOT NULL UNIQUE,
	"space_slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "space_membership_directory" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"global_user_id" uuid NOT NULL,
	"space_slug" text NOT NULL,
	"space_user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "space_join_code_directory_space_slug_idx" ON "space_join_code_directory" ("space_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "space_membership_directory_user_space_unique" ON "space_membership_directory" ("global_user_id","space_slug");--> statement-breakpoint
CREATE INDEX "space_membership_directory_space_user_idx" ON "space_membership_directory" ("space_user_id");
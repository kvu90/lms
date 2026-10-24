CREATE TABLE "message_moderator_actions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"message_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"message_seq" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_user_deletions" (
	"message_id" uuid,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_user_deletions_pkey" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "recalled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "recalled_by" uuid;--> statement-breakpoint
CREATE INDEX "message_moderator_actions_message_id_idx" ON "message_moderator_actions" ("message_id");--> statement-breakpoint
CREATE INDEX "message_moderator_actions_conversation_id_idx" ON "message_moderator_actions" ("conversation_id");--> statement-breakpoint
CREATE INDEX "message_moderator_actions_actor_id_idx" ON "message_moderator_actions" ("actor_id");--> statement-breakpoint
CREATE INDEX "message_user_deletions_user_id_idx" ON "message_user_deletions" ("user_id");--> statement-breakpoint
ALTER TABLE "message_user_deletions" ADD CONSTRAINT "message_user_deletions_message_id_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE CASCADE;
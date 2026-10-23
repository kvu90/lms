CREATE TABLE "user_oauth_links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"userid" uuid NOT NULL,
	"issuer" text NOT NULL,
	"issuer_user_id" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_oauth_links_issuer_subject_unique" UNIQUE("issuer","issuer_user_id"),
	CONSTRAINT "user_oauth_links_user_issuer_unique" UNIQUE("userid","issuer")
);
--> statement-breakpoint
CREATE INDEX "user_oauth_links_userid_idx" ON "user_oauth_links" ("userid");--> statement-breakpoint
ALTER TABLE "user_oauth_links" ADD CONSTRAINT "user_oauth_links_userid_users_id_fkey" FOREIGN KEY ("userid") REFERENCES "users"("id") ON DELETE CASCADE;
CREATE TABLE "assign_grades" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"assignment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"grader_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"grade" double precision,
	"feedback" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assign_grades_assignment_user_unique" UNIQUE("assignment_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "assign_submission_files" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"submission_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assign_submission_files_submission_file_unique" UNIQUE("submission_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "assign_submissions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"assignment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assign_submissions_assignment_user_unique" UNIQUE("assignment_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course" uuid NOT NULL,
	"cm_id" uuid,
	"name" text NOT NULL,
	"intro" text DEFAULT '' NOT NULL,
	"due_date" timestamp with time zone,
	"max_files" integer DEFAULT 10 NOT NULL,
	"accepted_file_types" text,
	"grade" double precision DEFAULT 10 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "assign_grades_assignment_id_idx" ON "assign_grades" ("assignment_id");--> statement-breakpoint
CREATE INDEX "assign_grades_user_id_idx" ON "assign_grades" ("user_id");--> statement-breakpoint
CREATE INDEX "assign_submission_files_submission_id_idx" ON "assign_submission_files" ("submission_id");--> statement-breakpoint
CREATE INDEX "assign_submissions_assignment_id_idx" ON "assign_submissions" ("assignment_id");--> statement-breakpoint
CREATE INDEX "assign_submissions_user_id_idx" ON "assign_submissions" ("user_id");--> statement-breakpoint
CREATE INDEX "assignments_course_idx" ON "assignments" ("course");--> statement-breakpoint
CREATE INDEX "assignments_cm_id_idx" ON "assignments" ("cm_id");--> statement-breakpoint
ALTER TABLE "assign_grades" ADD CONSTRAINT "assign_grades_assignment_id_assignments_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assign_submission_files" ADD CONSTRAINT "assign_submission_files_2yBSlJM0A5zz_fkey" FOREIGN KEY ("submission_id") REFERENCES "assign_submissions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assign_submission_files" ADD CONSTRAINT "assign_submission_files_file_id_files_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assign_submissions" ADD CONSTRAINT "assign_submissions_assignment_id_assignments_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_course_course_id_fkey" FOREIGN KEY ("course") REFERENCES "course"("id") ON DELETE CASCADE;
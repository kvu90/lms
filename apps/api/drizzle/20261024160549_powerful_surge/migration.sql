CREATE TABLE "assign_annotations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"submission_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"page" integer DEFAULT 1 NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"kind" text NOT NULL,
	"color" text,
	"text" text,
	"points" jsonb,
	"author_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assign_feedback_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"grade_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assign_grade_revisions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"grade_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"previous_grade" double precision,
	"new_grade" double precision,
	"previous_level" text,
	"new_level" text,
	"previous_feedback" text,
	"new_feedback" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assign_rubric_criteria" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"rubric_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description_for_student" text,
	"description_for_grader" text,
	"mode" text DEFAULT 'levels' NOT NULL,
	"max_score" double precision,
	"outcome_id" text,
	"outcome_text" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assign_rubric_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"grade_id" uuid NOT NULL,
	"criterion_id" uuid NOT NULL,
	"level_id" uuid,
	"score" double precision,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assign_rubric_evaluations_grade_criterion_unique" UNIQUE("grade_id","criterion_id")
);
--> statement-breakpoint
CREATE TABLE "assign_rubric_levels" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"criterion_id" uuid NOT NULL,
	"label" text NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assign_rubrics" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"assignment_id" uuid NOT NULL CONSTRAINT "assign_rubrics_assignment_unique" UNIQUE,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teacher_comment_bank" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner_id" uuid NOT NULL,
	"category" text,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assign_grades" ADD COLUMN "level" text;--> statement-breakpoint
ALTER TABLE "assign_grades" ADD COLUMN "feedback_progress" text;--> statement-breakpoint
ALTER TABLE "assign_grades" ADD COLUMN "feedback_strengths" text;--> statement-breakpoint
ALTER TABLE "assign_grades" ADD COLUMN "feedback_weaknesses" text;--> statement-breakpoint
ALTER TABLE "assign_grades" ADD COLUMN "status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "assign_grades" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assign_grades" ADD COLUMN "released_by" uuid;--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "result_mode" text DEFAULT 'score_feedback' NOT NULL;--> statement-breakpoint
CREATE INDEX "assign_annotations_submission_id_idx" ON "assign_annotations" ("submission_id");--> statement-breakpoint
CREATE INDEX "assign_annotations_file_id_idx" ON "assign_annotations" ("file_id");--> statement-breakpoint
CREATE INDEX "assign_feedback_messages_grade_id_idx" ON "assign_feedback_messages" ("grade_id");--> statement-breakpoint
CREATE INDEX "assign_grade_revisions_grade_id_idx" ON "assign_grade_revisions" ("grade_id");--> statement-breakpoint
CREATE INDEX "assign_rubric_criteria_rubric_id_idx" ON "assign_rubric_criteria" ("rubric_id");--> statement-breakpoint
CREATE INDEX "assign_rubric_evaluations_grade_id_idx" ON "assign_rubric_evaluations" ("grade_id");--> statement-breakpoint
CREATE INDEX "assign_rubric_levels_criterion_id_idx" ON "assign_rubric_levels" ("criterion_id");--> statement-breakpoint
CREATE INDEX "teacher_comment_bank_owner_id_idx" ON "teacher_comment_bank" ("owner_id");--> statement-breakpoint
ALTER TABLE "assign_annotations" ADD CONSTRAINT "assign_annotations_submission_id_assign_submissions_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "assign_submissions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assign_annotations" ADD CONSTRAINT "assign_annotations_file_id_files_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assign_feedback_messages" ADD CONSTRAINT "assign_feedback_messages_grade_id_assign_grades_id_fkey" FOREIGN KEY ("grade_id") REFERENCES "assign_grades"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assign_grade_revisions" ADD CONSTRAINT "assign_grade_revisions_grade_id_assign_grades_id_fkey" FOREIGN KEY ("grade_id") REFERENCES "assign_grades"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assign_rubric_criteria" ADD CONSTRAINT "assign_rubric_criteria_rubric_id_assign_rubrics_id_fkey" FOREIGN KEY ("rubric_id") REFERENCES "assign_rubrics"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assign_rubric_evaluations" ADD CONSTRAINT "assign_rubric_evaluations_grade_id_assign_grades_id_fkey" FOREIGN KEY ("grade_id") REFERENCES "assign_grades"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assign_rubric_evaluations" ADD CONSTRAINT "assign_rubric_evaluations_HlmmYPrbTwKl_fkey" FOREIGN KEY ("criterion_id") REFERENCES "assign_rubric_criteria"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assign_rubric_evaluations" ADD CONSTRAINT "assign_rubric_evaluations_level_id_assign_rubric_levels_id_fkey" FOREIGN KEY ("level_id") REFERENCES "assign_rubric_levels"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "assign_rubric_levels" ADD CONSTRAINT "assign_rubric_levels_F1wj7IWBuE4l_fkey" FOREIGN KEY ("criterion_id") REFERENCES "assign_rubric_criteria"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assign_rubrics" ADD CONSTRAINT "assign_rubrics_assignment_id_assignments_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE;
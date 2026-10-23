CREATE TABLE "qtype_essay_options" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"questionversionid" uuid NOT NULL CONSTRAINT "qtype_essay_options_version_unique" UNIQUE,
	"responseformat" text DEFAULT 'editor' NOT NULL,
	"responserequired" boolean DEFAULT true NOT NULL,
	"responsefieldlines" integer DEFAULT 15 NOT NULL,
	"minwordlimit" integer,
	"maxwordlimit" integer,
	"graderinfo" jsonb,
	"responsetemplate" jsonb
);
--> statement-breakpoint
CREATE TABLE "qtype_multichoice_options" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"questionversionid" uuid NOT NULL CONSTRAINT "qtype_multichoice_options_version_unique" UNIQUE,
	"single" boolean DEFAULT true NOT NULL,
	"shuffleanswers" boolean DEFAULT false NOT NULL,
	"answernumbering" text DEFAULT 'abc' NOT NULL,
	"correctfeedback" jsonb,
	"partiallycorrectfeedback" jsonb,
	"incorrectfeedback" jsonb,
	"shownumcorrect" boolean DEFAULT false NOT NULL,
	"showstandardinstruction" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qtype_shortanswer_options" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"questionversionid" uuid NOT NULL CONSTRAINT "qtype_shortanswer_options_version_unique" UNIQUE,
	"usecase" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_answers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"questionversionid" uuid NOT NULL,
	"answer" jsonb NOT NULL,
	"fraction" double precision DEFAULT 0 NOT NULL,
	"feedback" jsonb,
	"sortorder" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_truefalse" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"questionversionid" uuid NOT NULL CONSTRAINT "question_truefalse_version_unique" UNIQUE,
	"trueanswer" uuid NOT NULL,
	"falseanswer" uuid NOT NULL,
	"showstandardinstruction" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stimuli" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"categoryid" uuid NOT NULL,
	"createdby" uuid,
	"content" jsonb NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "question_versions" ADD COLUMN "generalfeedback" jsonb;--> statement-breakpoint
ALTER TABLE "question_versions" ADD COLUMN "guidance" jsonb;--> statement-breakpoint
ALTER TABLE "question_versions" ADD COLUMN "penalty" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "question_versions" ADD COLUMN "stimulusid" uuid;--> statement-breakpoint
ALTER TABLE "question_versions" DROP COLUMN "answerdata";--> statement-breakpoint
ALTER TABLE "question_versions" ALTER COLUMN "questiontext" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "question_versions" ALTER COLUMN "questiontext" SET DATA TYPE jsonb USING (jsonb_build_object('type', 'doc', 'content', jsonb_build_array(jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', "questiontext"))))));--> statement-breakpoint
ALTER TABLE "question_versions" ALTER COLUMN "questiontext" SET DEFAULT '{"type":"doc","content":[{"type":"paragraph"}]}';--> statement-breakpoint
CREATE INDEX "question_answers_questionversionid_idx" ON "question_answers" ("questionversionid");--> statement-breakpoint
CREATE INDEX "question_versions_stimulusid_idx" ON "question_versions" ("stimulusid");--> statement-breakpoint
CREATE INDEX "stimuli_categoryid_idx" ON "stimuli" ("categoryid");--> statement-breakpoint
CREATE INDEX "stimuli_createdby_idx" ON "stimuli" ("createdby");--> statement-breakpoint
ALTER TABLE "qtype_essay_options" ADD CONSTRAINT "qtype_essay_options_questionversionid_question_versions_id_fkey" FOREIGN KEY ("questionversionid") REFERENCES "question_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "qtype_multichoice_options" ADD CONSTRAINT "qtype_multichoice_options_5ILBIK5w9ssS_fkey" FOREIGN KEY ("questionversionid") REFERENCES "question_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "qtype_shortanswer_options" ADD CONSTRAINT "qtype_shortanswer_options_r5Ff3LJya3l2_fkey" FOREIGN KEY ("questionversionid") REFERENCES "question_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_answers" ADD CONSTRAINT "question_answers_questionversionid_question_versions_id_fkey" FOREIGN KEY ("questionversionid") REFERENCES "question_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_truefalse" ADD CONSTRAINT "question_truefalse_questionversionid_question_versions_id_fkey" FOREIGN KEY ("questionversionid") REFERENCES "question_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_truefalse" ADD CONSTRAINT "question_truefalse_trueanswer_question_answers_id_fkey" FOREIGN KEY ("trueanswer") REFERENCES "question_answers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_truefalse" ADD CONSTRAINT "question_truefalse_falseanswer_question_answers_id_fkey" FOREIGN KEY ("falseanswer") REFERENCES "question_answers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_stimulusid_stimuli_id_fkey" FOREIGN KEY ("stimulusid") REFERENCES "stimuli"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "stimuli" ADD CONSTRAINT "stimuli_categoryid_question_categories_id_fkey" FOREIGN KEY ("categoryid") REFERENCES "question_categories"("id") ON DELETE CASCADE;
CREATE TABLE "admin_setting_audit" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"setting_key" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"changed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"key" text NOT NULL UNIQUE,
	"value" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"seq" bigint UNIQUE GENERATED ALWAYS AS IDENTITY (sequence name "event_log_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event_type" text NOT NULL,
	"context_id" uuid,
	"user_id" uuid,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"seq" bigint UNIQUE GENERATED ALWAYS AS IDENTITY (sequence name "outbox_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"aggregate" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "plugin_config" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"plugin" text NOT NULL,
	"name" text NOT NULL,
	"value" text,
	CONSTRAINT "plugin_config_plugin_name_unique" UNIQUE("plugin","name")
);
--> statement-breakpoint
CREATE TABLE "scheduled_task_config" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"task_name" text NOT NULL UNIQUE,
	"schedule" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"task_name" text NOT NULL,
	"status" text NOT NULL,
	"message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "capabilities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL UNIQUE,
	"cap_type" text DEFAULT 'write' NOT NULL,
	"context_level" integer DEFAULT 10 NOT NULL,
	"component" text DEFAULT 'core' NOT NULL,
	"risk_bitmask" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"context_level" integer NOT NULL,
	"instance_id" uuid,
	"path" text NOT NULL,
	"depth" integer NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "context_level_instance_unique" UNIQUE("context_level","instance_id")
);
--> statement-breakpoint
CREATE TABLE "role" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text DEFAULT '' NOT NULL,
	"short_name" text NOT NULL UNIQUE,
	"description" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archetype" text
);
--> statement-breakpoint
CREATE TABLE "role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"role_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"context_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modifier_id" uuid,
	"component" text DEFAULT '' NOT NULL,
	"item_id" uuid,
	CONSTRAINT "role_assignments_unique" UNIQUE("role_id","user_id","context_id","component","item_id")
);
--> statement-breakpoint
CREATE TABLE "role_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"context_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"permission" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modifier_id" uuid,
	CONSTRAINT "role_capabilities_unique" UNIQUE("context_id","role_id","capability")
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"value" text,
	CONSTRAINT "user_preferences_unique" UNIQUE("user_id","name")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"username" text NOT NULL UNIQUE,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"password_hash" text,
	"first_name" text DEFAULT '' NOT NULL,
	"last_name" text DEFAULT '' NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"force_password_change" boolean DEFAULT false NOT NULL,
	"is_guest" boolean DEFAULT false NOT NULL,
	"last_login" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_user_id_provider_id_unique" UNIQUE("user_id","provider_id")
);
--> statement-breakpoint
CREATE TABLE "jwks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"alg" text,
	"crv" text
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL UNIQUE,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid,
	"username" text NOT NULL,
	"success" boolean NOT NULL,
	"ip" text,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_access_token" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"token" text UNIQUE,
	"client_id" text NOT NULL,
	"session_id" uuid,
	"user_id" uuid,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"refresh_id" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	"revoked" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid(),
	"client_id" text NOT NULL UNIQUE,
	"client_secret" text,
	"client_discovery_id" text,
	"disabled" boolean DEFAULT false NOT NULL,
	"skip_consent" boolean,
	"enable_end_session" boolean,
	"subject_type" text,
	"scopes" text[],
	"client_credentials_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text[],
	"tos" text,
	"policy" text,
	"software_id" text,
	"software_version" text,
	"software_statement" text,
	"redirect_uris" text[] NOT NULL,
	"post_logout_redirect_uris" text[],
	"backchannel_logout_uri" text,
	"backchannel_logout_session_required" boolean,
	"token_endpoint_auth_method" text,
	"application_type" text,
	"jwks" text,
	"jwks_uri" text,
	"grant_types" text[],
	"response_types" text[],
	"require_pkce" boolean,
	"dpop_bound_access_tokens" boolean DEFAULT false NOT NULL,
	"reference_id" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "oauth_client_assertion" (
	"id" text PRIMARY KEY,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client_resource" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone,
	CONSTRAINT "oauth_client_resource_client_resource_unique" UNIQUE("client_id","resource_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_consent" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"client_id" text NOT NULL,
	"user_id" uuid,
	"reference_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_token" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"token" text NOT NULL UNIQUE,
	"client_id" text NOT NULL,
	"session_id" uuid,
	"user_id" uuid NOT NULL,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	"revoked" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"rotation_replay_response" text,
	"rotation_replay_expires_at" timestamp with time zone,
	"auth_time" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_resource" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"identifier" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"access_token_ttl" integer,
	"refresh_token_ttl" integer,
	"signing_algorithm" text,
	"signing_key_id" text,
	"allowed_scopes" text[],
	"custom_claims" jsonb,
	"dpop_bound_access_tokens_required" boolean DEFAULT false NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "refresh_token_family" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"family_id" text NOT NULL UNIQUE,
	"user_id" uuid NOT NULL,
	"ip" text,
	"user_agent" text,
	"current_token_hash" text NOT NULL,
	"previous_token_hash" text,
	"revoked" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_oauth_links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL,
	"issuer" text NOT NULL,
	"issuer_user_id" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_oauth_links_issuer_subject_unique" UNIQUE("issuer","issuer_user_id"),
	CONSTRAINT "user_oauth_links_user_issuer_unique" UNIQUE("user_id","issuer")
);
--> statement-breakpoint
CREATE TABLE "user_totp" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL UNIQUE,
	"secret_encrypted" text NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "custom_field_category" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"component" text NOT NULL,
	"area" text NOT NULL,
	"item_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_field_data" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"field_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"value" text,
	"value_format" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_field_data_unique" UNIQUE("field_id","instance_id")
);
--> statement-breakpoint
CREATE TABLE "custom_field_field" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"category_id" uuid NOT NULL,
	"short_name" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config_data" jsonb DEFAULT '{}' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"content_hash" text NOT NULL,
	"context_id" uuid NOT NULL,
	"component" text NOT NULL,
	"file_area" text NOT NULL,
	"item_id" uuid,
	"file_path" text DEFAULT '/' NOT NULL,
	"file_name" text NOT NULL,
	"user_id" uuid,
	"file_size" integer NOT NULL,
	"mime_type" text,
	"status" integer DEFAULT 0 NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"category" uuid NOT NULL,
	"full_name" text NOT NULL,
	"short_name" text NOT NULL UNIQUE,
	"id_number" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"format" text DEFAULT 'topics' NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	"group_mode" integer DEFAULT 0 NOT NULL,
	"group_mode_force" boolean DEFAULT false NOT NULL,
	"enable_completion" boolean DEFAULT true NOT NULL,
	"subject_id" uuid,
	"grade" smallint,
	"is_template" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_grade_check" CHECK ("grade" is null or ("grade" between 1 and 12))
);
--> statement-breakpoint
CREATE TABLE "course_categories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"id_number" text,
	"description" text DEFAULT '' NOT NULL,
	"parent" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"path" text DEFAULT '' NOT NULL,
	"depth" integer DEFAULT 1 NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_format_options" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course_id" uuid NOT NULL,
	"format" text NOT NULL,
	"section_id" uuid,
	"name" text NOT NULL,
	"value" text,
	CONSTRAINT "course_format_options_unique" UNIQUE("course_id","format","section_id","name")
);
--> statement-breakpoint
CREATE TABLE "course_modules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course" uuid NOT NULL,
	"section" uuid NOT NULL,
	"component" text NOT NULL,
	"instance_id" uuid,
	"name" text DEFAULT '' NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"group_mode" integer DEFAULT 0 NOT NULL,
	"availability" jsonb,
	"completion" integer DEFAULT 0 NOT NULL,
	"completion_view" boolean DEFAULT false NOT NULL,
	"completion_use_grade" boolean DEFAULT false NOT NULL,
	"completion_manual" boolean DEFAULT false NOT NULL,
	"completion_expected" timestamp with time zone,
	"open_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"deletion_in_progress" boolean DEFAULT false NOT NULL,
	"added" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_section_anchor_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"anchor_id" uuid NOT NULL,
	"outcome_id" uuid,
	"content" text NOT NULL,
	"position" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_section_anchor_outcomes_position_check" CHECK ("position" > 0)
);
--> statement-breakpoint
CREATE TABLE "course_section_anchors" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"section_id" uuid NOT NULL CONSTRAINT "course_section_anchors_section_unique" UNIQUE,
	"node_id" uuid,
	"curriculum_id" uuid,
	"node_title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_section_book_anchors" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"section_id" uuid NOT NULL CONSTRAINT "course_section_book_anchors_section_unique" UNIQUE,
	"book_node_id" uuid,
	"book_id" uuid,
	"node_title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_section_book_item_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"item_id" uuid NOT NULL,
	"outcome_id" uuid,
	"content" text NOT NULL,
	"position" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_section_book_item_outcomes_position_check" CHECK ("position" > 0)
);
--> statement-breakpoint
CREATE TABLE "course_section_book_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"anchor_id" uuid NOT NULL,
	"book_node_id" uuid,
	"title" text NOT NULL,
	"position" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_section_book_items_position_check" CHECK ("position" > 0)
);
--> statement-breakpoint
CREATE TABLE "course_sections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course" uuid NOT NULL,
	"section" integer DEFAULT 0 NOT NULL,
	"name" text,
	"summary" text DEFAULT '' NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"availability" jsonb,
	"open_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_sections_course_section_unique" UNIQUE("course","section")
);
--> statement-breakpoint
CREATE TABLE "cohort" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"id_number" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"context_id" uuid NOT NULL,
	"component" text DEFAULT '' NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cohort_members" (
	"cohort_id" uuid,
	"user_id" uuid,
	"time_added" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cohort_members_pkey" PRIMARY KEY("cohort_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "course_groups" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course_id" uuid NOT NULL,
	"name" text NOT NULL,
	"id_number" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"enrolment_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_groups_course_name_unique" UNIQUE("course_id","name")
);
--> statement-breakpoint
CREATE TABLE "groupings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course_id" uuid NOT NULL,
	"name" text NOT NULL,
	"id_number" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groupings_course_name_unique" UNIQUE("course_id","name")
);
--> statement-breakpoint
CREATE TABLE "groupings_groups" (
	"grouping_id" uuid,
	"group_id" uuid,
	"time_added" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groupings_groups_pkey" PRIMARY KEY("grouping_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "groups_members" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"time_added" timestamp with time zone DEFAULT now() NOT NULL,
	"component" text DEFAULT '' NOT NULL,
	"item_id" uuid,
	CONSTRAINT "groups_members_unique" UNIQUE("group_id","user_id","component","item_id")
);
--> statement-breakpoint
CREATE TABLE "enrol" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course_id" uuid NOT NULL,
	"enrol" text NOT NULL,
	"status" integer DEFAULT 0 NOT NULL,
	"name" text,
	"role_id" uuid,
	"enrol_period" integer DEFAULT 0 NOT NULL,
	"time_start" timestamp with time zone,
	"time_end" timestamp with time zone,
	"custom_int1" uuid,
	"custom_int2" uuid,
	"custom_text1" text DEFAULT 'suspend' NOT NULL,
	"cost" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT '' NOT NULL,
	"payment_account_id" uuid,
	"enrolment_key" text,
	"send_welcome_message" boolean DEFAULT false NOT NULL,
	"welcome_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_enrolments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"enrol_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" integer DEFAULT 0 NOT NULL,
	"time_start" timestamp with time zone DEFAULT now() NOT NULL,
	"time_end" timestamp with time zone,
	"modifier_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_enrolments_unique" UNIQUE("enrol_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "course_completion_crit_compl" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"criteria_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"marked_by" uuid,
	"time_completed" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_completion_crit_compl_unique" UNIQUE("criteria_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "course_completion_criteria" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course" uuid NOT NULL,
	"criteria_type" text NOT NULL,
	"module_instance" uuid,
	"date" timestamp with time zone,
	"course_instance" uuid,
	"enrol_period_days" integer,
	"role_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_completion_settings" (
	"course" uuid PRIMARY KEY,
	"method" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_completions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL,
	"course" uuid NOT NULL,
	"status" text DEFAULT 'not_started' NOT NULL,
	"time_enrolled" timestamp with time zone DEFAULT now() NOT NULL,
	"time_started" timestamp with time zone,
	"time_completed" timestamp with time zone,
	"re_aggregate" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_completions_unique" UNIQUE("user_id","course")
);
--> statement-breakpoint
CREATE TABLE "course_modules_completion" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course_module_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"completion_state" integer DEFAULT 0 NOT NULL,
	"viewed" boolean DEFAULT false NOT NULL,
	"override_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_modules_completion_unique" UNIQUE("course_module_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "grade_categories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course_id" uuid NOT NULL,
	"parent" uuid,
	"full_name" text DEFAULT '' NOT NULL,
	"aggregation" text DEFAULT 'natural' NOT NULL,
	"drop_low" integer DEFAULT 0 NOT NULL,
	"keep_high" integer DEFAULT 0 NOT NULL,
	"aggregate_only_graded" boolean DEFAULT false NOT NULL,
	"depth" integer DEFAULT 1 NOT NULL,
	"path" text DEFAULT '' NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grade_grades" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"item_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"raw_grade" double precision,
	"raw_grade_max" double precision DEFAULT 100 NOT NULL,
	"raw_grade_min" double precision DEFAULT 0 NOT NULL,
	"final_grade" double precision,
	"hidden" boolean DEFAULT false NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"lock_time" timestamp with time zone,
	"overridden" boolean DEFAULT false NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"frozen" boolean DEFAULT false NOT NULL,
	"feedback" text,
	"information" text,
	"aggregation_status" text DEFAULT 'unknown' NOT NULL,
	"aggregation_weight" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grade_grades_item_user_unique" UNIQUE("item_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "grade_grades_history" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"action" integer DEFAULT 2 NOT NULL,
	"old_id" uuid,
	"item_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"raw_grade" double precision,
	"final_grade" double precision,
	"overridden" boolean DEFAULT false NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"frozen" boolean DEFAULT false NOT NULL,
	"source" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"logged_user" uuid
);
--> statement-breakpoint
CREATE TABLE "grade_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course_id" uuid NOT NULL,
	"category_id" uuid,
	"item_name" text DEFAULT '' NOT NULL,
	"item_type" text DEFAULT 'manual' NOT NULL,
	"item_module" text,
	"item_instance" uuid,
	"grade_type" text DEFAULT 'value' NOT NULL,
	"grade_max" double precision DEFAULT 100 NOT NULL,
	"grade_min" double precision DEFAULT 0 NOT NULL,
	"grade_pass" double precision DEFAULT 0 NOT NULL,
	"scale_id" uuid,
	"outcome_id" uuid,
	"id_number" text,
	"calculation" text,
	"weight_override" boolean DEFAULT false NOT NULL,
	"aggregation_coef" double precision DEFAULT 0 NOT NULL,
	"extra_credit" boolean DEFAULT false NOT NULL,
	"multiplicator" double precision DEFAULT 1 NOT NULL,
	"plus_factor" double precision DEFAULT 0 NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"posting_policy" text DEFAULT 'auto' NOT NULL,
	"vn_book_id" uuid,
	"vn_role" text,
	"vn_ordinal" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grade_items_course_id_number_unique" UNIQUE("course_id","id_number"),
	CONSTRAINT "grade_items_course_type_instance_unique" UNIQUE("course_id","item_type","item_instance","item_module")
);
--> statement-breakpoint
CREATE TABLE "grade_letters" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"context_id" uuid NOT NULL,
	"lower_boundary" double precision NOT NULL,
	"letter" text NOT NULL,
	CONSTRAINT "grade_letters_context_boundary_unique" UNIQUE("context_id","lower_boundary")
);
--> statement-breakpoint
CREATE TABLE "grade_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course_id" uuid,
	"scale_id" uuid NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grade_publications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"item_id" uuid,
	"book_id" uuid,
	"user_id" uuid,
	"action" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scales" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course_id" uuid,
	"name" text NOT NULL,
	"scale" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vn_activity_mappings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"cm_id" uuid NOT NULL CONSTRAINT "vn_activity_mappings_cm_unique" UNIQUE,
	"item_id" uuid NOT NULL,
	"target_item_id" uuid NOT NULL,
	"role" text NOT NULL,
	"ordinal" integer,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vn_candidate_actions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"mapping_id" uuid,
	"target_item_id" uuid NOT NULL,
	"source_item_id" uuid,
	"user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"source_grade_value" double precision,
	"source_grade_updated_at" timestamp with time zone,
	"converted_grade" double precision,
	"committed_value" double precision,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vn_gradebooks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course_id" uuid NOT NULL,
	"term" text NOT NULL,
	"regime" text DEFAULT 'tt22' NOT NULL,
	"assessment_mode" text DEFAULT 'score' NOT NULL,
	"subject_periods_per_year" integer,
	"dgtx_quota" integer DEFAULT 0 NOT NULL,
	"category_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"close_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vn_gradebooks_course_term_unique" UNIQUE("course_id","term")
);
--> statement-breakpoint
CREATE TABLE "vn_term_results" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"book_id" uuid,
	"course_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" text DEFAULT 'term' NOT NULL,
	"dtb_hk" double precision,
	"dtb_year" double precision,
	"comment_result" text,
	"comment" text,
	"replaced_by_result_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guardian_digests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"guardian_user_id" uuid NOT NULL,
	"student_user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"activity_cm_id" uuid,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"new_results_count" integer DEFAULT 0 NOT NULL,
	"announcements_count" integer DEFAULT 0 NOT NULL,
	"overdue_count" integer DEFAULT 0 NOT NULL,
	"upcoming_count" integer DEFAULT 0 NOT NULL,
	"notification_id" uuid,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guardian_links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"guardian_user_id" uuid NOT NULL,
	"student_user_id" uuid NOT NULL,
	"relationship" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"revoked_by" uuid,
	"revoked_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guardian_view_state" (
	"guardian_user_id" uuid,
	"student_user_id" uuid,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guardian_view_state_pkey" PRIMARY KEY("guardian_user_id","student_user_id")
);
--> statement-breakpoint
CREATE TABLE "user_course_card_prefs" (
	"user_id" uuid,
	"course_id" uuid,
	"color" text,
	"nickname" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_course_card_prefs_pkey" PRIMARY KEY("user_id","course_id")
);
--> statement-breakpoint
CREATE TABLE "user_dashboard_state" (
	"user_id" uuid PRIMARY KEY,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qtype_essay_options" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"question_version_id" uuid NOT NULL CONSTRAINT "qtype_essay_options_version_unique" UNIQUE,
	"response_format" text DEFAULT 'editor' NOT NULL,
	"response_required" boolean DEFAULT true NOT NULL,
	"response_field_lines" integer DEFAULT 15 NOT NULL,
	"min_word_limit" integer,
	"max_word_limit" integer,
	"grader_info" jsonb,
	"response_template" jsonb
);
--> statement-breakpoint
CREATE TABLE "qtype_multichoice_options" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"question_version_id" uuid NOT NULL CONSTRAINT "qtype_multichoice_options_version_unique" UNIQUE,
	"single" boolean DEFAULT true NOT NULL,
	"shuffle_answers" boolean DEFAULT false NOT NULL,
	"answer_numbering" text DEFAULT 'abc' NOT NULL,
	"correct_feedback" jsonb,
	"partially_correct_feedback" jsonb,
	"incorrect_feedback" jsonb,
	"show_num_correct" boolean DEFAULT false NOT NULL,
	"show_standard_instruction" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qtype_shortanswer_options" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"question_version_id" uuid NOT NULL CONSTRAINT "qtype_shortanswer_options_version_unique" UNIQUE,
	"use_case" boolean DEFAULT false NOT NULL,
	"numeric_answer" boolean DEFAULT false NOT NULL,
	"numeric_max_length" integer,
	"numeric_allow_sign" boolean DEFAULT true NOT NULL,
	"numeric_allow_decimal" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"category" uuid NOT NULL,
	"qtype" text NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid,
	"modified_by" uuid,
	"derived_from_question_id" uuid,
	"derived_from_version_id" uuid,
	"derived_from_bank_id" uuid,
	"original_author_id" uuid,
	"source_kind" text,
	"source_ref" text,
	"idnumber" text,
	"copy_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_answers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"question_version_id" uuid NOT NULL,
	"answer" jsonb NOT NULL,
	"fraction" double precision DEFAULT 0 NOT NULL,
	"feedback" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_attempt_step_data" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"attempt_step_id" uuid NOT NULL,
	"name" text NOT NULL,
	"value" text,
	CONSTRAINT "question_attempt_step_data_step_name_unique" UNIQUE("attempt_step_id","name")
);
--> statement-breakpoint
CREATE TABLE "question_attempt_steps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"question_attempt_id" uuid NOT NULL,
	"sequence_number" integer NOT NULL,
	"state" text NOT NULL,
	"fraction" double precision,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_attempt_steps_attempt_seq_unique" UNIQUE("question_attempt_id","sequence_number")
);
--> statement-breakpoint
CREATE TABLE "question_attempts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"question_usage_id" uuid NOT NULL,
	"slot" integer NOT NULL,
	"behaviour" text DEFAULT 'deferredfeedback' NOT NULL,
	"question_id" uuid NOT NULL,
	"question_version_id" uuid,
	"variant" integer DEFAULT 1 NOT NULL,
	"max_mark" double precision DEFAULT 1 NOT NULL,
	"min_fraction" double precision DEFAULT 0 NOT NULL,
	"max_fraction" double precision DEFAULT 1 NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"question_summary" text,
	"response_summary" text,
	"right_answer" text,
	"state" text DEFAULT 'notstarted' NOT NULL,
	"fraction" double precision,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_attempts_usage_slot_unique" UNIQUE("question_usage_id","slot")
);
--> statement-breakpoint
CREATE TABLE "question_bank_contributions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"question_id" uuid NOT NULL,
	"target_bank_id" uuid NOT NULL,
	"target_question_id" uuid,
	"proposer_id" uuid NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"mode" text DEFAULT 'new' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"content_hash" text DEFAULT '' NOT NULL,
	"near_duplicate_of" uuid,
	"reject_reason" text,
	"reviewer_id" uuid,
	"result_question_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_bank_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"question_category_id" uuid NOT NULL,
	"question_id" uuid NOT NULL CONSTRAINT "question_bank_entries_question_unique" UNIQUE,
	"latest_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"withdrawn_reason" text,
	"withdrawn_by" uuid,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_banks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"bank_kind" text DEFAULT 'question' NOT NULL,
	"scope" text NOT NULL,
	"owner_id" uuid,
	"scope_ref_id" uuid,
	"context_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_categories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"context_id" uuid NOT NULL,
	"bank_id" uuid,
	"info" text DEFAULT '' NOT NULL,
	"parent" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"stamp" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_truefalse" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"question_version_id" uuid NOT NULL CONSTRAINT "question_truefalse_version_unique" UNIQUE,
	"true_answer" uuid NOT NULL,
	"false_answer" uuid NOT NULL,
	"show_standard_instruction" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_usages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"component" text NOT NULL,
	"instance_id" uuid,
	"owning_context_id" uuid,
	"preferred_behaviour" text DEFAULT 'deferredfeedback' NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"question_bank_entry_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"question_text" jsonb DEFAULT '{"type":"doc","content":[{"type":"paragraph"}]}' NOT NULL,
	"general_feedback" jsonb,
	"guidance" jsonb,
	"default_mark" double precision DEFAULT 1 NOT NULL,
	"penalty" double precision DEFAULT 0 NOT NULL,
	"stimulus_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_versions_entry_version_unique" UNIQUE("question_bank_entry_id","version")
);
--> statement-breakpoint
CREATE TABLE "stimuli" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"category_id" uuid NOT NULL,
	"created_by" uuid,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"tool" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mcp_idempotency_keys_user_key_unique" UNIQUE("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "exam_deployments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"paper_id" uuid NOT NULL,
	"paper_version_id" uuid NOT NULL,
	"quiz_id" uuid NOT NULL,
	"variant_count" integer DEFAULT 1 NOT NULL,
	"variants" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exam_dossier_reviews" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"dossier_id" uuid NOT NULL,
	"level" integer NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_dossier_reviews_level_check" CHECK ("level" in (1, 2)),
	CONSTRAINT "exam_dossier_reviews_decision_check" CHECK ("decision" in ('approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "exam_dossiers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"paper_id" uuid NOT NULL,
	"target_bank_id" uuid NOT NULL,
	"proposer_id" uuid NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"paper_version_id" uuid,
	"paper_version_number" integer,
	"matrix_id" uuid,
	"matrix_version" integer,
	"spec_snapshot" jsonb,
	"result_paper_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_dossiers_status_check" CHECK ("status" in ('draft', 'pending', 'pending_board', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "exam_paper_contributions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"paper_id" uuid NOT NULL,
	"target_bank_id" uuid NOT NULL,
	"proposer_id" uuid NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"content_hash" text DEFAULT '' NOT NULL,
	"near_duplicate_of" uuid,
	"reject_reason" text,
	"reviewer_id" uuid,
	"result_paper_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exam_paper_slots" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"paper_version_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"section" text DEFAULT '' NOT NULL,
	"question_id" uuid NOT NULL,
	"pinned_version_id" uuid,
	"pinned_version_number" integer,
	"max_mark" double precision DEFAULT 1 NOT NULL,
	"cluster_id" uuid,
	"matrix_cell_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_paper_slots_version_position_unique" UNIQUE("paper_version_id","position")
);
--> statement-breakpoint
CREATE TABLE "exam_paper_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"paper_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"subject_id" uuid,
	"grade" integer,
	"exam_kind" text,
	"total_score" double precision DEFAULT 10 NOT NULL,
	"duration_minutes" integer,
	"tf_scale" jsonb,
	"matrix_id" uuid,
	"matrix_version" integer,
	"recipe_spec" jsonb,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_paper_versions_paper_version_unique" UNIQUE("paper_id","version"),
	CONSTRAINT "exam_paper_versions_exam_kind_check" CHECK ("exam_kind" is null or "exam_kind" in ('regular', 'midterm', 'final', 'mock', 'practice'))
);
--> statement-breakpoint
CREATE TABLE "exam_papers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"bank_id" uuid NOT NULL,
	"kind" text DEFAULT 'snapshot' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"derived_from_paper_id" uuid,
	"derived_from_matrix_id" uuid,
	"original_author_id" uuid,
	"created_by" uuid NOT NULL,
	"latest_version" integer DEFAULT 1 NOT NULL,
	"copy_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_papers_kind_check" CHECK ("kind" in ('snapshot', 'recipe')),
	CONSTRAINT "exam_papers_status_check" CHECK ("status" in ('draft', 'ready', 'hidden'))
);
--> statement-breakpoint
CREATE TABLE "exam_matrices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"curriculum_id" uuid NOT NULL,
	"context_id" uuid NOT NULL,
	"bank_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"is_template" boolean DEFAULT false NOT NULL,
	"derived_from_matrix_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"preset_kind" text DEFAULT 'custom' NOT NULL,
	"target_form_percents" jsonb,
	"target_level_percents" jsonb,
	"level_set" text DEFAULT 'three' NOT NULL,
	"scope_note" text,
	"scope_outcome_ids" jsonb,
	"total_score" double precision DEFAULT 10 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_matrices_preset_kind_check" CHECK ("preset_kind" in ('cv7991_periodic', 'qd764_graduation', 'custom')),
	CONSTRAINT "exam_matrices_level_set_check" CHECK ("level_set" in ('three', 'four')),
	CONSTRAINT "exam_matrices_status_check" CHECK ("status" in ('draft', 'ready', 'hidden'))
);
--> statement-breakpoint
CREATE TABLE "exam_matrix_cells" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"matrix_id" uuid NOT NULL,
	"learning_outcome_id" uuid NOT NULL,
	"cognitive_level" text NOT NULL,
	"qtype" text NOT NULL,
	"question_count" integer NOT NULL,
	"cell_score" double precision NOT NULL,
	"minutes" integer,
	"tf_scale" jsonb,
	"position" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_matrix_cells_unique" UNIQUE("matrix_id","learning_outcome_id","cognitive_level","qtype"),
	CONSTRAINT "exam_matrix_cells_level_check" CHECK ("cognitive_level" in ('biet', 'hieu', 'van_dung', 'van_dung_cao')),
	CONSTRAINT "exam_matrix_cells_qtype_check" CHECK ("qtype" in ('multichoice', 'truefalse', 'shortanswer', 'essay')),
	CONSTRAINT "exam_matrix_cells_count_check" CHECK ("question_count" > 0),
	CONSTRAINT "exam_matrix_cells_score_check" CHECK ("cell_score" > 0)
);
--> statement-breakpoint
CREATE TABLE "exam_matrix_contributions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"matrix_id" uuid NOT NULL,
	"target_bank_id" uuid NOT NULL,
	"proposer_id" uuid NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reject_reason" text,
	"reviewer_id" uuid,
	"result_matrix_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_matrix_contributions_status_check" CHECK ("status" in ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "quiz_attempt_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"attempt_id" uuid NOT NULL,
	"type" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quiz_attempts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"quiz_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"usage_id" uuid NOT NULL CONSTRAINT "quiz_attempts_usage_unique" UNIQUE,
	"state" text DEFAULT 'inprogress' NOT NULL,
	"preview" boolean DEFAULT false NOT NULL,
	"makeup" boolean DEFAULT false NOT NULL,
	"applied_settings" jsonb,
	"time_start" timestamp with time zone DEFAULT now() NOT NULL,
	"time_finish" timestamp with time zone,
	"sum_grades" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_attempts_quiz_user_number_unique" UNIQUE("quiz_id","user_id","attempt_number")
);
--> statement-breakpoint
CREATE TABLE "quiz_feedbacks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"quiz_id" uuid NOT NULL,
	"min_percent" double precision NOT NULL,
	"max_percent" double precision NOT NULL,
	"feedback" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_feedbacks_range_check" CHECK ("min_percent" >= 0 and "max_percent" <= 100 and "min_percent" < "max_percent")
);
--> statement-breakpoint
CREATE TABLE "quiz_overrides" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"quiz_id" uuid NOT NULL,
	"group_id" uuid,
	"user_id" uuid,
	"time_open" timestamp with time zone,
	"time_close" timestamp with time zone,
	"time_limit" integer,
	"attempts" integer,
	"password_hash" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_overrides_quiz_group_unique" UNIQUE("quiz_id","group_id"),
	CONSTRAINT "quiz_overrides_quiz_user_unique" UNIQUE("quiz_id","user_id"),
	CONSTRAINT "quiz_overrides_exactly_one_target" CHECK (("group_id" is null) <> ("user_id" is null))
);
--> statement-breakpoint
CREATE TABLE "quiz_slot_version_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"quiz_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"from_version" integer,
	"to_version" integer NOT NULL,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quiz_slots" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"quiz_id" uuid NOT NULL,
	"slot" integer NOT NULL,
	"page" integer DEFAULT 1 NOT NULL,
	"question_id" uuid,
	"category_id" uuid,
	"matrix_cell_id" uuid,
	"cluster_id" uuid,
	"max_mark" double precision DEFAULT 1 NOT NULL,
	"version_mode" text DEFAULT 'follow_latest' NOT NULL,
	"pinned_version_id" uuid,
	"pinned_version_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_slots_quiz_slot_unique" UNIQUE("quiz_id","slot"),
	CONSTRAINT "quiz_slots_source_rule" CHECK (("question_id" is not null or "category_id" is not null or "matrix_cell_id" is not null) and not ("category_id" is not null and ("question_id" is not null or "matrix_cell_id" is not null)))
);
--> statement-breakpoint
CREATE TABLE "quizzes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course" uuid NOT NULL,
	"cm_id" uuid,
	"name" text NOT NULL,
	"intro" text DEFAULT '' NOT NULL,
	"time_open" timestamp with time zone,
	"time_close" timestamp with time zone,
	"time_limit" integer,
	"attempts_allowed" integer DEFAULT 0 NOT NULL,
	"grade_method" text DEFAULT 'highest' NOT NULL,
	"grade" double precision DEFAULT 10 NOT NULL,
	"shuffle_answers" boolean DEFAULT false NOT NULL,
	"password_hash" text,
	"subnet" text,
	"delay1" integer,
	"delay2" integer,
	"review_attempt" integer DEFAULT 69904 NOT NULL,
	"review_correctness" integer DEFAULT 4368 NOT NULL,
	"review_marks" integer DEFAULT 4368 NOT NULL,
	"review_specific_feedback" integer DEFAULT 4368 NOT NULL,
	"review_general_feedback" integer DEFAULT 4368 NOT NULL,
	"review_right_answer" integer DEFAULT 272 NOT NULL,
	"review_overall_feedback" integer DEFAULT 4368 NOT NULL,
	"matrix_id" uuid,
	"paper_id" uuid,
	"paper_version_id" uuid,
	"tf_scale" jsonb,
	"exam_kind" text,
	"late_entry_minutes" integer,
	"monitor_events" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quizzes_exam_kind_check" CHECK ("exam_kind" is null or "exam_kind" in ('regular', 'periodic', 'mock'))
);
--> statement-breakpoint
CREATE TABLE "quiz_paper_batches" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"quiz_id" uuid NOT NULL,
	"variant_code" text NOT NULL,
	"exam_code" text,
	"code_digits" integer DEFAULT 4 NOT NULL,
	"layout" jsonb NOT NULL,
	"roster" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_paper_batches_quiz_variant_unique" UNIQUE("quiz_id","variant_code"),
	CONSTRAINT "quiz_paper_batches_quiz_exam_code_unique" UNIQUE("quiz_id","exam_code"),
	CONSTRAINT "quiz_paper_batches_code_digits_check" CHECK ("code_digits" in (4, 8))
);
--> statement-breakpoint
CREATE TABLE "quiz_paper_scans" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"batch_id" uuid,
	"session_id" uuid,
	"quiz_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"warped_file_id" uuid,
	"student_id" uuid,
	"identity_source" text,
	"identity_code" text,
	"variant_code_read" text,
	"status" text DEFAULT 'needs_identity' NOT NULL,
	"quality" jsonb,
	"readings" jsonb DEFAULT '[]' NOT NULL,
	"attempt_id" uuid,
	"uploaded_by" uuid NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_paper_scans_status_check" CHECK ("status" in ('needs_identity', 'needs_review', 'ready', 'recorded')),
	CONSTRAINT "quiz_paper_scans_identity_source_check" CHECK ("identity_source" is null or "identity_source" in ('qr', 'bubbles', 'manual'))
);
--> statement-breakpoint
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
CREATE TABLE "assign_grades" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"assignment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"grader_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"grade" double precision,
	"level" text,
	"feedback" text,
	"feedback_progress" text,
	"feedback_strengths" text,
	"feedback_weaknesses" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assign_grades_assignment_user_unique" UNIQUE("assignment_id","user_id")
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
	"result_mode" text DEFAULT 'score_feedback' NOT NULL,
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
CREATE TABLE "course_last_access" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"cm_id" uuid NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_last_access_user_course_unique" UNIQUE("user_id","course_id")
);
--> statement-breakpoint
CREATE TABLE "course_module_progress" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"cm_id" uuid NOT NULL,
	"percent" integer DEFAULT 0 NOT NULL,
	"position_seconds" integer,
	"page" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_module_progress_user_cm_unique" UNIQUE("user_id","cm_id")
);
--> statement-breakpoint
CREATE TABLE "learning_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"cm_id" uuid NOT NULL,
	"cm_name" text DEFAULT '' NOT NULL,
	"component" text DEFAULT '' NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_records_user_cm_unique" UNIQUE("user_id","cm_id")
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course" uuid NOT NULL,
	"cm_id" uuid,
	"name" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course" uuid NOT NULL,
	"cm_id" uuid,
	"name" text NOT NULL,
	"kind" text DEFAULT 'file' NOT NULL,
	"file_id" uuid,
	"url" text,
	"transcript" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "curricula" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"subject_id" uuid NOT NULL,
	"grade" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "curricula_subject_id_grade_unique" UNIQUE("subject_id","grade"),
	CONSTRAINT "curricula_grade_check" CHECK ("grade" between 1 and 12)
);
--> statement-breakpoint
CREATE TABLE "curriculum_nodes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"curriculum_id" uuid NOT NULL,
	"parent_id" uuid,
	"title" text NOT NULL,
	"kind" text DEFAULT 'topic' NOT NULL,
	"position" integer DEFAULT 1 NOT NULL,
	"duration_periods" integer,
	"duration_percent" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "curriculum_nodes_curriculum_id_id_unique" UNIQUE("curriculum_id","id"),
	CONSTRAINT "curriculum_nodes_parent_not_self_check" CHECK ("parent_id" is null or "parent_id" <> "id"),
	CONSTRAINT "curriculum_nodes_position_check" CHECK ("position" > 0),
	CONSTRAINT "curriculum_nodes_kind_check" CHECK ("kind" in ('strand', 'topic', 'lesson')),
	CONSTRAINT "curriculum_nodes_duration_periods_check" CHECK ("duration_periods" is null or "duration_periods" >= 0),
	CONSTRAINT "curriculum_nodes_duration_percent_check" CHECK ("duration_percent" is null or ("duration_percent" >= 0 and "duration_percent" <= 100))
);
--> statement-breakpoint
CREATE TABLE "curriculum_program_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"dataset_key" text NOT NULL,
	"record_id" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"curriculum_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"source" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "curriculum_program_records_dataset_record_unique" UNIQUE("dataset_key","record_id")
);
--> statement-breakpoint
CREATE TABLE "learning_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"node_id" uuid NOT NULL,
	"content" text NOT NULL,
	"position" integer DEFAULT 1 NOT NULL,
	"source_kind" text DEFAULT 'program' NOT NULL,
	"source_ref" text,
	"derived_from_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_outcomes_position_check" CHECK ("position" > 0),
	CONSTRAINT "learning_outcomes_source_kind_check" CHECK ("source_kind" in ('program', 'derived'))
);
--> statement-breakpoint
CREATE TABLE "question_learning_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"question_id" uuid NOT NULL,
	"learning_outcome_id" uuid NOT NULL,
	"cognitive_level" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_learning_outcomes_question_outcome_unique" UNIQUE("question_id","learning_outcome_id"),
	CONSTRAINT "question_learning_outcomes_cognitive_level_check" CHECK ("cognitive_level" in ('biet', 'hieu', 'van_dung', 'van_dung_cao'))
);
--> statement-breakpoint
CREATE TABLE "question_subjects" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"question_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_subjects_question_subject_unique" UNIQUE("question_id","subject_id")
);
--> statement-breakpoint
CREATE TABLE "subjects" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"context_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL UNIQUE,
	"position" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subjects_position_check" CHECK ("position" > 0)
);
--> statement-breakpoint
CREATE TABLE "book_mappings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"book_node_id" uuid NOT NULL,
	"curriculum_node_id" uuid,
	"learning_outcome_id" uuid,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_mappings_one_target_check" CHECK (("curriculum_node_id" is null) <> ("learning_outcome_id" is null))
);
--> statement-breakpoint
CREATE TABLE "book_nodes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"book_id" uuid NOT NULL,
	"parent_id" uuid,
	"title" text NOT NULL,
	"kind" text DEFAULT 'lesson' NOT NULL,
	"volume" smallint,
	"lesson_number" integer,
	"position" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_nodes_book_id_id_unique" UNIQUE("book_id","id"),
	CONSTRAINT "book_nodes_parent_not_self_check" CHECK ("parent_id" is null or "parent_id" <> "id"),
	CONSTRAINT "book_nodes_kind_check" CHECK ("kind" in ('chapter', 'lesson')),
	CONSTRAINT "book_nodes_volume_check" CHECK ("volume" is null or "volume" between 1 and 2),
	CONSTRAINT "book_nodes_lesson_number_check" CHECK ("lesson_number" is null or "lesson_number" > 0),
	CONSTRAINT "book_nodes_position_check" CHECK ("position" > 0)
);
--> statement-breakpoint
CREATE TABLE "book_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"dataset_key" text NOT NULL,
	"record_id" text NOT NULL,
	"book_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"source" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_records_dataset_record_unique" UNIQUE("dataset_key","record_id")
);
--> statement-breakpoint
CREATE TABLE "books" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"kind" text DEFAULT 'textbook' NOT NULL,
	"title" text NOT NULL,
	"subject_id" uuid,
	"grade" smallint,
	"series" text,
	"author" text,
	"publisher" text,
	"published_year" smallint,
	"isbn" text,
	"attribution_public" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "books_subject_grade_title_unique" UNIQUE("subject_id","grade","title"),
	CONSTRAINT "books_grade_check" CHECK ("grade" is null or "grade" between 1 and 12),
	CONSTRAINT "books_position_check" CHECK ("position" > 0)
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"conversation_id" uuid NOT NULL,
	"user_id_from" uuid NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"full_message" text DEFAULT '' NOT NULL,
	"small_message" text DEFAULT '' NOT NULL,
	"seq" integer NOT NULL,
	"client_message_id" text,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"recalled_at" timestamp with time zone,
	"recalled_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_conversation_client_id_unique" UNIQUE("conversation_id","user_id_from","client_message_id")
);
--> statement-breakpoint
CREATE TABLE "message_contact_requests" (
	"user_id_from" uuid,
	"user_id_to" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_contact_requests_pkey" PRIMARY KEY("user_id_from","user_id_to")
);
--> statement-breakpoint
CREATE TABLE "message_contacts" (
	"user_id" uuid,
	"contact_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_contacts_pkey" PRIMARY KEY("user_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE "message_conversation_members" (
	"conversation_id" uuid,
	"user_id" uuid,
	"last_read_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_conversation_members_pkey" PRIMARY KEY("conversation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "message_conversation_reports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"conversation_id" uuid NOT NULL,
	"reporter_id" uuid NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_conversations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"type" integer DEFAULT 1 NOT NULL,
	"name" text,
	"component" text,
	"item_type" text,
	"item_id" uuid,
	"context_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"last_message_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "message_users_blocked" (
	"user_id" uuid,
	"blocked_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_users_blocked_pkey" PRIMARY KEY("user_id","blocked_user_id")
);
--> statement-breakpoint
CREATE TABLE "notification_dispatch_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"notification_id" uuid,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"dedupe_key" text CONSTRAINT "notification_dispatch_log_dedupe_unique" UNIQUE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id_from" uuid,
	"user_id_to" uuid NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"full_message" text DEFAULT '' NOT NULL,
	"small_message" text DEFAULT '' NOT NULL,
	"component" text DEFAULT '' NOT NULL,
	"event_type" text DEFAULT '' NOT NULL,
	"context_url" text,
	"context_url_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"time_read" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"event_type" text DEFAULT 'user' NOT NULL,
	"course_id" uuid,
	"group_id" uuid,
	"category_id" uuid,
	"user_id" uuid,
	"context_id" uuid,
	"subscription_id" uuid,
	"uuid" text,
	"repeat_id" uuid,
	"rrule" text,
	"is_exception" boolean DEFAULT false NOT NULL,
	"exception_of" uuid,
	"time_start" timestamp with time zone NOT NULL,
	"time_duration" integer DEFAULT 0 NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_export_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL UNIQUE,
	"token_hash" text NOT NULL UNIQUE,
	"last_access" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"url" text,
	"ics_data" text,
	"event_type" text DEFAULT 'site' NOT NULL,
	"course_id" uuid,
	"category_id" uuid,
	"user_id" uuid,
	"poll_interval" integer DEFAULT 604800 NOT NULL,
	"last_updated" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "badge" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"type" integer DEFAULT 1 NOT NULL,
	"course_id" uuid,
	"issuer_name" text DEFAULT '' NOT NULL,
	"issuer_url" text DEFAULT '' NOT NULL,
	"issuer_contact" text DEFAULT '' NOT NULL,
	"expire_date" timestamp with time zone,
	"expire_period" integer,
	"status" integer DEFAULT 0 NOT NULL,
	"version" text DEFAULT '' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"user_created" uuid,
	"user_modified" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "badge_criteria" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"badge_id" uuid NOT NULL,
	"criteria_type" text NOT NULL,
	"method" integer DEFAULT 1 NOT NULL,
	"params" jsonb DEFAULT '{}' NOT NULL,
	"description" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "badge_issued" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"badge_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"unique_hash" text NOT NULL UNIQUE,
	"snapshot" jsonb DEFAULT '{}' NOT NULL,
	"evidence" jsonb DEFAULT '{}' NOT NULL,
	"date_issued" timestamp with time zone DEFAULT now() NOT NULL,
	"date_expire" timestamp with time zone,
	"visible" boolean DEFAULT true NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	"issuer_notified" boolean DEFAULT false NOT NULL,
	CONSTRAINT "badge_issued_badge_user_unique" UNIQUE("badge_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "badge_manual_award" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"badge_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"issuer_id" uuid NOT NULL,
	"issuer_role" uuid,
	"date_met" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "badge_manual_award_unique" UNIQUE("badge_id","recipient_id","issuer_id")
);
--> statement-breakpoint
CREATE TABLE "competency" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"framework_id" uuid NOT NULL,
	"short_name" text NOT NULL,
	"id_number" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"parent_id" uuid,
	"path" text DEFAULT '' NOT NULL,
	"depth" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"rule_type" text,
	"rule_config" jsonb,
	"rule_outcome" text DEFAULT 'nothing' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competency_course_comp" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course_id" uuid NOT NULL,
	"competency_id" uuid NOT NULL,
	"rule_outcome" text DEFAULT 'nothing' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competency_course_comp_unique" UNIQUE("course_id","competency_id")
);
--> statement-breakpoint
CREATE TABLE "competency_evidence" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_competency_id" uuid NOT NULL,
	"context_id" uuid,
	"action_user_id" uuid NOT NULL,
	"action" text DEFAULT 'evidence' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"url" text,
	"grade" integer,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competency_framework" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"short_name" text NOT NULL,
	"id_number" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"context_id" uuid NOT NULL,
	"scale_configuration" jsonb DEFAULT '{}' NOT NULL,
	"taxonomies" text DEFAULT 'competency' NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competency_module_comp" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course_module_id" uuid NOT NULL,
	"competency_id" uuid NOT NULL,
	"rule_outcome" text DEFAULT 'nothing' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competency_module_comp_unique" UNIQUE("course_module_id","competency_id")
);
--> statement-breakpoint
CREATE TABLE "competency_plan_comp" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"plan_id" uuid NOT NULL,
	"competency_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competency_plan_comp_unique" UNIQUE("plan_id","competency_id")
);
--> statement-breakpoint
CREATE TABLE "competency_plan_review" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"plan_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" text NOT NULL,
	"status_from" integer NOT NULL,
	"status_to" integer NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competency_template" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"short_name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"context_id" uuid NOT NULL,
	"due_date" timestamp with time zone,
	"visible" boolean DEFAULT true NOT NULL,
	"status" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competency_template_cohort" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"template_id" uuid NOT NULL,
	"cohort_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competency_template_cohort_unique" UNIQUE("template_id","cohort_id")
);
--> statement-breakpoint
CREATE TABLE "competency_template_comp" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"template_id" uuid NOT NULL,
	"competency_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competency_template_comp_unique" UNIQUE("template_id","competency_id")
);
--> statement-breakpoint
CREATE TABLE "competency_user_comp" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL,
	"competency_id" uuid NOT NULL,
	"plan_id" uuid,
	"course_id" uuid,
	"status" integer DEFAULT 0 NOT NULL,
	"proficiency" boolean,
	"grade" integer,
	"reviewer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competency_user_comp_unique" UNIQUE("user_id","competency_id","plan_id","course_id")
);
--> statement-breakpoint
CREATE TABLE "learning_plans" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"user_id" uuid NOT NULL,
	"template_id" uuid,
	"status" integer DEFAULT 0 NOT NULL,
	"due_date" timestamp with time zone,
	"reviewer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blog_association" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"blog_id" uuid NOT NULL,
	"context_id" uuid NOT NULL,
	"assoc_type" text NOT NULL,
	"assoc_id" uuid NOT NULL,
	CONSTRAINT "blog_association_unique" UNIQUE("blog_id","assoc_type","assoc_id")
);
--> statement-breakpoint
CREATE TABLE "blog_post_placements" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"post_id" uuid NOT NULL,
	"space_type" text NOT NULL,
	"space_id" uuid,
	"context_id" uuid NOT NULL,
	"status" text DEFAULT 'approved' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	CONSTRAINT "blog_post_placements_unique" UNIQUE("post_id","space_type","space_id")
);
--> statement-breakpoint
CREATE TABLE "blog_post_references" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"post_id" uuid NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" text,
	"question_id" uuid,
	"question_version_id" uuid,
	"display_mode" text,
	"caption" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blog_posts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"publish_state" text DEFAULT 'draft' NOT NULL,
	"space_type" text DEFAULT 'user' NOT NULL,
	"space_id" uuid,
	"kind" text DEFAULT 'article' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"audience" text DEFAULT 'private' NOT NULL,
	"moderation_state" text DEFAULT 'clear' NOT NULL,
	"comments_policy" text DEFAULT 'open' NOT NULL,
	"question_state" text,
	"published_at" timestamp with time zone,
	"scheduled_at" timestamp with time zone,
	"pinned_until" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"delete_reason" text,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"last_modified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"context_id" uuid NOT NULL,
	"component" text NOT NULL,
	"comment_area" text NOT NULL,
	"item_id" uuid NOT NULL,
	"content" text NOT NULL,
	"format" integer DEFAULT 1 NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"time_deleted" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"course_id" uuid,
	"user_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"format" integer DEFAULT 1 NOT NULL,
	"publish_state" text DEFAULT 'draft' NOT NULL,
	"group_id" uuid,
	"user_modified" uuid,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"last_modified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rating" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"context_id" uuid NOT NULL,
	"component" text NOT NULL,
	"rating_area" text NOT NULL,
	"item_id" uuid NOT NULL,
	"scale_id" integer NOT NULL,
	"rating" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rating_unique" UNIQUE("context_id","component","rating_area","item_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid,
	"tag_coll_id" uuid,
	"name" text NOT NULL,
	"raw_name" text NOT NULL,
	"is_standard" boolean DEFAULT false NOT NULL,
	"flag" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_coll_name_unique" UNIQUE("tag_coll_id","name")
);
--> statement-breakpoint
CREATE TABLE "tag_collection" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"is_standard" boolean DEFAULT false NOT NULL,
	"component" text,
	"searchable" boolean DEFAULT true NOT NULL,
	"custom_url" text
);
--> statement-breakpoint
CREATE TABLE "tag_correlation" (
	"tag_id" uuid PRIMARY KEY,
	"correlated_tags" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag_instance" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"tag_id" uuid NOT NULL,
	"component" text NOT NULL,
	"item_type" text NOT NULL,
	"item_id" uuid NOT NULL,
	"context_id" uuid NOT NULL,
	"ti_user_id" uuid,
	"ordering" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_instance_unique" UNIQUE("tag_id","component","item_type","item_id","context_id","ti_user_id")
);
--> statement-breakpoint
CREATE TABLE "search_documents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"area" text NOT NULL,
	"item_id" uuid NOT NULL,
	"context_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"owner_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_documents_area_item_unique" UNIQUE("area","item_id")
);
--> statement-breakpoint
CREATE TABLE "external_services" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL UNIQUE,
	"short_name" text NOT NULL UNIQUE,
	"enabled" boolean DEFAULT true NOT NULL,
	"functions" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"token_hash" text NOT NULL UNIQUE,
	"user_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"valid_until" timestamp with time zone,
	"ip_restriction" text,
	"revoked" boolean DEFAULT false NOT NULL,
	"last_access" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_id_mappings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"job_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"old_id" uuid NOT NULL,
	"new_id" uuid NOT NULL,
	CONSTRAINT "backup_id_mappings_unique" UNIQUE("job_id","item_type","old_id")
);
--> statement-breakpoint
CREATE TABLE "backup_job_steps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"job_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"type" text NOT NULL,
	"scope" text DEFAULT 'course' NOT NULL,
	"course_id" uuid,
	"target_course_id" uuid,
	"mode" text DEFAULT 'new' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"anonymize" boolean DEFAULT false NOT NULL,
	"user_id" uuid NOT NULL,
	"archive" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"time_finished" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "analytics_models" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL UNIQUE,
	"target" text NOT NULL,
	"indicators" jsonb DEFAULT '[]' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_predictions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"model_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"context_id" uuid NOT NULL,
	"course_id" uuid,
	"score" double precision DEFAULT 0 NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insights" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"model_id" uuid NOT NULL,
	"prediction_id" uuid,
	"user_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"context_id" uuid NOT NULL,
	"course_id" uuid,
	"heading" text DEFAULT '' NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_builder_audience" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"report_id" uuid NOT NULL,
	"user_id" uuid,
	"role" text
);
--> statement-breakpoint
CREATE TABLE "report_builder_report" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"data_source" text NOT NULL,
	"columns" jsonb DEFAULT '[]' NOT NULL,
	"filters" jsonb DEFAULT '{}' NOT NULL,
	"created_by" uuid NOT NULL,
	"context_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_builder_schedule" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"report_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"cron" text DEFAULT 'daily' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run" timestamp with time zone,
	"last_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_bank_content" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"content_type" text DEFAULT 'file-based' NOT NULL,
	"context_id" uuid NOT NULL,
	"creator_id" uuid NOT NULL,
	"visibility" text DEFAULT 'draft' NOT NULL,
	"file_id" uuid,
	"config_data" jsonb,
	"resource_type" text DEFAULT 'reference' NOT NULL,
	"scope" text DEFAULT 'personal' NOT NULL,
	"space_id" uuid,
	"subject_id" uuid,
	"grade" smallint,
	"level" text,
	"curriculum_node_id" uuid,
	"outcome_ids" jsonb,
	"question_category_id" uuid,
	"external_url" text,
	"description" text,
	"keywords" jsonb,
	"target_audience" text,
	"lesson_position" text,
	"tech_format" text,
	"size_bytes" bigint,
	"duration_seconds" integer,
	"language" text DEFAULT 'vi' NOT NULL,
	"original_author" text,
	"source_kind" text,
	"source_citation" text,
	"license" text,
	"derived_from_id" uuid,
	"review_status" text DEFAULT 'draft' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"review_checklist" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_bank_content_grade_check" CHECK ("grade" is null or ("grade" between 1 and 12))
);
--> statement-breakpoint
CREATE TABLE "payment_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"gateway" text DEFAULT 'manual' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_refunds" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"payment_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"external_transaction_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"gateway" text DEFAULT 'manual' NOT NULL,
	"external_transaction_id" text,
	"component" text DEFAULT '' NOT NULL,
	"item_id" uuid,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_external_tx_unique" UNIQUE("gateway","external_transaction_id")
);
--> statement-breakpoint
CREATE TABLE "privacy_export_files" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"request_id" uuid NOT NULL,
	"file_id" uuid,
	"subsystem" text DEFAULT '' NOT NULL,
	"manifest" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "privacy_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"approved_by" uuid,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "event_log_context_id_idx" ON "event_log" ("context_id");--> statement-breakpoint
CREATE INDEX "event_log_user_id_idx" ON "event_log" ("user_id");--> statement-breakpoint
CREATE INDEX "context_instance_id_idx" ON "context" ("instance_id");--> statement-breakpoint
CREATE INDEX "role_assignments_user_id_idx" ON "role_assignments" ("user_id");--> statement-breakpoint
CREATE INDEX "role_assignments_context_id_idx" ON "role_assignments" ("context_id");--> statement-breakpoint
CREATE INDEX "role_assignments_modifier_id_idx" ON "role_assignments" ("modifier_id");--> statement-breakpoint
CREATE INDEX "role_assignments_item_id_idx" ON "role_assignments" ("item_id");--> statement-breakpoint
CREATE INDEX "role_capabilities_role_id_idx" ON "role_capabilities" ("role_id");--> statement-breakpoint
CREATE INDEX "role_capabilities_modifier_id_idx" ON "role_capabilities" ("modifier_id");--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" ("user_id");--> statement-breakpoint
CREATE INDEX "two_factor_user_id_idx" ON "two_factor" ("user_id");--> statement-breakpoint
CREATE INDEX "login_attempts_user_id_idx" ON "login_attempts" ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_access_token_client_id_idx" ON "oauth_access_token" ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_access_token_session_id_idx" ON "oauth_access_token" ("session_id");--> statement-breakpoint
CREATE INDEX "oauth_access_token_user_id_idx" ON "oauth_access_token" ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_access_token_refresh_id_idx" ON "oauth_access_token" ("refresh_id");--> statement-breakpoint
CREATE INDEX "oauth_client_user_id_idx" ON "oauth_client" ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_client_client_discovery_id_idx" ON "oauth_client" ("client_discovery_id");--> statement-breakpoint
CREATE INDEX "oauth_client_resource_client_id_idx" ON "oauth_client_resource" ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_client_resource_resource_id_idx" ON "oauth_client_resource" ("resource_id");--> statement-breakpoint
CREATE INDEX "oauth_consent_client_id_idx" ON "oauth_consent" ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_consent_user_id_idx" ON "oauth_consent" ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_client_id_idx" ON "oauth_refresh_token" ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_session_id_idx" ON "oauth_refresh_token" ("session_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_user_id_idx" ON "oauth_refresh_token" ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_token_family_user_id_idx" ON "refresh_token_family" ("user_id");--> statement-breakpoint
CREATE INDEX "user_oauth_links_user_id_idx" ON "user_oauth_links" ("user_id");--> statement-breakpoint
CREATE INDEX "user_totp_user_id_idx" ON "user_totp" ("user_id");--> statement-breakpoint
CREATE INDEX "custom_field_category_item_id_idx" ON "custom_field_category" ("item_id");--> statement-breakpoint
CREATE INDEX "custom_field_data_instance_id_idx" ON "custom_field_data" ("instance_id");--> statement-breakpoint
CREATE INDEX "custom_field_field_category_id_idx" ON "custom_field_field" ("category_id");--> statement-breakpoint
CREATE INDEX "files_context_id_idx" ON "files" ("context_id");--> statement-breakpoint
CREATE INDEX "files_item_id_idx" ON "files" ("item_id");--> statement-breakpoint
CREATE INDEX "files_user_id_idx" ON "files" ("user_id");--> statement-breakpoint
CREATE INDEX "course_category_idx" ON "course" ("category");--> statement-breakpoint
CREATE INDEX "course_subject_id_idx" ON "course" ("subject_id");--> statement-breakpoint
CREATE INDEX "course_categories_parent_idx" ON "course_categories" ("parent");--> statement-breakpoint
CREATE INDEX "course_format_options_section_id_idx" ON "course_format_options" ("section_id");--> statement-breakpoint
CREATE INDEX "course_modules_course_idx" ON "course_modules" ("course");--> statement-breakpoint
CREATE INDEX "course_modules_instance_id_idx" ON "course_modules" ("instance_id");--> statement-breakpoint
CREATE INDEX "course_modules_section_idx" ON "course_modules" ("section");--> statement-breakpoint
CREATE INDEX "course_section_anchor_outcomes_anchor_idx" ON "course_section_anchor_outcomes" ("anchor_id","position");--> statement-breakpoint
CREATE INDEX "course_section_anchor_outcomes_outcome_id_idx" ON "course_section_anchor_outcomes" ("outcome_id");--> statement-breakpoint
CREATE INDEX "course_section_anchors_node_id_idx" ON "course_section_anchors" ("node_id");--> statement-breakpoint
CREATE INDEX "course_section_anchors_curriculum_id_idx" ON "course_section_anchors" ("curriculum_id");--> statement-breakpoint
CREATE INDEX "course_section_book_anchors_node_id_idx" ON "course_section_book_anchors" ("book_node_id");--> statement-breakpoint
CREATE INDEX "course_section_book_anchors_book_id_idx" ON "course_section_book_anchors" ("book_id");--> statement-breakpoint
CREATE INDEX "course_section_book_item_outcomes_item_idx" ON "course_section_book_item_outcomes" ("item_id","position");--> statement-breakpoint
CREATE INDEX "course_section_book_item_outcomes_outcome_id_idx" ON "course_section_book_item_outcomes" ("outcome_id");--> statement-breakpoint
CREATE INDEX "course_section_book_items_anchor_idx" ON "course_section_book_items" ("anchor_id","position");--> statement-breakpoint
CREATE INDEX "course_section_book_items_node_id_idx" ON "course_section_book_items" ("book_node_id");--> statement-breakpoint
CREATE INDEX "cohort_context_id_idx" ON "cohort" ("context_id");--> statement-breakpoint
CREATE INDEX "cohort_members_user_id_idx" ON "cohort_members" ("user_id");--> statement-breakpoint
CREATE INDEX "groupings_groups_group_id_idx" ON "groupings_groups" ("group_id");--> statement-breakpoint
CREATE INDEX "groups_members_user_id_idx" ON "groups_members" ("user_id");--> statement-breakpoint
CREATE INDEX "groups_members_item_id_idx" ON "groups_members" ("item_id");--> statement-breakpoint
CREATE INDEX "enrol_course_id_idx" ON "enrol" ("course_id");--> statement-breakpoint
CREATE INDEX "enrol_role_id_idx" ON "enrol" ("role_id");--> statement-breakpoint
CREATE INDEX "enrol_custom_int1_idx" ON "enrol" ("custom_int1");--> statement-breakpoint
CREATE INDEX "enrol_custom_int2_idx" ON "enrol" ("custom_int2");--> statement-breakpoint
CREATE INDEX "enrol_payment_account_id_idx" ON "enrol" ("payment_account_id");--> statement-breakpoint
CREATE INDEX "user_enrolments_user_id_idx" ON "user_enrolments" ("user_id");--> statement-breakpoint
CREATE INDEX "user_enrolments_enrol_id_user_id_idx" ON "user_enrolments" ("enrol_id","user_id");--> statement-breakpoint
CREATE INDEX "user_enrolments_modifier_id_idx" ON "user_enrolments" ("modifier_id");--> statement-breakpoint
CREATE INDEX "course_completion_crit_compl_user_id_idx" ON "course_completion_crit_compl" ("user_id");--> statement-breakpoint
CREATE INDEX "course_completion_criteria_course_idx" ON "course_completion_criteria" ("course");--> statement-breakpoint
CREATE INDEX "course_completion_criteria_module_instance_idx" ON "course_completion_criteria" ("module_instance");--> statement-breakpoint
CREATE INDEX "course_completion_criteria_course_instance_idx" ON "course_completion_criteria" ("course_instance");--> statement-breakpoint
CREATE INDEX "course_completion_criteria_role_id_idx" ON "course_completion_criteria" ("role_id");--> statement-breakpoint
CREATE INDEX "course_completions_course_idx" ON "course_completions" ("course");--> statement-breakpoint
CREATE INDEX "course_modules_completion_user_id_idx" ON "course_modules_completion" ("user_id");--> statement-breakpoint
CREATE INDEX "grade_categories_course_id_idx" ON "grade_categories" ("course_id");--> statement-breakpoint
CREATE INDEX "grade_categories_parent_idx" ON "grade_categories" ("parent");--> statement-breakpoint
CREATE INDEX "grade_grades_user_id_idx" ON "grade_grades" ("user_id");--> statement-breakpoint
CREATE INDEX "grade_grades_history_old_id_idx" ON "grade_grades_history" ("old_id");--> statement-breakpoint
CREATE INDEX "grade_grades_history_item_id_idx" ON "grade_grades_history" ("item_id");--> statement-breakpoint
CREATE INDEX "grade_grades_history_user_id_idx" ON "grade_grades_history" ("user_id");--> statement-breakpoint
CREATE INDEX "grade_grades_history_logged_user_idx" ON "grade_grades_history" ("logged_user");--> statement-breakpoint
CREATE INDEX "grade_items_category_id_idx" ON "grade_items" ("category_id");--> statement-breakpoint
CREATE INDEX "grade_items_vn_book_id_idx" ON "grade_items" ("vn_book_id");--> statement-breakpoint
CREATE INDEX "grade_items_item_instance_idx" ON "grade_items" ("item_instance");--> statement-breakpoint
CREATE INDEX "grade_items_scale_id_idx" ON "grade_items" ("scale_id");--> statement-breakpoint
CREATE INDEX "grade_items_outcome_id_idx" ON "grade_items" ("outcome_id");--> statement-breakpoint
CREATE INDEX "grade_outcomes_course_id_idx" ON "grade_outcomes" ("course_id");--> statement-breakpoint
CREATE INDEX "grade_outcomes_scale_id_idx" ON "grade_outcomes" ("scale_id");--> statement-breakpoint
CREATE INDEX "grade_publications_course_id_idx" ON "grade_publications" ("course_id");--> statement-breakpoint
CREATE INDEX "grade_publications_item_id_idx" ON "grade_publications" ("item_id");--> statement-breakpoint
CREATE INDEX "grade_publications_book_id_idx" ON "grade_publications" ("book_id");--> statement-breakpoint
CREATE INDEX "grade_publications_user_id_idx" ON "grade_publications" ("user_id");--> statement-breakpoint
CREATE INDEX "scales_course_id_idx" ON "scales" ("course_id");--> statement-breakpoint
CREATE INDEX "vn_activity_mappings_course_id_idx" ON "vn_activity_mappings" ("course_id");--> statement-breakpoint
CREATE INDEX "vn_activity_mappings_book_id_idx" ON "vn_activity_mappings" ("book_id");--> statement-breakpoint
CREATE INDEX "vn_activity_mappings_cm_id_idx" ON "vn_activity_mappings" ("cm_id");--> statement-breakpoint
CREATE INDEX "vn_activity_mappings_item_id_idx" ON "vn_activity_mappings" ("item_id");--> statement-breakpoint
CREATE INDEX "vn_activity_mappings_target_item_id_idx" ON "vn_activity_mappings" ("target_item_id");--> statement-breakpoint
CREATE INDEX "vn_candidate_actions_course_id_idx" ON "vn_candidate_actions" ("course_id");--> statement-breakpoint
CREATE INDEX "vn_candidate_actions_book_id_idx" ON "vn_candidate_actions" ("book_id");--> statement-breakpoint
CREATE INDEX "vn_candidate_actions_mapping_id_idx" ON "vn_candidate_actions" ("mapping_id");--> statement-breakpoint
CREATE INDEX "vn_candidate_actions_target_item_id_idx" ON "vn_candidate_actions" ("target_item_id");--> statement-breakpoint
CREATE INDEX "vn_candidate_actions_source_item_id_idx" ON "vn_candidate_actions" ("source_item_id");--> statement-breakpoint
CREATE INDEX "vn_candidate_actions_user_id_idx" ON "vn_candidate_actions" ("user_id");--> statement-breakpoint
CREATE INDEX "vn_gradebooks_course_id_idx" ON "vn_gradebooks" ("course_id");--> statement-breakpoint
CREATE INDEX "vn_gradebooks_category_id_idx" ON "vn_gradebooks" ("category_id");--> statement-breakpoint
CREATE INDEX "vn_term_results_book_id_idx" ON "vn_term_results" ("book_id");--> statement-breakpoint
CREATE INDEX "vn_term_results_course_id_idx" ON "vn_term_results" ("course_id");--> statement-breakpoint
CREATE INDEX "vn_term_results_user_id_idx" ON "vn_term_results" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guardian_digests_dedupe_key_unique" ON "guardian_digests" ("dedupe_key");--> statement-breakpoint
CREATE INDEX "guardian_digests_guardian_user_id_idx" ON "guardian_digests" ("guardian_user_id");--> statement-breakpoint
CREATE INDEX "guardian_digests_student_user_id_idx" ON "guardian_digests" ("student_user_id");--> statement-breakpoint
CREATE INDEX "guardian_links_guardian_user_id_idx" ON "guardian_links" ("guardian_user_id");--> statement-breakpoint
CREATE INDEX "guardian_links_student_user_id_idx" ON "guardian_links" ("student_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guardian_links_active_pair_unique" ON "guardian_links" ("guardian_user_id","student_user_id") WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX "guardian_view_state_student_user_id_idx" ON "guardian_view_state" ("student_user_id");--> statement-breakpoint
CREATE INDEX "user_course_card_prefs_course_idx" ON "user_course_card_prefs" ("course_id");--> statement-breakpoint
CREATE INDEX "question_category_idx" ON "question" ("category");--> statement-breakpoint
CREATE INDEX "question_created_by_idx" ON "question" ("created_by");--> statement-breakpoint
CREATE INDEX "question_modified_by_idx" ON "question" ("modified_by");--> statement-breakpoint
CREATE INDEX "question_derived_from_idx" ON "question" ("derived_from_question_id");--> statement-breakpoint
CREATE INDEX "question_answers_question_version_id_idx" ON "question_answers" ("question_version_id");--> statement-breakpoint
CREATE INDEX "question_attempt_steps_user_id_idx" ON "question_attempt_steps" ("user_id");--> statement-breakpoint
CREATE INDEX "question_attempts_question_id_idx" ON "question_attempts" ("question_id");--> statement-breakpoint
CREATE INDEX "question_attempts_question_version_id_idx" ON "question_attempts" ("question_version_id");--> statement-breakpoint
CREATE INDEX "question_attempts_user_id_idx" ON "question_attempts" ("user_id");--> statement-breakpoint
CREATE INDEX "question_bank_contributions_target_bank_idx" ON "question_bank_contributions" ("target_bank_id");--> statement-breakpoint
CREATE INDEX "question_bank_contributions_question_idx" ON "question_bank_contributions" ("question_id");--> statement-breakpoint
CREATE INDEX "question_bank_contributions_proposer_idx" ON "question_bank_contributions" ("proposer_id");--> statement-breakpoint
CREATE INDEX "question_bank_contributions_status_idx" ON "question_bank_contributions" ("status");--> statement-breakpoint
CREATE INDEX "question_bank_entries_question_category_id_idx" ON "question_bank_entries" ("question_category_id");--> statement-breakpoint
CREATE INDEX "question_banks_scope_idx" ON "question_banks" ("scope");--> statement-breakpoint
CREATE INDEX "question_banks_kind_idx" ON "question_banks" ("bank_kind");--> statement-breakpoint
CREATE INDEX "question_banks_owner_id_idx" ON "question_banks" ("owner_id");--> statement-breakpoint
CREATE INDEX "question_banks_scope_ref_id_idx" ON "question_banks" ("scope_ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX "question_banks_personal_owner_kind_unique" ON "question_banks" ("owner_id","bank_kind") WHERE scope = 'personal';--> statement-breakpoint
CREATE UNIQUE INDEX "question_banks_scope_ref_kind_unique" ON "question_banks" ("scope","scope_ref_id","bank_kind") WHERE scope_ref_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "question_banks_school_kind_unique" ON "question_banks" ("scope","bank_kind") WHERE scope = 'school';--> statement-breakpoint
CREATE INDEX "question_categories_context_id_idx" ON "question_categories" ("context_id");--> statement-breakpoint
CREATE INDEX "question_categories_parent_idx" ON "question_categories" ("parent");--> statement-breakpoint
CREATE INDEX "question_categories_bank_id_idx" ON "question_categories" ("bank_id");--> statement-breakpoint
CREATE INDEX "question_truefalse_true_answer_idx" ON "question_truefalse" ("true_answer");--> statement-breakpoint
CREATE INDEX "question_truefalse_false_answer_idx" ON "question_truefalse" ("false_answer");--> statement-breakpoint
CREATE INDEX "question_usages_instance_id_idx" ON "question_usages" ("instance_id");--> statement-breakpoint
CREATE INDEX "question_usages_owning_context_id_idx" ON "question_usages" ("owning_context_id");--> statement-breakpoint
CREATE INDEX "question_usages_user_id_idx" ON "question_usages" ("user_id");--> statement-breakpoint
CREATE INDEX "question_versions_question_id_idx" ON "question_versions" ("question_id");--> statement-breakpoint
CREATE INDEX "question_versions_stimulus_id_idx" ON "question_versions" ("stimulus_id");--> statement-breakpoint
CREATE INDEX "stimuli_category_id_idx" ON "stimuli" ("category_id");--> statement-breakpoint
CREATE INDEX "stimuli_created_by_idx" ON "stimuli" ("created_by");--> statement-breakpoint
CREATE INDEX "mcp_idempotency_keys_expires_idx" ON "mcp_idempotency_keys" ("expires_at");--> statement-breakpoint
CREATE INDEX "exam_deployments_paper_idx" ON "exam_deployments" ("paper_id");--> statement-breakpoint
CREATE INDEX "exam_deployments_paper_version_idx" ON "exam_deployments" ("paper_version_id");--> statement-breakpoint
CREATE INDEX "exam_deployments_quiz_idx" ON "exam_deployments" ("quiz_id");--> statement-breakpoint
CREATE INDEX "exam_dossier_reviews_dossier_idx" ON "exam_dossier_reviews" ("dossier_id");--> statement-breakpoint
CREATE INDEX "exam_dossiers_target_bank_idx" ON "exam_dossiers" ("target_bank_id");--> statement-breakpoint
CREATE INDEX "exam_dossiers_paper_idx" ON "exam_dossiers" ("paper_id");--> statement-breakpoint
CREATE INDEX "exam_dossiers_paper_version_idx" ON "exam_dossiers" ("paper_version_id");--> statement-breakpoint
CREATE INDEX "exam_dossiers_matrix_idx" ON "exam_dossiers" ("matrix_id");--> statement-breakpoint
CREATE INDEX "exam_dossiers_proposer_idx" ON "exam_dossiers" ("proposer_id");--> statement-breakpoint
CREATE INDEX "exam_dossiers_status_idx" ON "exam_dossiers" ("status");--> statement-breakpoint
CREATE INDEX "exam_paper_contributions_target_bank_idx" ON "exam_paper_contributions" ("target_bank_id");--> statement-breakpoint
CREATE INDEX "exam_paper_contributions_paper_idx" ON "exam_paper_contributions" ("paper_id");--> statement-breakpoint
CREATE INDEX "exam_paper_contributions_proposer_idx" ON "exam_paper_contributions" ("proposer_id");--> statement-breakpoint
CREATE INDEX "exam_paper_contributions_status_idx" ON "exam_paper_contributions" ("status");--> statement-breakpoint
CREATE INDEX "exam_paper_slots_version_idx" ON "exam_paper_slots" ("paper_version_id");--> statement-breakpoint
CREATE INDEX "exam_paper_slots_question_idx" ON "exam_paper_slots" ("question_id");--> statement-breakpoint
CREATE INDEX "exam_paper_slots_cluster_idx" ON "exam_paper_slots" ("cluster_id");--> statement-breakpoint
CREATE INDEX "exam_paper_slots_matrix_cell_idx" ON "exam_paper_slots" ("matrix_cell_id");--> statement-breakpoint
CREATE INDEX "exam_paper_versions_paper_idx" ON "exam_paper_versions" ("paper_id");--> statement-breakpoint
CREATE INDEX "exam_paper_versions_subject_idx" ON "exam_paper_versions" ("subject_id");--> statement-breakpoint
CREATE INDEX "exam_paper_versions_matrix_idx" ON "exam_paper_versions" ("matrix_id");--> statement-breakpoint
CREATE INDEX "exam_papers_bank_id_idx" ON "exam_papers" ("bank_id");--> statement-breakpoint
CREATE INDEX "exam_papers_status_idx" ON "exam_papers" ("status");--> statement-breakpoint
CREATE INDEX "exam_papers_created_by_idx" ON "exam_papers" ("created_by");--> statement-breakpoint
CREATE INDEX "exam_papers_derived_from_idx" ON "exam_papers" ("derived_from_paper_id");--> statement-breakpoint
CREATE INDEX "exam_matrices_subject_idx" ON "exam_matrices" ("subject_id");--> statement-breakpoint
CREATE INDEX "exam_matrices_curriculum_idx" ON "exam_matrices" ("curriculum_id");--> statement-breakpoint
CREATE INDEX "exam_matrices_bank_idx" ON "exam_matrices" ("bank_id");--> statement-breakpoint
CREATE INDEX "exam_matrix_cells_matrix_idx" ON "exam_matrix_cells" ("matrix_id");--> statement-breakpoint
CREATE INDEX "exam_matrix_cells_learning_outcome_idx" ON "exam_matrix_cells" ("learning_outcome_id");--> statement-breakpoint
CREATE INDEX "exam_matrix_contributions_target_bank_idx" ON "exam_matrix_contributions" ("target_bank_id");--> statement-breakpoint
CREATE INDEX "exam_matrix_contributions_matrix_idx" ON "exam_matrix_contributions" ("matrix_id");--> statement-breakpoint
CREATE INDEX "exam_matrix_contributions_proposer_idx" ON "exam_matrix_contributions" ("proposer_id");--> statement-breakpoint
CREATE INDEX "exam_matrix_contributions_status_idx" ON "exam_matrix_contributions" ("status");--> statement-breakpoint
CREATE INDEX "quiz_attempt_events_attempt_idx" ON "quiz_attempt_events" ("attempt_id");--> statement-breakpoint
CREATE INDEX "quiz_attempts_quiz_id_idx" ON "quiz_attempts" ("quiz_id");--> statement-breakpoint
CREATE INDEX "quiz_attempts_user_id_idx" ON "quiz_attempts" ("user_id");--> statement-breakpoint
CREATE INDEX "quiz_feedbacks_quiz_idx" ON "quiz_feedbacks" ("quiz_id");--> statement-breakpoint
CREATE INDEX "quiz_overrides_quiz_idx" ON "quiz_overrides" ("quiz_id");--> statement-breakpoint
CREATE INDEX "quiz_overrides_group_idx" ON "quiz_overrides" ("group_id");--> statement-breakpoint
CREATE INDEX "quiz_slot_version_events_slot_idx" ON "quiz_slot_version_events" ("slot_id");--> statement-breakpoint
CREATE INDEX "quiz_slot_version_events_quiz_idx" ON "quiz_slot_version_events" ("quiz_id");--> statement-breakpoint
CREATE INDEX "quiz_slots_question_id_idx" ON "quiz_slots" ("question_id");--> statement-breakpoint
CREATE INDEX "quiz_slots_category_id_idx" ON "quiz_slots" ("category_id");--> statement-breakpoint
CREATE INDEX "quiz_slots_matrix_cell_id_idx" ON "quiz_slots" ("matrix_cell_id");--> statement-breakpoint
CREATE INDEX "quiz_slots_cluster_id_idx" ON "quiz_slots" ("cluster_id");--> statement-breakpoint
CREATE INDEX "quizzes_course_idx" ON "quizzes" ("course");--> statement-breakpoint
CREATE INDEX "quizzes_cm_id_idx" ON "quizzes" ("cm_id");--> statement-breakpoint
CREATE INDEX "quizzes_matrix_idx" ON "quizzes" ("matrix_id");--> statement-breakpoint
CREATE INDEX "quizzes_paper_idx" ON "quizzes" ("paper_id");--> statement-breakpoint
CREATE INDEX "quizzes_paper_version_idx" ON "quizzes" ("paper_version_id");--> statement-breakpoint
CREATE INDEX "quiz_paper_batches_quiz_idx" ON "quiz_paper_batches" ("quiz_id");--> statement-breakpoint
CREATE INDEX "quiz_paper_scans_quiz_idx" ON "quiz_paper_scans" ("quiz_id");--> statement-breakpoint
CREATE INDEX "quiz_paper_scans_batch_idx" ON "quiz_paper_scans" ("batch_id");--> statement-breakpoint
CREATE INDEX "quiz_paper_scans_status_idx" ON "quiz_paper_scans" ("quiz_id","status");--> statement-breakpoint
CREATE INDEX "quiz_paper_scans_student_idx" ON "quiz_paper_scans" ("student_id");--> statement-breakpoint
CREATE INDEX "quiz_paper_scans_attempt_idx" ON "quiz_paper_scans" ("attempt_id");--> statement-breakpoint
CREATE INDEX "assign_annotations_submission_id_idx" ON "assign_annotations" ("submission_id");--> statement-breakpoint
CREATE INDEX "assign_annotations_file_id_idx" ON "assign_annotations" ("file_id");--> statement-breakpoint
CREATE INDEX "assign_feedback_messages_grade_id_idx" ON "assign_feedback_messages" ("grade_id");--> statement-breakpoint
CREATE INDEX "assign_grade_revisions_grade_id_idx" ON "assign_grade_revisions" ("grade_id");--> statement-breakpoint
CREATE INDEX "assign_grades_assignment_id_idx" ON "assign_grades" ("assignment_id");--> statement-breakpoint
CREATE INDEX "assign_grades_user_id_idx" ON "assign_grades" ("user_id");--> statement-breakpoint
CREATE INDEX "assign_rubric_criteria_rubric_id_idx" ON "assign_rubric_criteria" ("rubric_id");--> statement-breakpoint
CREATE INDEX "assign_rubric_evaluations_grade_id_idx" ON "assign_rubric_evaluations" ("grade_id");--> statement-breakpoint
CREATE INDEX "assign_rubric_evaluations_criterion_id_idx" ON "assign_rubric_evaluations" ("criterion_id");--> statement-breakpoint
CREATE INDEX "assign_rubric_evaluations_level_id_idx" ON "assign_rubric_evaluations" ("level_id");--> statement-breakpoint
CREATE INDEX "assign_rubric_levels_criterion_id_idx" ON "assign_rubric_levels" ("criterion_id");--> statement-breakpoint
CREATE INDEX "assign_submission_files_submission_id_idx" ON "assign_submission_files" ("submission_id");--> statement-breakpoint
CREATE INDEX "assign_submission_files_file_id_idx" ON "assign_submission_files" ("file_id");--> statement-breakpoint
CREATE INDEX "assign_submissions_assignment_id_idx" ON "assign_submissions" ("assignment_id");--> statement-breakpoint
CREATE INDEX "assign_submissions_user_id_idx" ON "assign_submissions" ("user_id");--> statement-breakpoint
CREATE INDEX "assignments_course_idx" ON "assignments" ("course");--> statement-breakpoint
CREATE INDEX "assignments_cm_id_idx" ON "assignments" ("cm_id");--> statement-breakpoint
CREATE INDEX "teacher_comment_bank_owner_id_idx" ON "teacher_comment_bank" ("owner_id");--> statement-breakpoint
CREATE INDEX "course_last_access_course_idx" ON "course_last_access" ("course_id");--> statement-breakpoint
CREATE INDEX "course_last_access_cm_id_idx" ON "course_last_access" ("cm_id");--> statement-breakpoint
CREATE INDEX "course_module_progress_course_idx" ON "course_module_progress" ("course_id");--> statement-breakpoint
CREATE INDEX "course_module_progress_cm_id_idx" ON "course_module_progress" ("cm_id");--> statement-breakpoint
CREATE INDEX "learning_records_course_idx" ON "learning_records" ("course_id");--> statement-breakpoint
CREATE INDEX "pages_course_idx" ON "pages" ("course");--> statement-breakpoint
CREATE INDEX "pages_cm_id_idx" ON "pages" ("cm_id");--> statement-breakpoint
CREATE INDEX "resources_course_idx" ON "resources" ("course");--> statement-breakpoint
CREATE INDEX "resources_cm_id_idx" ON "resources" ("cm_id");--> statement-breakpoint
CREATE INDEX "resources_file_id_idx" ON "resources" ("file_id");--> statement-breakpoint
CREATE INDEX "curricula_subject_id_idx" ON "curricula" ("subject_id");--> statement-breakpoint
CREATE INDEX "curriculum_nodes_tree_idx" ON "curriculum_nodes" ("curriculum_id","parent_id","position");--> statement-breakpoint
CREATE INDEX "curriculum_program_records_subject_id_idx" ON "curriculum_program_records" ("subject_id");--> statement-breakpoint
CREATE INDEX "curriculum_program_records_node_id_idx" ON "curriculum_program_records" ("node_id");--> statement-breakpoint
CREATE INDEX "curriculum_program_records_curriculum_id_idx" ON "curriculum_program_records" ("curriculum_id");--> statement-breakpoint
CREATE INDEX "learning_outcomes_node_id_idx" ON "learning_outcomes" ("node_id","position");--> statement-breakpoint
CREATE INDEX "learning_outcomes_derived_from_id_idx" ON "learning_outcomes" ("derived_from_id");--> statement-breakpoint
CREATE INDEX "question_learning_outcomes_outcome_level_idx" ON "question_learning_outcomes" ("learning_outcome_id","cognitive_level");--> statement-breakpoint
CREATE INDEX "question_learning_outcomes_question_id_idx" ON "question_learning_outcomes" ("question_id");--> statement-breakpoint
CREATE INDEX "question_subjects_subject_id_idx" ON "question_subjects" ("subject_id");--> statement-breakpoint
CREATE INDEX "question_subjects_question_id_idx" ON "question_subjects" ("question_id");--> statement-breakpoint
CREATE INDEX "subjects_context_id_idx" ON "subjects" ("context_id");--> statement-breakpoint
CREATE UNIQUE INDEX "book_mappings_node_unique" ON "book_mappings" ("book_node_id","curriculum_node_id") WHERE "curriculum_node_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "book_mappings_outcome_unique" ON "book_mappings" ("book_node_id","learning_outcome_id") WHERE "learning_outcome_id" is not null;--> statement-breakpoint
CREATE INDEX "book_mappings_book_node_idx" ON "book_mappings" ("book_node_id");--> statement-breakpoint
CREATE INDEX "book_mappings_curriculum_node_idx" ON "book_mappings" ("curriculum_node_id");--> statement-breakpoint
CREATE INDEX "book_mappings_outcome_idx" ON "book_mappings" ("learning_outcome_id");--> statement-breakpoint
CREATE INDEX "book_nodes_tree_idx" ON "book_nodes" ("book_id","parent_id","position");--> statement-breakpoint
CREATE INDEX "book_records_book_id_idx" ON "book_records" ("book_id");--> statement-breakpoint
CREATE INDEX "book_records_node_id_idx" ON "book_records" ("node_id");--> statement-breakpoint
CREATE INDEX "books_subject_id_idx" ON "books" ("subject_id");--> statement-breakpoint
CREATE INDEX "books_kind_idx" ON "books" ("kind");--> statement-breakpoint
CREATE INDEX "message_conversation_id_idx" ON "message" ("conversation_id");--> statement-breakpoint
CREATE INDEX "message_user_id_from_idx" ON "message" ("user_id_from");--> statement-breakpoint
CREATE INDEX "message_conversation_seq_idx" ON "message" ("conversation_id","seq");--> statement-breakpoint
CREATE INDEX "message_contact_requests_user_id_to_idx" ON "message_contact_requests" ("user_id_to");--> statement-breakpoint
CREATE INDEX "message_contacts_contact_id_idx" ON "message_contacts" ("contact_id");--> statement-breakpoint
CREATE INDEX "message_conversation_members_user_id_idx" ON "message_conversation_members" ("user_id");--> statement-breakpoint
CREATE INDEX "message_conversation_reports_conversation_id_idx" ON "message_conversation_reports" ("conversation_id");--> statement-breakpoint
CREATE INDEX "message_conversation_reports_reporter_id_idx" ON "message_conversation_reports" ("reporter_id");--> statement-breakpoint
CREATE INDEX "message_conversations_item_id_idx" ON "message_conversations" ("item_id");--> statement-breakpoint
CREATE INDEX "message_conversations_context_id_idx" ON "message_conversations" ("context_id");--> statement-breakpoint
CREATE INDEX "message_moderator_actions_message_id_idx" ON "message_moderator_actions" ("message_id");--> statement-breakpoint
CREATE INDEX "message_moderator_actions_conversation_id_idx" ON "message_moderator_actions" ("conversation_id");--> statement-breakpoint
CREATE INDEX "message_moderator_actions_actor_id_idx" ON "message_moderator_actions" ("actor_id");--> statement-breakpoint
CREATE INDEX "message_user_deletions_user_id_idx" ON "message_user_deletions" ("user_id");--> statement-breakpoint
CREATE INDEX "message_users_blocked_blocked_user_id_idx" ON "message_users_blocked" ("blocked_user_id");--> statement-breakpoint
CREATE INDEX "notification_dispatch_log_notification_id_idx" ON "notification_dispatch_log" ("notification_id");--> statement-breakpoint
CREATE INDEX "notification_dispatch_log_user_id_idx" ON "notification_dispatch_log" ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_user_id_from_idx" ON "notifications" ("user_id_from");--> statement-breakpoint
CREATE INDEX "notifications_user_id_to_idx" ON "notifications" ("user_id_to");--> statement-breakpoint
CREATE INDEX "calendar_events_course_id_idx" ON "calendar_events" ("course_id");--> statement-breakpoint
CREATE INDEX "calendar_events_group_id_idx" ON "calendar_events" ("group_id");--> statement-breakpoint
CREATE INDEX "calendar_events_category_id_idx" ON "calendar_events" ("category_id");--> statement-breakpoint
CREATE INDEX "calendar_events_user_id_idx" ON "calendar_events" ("user_id");--> statement-breakpoint
CREATE INDEX "calendar_events_context_id_idx" ON "calendar_events" ("context_id");--> statement-breakpoint
CREATE INDEX "calendar_events_subscription_id_idx" ON "calendar_events" ("subscription_id");--> statement-breakpoint
CREATE INDEX "calendar_events_repeat_id_idx" ON "calendar_events" ("repeat_id");--> statement-breakpoint
CREATE INDEX "calendar_events_exception_of_idx" ON "calendar_events" ("exception_of");--> statement-breakpoint
CREATE INDEX "calendar_export_tokens_user_id_idx" ON "calendar_export_tokens" ("user_id");--> statement-breakpoint
CREATE INDEX "calendar_subscriptions_course_id_idx" ON "calendar_subscriptions" ("course_id");--> statement-breakpoint
CREATE INDEX "calendar_subscriptions_category_id_idx" ON "calendar_subscriptions" ("category_id");--> statement-breakpoint
CREATE INDEX "calendar_subscriptions_user_id_idx" ON "calendar_subscriptions" ("user_id");--> statement-breakpoint
CREATE INDEX "badge_course_id_idx" ON "badge" ("course_id");--> statement-breakpoint
CREATE INDEX "badge_user_created_idx" ON "badge" ("user_created");--> statement-breakpoint
CREATE INDEX "badge_criteria_badge_id_idx" ON "badge_criteria" ("badge_id");--> statement-breakpoint
CREATE INDEX "badge_issued_user_id_idx" ON "badge_issued" ("user_id");--> statement-breakpoint
CREATE INDEX "badge_manual_award_recipient_id_idx" ON "badge_manual_award" ("recipient_id");--> statement-breakpoint
CREATE INDEX "badge_manual_award_issuer_id_idx" ON "badge_manual_award" ("issuer_id");--> statement-breakpoint
CREATE INDEX "badge_manual_award_issuer_role_idx" ON "badge_manual_award" ("issuer_role");--> statement-breakpoint
CREATE INDEX "competency_framework_id_idx" ON "competency" ("framework_id");--> statement-breakpoint
CREATE INDEX "competency_parent_id_idx" ON "competency" ("parent_id");--> statement-breakpoint
CREATE INDEX "competency_course_comp_competency_id_idx" ON "competency_course_comp" ("competency_id");--> statement-breakpoint
CREATE INDEX "competency_evidence_user_competency_id_idx" ON "competency_evidence" ("user_competency_id");--> statement-breakpoint
CREATE INDEX "competency_evidence_context_id_idx" ON "competency_evidence" ("context_id");--> statement-breakpoint
CREATE INDEX "competency_evidence_action_user_id_idx" ON "competency_evidence" ("action_user_id");--> statement-breakpoint
CREATE INDEX "competency_framework_context_id_idx" ON "competency_framework" ("context_id");--> statement-breakpoint
CREATE INDEX "competency_module_comp_competency_id_idx" ON "competency_module_comp" ("competency_id");--> statement-breakpoint
CREATE INDEX "competency_plan_comp_competency_id_idx" ON "competency_plan_comp" ("competency_id");--> statement-breakpoint
CREATE INDEX "competency_plan_review_plan_id_idx" ON "competency_plan_review" ("plan_id");--> statement-breakpoint
CREATE INDEX "competency_plan_review_actor_id_idx" ON "competency_plan_review" ("actor_id");--> statement-breakpoint
CREATE INDEX "competency_template_context_id_idx" ON "competency_template" ("context_id");--> statement-breakpoint
CREATE INDEX "competency_template_cohort_cohort_id_idx" ON "competency_template_cohort" ("cohort_id");--> statement-breakpoint
CREATE INDEX "competency_template_comp_competency_id_idx" ON "competency_template_comp" ("competency_id");--> statement-breakpoint
CREATE INDEX "competency_user_comp_competency_id_idx" ON "competency_user_comp" ("competency_id");--> statement-breakpoint
CREATE INDEX "competency_user_comp_plan_id_idx" ON "competency_user_comp" ("plan_id");--> statement-breakpoint
CREATE INDEX "competency_user_comp_course_id_idx" ON "competency_user_comp" ("course_id");--> statement-breakpoint
CREATE INDEX "competency_user_comp_reviewer_id_idx" ON "competency_user_comp" ("reviewer_id");--> statement-breakpoint
CREATE INDEX "learning_plans_user_id_idx" ON "learning_plans" ("user_id");--> statement-breakpoint
CREATE INDEX "learning_plans_template_id_idx" ON "learning_plans" ("template_id");--> statement-breakpoint
CREATE INDEX "learning_plans_reviewer_id_idx" ON "learning_plans" ("reviewer_id");--> statement-breakpoint
CREATE INDEX "blog_association_context_id_idx" ON "blog_association" ("context_id");--> statement-breakpoint
CREATE INDEX "blog_association_assoc_id_idx" ON "blog_association" ("assoc_id");--> statement-breakpoint
CREATE INDEX "blog_post_placements_post_id_idx" ON "blog_post_placements" ("post_id");--> statement-breakpoint
CREATE INDEX "blog_post_placements_space_idx" ON "blog_post_placements" ("space_type","space_id");--> statement-breakpoint
CREATE INDEX "blog_post_references_post_id_idx" ON "blog_post_references" ("post_id");--> statement-breakpoint
CREATE INDEX "blog_posts_user_id_idx" ON "blog_posts" ("user_id");--> statement-breakpoint
CREATE INDEX "blog_posts_space_idx" ON "blog_posts" ("space_type","space_id");--> statement-breakpoint
CREATE INDEX "blog_posts_status_published_idx" ON "blog_posts" ("status","published_at");--> statement-breakpoint
CREATE INDEX "comments_context_id_idx" ON "comments" ("context_id");--> statement-breakpoint
CREATE INDEX "comments_item_id_idx" ON "comments" ("item_id");--> statement-breakpoint
CREATE INDEX "comments_user_id_idx" ON "comments" ("user_id");--> statement-breakpoint
CREATE INDEX "notes_course_id_idx" ON "notes" ("course_id");--> statement-breakpoint
CREATE INDEX "notes_user_id_idx" ON "notes" ("user_id");--> statement-breakpoint
CREATE INDEX "notes_created_by_idx" ON "notes" ("created_by");--> statement-breakpoint
CREATE INDEX "notes_group_id_idx" ON "notes" ("group_id");--> statement-breakpoint
CREATE INDEX "rating_item_id_idx" ON "rating" ("item_id");--> statement-breakpoint
CREATE INDEX "rating_user_id_idx" ON "rating" ("user_id");--> statement-breakpoint
CREATE INDEX "tag_user_id_idx" ON "tag" ("user_id");--> statement-breakpoint
CREATE INDEX "tag_instance_item_id_idx" ON "tag_instance" ("item_id");--> statement-breakpoint
CREATE INDEX "tag_instance_context_id_idx" ON "tag_instance" ("context_id");--> statement-breakpoint
CREATE INDEX "tag_instance_ti_user_id_idx" ON "tag_instance" ("ti_user_id");--> statement-breakpoint
CREATE INDEX "search_documents_item_id_idx" ON "search_documents" ("item_id");--> statement-breakpoint
CREATE INDEX "search_documents_context_id_idx" ON "search_documents" ("context_id");--> statement-breakpoint
CREATE INDEX "search_documents_owner_id_idx" ON "search_documents" ("owner_id");--> statement-breakpoint
CREATE INDEX "external_tokens_user_id_idx" ON "external_tokens" ("user_id");--> statement-breakpoint
CREATE INDEX "external_tokens_service_id_idx" ON "external_tokens" ("service_id");--> statement-breakpoint
CREATE INDEX "backup_id_mappings_job_id_idx" ON "backup_id_mappings" ("job_id");--> statement-breakpoint
CREATE INDEX "backup_id_mappings_old_id_idx" ON "backup_id_mappings" ("old_id");--> statement-breakpoint
CREATE INDEX "backup_id_mappings_new_id_idx" ON "backup_id_mappings" ("new_id");--> statement-breakpoint
CREATE INDEX "backup_job_steps_job_id_idx" ON "backup_job_steps" ("job_id");--> statement-breakpoint
CREATE INDEX "backup_jobs_course_id_idx" ON "backup_jobs" ("course_id");--> statement-breakpoint
CREATE INDEX "backup_jobs_target_course_id_idx" ON "backup_jobs" ("target_course_id");--> statement-breakpoint
CREATE INDEX "backup_jobs_user_id_idx" ON "backup_jobs" ("user_id");--> statement-breakpoint
CREATE INDEX "analytics_predictions_model_id_idx" ON "analytics_predictions" ("model_id");--> statement-breakpoint
CREATE INDEX "analytics_predictions_user_id_idx" ON "analytics_predictions" ("user_id");--> statement-breakpoint
CREATE INDEX "analytics_predictions_context_id_idx" ON "analytics_predictions" ("context_id");--> statement-breakpoint
CREATE INDEX "analytics_predictions_course_id_idx" ON "analytics_predictions" ("course_id");--> statement-breakpoint
CREATE INDEX "insights_model_id_idx" ON "insights" ("model_id");--> statement-breakpoint
CREATE INDEX "insights_prediction_id_idx" ON "insights" ("prediction_id");--> statement-breakpoint
CREATE INDEX "insights_user_id_idx" ON "insights" ("user_id");--> statement-breakpoint
CREATE INDEX "insights_recipient_id_idx" ON "insights" ("recipient_id");--> statement-breakpoint
CREATE INDEX "insights_context_id_idx" ON "insights" ("context_id");--> statement-breakpoint
CREATE INDEX "insights_course_id_idx" ON "insights" ("course_id");--> statement-breakpoint
CREATE INDEX "report_builder_audience_report_id_idx" ON "report_builder_audience" ("report_id");--> statement-breakpoint
CREATE INDEX "report_builder_audience_user_id_idx" ON "report_builder_audience" ("user_id");--> statement-breakpoint
CREATE INDEX "report_builder_report_created_by_idx" ON "report_builder_report" ("created_by");--> statement-breakpoint
CREATE INDEX "report_builder_report_context_id_idx" ON "report_builder_report" ("context_id");--> statement-breakpoint
CREATE INDEX "report_builder_schedule_report_id_idx" ON "report_builder_schedule" ("report_id");--> statement-breakpoint
CREATE INDEX "report_builder_schedule_created_by_idx" ON "report_builder_schedule" ("created_by");--> statement-breakpoint
CREATE INDEX "content_bank_content_context_id_idx" ON "content_bank_content" ("context_id");--> statement-breakpoint
CREATE INDEX "content_bank_content_creator_id_idx" ON "content_bank_content" ("creator_id");--> statement-breakpoint
CREATE INDEX "content_bank_content_file_id_idx" ON "content_bank_content" ("file_id");--> statement-breakpoint
CREATE INDEX "content_bank_content_scope_idx" ON "content_bank_content" ("scope");--> statement-breakpoint
CREATE INDEX "content_bank_content_space_id_idx" ON "content_bank_content" ("space_id");--> statement-breakpoint
CREATE INDEX "content_bank_content_subject_id_idx" ON "content_bank_content" ("subject_id");--> statement-breakpoint
CREATE INDEX "content_bank_content_curriculum_node_id_idx" ON "content_bank_content" ("curriculum_node_id");--> statement-breakpoint
CREATE INDEX "content_bank_content_question_category_id_idx" ON "content_bank_content" ("question_category_id");--> statement-breakpoint
CREATE INDEX "content_bank_content_review_status_idx" ON "content_bank_content" ("review_status");--> statement-breakpoint
CREATE INDEX "content_bank_content_derived_from_id_idx" ON "content_bank_content" ("derived_from_id");--> statement-breakpoint
CREATE INDEX "payment_refunds_payment_id_idx" ON "payment_refunds" ("payment_id");--> statement-breakpoint
CREATE INDEX "payments_account_id_idx" ON "payments" ("account_id");--> statement-breakpoint
CREATE INDEX "payments_user_id_idx" ON "payments" ("user_id");--> statement-breakpoint
CREATE INDEX "payments_item_id_idx" ON "payments" ("item_id");--> statement-breakpoint
CREATE INDEX "privacy_export_files_request_id_idx" ON "privacy_export_files" ("request_id");--> statement-breakpoint
CREATE INDEX "privacy_export_files_file_id_idx" ON "privacy_export_files" ("file_id");--> statement-breakpoint
CREATE INDEX "privacy_requests_user_id_idx" ON "privacy_requests" ("user_id");--> statement-breakpoint
CREATE INDEX "privacy_requests_requested_by_idx" ON "privacy_requests" ("requested_by");--> statement-breakpoint
CREATE INDEX "privacy_requests_approved_by_idx" ON "privacy_requests" ("approved_by");--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_role_id_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_context_id_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "context"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "role_capabilities" ADD CONSTRAINT "role_capabilities_context_id_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "context"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "role_capabilities" ADD CONSTRAINT "role_capabilities_role_id_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "login_attempts" ADD CONSTRAINT "login_attempts_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_refresh_id_oauth_refresh_token_id_fkey" FOREIGN KEY ("refresh_id") REFERENCES "oauth_refresh_token"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_dn2L1gs9Dolm_fkey" FOREIGN KEY ("resource_id") REFERENCES "oauth_resource"("identifier") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "refresh_token_family" ADD CONSTRAINT "refresh_token_family_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_oauth_links" ADD CONSTRAINT "user_oauth_links_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_totp" ADD CONSTRAINT "user_totp_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "custom_field_data" ADD CONSTRAINT "custom_field_data_field_id_custom_field_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "custom_field_field"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "custom_field_field" ADD CONSTRAINT "custom_field_field_category_id_custom_field_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "custom_field_category"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course" ADD CONSTRAINT "course_category_course_categories_id_fkey" FOREIGN KEY ("category") REFERENCES "course_categories"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course" ADD CONSTRAINT "course_subject_id_subjects_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "course_format_options" ADD CONSTRAINT "course_format_options_course_id_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_modules" ADD CONSTRAINT "course_modules_course_course_id_fkey" FOREIGN KEY ("course") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_modules" ADD CONSTRAINT "course_modules_section_course_sections_id_fkey" FOREIGN KEY ("section") REFERENCES "course_sections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_section_anchor_outcomes" ADD CONSTRAINT "course_section_anchor_outcomes_XIdfo0CZfh3M_fkey" FOREIGN KEY ("anchor_id") REFERENCES "course_section_anchors"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_section_anchor_outcomes" ADD CONSTRAINT "course_section_anchor_outcomes_sjLzNL8BlDa3_fkey" FOREIGN KEY ("outcome_id") REFERENCES "learning_outcomes"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "course_section_anchors" ADD CONSTRAINT "course_section_anchors_section_id_course_sections_id_fkey" FOREIGN KEY ("section_id") REFERENCES "course_sections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_section_anchors" ADD CONSTRAINT "course_section_anchors_node_id_curriculum_nodes_id_fkey" FOREIGN KEY ("node_id") REFERENCES "curriculum_nodes"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "course_section_anchors" ADD CONSTRAINT "course_section_anchors_curriculum_id_curricula_id_fkey" FOREIGN KEY ("curriculum_id") REFERENCES "curricula"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "course_section_book_anchors" ADD CONSTRAINT "course_section_book_anchors_section_id_course_sections_id_fkey" FOREIGN KEY ("section_id") REFERENCES "course_sections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_section_book_anchors" ADD CONSTRAINT "course_section_book_anchors_book_node_id_book_nodes_id_fkey" FOREIGN KEY ("book_node_id") REFERENCES "book_nodes"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "course_section_book_anchors" ADD CONSTRAINT "course_section_book_anchors_book_id_books_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "course_section_book_item_outcomes" ADD CONSTRAINT "course_section_book_item_outcomes_V5jrCyXF8694_fkey" FOREIGN KEY ("item_id") REFERENCES "course_section_book_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_section_book_item_outcomes" ADD CONSTRAINT "course_section_book_item_outcomes_niCrfwnBDPmN_fkey" FOREIGN KEY ("outcome_id") REFERENCES "learning_outcomes"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "course_section_book_items" ADD CONSTRAINT "course_section_book_items_Rj7bOpLW65Bx_fkey" FOREIGN KEY ("anchor_id") REFERENCES "course_section_book_anchors"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_section_book_items" ADD CONSTRAINT "course_section_book_items_book_node_id_book_nodes_id_fkey" FOREIGN KEY ("book_node_id") REFERENCES "book_nodes"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "course_sections" ADD CONSTRAINT "course_sections_course_course_id_fkey" FOREIGN KEY ("course") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "cohort_members" ADD CONSTRAINT "cohort_members_cohort_id_cohort_id_fkey" FOREIGN KEY ("cohort_id") REFERENCES "cohort"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_groups" ADD CONSTRAINT "course_groups_course_id_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "groupings" ADD CONSTRAINT "groupings_course_id_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "groupings_groups" ADD CONSTRAINT "groupings_groups_grouping_id_groupings_id_fkey" FOREIGN KEY ("grouping_id") REFERENCES "groupings"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "groupings_groups" ADD CONSTRAINT "groupings_groups_group_id_course_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "course_groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "groups_members" ADD CONSTRAINT "groups_members_group_id_course_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "course_groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "enrol" ADD CONSTRAINT "enrol_course_id_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_enrolments" ADD CONSTRAINT "user_enrolments_enrol_id_enrol_id_fkey" FOREIGN KEY ("enrol_id") REFERENCES "enrol"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_completion_crit_compl" ADD CONSTRAINT "course_completion_crit_compl_us1SEGOfYz6U_fkey" FOREIGN KEY ("criteria_id") REFERENCES "course_completion_criteria"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_completion_criteria" ADD CONSTRAINT "course_completion_criteria_course_course_id_fkey" FOREIGN KEY ("course") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_completion_criteria" ADD CONSTRAINT "course_completion_criteria_course_instance_course_id_fkey" FOREIGN KEY ("course_instance") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_completion_criteria" ADD CONSTRAINT "course_completion_criteria_role_id_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "course_completion_settings" ADD CONSTRAINT "course_completion_settings_course_course_id_fkey" FOREIGN KEY ("course") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_completions" ADD CONSTRAINT "course_completions_course_course_id_fkey" FOREIGN KEY ("course") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_modules_completion" ADD CONSTRAINT "course_modules_completion_flWxjSj7LKhz_fkey" FOREIGN KEY ("course_module_id") REFERENCES "course_modules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "grade_categories" ADD CONSTRAINT "grade_categories_course_id_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "grade_grades" ADD CONSTRAINT "grade_grades_item_id_grade_items_id_fkey" FOREIGN KEY ("item_id") REFERENCES "grade_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "grade_items" ADD CONSTRAINT "grade_items_course_id_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "grade_items" ADD CONSTRAINT "grade_items_category_id_grade_categories_id_fkey" FOREIGN KEY ("category_id") REFERENCES "grade_categories"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "grade_items" ADD CONSTRAINT "grade_items_scale_id_scales_id_fkey" FOREIGN KEY ("scale_id") REFERENCES "scales"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "grade_items" ADD CONSTRAINT "grade_items_outcome_id_grade_outcomes_id_fkey" FOREIGN KEY ("outcome_id") REFERENCES "grade_outcomes"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "grade_items" ADD CONSTRAINT "grade_items_vn_book_id_vn_gradebooks_id_fkey" FOREIGN KEY ("vn_book_id") REFERENCES "vn_gradebooks"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "grade_outcomes" ADD CONSTRAINT "grade_outcomes_course_id_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "grade_outcomes" ADD CONSTRAINT "grade_outcomes_scale_id_scales_id_fkey" FOREIGN KEY ("scale_id") REFERENCES "scales"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "grade_publications" ADD CONSTRAINT "grade_publications_course_id_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "grade_publications" ADD CONSTRAINT "grade_publications_item_id_grade_items_id_fkey" FOREIGN KEY ("item_id") REFERENCES "grade_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "grade_publications" ADD CONSTRAINT "grade_publications_book_id_vn_gradebooks_id_fkey" FOREIGN KEY ("book_id") REFERENCES "vn_gradebooks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vn_activity_mappings" ADD CONSTRAINT "vn_activity_mappings_course_id_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vn_activity_mappings" ADD CONSTRAINT "vn_activity_mappings_book_id_vn_gradebooks_id_fkey" FOREIGN KEY ("book_id") REFERENCES "vn_gradebooks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vn_activity_mappings" ADD CONSTRAINT "vn_activity_mappings_cm_id_course_modules_id_fkey" FOREIGN KEY ("cm_id") REFERENCES "course_modules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vn_activity_mappings" ADD CONSTRAINT "vn_activity_mappings_item_id_grade_items_id_fkey" FOREIGN KEY ("item_id") REFERENCES "grade_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vn_activity_mappings" ADD CONSTRAINT "vn_activity_mappings_target_item_id_grade_items_id_fkey" FOREIGN KEY ("target_item_id") REFERENCES "grade_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vn_candidate_actions" ADD CONSTRAINT "vn_candidate_actions_course_id_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vn_candidate_actions" ADD CONSTRAINT "vn_candidate_actions_book_id_vn_gradebooks_id_fkey" FOREIGN KEY ("book_id") REFERENCES "vn_gradebooks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vn_candidate_actions" ADD CONSTRAINT "vn_candidate_actions_mapping_id_vn_activity_mappings_id_fkey" FOREIGN KEY ("mapping_id") REFERENCES "vn_activity_mappings"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "vn_candidate_actions" ADD CONSTRAINT "vn_candidate_actions_target_item_id_grade_items_id_fkey" FOREIGN KEY ("target_item_id") REFERENCES "grade_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vn_candidate_actions" ADD CONSTRAINT "vn_candidate_actions_source_item_id_grade_items_id_fkey" FOREIGN KEY ("source_item_id") REFERENCES "grade_items"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "vn_gradebooks" ADD CONSTRAINT "vn_gradebooks_course_id_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vn_gradebooks" ADD CONSTRAINT "vn_gradebooks_category_id_grade_categories_id_fkey" FOREIGN KEY ("category_id") REFERENCES "grade_categories"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "vn_term_results" ADD CONSTRAINT "vn_term_results_book_id_vn_gradebooks_id_fkey" FOREIGN KEY ("book_id") REFERENCES "vn_gradebooks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vn_term_results" ADD CONSTRAINT "vn_term_results_course_id_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "guardian_digests" ADD CONSTRAINT "guardian_digests_guardian_user_id_users_id_fkey" FOREIGN KEY ("guardian_user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "guardian_digests" ADD CONSTRAINT "guardian_digests_student_user_id_users_id_fkey" FOREIGN KEY ("student_user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "guardian_links" ADD CONSTRAINT "guardian_links_guardian_user_id_users_id_fkey" FOREIGN KEY ("guardian_user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "guardian_links" ADD CONSTRAINT "guardian_links_student_user_id_users_id_fkey" FOREIGN KEY ("student_user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "guardian_view_state" ADD CONSTRAINT "guardian_view_state_guardian_user_id_users_id_fkey" FOREIGN KEY ("guardian_user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "guardian_view_state" ADD CONSTRAINT "guardian_view_state_student_user_id_users_id_fkey" FOREIGN KEY ("student_user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_course_card_prefs" ADD CONSTRAINT "user_course_card_prefs_course_id_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "qtype_essay_options" ADD CONSTRAINT "qtype_essay_options_rP8Wa5wQJvJN_fkey" FOREIGN KEY ("question_version_id") REFERENCES "question_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "qtype_multichoice_options" ADD CONSTRAINT "qtype_multichoice_options_wd17CNE0Cw44_fkey" FOREIGN KEY ("question_version_id") REFERENCES "question_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "qtype_shortanswer_options" ADD CONSTRAINT "qtype_shortanswer_options_RzUKXPi2D6We_fkey" FOREIGN KEY ("question_version_id") REFERENCES "question_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question" ADD CONSTRAINT "question_category_question_categories_id_fkey" FOREIGN KEY ("category") REFERENCES "question_categories"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_answers" ADD CONSTRAINT "question_answers_question_version_id_question_versions_id_fkey" FOREIGN KEY ("question_version_id") REFERENCES "question_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_attempt_step_data" ADD CONSTRAINT "question_attempt_step_data_IY7k9FtOXqko_fkey" FOREIGN KEY ("attempt_step_id") REFERENCES "question_attempt_steps"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_attempt_steps" ADD CONSTRAINT "question_attempt_steps_KOb6nGnzo8Fx_fkey" FOREIGN KEY ("question_attempt_id") REFERENCES "question_attempts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_attempts" ADD CONSTRAINT "question_attempts_question_usage_id_question_usages_id_fkey" FOREIGN KEY ("question_usage_id") REFERENCES "question_usages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_attempts" ADD CONSTRAINT "question_attempts_question_id_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "question"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_attempts" ADD CONSTRAINT "question_attempts_question_version_id_question_versions_id_fkey" FOREIGN KEY ("question_version_id") REFERENCES "question_versions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "question_bank_contributions" ADD CONSTRAINT "question_bank_contributions_question_id_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "question"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_bank_contributions" ADD CONSTRAINT "question_bank_contributions_MgHALFjkbgfv_fkey" FOREIGN KEY ("target_bank_id") REFERENCES "question_banks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_bank_entries" ADD CONSTRAINT "question_bank_entries_BhJIQCl6jHum_fkey" FOREIGN KEY ("question_category_id") REFERENCES "question_categories"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_bank_entries" ADD CONSTRAINT "question_bank_entries_question_id_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "question"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_categories" ADD CONSTRAINT "question_categories_bank_id_question_banks_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "question_banks"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "question_truefalse" ADD CONSTRAINT "question_truefalse_VREOpGcldK6H_fkey" FOREIGN KEY ("question_version_id") REFERENCES "question_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_truefalse" ADD CONSTRAINT "question_truefalse_true_answer_question_answers_id_fkey" FOREIGN KEY ("true_answer") REFERENCES "question_answers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_truefalse" ADD CONSTRAINT "question_truefalse_false_answer_question_answers_id_fkey" FOREIGN KEY ("false_answer") REFERENCES "question_answers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_1NDKL1LfCtcc_fkey" FOREIGN KEY ("question_bank_entry_id") REFERENCES "question_bank_entries"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_question_id_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "question"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_stimulus_id_stimuli_id_fkey" FOREIGN KEY ("stimulus_id") REFERENCES "stimuli"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "stimuli" ADD CONSTRAINT "stimuli_category_id_question_categories_id_fkey" FOREIGN KEY ("category_id") REFERENCES "question_categories"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exam_deployments" ADD CONSTRAINT "exam_deployments_paper_id_exam_papers_id_fkey" FOREIGN KEY ("paper_id") REFERENCES "exam_papers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exam_deployments" ADD CONSTRAINT "exam_deployments_paper_version_id_exam_paper_versions_id_fkey" FOREIGN KEY ("paper_version_id") REFERENCES "exam_paper_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exam_dossier_reviews" ADD CONSTRAINT "exam_dossier_reviews_dossier_id_exam_dossiers_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "exam_dossiers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exam_dossiers" ADD CONSTRAINT "exam_dossiers_paper_id_exam_papers_id_fkey" FOREIGN KEY ("paper_id") REFERENCES "exam_papers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exam_dossiers" ADD CONSTRAINT "exam_dossiers_target_bank_id_question_banks_id_fkey" FOREIGN KEY ("target_bank_id") REFERENCES "question_banks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exam_dossiers" ADD CONSTRAINT "exam_dossiers_paper_version_id_exam_paper_versions_id_fkey" FOREIGN KEY ("paper_version_id") REFERENCES "exam_paper_versions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "exam_dossiers" ADD CONSTRAINT "exam_dossiers_matrix_id_exam_matrices_id_fkey" FOREIGN KEY ("matrix_id") REFERENCES "exam_matrices"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "exam_paper_contributions" ADD CONSTRAINT "exam_paper_contributions_paper_id_exam_papers_id_fkey" FOREIGN KEY ("paper_id") REFERENCES "exam_papers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exam_paper_contributions" ADD CONSTRAINT "exam_paper_contributions_target_bank_id_question_banks_id_fkey" FOREIGN KEY ("target_bank_id") REFERENCES "question_banks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exam_paper_slots" ADD CONSTRAINT "exam_paper_slots_paper_version_id_exam_paper_versions_id_fkey" FOREIGN KEY ("paper_version_id") REFERENCES "exam_paper_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exam_paper_slots" ADD CONSTRAINT "exam_paper_slots_question_id_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "question"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exam_paper_slots" ADD CONSTRAINT "exam_paper_slots_matrix_cell_id_exam_matrix_cells_id_fkey" FOREIGN KEY ("matrix_cell_id") REFERENCES "exam_matrix_cells"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "exam_paper_versions" ADD CONSTRAINT "exam_paper_versions_paper_id_exam_papers_id_fkey" FOREIGN KEY ("paper_id") REFERENCES "exam_papers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exam_paper_versions" ADD CONSTRAINT "exam_paper_versions_subject_id_subjects_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "exam_paper_versions" ADD CONSTRAINT "exam_paper_versions_matrix_id_exam_matrices_id_fkey" FOREIGN KEY ("matrix_id") REFERENCES "exam_matrices"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "exam_papers" ADD CONSTRAINT "exam_papers_bank_id_question_banks_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "question_banks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exam_matrices" ADD CONSTRAINT "exam_matrices_subject_id_subjects_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exam_matrices" ADD CONSTRAINT "exam_matrices_curriculum_id_curricula_id_fkey" FOREIGN KEY ("curriculum_id") REFERENCES "curricula"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exam_matrices" ADD CONSTRAINT "exam_matrices_bank_id_question_banks_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "question_banks"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "exam_matrix_cells" ADD CONSTRAINT "exam_matrix_cells_matrix_id_exam_matrices_id_fkey" FOREIGN KEY ("matrix_id") REFERENCES "exam_matrices"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exam_matrix_cells" ADD CONSTRAINT "exam_matrix_cells_learning_outcome_id_learning_outcomes_id_fkey" FOREIGN KEY ("learning_outcome_id") REFERENCES "learning_outcomes"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "exam_matrix_contributions" ADD CONSTRAINT "exam_matrix_contributions_matrix_id_exam_matrices_id_fkey" FOREIGN KEY ("matrix_id") REFERENCES "exam_matrices"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exam_matrix_contributions" ADD CONSTRAINT "exam_matrix_contributions_target_bank_id_question_banks_id_fkey" FOREIGN KEY ("target_bank_id") REFERENCES "question_banks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "quiz_attempt_events" ADD CONSTRAINT "quiz_attempt_events_attempt_id_quiz_attempts_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "quiz_attempts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_quiz_id_quizzes_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "quizzes"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_usage_id_question_usages_id_fkey" FOREIGN KEY ("usage_id") REFERENCES "question_usages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "quiz_feedbacks" ADD CONSTRAINT "quiz_feedbacks_quiz_id_quizzes_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "quizzes"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "quiz_overrides" ADD CONSTRAINT "quiz_overrides_quiz_id_quizzes_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "quizzes"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "quiz_overrides" ADD CONSTRAINT "quiz_overrides_group_id_course_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "course_groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "quiz_slot_version_events" ADD CONSTRAINT "quiz_slot_version_events_quiz_id_quizzes_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "quizzes"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "quiz_slot_version_events" ADD CONSTRAINT "quiz_slot_version_events_slot_id_quiz_slots_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "quiz_slots"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "quiz_slots" ADD CONSTRAINT "quiz_slots_quiz_id_quizzes_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "quizzes"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "quiz_slots" ADD CONSTRAINT "quiz_slots_question_id_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "question"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "quiz_slots" ADD CONSTRAINT "quiz_slots_category_id_question_categories_id_fkey" FOREIGN KEY ("category_id") REFERENCES "question_categories"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "quiz_slots" ADD CONSTRAINT "quiz_slots_matrix_cell_id_exam_matrix_cells_id_fkey" FOREIGN KEY ("matrix_cell_id") REFERENCES "exam_matrix_cells"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_course_course_id_fkey" FOREIGN KEY ("course") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_matrix_id_exam_matrices_id_fkey" FOREIGN KEY ("matrix_id") REFERENCES "exam_matrices"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_paper_id_exam_papers_id_fkey" FOREIGN KEY ("paper_id") REFERENCES "exam_papers"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_paper_version_id_exam_paper_versions_id_fkey" FOREIGN KEY ("paper_version_id") REFERENCES "exam_paper_versions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "quiz_paper_batches" ADD CONSTRAINT "quiz_paper_batches_quiz_id_quizzes_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "quizzes"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "quiz_paper_scans" ADD CONSTRAINT "quiz_paper_scans_batch_id_quiz_paper_batches_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "quiz_paper_batches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "quiz_paper_scans" ADD CONSTRAINT "quiz_paper_scans_quiz_id_quizzes_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "quizzes"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "quiz_paper_scans" ADD CONSTRAINT "quiz_paper_scans_attempt_id_quiz_attempts_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "quiz_attempts"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "assign_annotations" ADD CONSTRAINT "assign_annotations_submission_id_assign_submissions_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "assign_submissions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assign_annotations" ADD CONSTRAINT "assign_annotations_file_id_files_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assign_feedback_messages" ADD CONSTRAINT "assign_feedback_messages_grade_id_assign_grades_id_fkey" FOREIGN KEY ("grade_id") REFERENCES "assign_grades"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assign_grade_revisions" ADD CONSTRAINT "assign_grade_revisions_grade_id_assign_grades_id_fkey" FOREIGN KEY ("grade_id") REFERENCES "assign_grades"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assign_grades" ADD CONSTRAINT "assign_grades_assignment_id_assignments_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assign_rubric_criteria" ADD CONSTRAINT "assign_rubric_criteria_rubric_id_assign_rubrics_id_fkey" FOREIGN KEY ("rubric_id") REFERENCES "assign_rubrics"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assign_rubric_evaluations" ADD CONSTRAINT "assign_rubric_evaluations_grade_id_assign_grades_id_fkey" FOREIGN KEY ("grade_id") REFERENCES "assign_grades"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assign_rubric_evaluations" ADD CONSTRAINT "assign_rubric_evaluations_HlmmYPrbTwKl_fkey" FOREIGN KEY ("criterion_id") REFERENCES "assign_rubric_criteria"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assign_rubric_evaluations" ADD CONSTRAINT "assign_rubric_evaluations_level_id_assign_rubric_levels_id_fkey" FOREIGN KEY ("level_id") REFERENCES "assign_rubric_levels"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "assign_rubric_levels" ADD CONSTRAINT "assign_rubric_levels_F1wj7IWBuE4l_fkey" FOREIGN KEY ("criterion_id") REFERENCES "assign_rubric_criteria"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assign_rubrics" ADD CONSTRAINT "assign_rubrics_assignment_id_assignments_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assign_submission_files" ADD CONSTRAINT "assign_submission_files_2yBSlJM0A5zz_fkey" FOREIGN KEY ("submission_id") REFERENCES "assign_submissions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assign_submission_files" ADD CONSTRAINT "assign_submission_files_file_id_files_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assign_submissions" ADD CONSTRAINT "assign_submissions_assignment_id_assignments_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_course_course_id_fkey" FOREIGN KEY ("course") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_last_access" ADD CONSTRAINT "course_last_access_course_id_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_last_access" ADD CONSTRAINT "course_last_access_cm_id_course_modules_id_fkey" FOREIGN KEY ("cm_id") REFERENCES "course_modules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_module_progress" ADD CONSTRAINT "course_module_progress_course_id_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "course_module_progress" ADD CONSTRAINT "course_module_progress_cm_id_course_modules_id_fkey" FOREIGN KEY ("cm_id") REFERENCES "course_modules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_course_course_id_fkey" FOREIGN KEY ("course") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_course_course_id_fkey" FOREIGN KEY ("course") REFERENCES "course"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_file_id_files_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "curricula" ADD CONSTRAINT "curricula_subject_id_subjects_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "curriculum_nodes" ADD CONSTRAINT "curriculum_nodes_curriculum_id_curricula_id_fkey" FOREIGN KEY ("curriculum_id") REFERENCES "curricula"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "curriculum_nodes" ADD CONSTRAINT "curriculum_nodes_parent_fk" FOREIGN KEY ("curriculum_id","parent_id") REFERENCES "curriculum_nodes"("curriculum_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "curriculum_program_records" ADD CONSTRAINT "curriculum_program_records_subject_id_subjects_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "curriculum_program_records" ADD CONSTRAINT "curriculum_program_records_curriculum_id_curricula_id_fkey" FOREIGN KEY ("curriculum_id") REFERENCES "curricula"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "curriculum_program_records" ADD CONSTRAINT "curriculum_program_records_node_id_curriculum_nodes_id_fkey" FOREIGN KEY ("node_id") REFERENCES "curriculum_nodes"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "learning_outcomes" ADD CONSTRAINT "learning_outcomes_node_id_curriculum_nodes_id_fkey" FOREIGN KEY ("node_id") REFERENCES "curriculum_nodes"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "learning_outcomes" ADD CONSTRAINT "learning_outcomes_derived_from_id_learning_outcomes_id_fkey" FOREIGN KEY ("derived_from_id") REFERENCES "learning_outcomes"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "question_learning_outcomes" ADD CONSTRAINT "question_learning_outcomes_question_id_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "question"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_learning_outcomes" ADD CONSTRAINT "question_learning_outcomes_uFf0zSMdIR5s_fkey" FOREIGN KEY ("learning_outcome_id") REFERENCES "learning_outcomes"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "question_subjects" ADD CONSTRAINT "question_subjects_question_id_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "question"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "question_subjects" ADD CONSTRAINT "question_subjects_subject_id_subjects_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "book_mappings" ADD CONSTRAINT "book_mappings_book_node_id_book_nodes_id_fkey" FOREIGN KEY ("book_node_id") REFERENCES "book_nodes"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "book_mappings" ADD CONSTRAINT "book_mappings_curriculum_node_id_curriculum_nodes_id_fkey" FOREIGN KEY ("curriculum_node_id") REFERENCES "curriculum_nodes"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "book_mappings" ADD CONSTRAINT "book_mappings_learning_outcome_id_learning_outcomes_id_fkey" FOREIGN KEY ("learning_outcome_id") REFERENCES "learning_outcomes"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "book_nodes" ADD CONSTRAINT "book_nodes_book_id_books_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "book_nodes" ADD CONSTRAINT "book_nodes_parent_fk" FOREIGN KEY ("book_id","parent_id") REFERENCES "book_nodes"("book_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "book_records" ADD CONSTRAINT "book_records_book_id_books_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "book_records" ADD CONSTRAINT "book_records_node_id_book_nodes_id_fkey" FOREIGN KEY ("node_id") REFERENCES "book_nodes"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_subject_id_subjects_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_message_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "message_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message_conversation_members" ADD CONSTRAINT "message_conversation_members_nGTyxtbairiu_fkey" FOREIGN KEY ("conversation_id") REFERENCES "message_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message_conversation_reports" ADD CONSTRAINT "message_conversation_reports_Pp9sKN3GPtqe_fkey" FOREIGN KEY ("conversation_id") REFERENCES "message_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message_user_deletions" ADD CONSTRAINT "message_user_deletions_message_id_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "badge_criteria" ADD CONSTRAINT "badge_criteria_badge_id_badge_id_fkey" FOREIGN KEY ("badge_id") REFERENCES "badge"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "badge_issued" ADD CONSTRAINT "badge_issued_badge_id_badge_id_fkey" FOREIGN KEY ("badge_id") REFERENCES "badge"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "badge_manual_award" ADD CONSTRAINT "badge_manual_award_badge_id_badge_id_fkey" FOREIGN KEY ("badge_id") REFERENCES "badge"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency" ADD CONSTRAINT "competency_framework_id_competency_framework_id_fkey" FOREIGN KEY ("framework_id") REFERENCES "competency_framework"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_course_comp" ADD CONSTRAINT "competency_course_comp_competency_id_competency_id_fkey" FOREIGN KEY ("competency_id") REFERENCES "competency"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_evidence" ADD CONSTRAINT "competency_evidence_frDPRl5EpkoF_fkey" FOREIGN KEY ("user_competency_id") REFERENCES "competency_user_comp"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_module_comp" ADD CONSTRAINT "competency_module_comp_competency_id_competency_id_fkey" FOREIGN KEY ("competency_id") REFERENCES "competency"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_plan_comp" ADD CONSTRAINT "competency_plan_comp_plan_id_learning_plans_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "learning_plans"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_plan_comp" ADD CONSTRAINT "competency_plan_comp_competency_id_competency_id_fkey" FOREIGN KEY ("competency_id") REFERENCES "competency"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_plan_review" ADD CONSTRAINT "competency_plan_review_plan_id_learning_plans_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "learning_plans"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_template_cohort" ADD CONSTRAINT "competency_template_cohort_rz9pKDP1nFH8_fkey" FOREIGN KEY ("template_id") REFERENCES "competency_template"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_template_comp" ADD CONSTRAINT "competency_template_comp_H2NoFiKnKq8W_fkey" FOREIGN KEY ("template_id") REFERENCES "competency_template"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_template_comp" ADD CONSTRAINT "competency_template_comp_competency_id_competency_id_fkey" FOREIGN KEY ("competency_id") REFERENCES "competency"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "competency_user_comp" ADD CONSTRAINT "competency_user_comp_competency_id_competency_id_fkey" FOREIGN KEY ("competency_id") REFERENCES "competency"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "blog_association" ADD CONSTRAINT "blog_association_blog_id_blog_posts_id_fkey" FOREIGN KEY ("blog_id") REFERENCES "blog_posts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "blog_post_placements" ADD CONSTRAINT "blog_post_placements_post_id_blog_posts_id_fkey" FOREIGN KEY ("post_id") REFERENCES "blog_posts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "blog_post_references" ADD CONSTRAINT "blog_post_references_post_id_blog_posts_id_fkey" FOREIGN KEY ("post_id") REFERENCES "blog_posts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tag_correlation" ADD CONSTRAINT "tag_correlation_tag_id_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tag"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tag_instance" ADD CONSTRAINT "tag_instance_tag_id_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tag"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "external_tokens" ADD CONSTRAINT "external_tokens_service_id_external_services_id_fkey" FOREIGN KEY ("service_id") REFERENCES "external_services"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "backup_id_mappings" ADD CONSTRAINT "backup_id_mappings_job_id_backup_jobs_id_fkey" FOREIGN KEY ("job_id") REFERENCES "backup_jobs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "backup_job_steps" ADD CONSTRAINT "backup_job_steps_job_id_backup_jobs_id_fkey" FOREIGN KEY ("job_id") REFERENCES "backup_jobs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "analytics_predictions" ADD CONSTRAINT "analytics_predictions_model_id_analytics_models_id_fkey" FOREIGN KEY ("model_id") REFERENCES "analytics_models"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_model_id_analytics_models_id_fkey" FOREIGN KEY ("model_id") REFERENCES "analytics_models"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "report_builder_audience" ADD CONSTRAINT "report_builder_audience_report_id_report_builder_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "report_builder_report"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "report_builder_schedule" ADD CONSTRAINT "report_builder_schedule_report_id_report_builder_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "report_builder_report"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "content_bank_content" ADD CONSTRAINT "content_bank_content_subject_id_subjects_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "content_bank_content" ADD CONSTRAINT "content_bank_content_2sh6wRttD61R_fkey" FOREIGN KEY ("curriculum_node_id") REFERENCES "curriculum_nodes"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "content_bank_content" ADD CONSTRAINT "content_bank_content_cC6kSo4nHuXc_fkey" FOREIGN KEY ("question_category_id") REFERENCES "question_categories"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "content_bank_content" ADD CONSTRAINT "content_bank_content_mtO4LF7jxHiG_fkey" FOREIGN KEY ("derived_from_id") REFERENCES "content_bank_content"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_payment_id_payments_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_account_id_payment_accounts_id_fkey" FOREIGN KEY ("account_id") REFERENCES "payment_accounts"("id");--> statement-breakpoint
ALTER TABLE "privacy_export_files" ADD CONSTRAINT "privacy_export_files_request_id_privacy_requests_id_fkey" FOREIGN KEY ("request_id") REFERENCES "privacy_requests"("id") ON DELETE CASCADE;
CREATE TABLE "capabilities" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "capabilities_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL UNIQUE,
	"captype" text DEFAULT 'write' NOT NULL,
	"contextlevel" integer DEFAULT 10 NOT NULL,
	"component" text DEFAULT 'core' NOT NULL,
	"riskbitmask" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "context_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"contextlevel" integer NOT NULL,
	"instanceid" integer DEFAULT 0 NOT NULL,
	"path" text NOT NULL,
	"depth" integer NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "context_level_instance_unique" UNIQUE("contextlevel","instanceid")
);
--> statement-breakpoint
CREATE TABLE "customfield_category" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "customfield_category_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"component" text NOT NULL,
	"area" text NOT NULL,
	"itemid" integer DEFAULT 0 NOT NULL,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customfield_data" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "customfield_data_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"fieldid" integer NOT NULL,
	"instanceid" integer NOT NULL,
	"value" text,
	"valueformat" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customfield_data_unique" UNIQUE("fieldid","instanceid")
);
--> statement-breakpoint
CREATE TABLE "customfield_field" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "customfield_field_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"categoryid" integer NOT NULL,
	"shortname" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"configdata" jsonb DEFAULT '{}' NOT NULL,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "files_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"contenthash" text NOT NULL,
	"contextid" integer NOT NULL,
	"component" text NOT NULL,
	"filearea" text NOT NULL,
	"itemid" integer DEFAULT 0 NOT NULL,
	"filepath" text DEFAULT '/' NOT NULL,
	"filename" text NOT NULL,
	"userid" integer,
	"filesize" integer NOT NULL,
	"mimetype" text,
	"status" integer DEFAULT 0 NOT NULL,
	"source" text,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "login_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userid" integer,
	"username" text NOT NULL,
	"success" boolean NOT NULL,
	"ip" text,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_token_family" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "refresh_token_family_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"family_id" text NOT NULL UNIQUE,
	"userid" integer NOT NULL,
	"current_token_hash" text NOT NULL,
	"previous_token_hash" text,
	"revoked" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "role_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text DEFAULT '' NOT NULL,
	"shortname" text NOT NULL UNIQUE,
	"description" text DEFAULT '' NOT NULL,
	"sortorder" integer DEFAULT 0 NOT NULL,
	"archetype" text
);
--> statement-breakpoint
CREATE TABLE "role_assignments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "role_assignments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"roleid" integer NOT NULL,
	"userid" integer NOT NULL,
	"contextid" integer NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	"modifierid" integer,
	"component" text DEFAULT '' NOT NULL,
	"itemid" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "role_assignments_unique" UNIQUE("roleid","userid","contextid","component","itemid")
);
--> statement-breakpoint
CREATE TABLE "role_capabilities" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "role_capabilities_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"contextid" integer NOT NULL,
	"roleid" integer NOT NULL,
	"capability" text NOT NULL,
	"permission" integer NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL,
	"modifierid" integer,
	CONSTRAINT "role_capabilities_unique" UNIQUE("contextid","roleid","capability")
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_preferences_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userid" integer NOT NULL,
	"name" text NOT NULL,
	"value" text,
	CONSTRAINT "user_preferences_unique" UNIQUE("userid","name")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"username" text NOT NULL UNIQUE,
	"email" text NOT NULL UNIQUE,
	"password_hash" text,
	"firstname" text DEFAULT '' NOT NULL,
	"lastname" text DEFAULT '' NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"force_password_change" boolean DEFAULT false NOT NULL,
	"is_guest" boolean DEFAULT false NOT NULL,
	"lastlogin" timestamp with time zone,
	"timecreated" timestamp with time zone DEFAULT now() NOT NULL,
	"timemodified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customfield_data" ADD CONSTRAINT "customfield_data_fieldid_customfield_field_id_fkey" FOREIGN KEY ("fieldid") REFERENCES "customfield_field"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "customfield_field" ADD CONSTRAINT "customfield_field_categoryid_customfield_category_id_fkey" FOREIGN KEY ("categoryid") REFERENCES "customfield_category"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "login_attempts" ADD CONSTRAINT "login_attempts_userid_users_id_fkey" FOREIGN KEY ("userid") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "refresh_token_family" ADD CONSTRAINT "refresh_token_family_userid_users_id_fkey" FOREIGN KEY ("userid") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_roleid_role_id_fkey" FOREIGN KEY ("roleid") REFERENCES "role"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_contextid_context_id_fkey" FOREIGN KEY ("contextid") REFERENCES "context"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "role_capabilities" ADD CONSTRAINT "role_capabilities_contextid_context_id_fkey" FOREIGN KEY ("contextid") REFERENCES "context"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "role_capabilities" ADD CONSTRAINT "role_capabilities_roleid_role_id_fkey" FOREIGN KEY ("roleid") REFERENCES "role"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_userid_users_id_fkey" FOREIGN KEY ("userid") REFERENCES "users"("id") ON DELETE CASCADE;
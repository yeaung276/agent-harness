ALTER TABLE "browser_sessions" RENAME TO "browsers";--> statement-breakpoint
ALTER TABLE "browsers" RENAME CONSTRAINT "browser_sessions_pkey" TO "browsers_pkey";--> statement-breakpoint
ALTER TABLE "browsers" RENAME CONSTRAINT "browser_sessions_workspace_id_workspaces_id_fk" TO "browsers_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "browsers" RENAME CONSTRAINT "browser_sessions_user_id_users_id_fk" TO "browsers_user_id_users_id_fk";--> statement-breakpoint
UPDATE "sandbox_activities" SET "status" = 'failed' WHERE "status" = 'running';--> statement-breakpoint
ALTER TABLE "sandbox_activities" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sandbox_activities" DROP COLUMN "finished_at";--> statement-breakpoint
CREATE TABLE "browser_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"browser_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"command" text NOT NULL,
	"status" text NOT NULL,
	"output" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_activities" ADD CONSTRAINT "browser_activities_browser_id_browsers_id_fk" FOREIGN KEY ("browser_id") REFERENCES "public"."browsers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_activities_browser_created_idx" ON "browser_activities" USING btree ("browser_id","created_at");

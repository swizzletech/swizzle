ALTER TABLE "automation_checks" ADD COLUMN "last_report" jsonb;--> statement-breakpoint
ALTER TABLE "automation_checks" ADD COLUMN "last_green_report" jsonb;
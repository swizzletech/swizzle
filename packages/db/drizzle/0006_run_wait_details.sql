ALTER TABLE "runs" ADD COLUMN "wait_approver" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "wait_details" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "wait_started_at" timestamp with time zone;
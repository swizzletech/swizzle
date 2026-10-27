ALTER TABLE "runs" ADD COLUMN "step_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "step_result_bytes" integer DEFAULT 0 NOT NULL;
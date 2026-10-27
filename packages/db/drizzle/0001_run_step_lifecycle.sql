ALTER TABLE "run_steps" ALTER COLUMN "value" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "run_steps" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run_steps" ADD COLUMN "finished_at" timestamp with time zone;
ALTER TABLE "runs" ADD COLUMN "placement_deadline_at" timestamp with time zone NOT NULL;--> statement-breakpoint
CREATE INDEX "runs_status_placement_deadline_idx" ON "runs" USING btree ("status","placement_deadline_at");--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "placement_started_at";
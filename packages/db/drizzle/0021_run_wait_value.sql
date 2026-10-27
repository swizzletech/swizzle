DROP INDEX "runs_status_wait_until_idx";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "wait" jsonb;--> statement-breakpoint
CREATE INDEX "runs_status_wait_until_idx" ON "runs" USING btree ("status",("wait"->>'until'));--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "wait_reason";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "wait_assignee";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "wait_details";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "wait_started_at";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "wait_key";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "wait_until";
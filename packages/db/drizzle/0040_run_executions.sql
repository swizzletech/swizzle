ALTER TABLE "run_attempt_connection_usages" RENAME TO "run_execution_connection_usages";--> statement-breakpoint
ALTER TABLE "run_attempt_secret_usages" RENAME TO "run_execution_secret_usages";--> statement-breakpoint
ALTER TABLE "run_attempts" RENAME TO "run_executions";--> statement-breakpoint
ALTER TABLE "execution_leases" RENAME COLUMN "attempt_number" TO "execution_number";--> statement-breakpoint
ALTER TABLE "run_execution_connection_usages" RENAME COLUMN "attempt_number" TO "execution_number";--> statement-breakpoint
ALTER TABLE "run_execution_secret_usages" RENAME COLUMN "attempt_number" TO "execution_number";--> statement-breakpoint
ALTER TABLE "run_executions" RENAME COLUMN "attempt_number" TO "execution_number";--> statement-breakpoint
ALTER TABLE "run_executions" RENAME COLUMN "segment_attempt" TO "attempt";--> statement-breakpoint
ALTER TABLE "run_steps" RENAME COLUMN "attempt_number" TO "execution_number";--> statement-breakpoint
ALTER TABLE "run_execution_connection_usages" DROP CONSTRAINT "run_attempt_connection_usages_run_id_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "run_execution_secret_usages" DROP CONSTRAINT "run_attempt_secret_usages_run_id_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "run_executions" DROP CONSTRAINT "run_attempts_run_id_runs_id_fk";
--> statement-breakpoint
DROP INDEX "run_attempt_connection_usages_attempt_connection_unique";--> statement-breakpoint
DROP INDEX "run_attempt_connection_usages_run_attempt_idx";--> statement-breakpoint
DROP INDEX "run_attempt_secret_usages_attempt_secret_unique";--> statement-breakpoint
DROP INDEX "run_attempt_secret_usages_run_attempt_idx";--> statement-breakpoint
DROP INDEX "run_attempts_run_attempt_unique";--> statement-breakpoint
DROP INDEX "run_attempts_run_started_idx";--> statement-breakpoint
DROP INDEX "run_attempts_status_heartbeat_idx";--> statement-breakpoint
DROP INDEX "run_attempts_finished_at_idx";--> statement-breakpoint
ALTER TABLE "run_executions" ADD COLUMN "wait" jsonb;--> statement-breakpoint
ALTER TABLE "run_execution_connection_usages" ADD CONSTRAINT "run_execution_connection_usages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_execution_secret_usages" ADD CONSTRAINT "run_execution_secret_usages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_executions" ADD CONSTRAINT "run_executions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_execution_connection_usages_execution_connection_unique" ON "run_execution_connection_usages" USING btree ("run_id","execution_number","connection_name");--> statement-breakpoint
CREATE INDEX "run_execution_connection_usages_run_execution_idx" ON "run_execution_connection_usages" USING btree ("run_id","execution_number","injected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_execution_secret_usages_execution_secret_unique" ON "run_execution_secret_usages" USING btree ("run_id","execution_number","secret_name");--> statement-breakpoint
CREATE INDEX "run_execution_secret_usages_run_execution_idx" ON "run_execution_secret_usages" USING btree ("run_id","execution_number","injected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_executions_run_execution_unique" ON "run_executions" USING btree ("run_id","execution_number");--> statement-breakpoint
CREATE INDEX "run_executions_run_started_idx" ON "run_executions" USING btree ("run_id","started_at");--> statement-breakpoint
CREATE INDEX "run_executions_status_heartbeat_idx" ON "run_executions" USING btree ("status","last_heartbeat_at");--> statement-breakpoint
CREATE INDEX "run_executions_finished_at_idx" ON "run_executions" USING btree ("finished_at");--> statement-breakpoint
ALTER TABLE "execution_leases" DROP COLUMN "segment_attempt";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "last_attempt_number";
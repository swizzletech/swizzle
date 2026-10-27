ALTER TABLE "runs" ADD COLUMN "terminal_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "execution_leases_active_idx" ON "execution_leases" USING btree ("expires_at") WHERE "execution_leases"."released" = false;--> statement-breakpoint
CREATE INDEX "notification_deliveries_pending_idx" ON "notification_deliveries" USING btree ("id") WHERE "notification_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "runs_terminal_pending_idx" ON "runs" USING btree ("id") WHERE "runs"."terminal_pending" = true;
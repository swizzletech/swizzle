ALTER TABLE "automation_timeout_grant_audit_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deployment_audit_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "trigger_audit_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_audit_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "automation_timeout_grant_audit_events" CASCADE;--> statement-breakpoint
DROP TABLE "deployment_audit_events" CASCADE;--> statement-breakpoint
DROP TABLE "trigger_audit_events" CASCADE;--> statement-breakpoint
DROP TABLE "worker_audit_events" CASCADE;--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_actor_kind";--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "deployment_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "trigger_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "worker_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "change" jsonb;--> statement-breakpoint
CREATE INDEX "audit_events_automation_id_idx" ON "audit_events" USING btree ("automation_id","environment","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_worker_idx" ON "audit_events" USING btree ("worker_id","occurred_at");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_kind" CHECK ("audit_events"."actor_kind" IN ('person', 'service-account', 'link', 'open', 'worker', 'system'));
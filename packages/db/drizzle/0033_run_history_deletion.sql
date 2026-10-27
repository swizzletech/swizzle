ALTER TABLE "runs" DROP CONSTRAINT "runs_automation_id_automations_id_fk";
--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_version_id_automation_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_deployment_id_deployments_id_fk";
--> statement-breakpoint
DROP INDEX "automations_slug_unique";--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_version_id_automation_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."automation_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automations_slug_unique" ON "automations" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "automations" DROP COLUMN "deleted_at";
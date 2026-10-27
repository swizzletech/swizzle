CREATE TABLE "worker_run_images" (
	"deployment_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"environment" varchar(32) NOT NULL,
	"tag" varchar(36) NOT NULL,
	CONSTRAINT "worker_run_images_deployment_id_worker_id_pk" PRIMARY KEY("deployment_id","worker_id")
);
--> statement-breakpoint
ALTER TABLE "worker_run_images" ADD CONSTRAINT "worker_run_images_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_run_images" ADD CONSTRAINT "worker_run_images_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;
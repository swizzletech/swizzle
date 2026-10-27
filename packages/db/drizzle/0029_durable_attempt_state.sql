ALTER TABLE "execution_leases" ADD COLUMN "attempt" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "service_health" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "service_health_at" timestamp with time zone;
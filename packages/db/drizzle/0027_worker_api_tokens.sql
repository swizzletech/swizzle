ALTER TABLE "workers" DROP CONSTRAINT "workers_token_hash_unique";--> statement-breakpoint
ALTER TABLE "api_tokens" DROP CONSTRAINT "api_tokens_one_holder";--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "worker_id" uuid;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_worker_unique" ON "api_tokens" USING btree ("worker_id") WHERE "api_tokens"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "workers" DROP COLUMN "token_hash";--> statement-breakpoint
ALTER TABLE "workers" DROP COLUMN "token_expires_at";--> statement-breakpoint
ALTER TABLE "workers" DROP COLUMN "budget_started_at";--> statement-breakpoint
ALTER TABLE "workers" DROP COLUMN "budget_used";--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_one_holder" CHECK (num_nonnulls(user_id, service_account_id, worker_id) = 1);
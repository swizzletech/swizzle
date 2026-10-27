ALTER TABLE "api_tokens" DROP CONSTRAINT "api_tokens_issued_by_auth_users_id_fk";
--> statement-breakpoint
ALTER TABLE "service_accounts" DROP CONSTRAINT "service_accounts_created_by_auth_users_id_fk";
--> statement-breakpoint
ALTER TABLE "service_accounts" ALTER COLUMN "created_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "issued_by_name" text;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD COLUMN "created_by_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_issuer" CHECK ((issued_by IS NULL) = (issued_by_name IS NULL));
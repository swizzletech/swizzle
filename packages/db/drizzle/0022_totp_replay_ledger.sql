CREATE TABLE "auth_totp_uses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_totp_uses" ADD CONSTRAINT "auth_totp_uses_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_totp_uses_code_unique" ON "auth_totp_uses" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "auth_totp_uses_expires_idx" ON "auth_totp_uses" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "auth_two_factors" DROP COLUMN "last_used_step";
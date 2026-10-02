CREATE TABLE "order_counters" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"last_number" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "full_name" varchar(255);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone" varchar(20);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "order_counters" AS PERMISSIVE FOR ALL TO public USING ("order_counters"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("order_counters"."tenant_id" = current_setting('app.tenant_id')::uuid);
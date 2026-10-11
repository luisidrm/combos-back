CREATE TABLE "manual_payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"label" varchar(60) NOT NULL,
	"recipient" varchar(255) NOT NULL,
	"handle" varchar(60),
	"link_template" varchar(500),
	"payee_name" varchar(120),
	"instructions_es" text,
	"instructions_en" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "manual_payment_methods" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "manual_payment_methods" AS PERMISSIVE FOR ALL TO public USING ("manual_payment_methods"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("manual_payment_methods"."tenant_id" = current_setting('app.tenant_id')::uuid);
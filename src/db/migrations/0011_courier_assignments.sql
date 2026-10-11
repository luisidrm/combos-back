CREATE TABLE "courier_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"courier_id" uuid NOT NULL,
	"assigned_by_user_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'assigned' NOT NULL,
	"reason" varchar(40),
	"note" text,
	"accepted_at" timestamp with time zone,
	"picked_up_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "courier_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "courier_assignments" ADD CONSTRAINT "courier_assignments_courier_id_couriers_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."couriers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "courier_assignments_one_open_per_order" ON "courier_assignments" USING btree ("tenant_id","order_id") WHERE "courier_assignments"."status" in ('assigned', 'accepted', 'picked_up');--> statement-breakpoint
CREATE INDEX "courier_assignments_courier_idx" ON "courier_assignments" USING btree ("tenant_id","courier_id","status");--> statement-breakpoint
CREATE INDEX "courier_assignments_order_idx" ON "courier_assignments" USING btree ("tenant_id","order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "couriers_tenant_user_unique" ON "couriers" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "courier_assignments" AS PERMISSIVE FOR ALL TO public USING ("courier_assignments"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("courier_assignments"."tenant_id" = current_setting('app.tenant_id')::uuid);
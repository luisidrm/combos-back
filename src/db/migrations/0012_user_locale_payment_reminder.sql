ALTER TABLE "users" ADD COLUMN "locale" varchar(5) DEFAULT 'es' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_reminder_sent_at" timestamp with time zone;
ALTER TABLE "addresses" ADD COLUMN "neighborhood" varchar(100);--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "product_name_en_snapshot" varchar(255);--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "product_thumb_url_snapshot" text;
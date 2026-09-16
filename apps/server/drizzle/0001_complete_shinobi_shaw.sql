CREATE TABLE `supplier_quota` (
	`platform` text PRIMARY KEY NOT NULL,
	`remaining` integer,
	`reset_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `products` ADD `source` text;--> statement-breakpoint
ALTER TABLE `products` ADD `source_raw_id` integer;
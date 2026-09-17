PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_creatives` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`aspect` text NOT NULL,
	`slot` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`original_path` text,
	`detected_format` text,
	`finished_path` text,
	`file_name` text,
	`width` integer,
	`height` integer,
	`bytes` integer,
	`sha256` text,
	`metadata_check` text,
	`approval` text DEFAULT 'pending' NOT NULL,
	`flags` text,
	`error` text,
	`meta_image_hash` text,
	`created_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`batch_id`) REFERENCES `creative_batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
DROP TABLE `creatives`;--> statement-breakpoint
ALTER TABLE `__new_creatives` RENAME TO `creatives`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `creatives_batch_idx` ON `creatives` (`batch_id`);--> statement-breakpoint
CREATE INDEX `creatives_product_idx` ON `creatives` (`product_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `creatives_product_aspect_slot` ON `creatives` (`product_id`,`aspect`,`slot`);--> statement-breakpoint
ALTER TABLE `codex_tasks` ADD `aspect` text;--> statement-breakpoint
ALTER TABLE `codex_tasks` ADD `result` text;--> statement-breakpoint
ALTER TABLE `creative_batches` ADD `handle` text;--> statement-breakpoint
ALTER TABLE `creative_batches` ADD `formats` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `creative_batches` ADD `count_per_format` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `creative_batches` ADD `settings_used` text;--> statement-breakpoint
ALTER TABLE `creative_batches` ADD `api_requests` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `creative_batches` ADD `note` text;--> statement-breakpoint
ALTER TABLE `creative_batches` ADD `replaces_creative_id` integer;--> statement-breakpoint
ALTER TABLE `creative_batches` ADD `finished_at` text;
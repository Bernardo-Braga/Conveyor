CREATE TABLE `ad_sets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` integer NOT NULL,
	`name` text NOT NULL,
	`budget_minor` integer,
	`overrides` text,
	`interests` text,
	`interest_source` text DEFAULT 'none' NOT NULL,
	`meta_id` text,
	`status` text DEFAULT 'PAUSED' NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `ads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ad_set_id` integer NOT NULL,
	`creative_id` integer,
	`copy_id` integer,
	`meta_creative_id` text,
	`meta_ad_id` text,
	`status` text DEFAULT 'PAUSED' NOT NULL,
	`insights` text,
	FOREIGN KEY (`ad_set_id`) REFERENCES `ad_sets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`creative_id`) REFERENCES `creatives`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`copy_id`) REFERENCES `product_copy`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `campaign_edits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` integer NOT NULL,
	`changes` text NOT NULL,
	`state_before` text,
	`batch_results` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`template_json` text NOT NULL,
	`meta_campaign_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`last_read_at` text,
	`last_state` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `codex_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` integer NOT NULL,
	`creative_ids` text,
	`worker` integer,
	`folder` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`started_at` text,
	`finished_at` text,
	`error` text,
	FOREIGN KEY (`batch_id`) REFERENCES `creative_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `connection_checks` (
	`service` text PRIMARY KEY NOT NULL,
	`ok` integer NOT NULL,
	`detail` text NOT NULL,
	`checked_at` text NOT NULL,
	`request_id` text,
	`requests` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `costs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer,
	`service` text NOT NULL,
	`units` text,
	`amount_minor` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `creative_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`prompt_template_id` integer,
	`prompt_template_version` integer,
	`prompt` text NOT NULL,
	`engine` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`cost_minor` integer,
	`task_count` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `creatives` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` integer NOT NULL,
	`aspect` text NOT NULL,
	`original_path` text NOT NULL,
	`detected_format` text,
	`finished_path` text,
	`width` integer,
	`height` integer,
	`sha256` text,
	`metadata_check` text,
	`approval` text DEFAULT 'pending' NOT NULL,
	`flags` text,
	`meta_image_hash` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `creative_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `import_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`signature` text NOT NULL,
	`mapping` text NOT NULL,
	`confirmed` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_profiles_signature_unique` ON `import_profiles` (`signature`);--> statement-breakpoint
CREATE TABLE `interest_cache` (
	`label` text PRIMARY KEY NOT NULL,
	`meta_id` text,
	`meta_name` text,
	`suggestions` text,
	`user_pick` text,
	`last_checked_at` text
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`product_id` integer,
	`status` text DEFAULT 'queued' NOT NULL,
	`input` text,
	`steps` text NOT NULL,
	`current_step` text,
	`checkpoints` text DEFAULT '{}' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`progress` text,
	`error` text,
	`log` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX `jobs_product_idx` ON `jobs` (`product_id`);--> statement-breakpoint
CREATE TABLE `product_copy` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`body_text` text NOT NULL,
	`headline` text NOT NULL,
	`description` text,
	`source_template_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`origin` text NOT NULL,
	`platform` text,
	`item_id` text,
	`source_url` text,
	`state` text DEFAULT 'importing' NOT NULL,
	`title` text,
	`moq` integer,
	`failure` text,
	`listing_draft` text,
	`shopify_product_id` text,
	`shopify_handle` text,
	`snapshot` text,
	`snapshot_at` text,
	`highlights` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_platform_item_unique` ON `products` (`platform`,`item_id`);--> statement-breakpoint
CREATE INDEX `products_shopify_id_idx` ON `products` (`shopify_product_id`);--> statement-breakpoint
CREATE INDEX `products_state_idx` ON `products` (`state`);--> statement-breakpoint
CREATE TABLE `prompt_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`body` text NOT NULL,
	`variables` text NOT NULL,
	`formats` text NOT NULL,
	`count_per_format` integer DEFAULT 4 NOT NULL,
	`reference_rule` text DEFAULT 'first_3_shopify_images' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reference_cache` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`shopify_image_id` text NOT NULL,
	`path` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reference_cache_unique` ON `reference_cache` (`product_id`,`shopify_image_id`);--> statement-breakpoint
CREATE TABLE `requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`service` text NOT NULL,
	`purpose` text NOT NULL,
	`product_id` integer,
	`job_id` integer,
	`method` text NOT NULL,
	`url` text NOT NULL,
	`status` integer,
	`ok` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`quota_remaining` integer,
	`quota_reset_at` text,
	`request_id` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `requests_at_idx` ON `requests` (`at`);--> statement-breakpoint
CREATE INDEX `requests_service_idx` ON `requests` (`service`);--> statement-breakpoint
CREATE INDEX `requests_product_idx` ON `requests` (`product_id`);--> statement-breakpoint
CREATE TABLE `secret_meta` (
	`name` text PRIMARY KEY NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`section` text PRIMARY KEY NOT NULL,
	`json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `supplier_raw` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`platform` text NOT NULL,
	`item_id` text NOT NULL,
	`fetched_at` text NOT NULL,
	`http_status` integer NOT NULL,
	`body` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `supplier_raw_item_idx` ON `supplier_raw` (`platform`,`item_id`);--> statement-breakpoint
CREATE TABLE `templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`template_id` text NOT NULL,
	`name` text NOT NULL,
	`version` integer NOT NULL,
	`source` text NOT NULL,
	`json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `templates_template_id_unique` ON `templates` (`template_id`);
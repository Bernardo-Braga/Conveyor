PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_product_launch` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`template_id` integer NOT NULL,
	`template` text,
	`creative_ids` text,
	`overrides` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_product_launch`("id", "product_id", "template_id", "template", "creative_ids", "overrides", "updated_at") SELECT "id", "product_id", "template_id", "template", "creative_ids", NULL, "updated_at" FROM `product_launch`;--> statement-breakpoint
DROP TABLE `product_launch`;--> statement-breakpoint
ALTER TABLE `__new_product_launch` RENAME TO `product_launch`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `product_launch_product_unique` ON `product_launch` (`product_id`);--> statement-breakpoint
ALTER TABLE `products` ADD `focus` text DEFAULT '' NOT NULL;
CREATE TABLE `product_launch` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`template_id` integer NOT NULL,
	`template` text NOT NULL,
	`creative_ids` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_launch_product_unique` ON `product_launch` (`product_id`);
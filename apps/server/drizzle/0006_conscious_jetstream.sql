ALTER TABLE `creatives` ADD `source_media_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `creatives_product_source_media` ON `creatives` (`product_id`,`source_media_id`);
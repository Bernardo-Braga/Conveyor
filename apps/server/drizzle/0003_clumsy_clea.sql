ALTER TABLE `templates` ADD `file_path` text;--> statement-breakpoint
ALTER TABLE `templates` ADD `file_mtime` text;--> statement-breakpoint
ALTER TABLE `templates` ADD `file_missing` integer DEFAULT false NOT NULL;